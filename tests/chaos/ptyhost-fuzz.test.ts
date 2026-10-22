// Garbage and damaged recordings through ptyhost's mirror: nothing throws, and wherever a snapshot is cut (at a
// ground-state seq, as ptyhost cuts them), a renderer restored from it and fed the rest ends equal to the mirror: its
// cells, wrap flags, cursor and modes (DEC private modes, LNM and tab stops included), and its cell styles, attributes
// and saved cursors too. Cuts that hit one of the snapshot's known losses are counted instead of compared.

import fs from 'node:fs'
import path from 'node:path'
import headless from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { DEFAULT_TERMINAL_SETTINGS } from '@kea/protocol'
import { colorThemeOf, createTerminalOptions, installRendererSwallow } from '@kea/terminal'
import { Mirror } from '../../app/ptyhost/src/mirror/mirror.ts'
import { REPO_ROOT } from '../support/holders.ts'
import { castPlan } from '../integration/ptyhost-child.ts'
import { terminalState, write } from '../integration/ptyhost-support.ts'
import { internals, screenStyles } from '../../packages/terminal/src/test-support.ts'
import { sgrOf } from '../../packages/terminal/src/attrs.ts'
import { VtScanner } from '../../packages/terminal/src/scanner.ts'

const DIR = path.join(REPO_ROOT, 'fixtures/cassettes')
const CASSETTES = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.cast'))
  .sort()
  .map((f) => castPlan(path.join(DIR, f)).bytes)
const SCROLLBACK = 500
const RUNS = 400
const COLORS = colorThemeOf(DEFAULT_TERMINAL_SETTINGS.theme)

/** Escape-heavy fragments, so random streams reach the parser's interesting states and not just text. */
const FRAGMENTS = ['\x1b', '\x1b[', '\x1b]', '\x1bP', '\x1b[?', '\x1b[?2026h', '\x1b[?2026l', '\x1b[?1049h', '\x1b[?1049l', '\x1b[38;2;', '\x1b[1;', 'm', ';', '\x07', '\x1b\\', '\r\n', '\x9b', '\x1b(0', '\x1b(B', '\x1b[>1u', '\x1b[<u', '\x1b[?1000h', '\x1b[?1006h', '\x1b[H', '\x1b[2J', '\x1b[r', '\x1b[5;10r', '\x1b7', '\x1b8', 'é', '日本', '\u{1f600}',
  // modes the trailer restores (DEC private modes, insert mode, LNM) and tab stops (HTS, TBC, a tab and a back-tab)
  '\x1b[?1h', '\x1b[?6h', '\x1b[?7l', '\x1b[?25l', '\x1b[?45h', '\x1b[?1004h', '\x1b[?2004h', '\x1b=', '\x1b[4h', '\x1b[20h', '\x1b[20l', '\n', '\x1bH', '\x1b[g', '\x1b[3g', '\t', '\x1b[Z'].map((s) => new TextEncoder().encode(s))

const randomStream = fc.array(fc.oneof(fc.uint8Array({ minLength: 1, maxLength: 64 }), fc.constantFrom(...FRAGMENTS)), { maxLength: 120 }).map(concat)

type Mutation = { at: number; kind: 'flip' | 'insert' | 'delete'; bytes: Uint8Array; n: number }
const mutation: fc.Arbitrary<Mutation> = fc.record({ at: fc.nat(), kind: fc.constantFrom('flip' as const, 'insert' as const, 'delete' as const), bytes: fc.oneof(fc.uint8Array({ minLength: 1, maxLength: 8 }), fc.constantFrom(...FRAGMENTS)), n: fc.integer({ min: 1, max: 32 }) })

/** A slice of a recorded session with bytes flipped, inserted and deleted. */
const mutatedCassette = fc.tuple(fc.nat({ max: CASSETTES.length - 1 }), fc.nat(), fc.integer({ min: 256, max: 16_384 }), fc.array(mutation, { maxLength: 12 })).map(([c, start, len, muts]) => {
  const src = CASSETTES[c]!
  const from = start % Math.max(1, src.length)
  let b = Array.from(src.subarray(from, from + len))
  for (const m of muts) {
    const at = b.length ? m.at % b.length : 0
    if (m.kind === 'flip') b[at] = (b[at] ?? 0) ^ (m.bytes[0] ?? 0xff)
    else if (m.kind === 'insert') b.splice(at, 0, ...m.bytes)
    else b.splice(at, m.n)
  }
  return Uint8Array.from(b)
})

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.byteLength
  }
  return out
}

