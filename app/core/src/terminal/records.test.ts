import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryLogger, noopLogger } from '@kea/kit'
import { L } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { FileRecords, MemoryRecords, recordsPath, type TerminalRecord } from './records.ts'

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
})
function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-test-'))
  homes.push(h)
  return h
}

let n = 0
function rec(over: Partial<TerminalRecord> = {}): TerminalRecord {
  n++
  return {
    ptyId: `r${String(n).padStart(9, '0')}`,
    sessionId: 'shells',
    kind: 'shell',
    argv: ['/bin/zsh', '-l'],
    cwd: '/tmp',
    title: null,
    holderPid: null,
    holderStartedAt: null,
    childPid: null,
    cols: 80,
    rows: 24,
    state: 'running',
    exitCode: null,
    exitSignal: null,
    tabOrder: 0,
    createdAt: n,
    endedAt: null,
    ...over,
  }
}

describe('terminal records', () => {
  it('U-PTY-41 · the file round-trips, is private (0600) and replaced atomically; a missing file means "rebuild"', () => {
    const h = home()
    const first = FileRecords.open(h, noopLogger)
    expect(first.loaded).toBe(false)
    const a = rec({ argv: ['/bin/zsh', '-l', 'quote " back\\slash', 'line\nbreak'] })
    const b = rec({ kind: 'agent', sessionId: 'S1', state: 'lost', endedAt: 99 })
    first.putMany([a, b])
    first.put({ ...a, title: 'vim' })
    first.delete('nonexistent')
    expect(fs.statSync(recordsPath(h)).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(h)).toEqual(['terminals.json']) // no temp file left behind
    const again = FileRecords.open(h, noopLogger)
    expect(again.loaded).toBe(true)
    expect(again.list().sort((x, y) => x.createdAt - y.createdAt)).toEqual([{ ...a, title: 'vim' }, b])
    again.delete(b.ptyId)
    expect(FileRecords.open(h, noopLogger).list().map((r) => r.ptyId)).toEqual([a.ptyId])
  })

  it('U-PTY-41 · an unreadable file is set aside and the store starts empty ("rebuild"); a malformed record is dropped alone', () => {
    const h = home()
    fs.writeFileSync(recordsPath(h), '{"v":1,"records":[') // torn
    const log = createMemoryLogger()
    const r = FileRecords.open(h, log)
    expect(r.loaded).toBe(false)
    expect(r.list()).toEqual([])
    expect(fs.existsSync(`${recordsPath(h)}.unreadable`)).toBe(true)
    expect(log.entries.some((e) => e.msg.includes('unreadable'))).toBe(true)

    const good = rec()
    fs.writeFileSync(recordsPath(h), JSON.stringify({ v: 1, records: [good, { ...good, ptyId: 'NOT-AN-ID' }, { ...rec(), state: 'zombie' }, 7] }))
    const partial = FileRecords.open(h, noopLogger)
    expect(partial.loaded).toBe(true)
    expect(partial.list()).toEqual([good])

    fs.writeFileSync(recordsPath(h), JSON.stringify({ v: 2, records: [] }))
    expect(FileRecords.open(h, noopLogger).loaded).toBe(false)
  })

  it('U-PTY-41 · bounded by L.terminalRecordsMax: the oldest ended record makes room; with every record running, a new one is refused', () => {
    const r = new MemoryRecords([])
    const ended = [rec({ state: 'exited', endedAt: 5 }), rec({ state: 'lost', endedAt: 3 })]
    r.putMany(ended)
    r.putMany(Array.from({ length: L.terminalRecordsMax - ended.length }, () => rec()))
    expect(r.list()).toHaveLength(L.terminalRecordsMax)
    const extra = rec()
    r.put(extra)
    expect(r.list()).toHaveLength(L.terminalRecordsMax)
    expect(r.get(ended[1]!.ptyId), 'the oldest ended record went first').toBeUndefined()
    expect(r.get(ended[0]!.ptyId)).toBeDefined()
    r.put(rec())
    expect(r.get(ended[0]!.ptyId)).toBeUndefined()
    const before = r.list().length
    expect(() => r.put(rec())).toThrow(/terminalRecordsMax/)
    expect(r.list()).toHaveLength(before)
    r.put({ ...extra, title: 'replacing an existing record needs no room' })
    expect(r.get(extra.ptyId)?.title).toMatch(/replacing/)
  })

  it('U-PTY-41 · a failed write changes nothing in memory', () => {
    const h = home()
    const r = FileRecords.open(h, noopLogger)
    const a = rec()
    r.put(a)
    fs.chmodSync(h, 0o500)
    try {
      expect(() => r.put(rec())).toThrow()
      expect(() => r.delete(a.ptyId)).toThrow()
      expect(r.list()).toEqual([a])
    } finally {
      fs.chmodSync(h, 0o700)
    }
  })
})
