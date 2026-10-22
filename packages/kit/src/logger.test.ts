import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { L } from '@kea/protocol/limits'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLogger, createMemoryLogger, noopLogger } from './logger.ts'

let tmp: string

beforeAll(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'kea-kit-log-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function lines(path: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('createLogger', () => {
  it('U-MEM-15 · writes NDJSON {t, level, proc, msg, ...fields} to <dir>/<process>.log, filtered by level', () => {
    const dir = join(tmp, 'basic')
    const log = createLogger({ dir, process: 'core', level: 'info', now: () => Date.UTC(2026, 0, 2, 3, 4, 5) })
    log.debug('hidden')
    log.info('hello', { sessionId: 's1', msg: 'cannot override', n: 1n })
    log.child({ sessionId: 's2' }).error('failed', { err: Object.assign(new Error('boom'), { code: 'EBOOM' }) })
    log.dispose()
    log.info('after dispose')
    expect(log.path).toBe(join(dir, 'core.log'))
    expect(fs.statSync(log.path).mode & 0o777).toBe(0o600)
    const [a, b, ...rest] = lines(log.path)
    expect(rest).toEqual([])
    expect(a).toEqual({ t: '2026-01-02T03:04:05.000Z', level: 'info', proc: 'core', msg: 'hello', sessionId: 's1', n: '1' })
    expect(b).toMatchObject({ level: 'error', proc: 'core', msg: 'failed', sessionId: 's2', err: { name: 'Error', message: 'boom', code: 'EBOOM' } })
  })

  it('U-MEM-15 · rotates at maxBytes keeping L.logFilesKept files per process', () => {
    const dir = join(tmp, 'rotate')
    const maxBytes = 1000
    const log = createLogger({ dir, process: 'ptyhost', maxBytes })
    for (let i = 0; i < 400; i++) log.info('line', { i })
    log.dispose()
    const files = fs.readdirSync(dir).sort()
    const expected = ['ptyhost.log', ...Array.from({ length: L.logFilesKept - 1 }, (_, i) => `ptyhost.log.${i + 1}`)].sort()
    expect(files).toEqual(expected)
    for (const f of files) expect(fs.statSync(join(dir, f)).size).toBeLessThanOrEqual(maxBytes)
    // Newest in the live file, older in .1, .2, …
    const live = lines(join(dir, 'ptyhost.log'))
    const one = lines(join(dir, 'ptyhost.log.1'))
    expect(live.at(-1)?.i).toBe(399)
    expect(one.at(-1)?.i).toBe((live[0]?.i as number) - 1)
  })

  it('U-MEM-15 · never throws: failed writes (disk full) are dropped and counted, and logging resumes', () => {
    const dir = join(tmp, 'full')
    const log = createLogger({ dir, process: 'main' })
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    })
    expect(() => log.info('lost')).not.toThrow()
    expect(log.dropped).toBe(1)
    log.info('kept')
    log.info('x'.repeat(L.logFileMaxBytes)) // one line over the rotation size is dropped
    expect(log.dropped).toBe(2)
    log.dispose()
    expect(lines(log.path).map((l) => l.msg)).toEqual(['kept'])

    // An unusable directory (a file in the way): every write is dropped, none throws.
    const blocker = join(tmp, 'blocker')
    fs.writeFileSync(blocker, '')
    const broken = createLogger({ dir: join(blocker, 'logs'), process: 'core' })
    expect(() => broken.error('x', { circular: (() => { const o: Record<string, unknown> = {}; o.self = o; return o })() })).not.toThrow()
    expect(broken.dropped).toBe(1)
    broken.dispose()
  })
})

describe('memory and no-op loggers', () => {
  it('U-MEM-15 · the memory logger keeps the newest L.logMemoryEntries entries', () => {
    const log = createMemoryLogger({ process: 'core' })
    for (let i = 0; i < L.logMemoryEntries + 5; i++) log.debug('m', { i })
    expect(log.entries).toHaveLength(L.logMemoryEntries)
    expect(log.entries[0]?.i).toBe(5)
    log.child({ a: 1 }).warn('w')
    expect(log.entries.at(-1)).toMatchObject({ level: 'warn', proc: 'core', msg: 'w', a: 1 })
    log.clear()
    expect(log.entries).toEqual([])
    expect(noopLogger.child({}).info('x')).toBeUndefined()
  })
})