/** A renderer-side terminal fed `prefix`, then `rest`: what `state` sees of it. */
async function probe(prefix: string, rest: Uint8Array, state: (t: headless.Terminal) => unknown): Promise<string> {
  const t = new headless.Terminal({ ...createTerminalOptions({ side: 'renderer', cols: 80, rows: 24, scrollback: SCROLLBACK }), allowProposedApi: true })
  try {
    await write(t, prefix)
    await write(t, rest)
    return JSON.stringify(state(t))
  } finally {
    t.dispose()
  }
}

/**
 * The snapshot's known losses, where equality cannot hold. The parser remembers the character it printed last, and a
 * zero-width character right after the cut joins that cell (a REP repeats it), while the renderer, whose last input was
 * the snapshot's control sequences, has nothing to join. Decided exactly: the mirror printed last, and two probes that
 * differ only in that memory end differently on the rest of the stream, in anything `state` compares (the cursor too:
 * the difference can be one column, with the screen it was on switched away).
 */
async function knownGap(t: headless.Terminal, rest: Uint8Array, state: (t: headless.Terminal) => unknown): Promise<boolean> {
  const parser = (t as unknown as { _core: { _inputHandler: { _parser: { precedingJoinState: number } } } })._core._inputHandler._parser
  if (parser.precedingJoinState === 0) return false
  return (await probe('a', rest, state)) !== (await probe('a\x1b[C\x1b[D', rest, state))
}

/**
 * A cursor in the pending-wrap column on the alternate screen or in origin mode (a known loss): it comes back on the
 * last column, so the next character overwrites that cell instead of wrapping.
 */
function pendingWrapLost(t: headless.Terminal): boolean {
  return t.buffer.active.cursorX >= t.cols && (t.buffer.active.type === 'alternate' || t.modes.originMode)
}

/**
 * Two known losses for styles only. A link opened before the cut: the serialize addon drops OSC 8 links, so they come
 * back as plain text, and an open one leaves marks the renderer cannot have, on the text after the cut and in the
 * extended-attributes flag of the current or a saved background (xterm.js keeps the link through SGR 0 and DECRC).
 * Decided by whether the mirror ever opened one.
 */
function linkSeen(t: headless.Terminal): boolean {
  return (t as unknown as { _core: { _oscLinkService: { _nextId: number } } })._core._oscLinkService._nextId > 1
}

/**
 * And current attributes no SGR sequence can set: xterm.js's DECRC restores the saved colours and flags but keeps the
 * current underline style and colour, so the underline flag and style can disagree. Decided exactly: the trailer's SGR
 * for them, written to a fresh terminal, sets something else.
 */
async function staleAttrs(t: headless.Terminal): Promise<boolean> {
  const a = internals(t as never).attrs
  const p = new headless.Terminal({ ...createTerminalOptions({ side: 'renderer', cols: 80, rows: 24, scrollback: 0 }), allowProposedApi: true })
  try {
    await write(p, sgrOf(a))
    return JSON.stringify(internals(p as never).attrs) !== JSON.stringify(a)
  } finally {
    p.dispose()
  }
}

/**
 * What a restored renderer must agree on with the mirror: cursor, modes (DEC private modes, insert mode, LNM), buffer,
 * scroll region, tab stops, charsets, title (ptyhost-support.ts `terminalState`), and every cell's text and width and
 * every row's wrap flag (C-FUZZ-3).
 */
function contentState(t: headless.Terminal) {
  const { serialized: _, ...state } = terminalState(t as never)
  const b = t.buffer.active
  const rows: string[] = []
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y)!
    // the first row's wrap flag says it continues a line already dropped from the scrollback: nothing to restore
    let row = line.isWrapped && y > 0 ? 'W|' : ' |'
    let wide = false
    for (let x = 0; x < t.cols; x++) {
      const c = line.getCell(x)!
      const w = c.getWidth()
      const ch = c.getChars()
      // a blank is a blank whatever width it was left with (an erased wide character's remains look the same)
      if (w === 0 && wide) row += ''
      else if (!ch) row += '·'.repeat(Math.max(1, w))
      else row += ch + (w === 2 ? '²' : '')
      wide = w === 2
    }
    rows.push(row)
  }
  return { ...state, rows }
}

/**
 * All of the above, every cell's style (colours, intensity and the other SGR flags, an erased cell's background), the
 * current attributes, and both screens' saved cursors: position, attributes, origin and wrap flags, G0–G3 and GL
 * (C-FUZZ-7). The saved charset table is compared by value: it can come back longer than it was (a known loss).
 */
function styledState(t: headless.Terminal) {
  const x = internals(t as never)
  const g = (s: { charsets: unknown[]; glevel: number }) => ({ g: [0, 1, 2, 3].map((i) => s.charsets[i] ?? null), glevel: s.glevel })
  return { ...contentState(t), styles: screenStyles(t as never), attrs: x.attrs, saved: x.saved, savedCharsets: { normal: g(x.savedCharsets.normal), alt: g(x.savedCharsets.alt) } }
}

