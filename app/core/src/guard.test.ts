import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLogger, Emitter, Supervisor, type SupervisedChild } from '@kea/kit'
import { L } from '@kea/protocol'
import { installCoreGuard } from './guard.ts'

afterEach(() => {
  vi.useRealTimers()
})

/** A stand-in for core's process: the guard on its own `process` events, and an `exit` that ends it. */
function fakeCore() {
  const proc = new EventEmitter()
  const log = createMemoryLogger({ process: 'core' })
  const exits = new Emitter<number>()
  const codes: { code: number; logged: string[] }[] = []
  installCoreGuard(proc, log, (code) => {
    codes.push({ code, logged: log.entries.map((e) => e.msg) })
    exits.fire(code)
  })
  return { proc, log, exits, codes }
}

describe('core exception guard', () => {
  it('U-FAIL-3 · an uncaught exception or an unhandled rejection is logged with its stack, then core exits 1', () => {
    const a = fakeCore()
    a.proc.emit('uncaughtException', new Error('boom'))
    expect(a.codes).toEqual([{ code: 1, logged: ['uncaught exception'] }])
    expect(a.log.entries[0]).toMatchObject({ level: 'error', msg: 'uncaught exception' })
    expect(String(a.log.entries[0]?.error)).toContain('Error: boom')

    const b = fakeCore()
    b.proc.emit('unhandledRejection', 'not an error')
    expect(b.codes).toEqual([{ code: 1, logged: ['unhandled rejection'] }])
    expect(b.log.entries[0]?.error).toBe('not an error')
  })

  it('U-FAIL-3 · under main’s Supervisor, a core that throws is replaced: it exits 1 and a new core starts after the backoff', () => {
    vi.useFakeTimers()
    const cores: ReturnType<typeof fakeCore>[] = []
    const sup = new Supervisor({
      name: 'core',
      heartbeat: false,
      spawn: (): SupervisedChild => {
        const c = fakeCore()
        cores.push(c)
        return {
          pid: cores.length,
          kill: () => c.exits.fire(137),
          ping: () => undefined,
          onPong: () => ({ dispose: () => undefined }),
          onExit: (cb) => c.exits.event(cb),
        }
      },
    })
    sup.start()
    expect(cores).toHaveLength(1)
    cores[0]?.proc.emit('uncaughtException', new TypeError('x is undefined'))
    expect(cores[0]?.codes.map((c) => c.code)).toEqual([1])
    vi.advanceTimersByTime(L.supervisorBackoffMinMs)
    expect(cores, 'a new core after the restart backoff').toHaveLength(2)
    cores[1]?.proc.emit('unhandledRejection', new Error('lost promise'))
    vi.advanceTimersByTime(L.supervisorBackoffMinMs * 2)
    expect(cores, 'and again after an unhandled rejection').toHaveLength(3)
    expect(sup.restarts).toBe(2)
    void sup.stop()
  })
})
