import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { castSchedule, CastError, parseCast } from './cassette.ts'
import { applyFileOp } from './files.ts'

const dir = mkdtempSync(join(tmpdir(), 'fake-agent-cast-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const CAST = [
  JSON.stringify({ version: 2, width: 80, height: 24, idle_time_limit: 1 }),
  JSON.stringify([0.1, 'o', 'hello ']),
  JSON.stringify([0.2, 'i', 'typed']),
  JSON.stringify([0.5, 'r', '100x30']),
  JSON.stringify([3.5, 'o', 'world\r\n']),
  JSON.stringify([3.75, 'o', '\x1b[1mbold\x1b[0m']),
  '',
].join('\n')

describe('fake-agent cassettes and files', () => {
  it('U-FAKE-18 · asciicast v2 parses: header, output events only, clear errors with line numbers', () => {
    const { header, events } = parseCast(CAST, 'x.cast')
    expect(header).toMatchObject({ version: 2, width: 80, height: 24 })
    expect(events).toEqual([
      { t: 0.1, data: 'hello ' },
      { t: 3.5, data: 'world\r\n' },
      { t: 3.75, data: '\x1b[1mbold\x1b[0m' },
    ])
    expect(() => parseCast('', 'e.cast')).toThrow(/empty/)
    expect(() => parseCast('{"version":1,"width":1,"height":1}', 'e.cast')).toThrow(/e.cast:1: expected an asciicast v2 header/)
    expect(() => parseCast(`${JSON.stringify({ version: 2, width: 1, height: 1 })}\n[1, "o"]`, 'e.cast')).toThrow(/e.cast:2: expected \[time, code, data\]/)
    expect(() => parseCast(`${JSON.stringify({ version: 2, width: 1, height: 1 })}\n[2, "o", "a"]\n[1, "o", "b"]`, 'e.cast')).toThrow(CastError)
    expect(() => parseCast(`${JSON.stringify({ version: 2, width: 1, height: 1 })}\nnot json`, 'e.cast')).toThrow(/e.cast:2: not JSON/)
  })

  it('U-FAKE-19 · replay timing: time / speed, idle gaps capped (header idle_time_limit or maxIdleMs), speed 0 = all at once', () => {
    const { header, events } = parseCast(CAST)
    const at = (o: { speed: number; maxIdleMs: number | null }) => castSchedule(events, { ...o, header }).map((e) => Math.round(e.atMs))
    expect(at({ speed: 1, maxIdleMs: null })).toEqual([100, 1100, 1350]) // 3.4 s gap capped at the header's 1 s
    expect(at({ speed: 2, maxIdleMs: null })).toEqual([50, 550, 675])
    expect(at({ speed: 1, maxIdleMs: 200 })).toEqual([100, 300, 500])
    expect(at({ speed: 0, maxIdleMs: null })).toEqual([0, 0, 0])
    expect(castSchedule(events, { speed: 1, maxIdleMs: null }).map((e) => Math.round(e.atMs))).toEqual([100, 3500, 3750]) // no header: no cap
  })

  it('U-FAKE-20 · file operations write, append, modify, rename, delete and mkdir inside the cwd, and refuse to leave it', () => {
    const cwd = join(dir, 'repo')
    mkdirSync(cwd)
    const op = (o: Partial<Parameters<typeof applyFileOp>[1]> & { op: Parameters<typeof applyFileOp>[1]['op']; path: string }) =>
      applyFileOp(cwd, { to: null, content: null, find: null, replace: null, ...o })
    op({ op: 'write', path: 'src/a.txt', content: 'one\n' })
    op({ op: 'append', path: 'src/a.txt', content: 'two\n' })
    op({ op: 'modify', path: 'src/a.txt', find: 'one', replace: 'ONE' })
    expect(readFileSync(join(cwd, 'src/a.txt'), 'utf8')).toBe('ONE\ntwo\n')
    op({ op: 'rename', path: 'src/a.txt', to: 'lib/b.txt' })
    op({ op: 'mkdir', path: 'empty/dir' })
    expect(readdirSync(join(cwd, 'src'))).toEqual([])
    expect(readFileSync(join(cwd, 'lib/b.txt'), 'utf8')).toBe('ONE\ntwo\n')
    op({ op: 'delete', path: 'lib' })
    expect(readdirSync(cwd).sort()).toEqual(['empty', 'src'])
    expect(() => op({ op: 'modify', path: 'missing.txt', find: 'a', replace: 'b' })).toThrow(/ENOENT/)
    writeFileSync(join(cwd, 'x.txt'), 'abc')
    expect(() => op({ op: 'modify', path: 'x.txt', find: 'zzz', replace: 'b' })).toThrow(/not found/)
    expect(() => op({ op: 'write', path: '../outside.txt', content: 'x' })).toThrow(/inside the working directory/)
    expect(() => op({ op: 'delete', path: '/etc/hosts' })).toThrow(/relative/) // os-ok: test data
    expect(() => op({ op: 'delete', path: '.' })).toThrow(/inside the working directory/)
  })
})
