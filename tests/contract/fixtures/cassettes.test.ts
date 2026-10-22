// Cassette replay: every recorded cassette in fixtures/cassettes is replayed, in event order (output and resizes),
// through ptyhost's own Mirror and through a classifier terminal that hooks every query-shaped sequence.
//
// Reference screens live next to each cassette (`<name>.screen.json`). After a deliberate change (new cassette, new
// xterm), regenerate them with `KEA_UPDATE_GOLDENS=1 npx vitest run --project contract tests/contract/fixtures/cassettes`
// and review the diff.
import serializeAddon from '@xterm/addon-serialize'
import headless from '@xterm/headless'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TERMINAL_SETTINGS } from '@kea/protocol'
import { colorThemeOf, createTerminalOptions, matchQuery, type CsiParams, type FunctionIdentifier, type QueryEntry } from '@kea/terminal'
import { Mirror } from '../../../app/ptyhost/src/mirror/mirror.ts'
import { parseCast } from '../../../tools/recorder/src/cast.ts'

const { Terminal } = headless
const { SerializeAddon } = serializeAddon
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const DIR = join(root, 'fixtures/cassettes')
const casts = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.cast')).sort() : []
const UPDATE = process.env.KEA_UPDATE_GOLDENS === '1'

/** Identifiers whose every form is a query: an unmatched one is a query the table does not know. */
const CSI_IDS: { id: FunctionIdentifier; alwaysQuery: boolean }[] = [
  { id: { final: 'c' }, alwaysQuery: true },
  { id: { prefix: '>', final: 'c' }, alwaysQuery: true },
  { id: { prefix: '=', final: 'c' }, alwaysQuery: true },
  { id: { final: 'n' }, alwaysQuery: true },
  { id: { prefix: '?', final: 'n' }, alwaysQuery: true },
  { id: { intermediates: '$', final: 'p' }, alwaysQuery: true },
  { id: { prefix: '?', intermediates: '$', final: 'p' }, alwaysQuery: true },
  { id: { prefix: '>', final: 'q' }, alwaysQuery: true },
  { id: { prefix: '?', final: 'u' }, alwaysQuery: false },
  { id: { final: 't' }, alwaysQuery: false },
]
const DCS_IDS: FunctionIdentifier[] = [
  { intermediates: '$', final: 'q' },
  { intermediates: '+', final: 'q' },
]
const OSC_IDS = [4, 10, 11, 12, 52]

const describeId = (id: FunctionIdentifier, params: CsiParams) => `${id.prefix ?? ''}${params.map((p) => (Array.isArray(p) ? p.join(':') : p)).join(';')}${id.intermediates ?? ''}${id.final}`

type Replay = {
  name: string
  queries: QueryEntry[]
  unknown: string[]
  replies: string[]
  recordedReplies: string[]
  warnings: string[]
  groundAtEnd: boolean
  screen: { cols: number; rows: number; cursor: [number, number]; altScreen: boolean; text: string[]; ansi: string }
}

