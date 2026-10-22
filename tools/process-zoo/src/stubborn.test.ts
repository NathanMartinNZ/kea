import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseStubbornArgs } from './stubborn.ts'
import { alive, jsonLines, killAll, zoo } from './test-support.ts'

const dir = mkdtempSync(join(tmpdir(), 'zoo-stubborn-'))
afterAll(async () => {
  await killAll()
  rmSync(dir, { recursive: true, force: true })
})

interface Line {
  stubborn: 'ready' | 'signal'
  signal?: string
  pid: number
}

describe('process zoo: stubborn', () => {
  it('U-ZOO-10 · stubborn reports INT, TERM and HUP and keeps running until SIGKILL; --ignore narrows the set', async () => {
    const log = join(dir, 'log.jsonl')
    const s = zoo('stubborn', ['--log', log])
    await s.until((o) => jsonLines<Line>(o, 'stubborn').length === 1, 'ready')
    expect(jsonLines<Line>(s.out(), 'stubborn')[0]).toMatchObject({ stubborn: 'ready', pid: s.child.pid, ignoring: ['SIGINT', 'SIGTERM', 'SIGHUP'] })
    for (const [i, sig] of (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).entries()) {
      s.child.kill(sig)
      await s.until((o) => jsonLines<Line>(o, 'stubborn').length === i + 2, `the ${sig} report`)
    }
    expect(jsonLines<Line>(s.out(), 'stubborn').slice(1).map((l) => l.signal)).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP'])
    expect(alive(s.child.pid as number)).toBe(true)
    s.child.kill('SIGKILL')
    expect(await s.exited).toEqual({ code: null, signal: 'SIGKILL' })
    expect(readFileSync(log, 'utf8')).toBe(s.out()) // the same lines, for when the terminal is gone

    const termOnly = zoo('stubborn', ['--ignore', 'term'])
    await termOnly.until((o) => o.includes('"ready"'), 'ready')
    termOnly.child.kill('SIGINT')
    expect(await termOnly.exited).toEqual({ code: null, signal: 'SIGINT' })
    expect(() => parseStubbornArgs(['--ignore', 'KILL'])).toThrow(/uncatchable/)
    expect(parseStubbornArgs(['--ignore', 'SIGUSR1,usr1', '--lifetime', '0'])).toEqual({ ignore: ['SIGUSR1'], log: null, lifetimeSec: 0 })
  })
})