/**
 * A tab stop set by the 8-bit C1 HTS (U+0088) before the cut (a known loss): it is an execute, which no parser hook
 * sees. Decided by the scanner, a port of xterm.js's parser table, so exactly when xterm.js executed one.
 */
function c1HtsSeen(bytes: Uint8Array): boolean {
  const scanner = new VtScanner()
  let seen = false
  scanner.addListener({ execute: (code) => (seen ||= code === 0x88) })
  scanner.feed(bytes)
  return seen
}

/** Resolves when the mirror has parsed everything written to it. */
async function parsed(m: Mirror): Promise<void> {
  await new Promise<void>((r) => m.terminal.write('', r))
}

/**
 * Feed `bytes` to a mirror in chunks cut at `cuts`; from `attachAt` on, cut a snapshot at the first chunk boundary where
 * the mirror is at a ground-state seq (as ptyhost does), restore a renderer from it and feed it the rest.
 * Returns whether a snapshot was cut, which known gaps the cut hit, and both final states as `state` sees them.
 */
async function attachRun<S>(bytes: Uint8Array, cuts: number[], attachAt: number, state: (t: headless.Terminal) => S) {
  const m = new Mirror({ cols: 80, rows: 24, scrollback: SCROLLBACK, colors: COLORS, startSeq: 0, reply: () => {}, parsed: () => {}, now: () => 0 })
  let r: headless.Terminal | null = null
  const known = { join: false, wrap: false, link: false, attrs: false, hts: false }
  try {
    const points = [...new Set([...cuts.map((c) => c % (bytes.length + 1)), bytes.length])].sort((a, b) => a - b)
    let at = 0
    for (const p of points) {
      if (p <= at) continue
      const chunk = bytes.subarray(at, p)
      m.write(at, chunk)
      if (r) await write(r, chunk)
      at = p
      if (!r && at >= attachAt) {
        await parsed(m)
        if (m.parserIdle && m.atGround) {
          known.join = await knownGap(m.terminal as never, bytes.subarray(at), state)
          known.wrap = pendingWrapLost(m.terminal as never)
          known.link = linkSeen(m.terminal as never)
          known.attrs = await staleAttrs(m.terminal as never)
          known.hts = c1HtsSeen(bytes.subarray(0, at))
          const s = m.snapshot()
          r = new headless.Terminal({ ...createTerminalOptions({ side: 'renderer', cols: s.cols, rows: s.rows, scrollback: SCROLLBACK }), allowProposedApi: true })
          installRendererSwallow(r as never)
          await write(r, s.data)
        }
      }
    }
    await parsed(m)
    return { cut: r !== null, known, mirror: state(m.terminal as never), renderer: r ? state(r) : null }
  } finally {
    r?.dispose()
    m.dispose()
  }
}

const cutsArb = fc.array(fc.nat(), { maxLength: 24 })

// xterm logs every malformed sequence it drops; garbage is the point here, so those lines are noise
beforeEach(() => {
  for (const level of ['error', 'warn', 'log'] as const) {
    const real = console[level].bind(console)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('xterm.js: Parsing error')) return
      real(...args)
    })
  }
})
afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * The property both tests check: random streams and mutated cassettes, attached at random offsets. Runs whose cut hit
 * one of `gaps` (the known losses) are counted, not compared.
 */
async function fuzz(state: (t: headless.Terminal) => unknown, gaps: ('join' | 'wrap' | 'link' | 'attrs' | 'hts')[]): Promise<void> {
  let compared = 0
  let known = 0
  await fc.assert(
    fc.asyncProperty(fc.oneof(randomStream, mutatedCassette), cutsArb, fc.nat(), async (bytes, cuts, attach) => {
      const res = await attachRun(bytes, cuts, attach % (bytes.length + 1), state)
      if (!res.cut) return
      if (gaps.some((g) => res.known[g])) {
        known++
        return
      }
      compared++
      expect(res.renderer).toEqual(res.mirror)
    }),
    { numRuns: RUNS },
  )
  // enough runs are compared: the rest never reached a ground state to cut at, or hit a known loss
  expect(compared, `${compared} compared, ${known} known gaps`).toBeGreaterThanOrEqual(RUNS / 4)
}

describe('mirror and snapshots under garbage', () => {
  it('C-FUZZ-3 · random byte streams and mutated cassettes, attached at random offsets: no exception, and a renderer restored from the snapshot ends with the mirror\'s cells, cursor and modes', async () => {
    await fuzz(contentState, ['join', 'wrap', 'hts'])
  })

  it('C-FUZZ-7 · the same streams through the patched serializer: the restored renderer also ends with the mirror\'s cell styles, and saved cursors come back with their attributes, modes and character sets', async () => {
    await fuzz(styledState, ['join', 'wrap', 'link', 'attrs', 'hts'])
  })
})