async function replay(name: string): Promise<Replay> {
  const cast = parseCast(readFileSync(join(DIR, name), 'utf8'))
  const { width: cols, height: rows } = cast.header
  const scrollback = DEFAULT_TERMINAL_SETTINGS.scrollback
  const warnings: string[] = []
  const note = (level: string) => (m: string, ...a: unknown[]) => warnings.push(`${level}: ${m} ${a.map(String).join(' ')}`.trim())
  const term = new Terminal({
    ...createTerminalOptions({ side: 'mirror', cols, rows, scrollback }),
    logLevel: 'warn',
    logger: { trace: () => {}, debug: () => {}, info: () => {}, warn: note('warn'), error: note('error') },
  })
  const serializer = new SerializeAddon()
  term.loadAddon(serializer)
  const queries: QueryEntry[] = []
  const unknown: string[] = []
  for (const { id, alwaysQuery } of CSI_IDS) {
    term.parser.registerCsiHandler(id, (params) => {
      const e = matchQuery('csi', id, params as CsiParams)
      if (e) queries.push(e)
      else if (alwaysQuery) unknown.push(`CSI ${describeId(id, params as CsiParams)}`)
      return false
    })
  }
  for (const id of DCS_IDS) {
    term.parser.registerDcsHandler(id, (data, params) => {
      const e = matchQuery('dcs', id, params as CsiParams, data)
      if (e) queries.push(e)
      else unknown.push(`DCS ${describeId(id, params as CsiParams)} ${JSON.stringify(data)}`)
      return false
    })
  }
  for (const id of OSC_IDS) {
    term.parser.registerOscHandler(id, (data) => {
      const e = matchQuery('osc', id, data)
      if (e) queries.push(e)
      return false
    })
  }

  const replies: string[] = []
  let parsed = 0
  let wake: (() => void) | null = null
  const mirror = new Mirror({
    cols,
    rows,
    scrollback,
    colors: colorThemeOf(DEFAULT_TERMINAL_SETTINGS.theme),
    startSeq: 0,
    reply: (d) => replies.push(d),
    parsed: (s) => {
      parsed = s
      wake?.()
    },
    now: () => 0,
  })
  const enc = new TextEncoder()
  let seq = 0
  for (const [, code, data] of cast.events) {
    if (code === 'o') {
      const b = enc.encode(data)
      mirror.write(seq, b)
      seq += b.byteLength
      term.write(b)
    } else if (code === 'r') {
      const [c, r] = data.split('x').map(Number) as [number, number]
      // a resize lands between the bytes written before it and after it, on both terminals
      await new Promise<void>((r2) => term.write('', r2))
      if (parsed < seq) await new Promise<void>((r2) => (wake = () => parsed >= seq && r2()))
      mirror.resize(c, r)
      term.resize(c, r)
    }
  }
  await new Promise<void>((r) => term.write('', r))
  if (parsed < seq) await new Promise<void>((r) => (wake = () => parsed >= seq && r()))
  const b = term.buffer.active
  const text: string[] = []
  for (let i = b.viewportY; i < b.viewportY + term.rows; i++) text.push(b.getLine(i)?.translateToString(true) ?? '')
  const screen = {
    cols: term.cols,
    rows: term.rows,
    cursor: [b.cursorX, b.cursorY] as [number, number],
    altScreen: b.type === 'alternate',
    text,
    ansi: serializer.serialize({ scrollback: 0, excludeModes: true }),
  }
  const groundAtEnd = mirror.parserIdle
  mirror.dispose()
  term.dispose()
  const recordedReplies = cast.events.filter((e) => e[1] === 'i' && e[2].startsWith('\x1b')).map((e) => e[2])
  return { name, queries, unknown, replies, recordedReplies, warnings, groundAtEnd, screen }
}

describe('cassette replay', () => {
  it('K-FX-4 · there are cassettes to replay', () => {
    expect(casts.length, 'record with pnpm record:cassette, then pnpm fixtures:scrub --only cassettes').toBeGreaterThan(0)
  })

  it('K-FX-4 · every query a recorded CLI sends is in the query table and the mirror answers it exactly as when recorded', async () => {
    let total = 0
    for (const name of casts) {
      const r = await replay(name)
      expect(r.unknown, `${name}: queries the table does not know`).toEqual([])
      const answered = r.queries.filter((q) => q.answeredBy !== 'nobody')
      expect(r.replies.length, `${name}: one reply per answered query (${answered.map((q) => q.id).join(', ')})`).toBe(answered.length)
      answered.forEach((q, i) => expect(r.replies[i], `${name}: reply ${i} to ${q.id}`).toMatch(q.reply as RegExp))
      // the same mirror code answered the live agent while recording: replay gives the same bytes
      expect(r.replies, `${name}: replies differ from those recorded`).toEqual(r.recordedReplies)
      total += r.queries.length
    }
    expect(total, 'the cassettes contain the CLIs\' startup queries').toBeGreaterThan(0)
  })

  it('K-FX-5 · every cassette replays without parser warnings, ends at ground, and its final screen matches the reference', async () => {
    for (const name of casts) {
      const r = await replay(name)
      expect(r.warnings, `${name}: xterm warnings`).toEqual([])
      expect(r.groundAtEnd, `${name}: ends inside an escape sequence`).toBe(true)
      const file = join(DIR, name.replace(/\.cast$/, '.screen.json'))
      const json = `${JSON.stringify(r.screen, null, 2)}\n`
      if (UPDATE || !existsSync(file)) {
        if (!UPDATE) throw new Error(`${name}: no reference screen; generate it with KEA_UPDATE_GOLDENS=1 and review it`)
        writeFileSync(file, json)
        continue
      }
      expect(JSON.parse(json), `${name}: final screen differs from ${file}`).toEqual(JSON.parse(readFileSync(file, 'utf8')))
    }
  })
})
