import { describe, expect, it } from 'vitest'
import { RepoMutex } from './mutex.ts'

/** A promise and the functions that settle it. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('the per-repository worktree mutex', () => {
  it('U-WT-11 · operations on one repository run one at a time in the order asked, a failure does not stop the next, other repositories run alongside; the entry goes when the queue drains', async () => {
    const m = new RepoMutex()
    const log: string[] = []
    const gates = [deferred(), deferred(), deferred()]
    const op = (name: string, gate: Promise<void>) => async () => {
      log.push(`start ${name}`)
      await gate
      log.push(`end ${name}`)
      return name
    }
    const first = m.run('/repo/a/.git', op('a1', gates[0]!.promise))
    const second = m.run('/repo/a/.git', op('a2', gates[1]!.promise))
    const other = m.run('/repo/b/.git', op('b1', Promise.resolve()))
    expect(m.size).toBe(2)
    expect(await other).toBe('b1')
    await Promise.resolve()
    expect(log).toEqual(['start a1', 'start b1', 'end b1'])

    gates[0]!.reject(new Error('git worktree add failed'))
    await expect(first).rejects.toThrow('git worktree add failed')
    const third = m.run('/repo/a/.git', op('a3', gates[2]!.promise))
    await new Promise((r) => setImmediate(r))
    expect(log.slice(3), 'a2 starts after a1 failed; a3 waits for a2').toEqual(['start a2'])
    gates[1]!.resolve()
    gates[2]!.resolve()
    expect(await second).toBe('a2')
    expect(await third).toBe('a3')
    expect(log.slice(3)).toEqual(['start a2', 'end a2', 'start a3', 'end a3'])
    await new Promise((r) => setImmediate(r))
    expect(m.size, 'bounded: drained queues leave nothing behind').toBe(0)
  })
})
