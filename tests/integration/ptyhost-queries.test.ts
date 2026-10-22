// The single query responder against a real holder: the process zoo's `prober` asks every query form of
// packages/terminal's table and judges the replies it gets on its own terminal.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MirrorConfig } from '@kea/protocol'
import { colorThemeOf } from '@kea/terminal'
import { DEFAULT_TERMINAL_SETTINGS } from '@kea/protocol'
import { zooScript } from '../../tools/process-zoo/src/index.ts'
import type { DoneRecord, ProbeRecord } from '../../tools/process-zoo/src/prober.ts'
import { ptyhostHarness, rawTty, until, type Harness } from '../support/holders.ts'
import { childArgv } from './ptyhost-child.ts'
import { parsedSeq, SIG, TestRenderer } from './ptyhost-support.ts'

let h: Harness | null = null
afterEach(async () => {
  await h?.dispose()
  h = null
})

/** `argv`, started only once a line arrives on the terminal (so a renderer can attach first). */
const gated = (argv: string[]) => ['/bin/sh', '-c', 'read _ && exec "$0" "$@"', ...argv]

function proberRecords(file: string): { replies: ProbeRecord[]; done: DoneRecord | null } {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  const recs = lines.map((l) => JSON.parse(l) as ProbeRecord | DoneRecord | { t: 'stray' })
  return { replies: recs.filter((r): r is ProbeRecord => r.t === 'reply'), done: (recs.find((r) => r.t === 'done') as DoneRecord | undefined) ?? null }
}

/** Every query answered exactly once with the table's reply (none for the deliberately silent ones), no strays. */
function expectAllAnswered(file: string, cols: number, rows: number): void {
  const { replies, done } = proberRecords(file)
  expect(done).not.toBeNull()
  expect(replies.filter((r) => !r.ok).map((r) => ({ id: r.id, replies: r.replies.map((x) => x.seq), timedOut: r.timedOut }))).toEqual([])
  expect(done!.strays).toBe(0)
  expect(done!.notOk).toEqual([])
  const ids = replies.map((r) => r.id)
  for (const id of ['DA1', 'DA2', 'DSR', 'DECRQM_DEC', 'KITTY_KBD', 'XTVERSION', 'DECRQSS', 'OSC4', 'OSC10', 'OSC11', 'OSC12', 'COLOR_SCHEME', 'WIN_PX', 'CELL_PX', 'WIN_CHARS']) expect(ids).toContain(id)
  // the geometry the mirror reports is the PTY's
  expect(replies.find((r) => r.id === 'WIN_CHARS')!.replies.map((x) => x.seq)).toEqual([`\x1b[8;${rows};${cols}t`])
}

describe('single query responder', () => {
  it('I-PTY-3 · with a renderer attached, every query is answered exactly once, correctly, and only by the mirror; ptyhost sends no colour-scheme report on a theme change', async () => {
    h = await ptyhostHarness()
    const out = path.join(h.home, 'probe.ndjson')
    const pty = await h.spawn({ argv: gated([process.execPath, zooScript('prober'), '--out', out]), cols: 100, rows: 30 })
    const r = new TestRenderer(h.manager, pty.ptyId)
    await until('the renderer\'s snapshot', () => r.snapshots === 1 && r.writtenSeq >= 0)
    r.input('go\r') // typed in the window
    await until('the prober to finish', () => proberRecords(out).done !== null)
    expectAllAnswered(out, 100, 30)
    expect(r.sentInput).toEqual([]) // the renderer answered nothing itself
    expect(r.discontinuities).toEqual([])
    r.close()

    // DECSET 2031 on, then the theme changes: nobody writes a CSI ? 997 n report to the PTY
    const rec = path.join(h.home, 'input.bin')
    const talk = await h.spawn({ argv: rawTty(childArgv('talk', ['--record', rec, '--print', '\\e[?2031h', '--then', '\\e[c'])) })
    const r2 = new TestRenderer(h.manager, talk.ptyId)
    await until('the 2031 set to be parsed', () => parsedSeq(talk) >= '\x1b[?2031h'.length && r2.writtenSeq >= 0)
    const base = colorThemeOf(DEFAULT_TERMINAL_SETTINGS.theme)
    const light: MirrorConfig = { ...base, palette: [...base.palette], foreground: '#101010', background: '#FAFAFA', dark: false, scrollback: DEFAULT_TERMINAL_SETTINGS.scrollback, diskBackedScrollback: true }
    h.manager.configure(light)
    r2.term.options.theme = { foreground: light.foreground, background: light.background }
    talk.signal(SIG.SIGUSR2, 'child') // DA1 as a sentinel: everything sent before its reply has arrived
    await until('the sentinel\'s reply', () => fs.existsSync(rec) && fs.readFileSync(rec, 'latin1').includes('c'))
    expect(fs.readFileSync(rec, 'latin1')).toBe('\x1b[?1;2c')
    expect(r2.sentInput).toEqual([])
    r2.close()
  })

  it('I-PTY-4 · with no renderer ever attached, every query is still answered exactly once', async () => {
    h = await ptyhostHarness()
    const out = path.join(h.home, 'probe.ndjson')
    await h.spawn({ argv: [process.execPath, zooScript('prober'), '--out', out], cols: 90, rows: 20 })
    await until('the prober to finish', () => proberRecords(out).done !== null)
    expectAllAnswered(out, 90, 20)
  })

  it('I-PTY-5 · a mirror rebuilt from the ring after a ptyhost restart answers none of the queries in its history; new ones once', async () => {
    h = await ptyhostHarness()
    const rec = path.join(h.home, 'input.bin')
    const history = 'history \\e[c\\e[6n\\e]11;?\\a\\e[?2026$p\\e[>q\\r\\n'
    const pty = await h.spawn({ argv: rawTty(childArgv('talk', ['--record', rec, '--print', history, '--then', '\\e[5n'])) })
    const id = pty.ptyId
    // answered live: one reply each
    await until('the live replies', () => fs.existsSync(rec) && fs.readFileSync(rec, 'latin1').includes('\x1bP>|'))
    const live = fs.readFileSync(rec, 'latin1')
    expect(live).toMatch(/^\x1b\[\?1;2c\x1b\[1;9R\x1b\]11;rgb:[0-9a-f/]+\x1b\\\x1b\[\?2026;2\$y\x1bP>\|xterm\.js\([^)]*\)\x1b\\$/)
    // ptyhost restarts without a checkpoint: the visible terminal is rebuilt from the whole ring at once
    const m = await h.restart({ visible: [id] })
    const p = m.get(id)!
    await until('the rebuild', () => p.currentMirror !== null && !p.isReplaying && parsedSeq(p) > 0)
    expect(p.checkpointSeq).toBeNull()
    // a new query, as a sentinel: once its reply is in, anything the rebuild had sent would be in too
    p.signal(SIG.SIGUSR2, 'child')
    await until('the new query\'s reply', () => fs.readFileSync(rec, 'latin1').endsWith('\x1b[0n'))
    expect(fs.readFileSync(rec, 'latin1')).toBe(`${live}\x1b[0n`)
  })
})
