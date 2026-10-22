import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { L } from '@kea/protocol/limits'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { HeldLimitError, POOL_LIMITS, PoolFullError, SpawnError, activeCount, heldCount, launchDetached, queuedCount, runHeld, runProcess } from './runProcess.ts'
import type { Pool, ProcessResult } from './runProcess.ts'

let tmp: string

beforeAll(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'kea-kit-run-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Wait (bounded, polling a condition — not a sleep) until `pid` no longer exists. */
async function waitGone(pid: number): Promise<void> {
  await vi.waitFor(() => expect(exists(pid)).toBe(false), { timeout: 5000, interval: 10 })
}

/** Zombie children of this (test) process, from `ps`. */
async function myZombies(): Promise<string[]> {
  const res = await runProcess('/bin/ps', ['-A', '-o', 'pid=,ppid=,stat='], { pool: 'other' })
  return (res.stdout?.toString() ?? '')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(([, ppid, stat]) => Number(ppid) === process.pid && (stat ?? '').startsWith('Z'))
    .map(([pid]) => pid as string)
}

/** Resolve when the child prints `marker` (lets a test act once the child is really running). */
function onMarker(marker: string): { onStdout: (c: Buffer) => void; seen: Promise<string> } {
  let buf = ''
  let resolve!: (s: string) => void
  const seen = new Promise<string>((r) => (resolve = r))
  return {
    seen,
    onStdout: (c) => {
      buf += c.toString()
      if (buf.includes(marker)) resolve(buf)
    },
  }
}

describe('runProcess', () => {
  it('U-MEM-11 · argv only: shell metacharacters are passed literally, nothing is interpreted', async () => {
    const args = ['$(touch pwned)', '`touch pwned2`', '; touch pwned3', '| cat', '*', '$HOME', "'quoted'", 'a b']
    const res = await runProcess('/usr/bin/printf', ['%s\\n', ...args], { pool: 'other', cwd: tmp }) // os-ok: in /usr/bin on both systems
    expect(res.code).toBe(0)
    expect(res.stdout?.toString()).toBe(args.map((a) => `${a}\n`).join(''))
    expect(fs.readdirSync(tmp)).toEqual([])
  })

  it('U-MEM-11 · resolves for non-zero exits with code and capped stderr; stdin and env pass through', async () => {
    const res = await runProcess('/bin/sh', ['-c', 'echo "err:$KEA_T" >&2; cat; exit 3'], {
      pool: 'other',
      env: { PATH: '/usr/bin:/bin', KEA_T: 'v' },
      stdin: 'from-stdin',
    })
    expect(res.code).toBe(3)
    expect(res.signal).toBeNull()
    expect(res.stderr).toBe('err:v\n')
    expect(res.stdout?.toString()).toBe('from-stdin')

    const big = await runProcess('/bin/sh', ['-c', `head -c ${L.processStderrMaxBytes * 4} /dev/zero | tr '\\0' e >&2`], { pool: 'other' })
    expect(big.code).toBe(0)
    expect(big.stderr.length).toBe(L.processStderrMaxBytes)
  })

  it('U-MEM-11 · timeout kills the whole process group: the child and its grandchild are both gone', async () => {
    const res = await runProcess('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { pool: 'other', timeoutMs: 300 })
    expect(res.timedOut).toBe(true)
    expect(res.cancelled).toBe(false)
    expect(res.code).toBeNull()
    expect(res.signal).toBe('SIGTERM')
    const grandchild = Number(res.stdout?.toString().trim())
    expect(grandchild).toBeGreaterThan(0)
    expect(exists(res.pid as number)).toBe(false) // the direct child is reaped by the time runProcess resolves
    await waitGone(grandchild)
  })

  it('U-MEM-11 · a group that ignores SIGTERM is SIGKILLed after L.processKillGraceMs', async () => {
    const res = await runProcess('/bin/sh', ['-c', 'trap "" TERM; sleep 30 & echo $!; wait'], { pool: 'other', timeoutMs: 100 })
    expect(res.timedOut).toBe(true)
    expect(res.signal).toBe('SIGKILL')
    expect(res.durationMs).toBeGreaterThanOrEqual(L.processKillGraceMs)
    await waitGone(Number(res.stdout?.toString().trim()))
  })

  it('U-MEM-11 · byte cap keeps exactly maxBytes, kills the process and marks the result truncated', async () => {
    const maxBytes = 1000
    const res = await runProcess('/usr/bin/yes', ['kea'], { pool: 'other', maxBytes }) // os-ok: in /usr/bin on both systems
    expect(res.truncated).toBe(true)
    expect(res.stdout?.length).toBe(maxBytes)
    expect(res.stdoutBytes).toBe(maxBytes)
    expect(res.signal).not.toBeNull()
    expect(exists(res.pid as number)).toBe(false)

    // Streaming: the parser sees exactly maxBytes and nothing is accumulated.
    let streamed = 0
    const s = await runProcess('/usr/bin/yes', ['kea'], { pool: 'other', maxBytes, onStdout: (c) => (streamed += c.length) }) // os-ok: in /usr/bin on both systems
    expect(streamed).toBe(maxBytes)
    expect(s.truncated).toBe(true)
    expect(s.stdout).toBeUndefined()

    // Default cap when collecting without one.
    const d = await runProcess('/usr/bin/yes', ['kea'], { pool: 'other' }) // os-ok: in /usr/bin on both systems
    expect(d.truncated).toBe(true)
    expect(d.stdout?.length).toBe(L.processStdoutMaxBytes)
  })

  it('U-MEM-11 · cancellation kills a running group; a request cancelled while queued never spawns', async () => {
    const ctrl = new AbortController()
    const m = onMarker('ready')
    const running = runProcess('/bin/sh', ['-c', 'sleep 30 & echo $!; echo ready; wait'], { pool: 'other', signal: ctrl.signal, onStdout: m.onStdout })
    const out = await m.seen
    ctrl.abort()
    const res = await running
    expect(res.cancelled).toBe(true)
    expect(res.timedOut).toBe(false)
    expect(res.signal).toBe('SIGTERM')
    await waitGone(Number(out.split('\n')[0]))

    // Fill the `ports` pool, queue one more, cancel it while queued.
    const blockerCtrl = new AbortController()
    const blockers = Array.from({ length: POOL_LIMITS.ports }, () =>
      runProcess('/bin/sleep', ['30'], { pool: 'ports', signal: blockerCtrl.signal }),
    )
    const queuedCtrl = new AbortController()
    const queued = runProcess('/bin/echo', ['never'], { pool: 'ports', signal: queuedCtrl.signal })
    await vi.waitFor(() => expect(queuedCount('ports')).toBe(1))
    expect(activeCount('ports')).toBe(POOL_LIMITS.ports)
    queuedCtrl.abort()
    const q = await queued
    expect(q).toMatchObject({ cancelled: true, pid: undefined, code: null })
    expect(queuedCount('ports')).toBe(0)
    blockerCtrl.abort()
    await Promise.all(blockers)
    expect(activeCount('ports')).toBe(0)

    // Already aborted: never spawns.
    const pre = await runProcess('/bin/echo', ['x'], { pool: 'other', signal: AbortSignal.abort() })
    expect(pre.cancelled).toBe(true)
    expect(pre.pid).toBeUndefined()
  })

  it('U-MEM-11 · pool limits are never exceeded under 100 concurrent requests; waiters are served FIFO; every child is reaped', async () => {
    const results: Array<Promise<ProcessResult>> = []
    const running: Record<Pool, number> = { git: 0, ports: 0, other: 0 }
    const maxRunning: Record<Pool, number> = { git: 0, ports: 0, other: 0 }
    const maxActive: Record<Pool, number> = { git: 0, ports: 0, other: 0 }
    const startOrder: Record<Pool, number[]> = { git: [], ports: [], other: [] }
    const pools: Pool[] = ['git', 'ports', 'other']

    for (let i = 0; i < 100; i++) {
      const pool = pools[i % pools.length] as Pool
      let started = false
      const p = runProcess('/bin/sh', ['-c', 'echo "$1"', 'sh', String(i)], {
        pool,
        onStdout: () => {
          maxActive[pool] = Math.max(maxActive[pool], activeCount(pool))
          if (started) return
          started = true
          startOrder[pool].push(i)
          running[pool]++
          maxRunning[pool] = Math.max(maxRunning[pool], running[pool])
        },
      }).then((r) => {
        if (started) running[pool]--
        return r
      })
      results.push(p)
    }
    for (const pool of pools) {
      expect(activeCount(pool)).toBe(POOL_LIMITS[pool])
      expect(queuedCount(pool)).toBeGreaterThan(0)
    }

    const done = await Promise.all(results)
    expect(done.every((r) => r.code === 0)).toBe(true)
    for (const pool of pools) {
      expect(maxRunning[pool]).toBeLessThanOrEqual(POOL_LIMITS[pool])
      expect(maxActive[pool]).toBeLessThanOrEqual(POOL_LIMITS[pool])
      expect(activeCount(pool)).toBe(0)
      expect(queuedCount(pool)).toBe(0)
    }
    // A pool of one runs its requests strictly in arrival order.
    expect(startOrder.ports).toEqual([...startOrder.ports].sort((a, b) => a - b))
    expect(startOrder.ports).toHaveLength(done.filter((_, i) => pools[i % pools.length] === 'ports').length)

    for (const r of done) expect(exists(r.pid as number)).toBe(false)
    expect(await myZombies()).toEqual([])
  })

  it('U-MEM-11 · spawn failures reject with a typed SpawnError and release the pool slot', async () => {
    const missing = runProcess(join(tmp, 'no-such-binary'), [], { pool: 'git' })
    await expect(missing).rejects.toBeInstanceOf(SpawnError)
    await expect(missing).rejects.toMatchObject({ code: 'ENOENT', reason: 'not-found' })
    await expect(runProcess('/bin/echo', [], { pool: 'git', cwd: join(tmp, 'no-such-dir') })).rejects.toMatchObject({ reason: 'cwd-missing' })
    fs.writeFileSync(join(tmp, 'not-exec'), 'x', { mode: 0o644 })
    await expect(runProcess(join(tmp, 'not-exec'), [], { pool: 'git' })).rejects.toMatchObject({ reason: 'permission' })
    fs.rmSync(join(tmp, 'not-exec'))
    expect(activeCount('git')).toBe(0)
    await expect(runProcess('/bin/echo', ['a', 1 as unknown as string], { pool: 'git' })).rejects.toBeInstanceOf(TypeError)
  })

  it('U-MEM-11 · a throwing stdout parser kills the child and rejects with its error', async () => {
    const res = runProcess('/usr/bin/yes', [], { // os-ok: in /usr/bin on both systems
      pool: 'other',
      onStdout: () => {
        throw new Error('parser blew up')
      },
    })
    await expect(res).rejects.toThrow('parser blew up')
    expect(activeCount('other')).toBe(0)
  })

  it('U-MEM-11 · a pool queue beyond L.poolQueueMax is refused with PoolFullError', async () => {
    const ctrl = new AbortController()
    const blockers = Array.from({ length: POOL_LIMITS.ports }, () => runProcess('/bin/sleep', ['30'], { pool: 'ports', signal: ctrl.signal }))
    const waiting = Array.from({ length: L.poolQueueMax }, () => runProcess('/bin/echo', [], { pool: 'ports', signal: ctrl.signal }))
    await vi.waitFor(() => expect(queuedCount('ports')).toBe(L.poolQueueMax))
    await expect(runProcess('/bin/echo', [], { pool: 'ports' })).rejects.toBeInstanceOf(PoolFullError)
    ctrl.abort()
    const all = await Promise.all([...blockers, ...waiting])
    expect(all.every((r) => r.cancelled)).toBe(true)
    expect(all.filter((r) => r.pid !== undefined)).toHaveLength(POOL_LIMITS.ports)
    expect(queuedCount('ports')).toBe(0)
  })

  it('U-MEM-11 · runHeld: stdin stays open until closeStdin(), so EOF tells the child its parent is gone; the child is reaped', async () => {
    let close!: () => void
    let pid = 0
    const marker = onMarker('ready')
    // the child reports, then waits for EOF on stdin and says so
    const done = runHeld('/bin/sh', ['-c', 'echo ready; cat >/dev/null; echo eof'], {
      onStdout: marker.onStdout,
      collect: true,
      onSpawn: (c) => {
        pid = c.pid
        close = c.closeStdin
      },
    })
    await marker.seen
    expect(heldCount()).toBe(1)
    expect(exists(pid)).toBe(true) // still waiting on stdin: nothing closed it
    close()
    const r = await done
    expect(r.code).toBe(0)
    expect(r.stdout?.toString()).toBe('ready\neof\n')
    expect(heldCount()).toBe(0)
    expect(exists(pid)).toBe(false)
  })

  it('U-MEM-11 · runHeld: at most L.heldChildrenMax at once, one more is refused at once; a spawn failure frees its place', async () => {
    await expect(runHeld(join(tmp, 'no-such-binary'), [], { onSpawn: () => {} })).rejects.toBeInstanceOf(SpawnError)
    expect(heldCount()).toBe(0)
    const closers: (() => void)[] = []
    const running = Array.from({ length: L.heldChildrenMax }, () => runHeld('/bin/cat', [], { onSpawn: (c) => closers.push(c.closeStdin) }))
    expect(heldCount()).toBe(L.heldChildrenMax)
    await expect(runHeld('/bin/cat', [], { onSpawn: () => {} })).rejects.toBeInstanceOf(HeldLimitError)
    await vi.waitFor(() => expect(closers).toHaveLength(L.heldChildrenMax))
    for (const c of closers) c()
    const all = await Promise.all(running)
    expect(all.every((r) => r.code === 0)).toBe(true)
    expect(heldCount()).toBe(0)
    expect(await myZombies()).toEqual([])
  })

  it('U-PLT-24 · launchDetached: an app the person keeps is started in a process group of its own with no pipes, resolves once it runs, and is neither killed nor waited for; it is reaped when it exits; a program that is not there rejects with SpawnError; the pool slot is held only while it starts', async () => {
    const started = join(tmp, 'detached-started')
    const stop = join(tmp, 'detached-stop')
    const script = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, String(process.pid)); console.log('to nowhere'); setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) process.exit(0) }, 20)`
    const { pid } = await launchDetached(process.execPath, ['-e', script], { pool: 'other', cwd: tmp })
    expect(activeCount('other')).toBe(0)
    await vi.waitFor(() => expect(fs.readFileSync(started, 'utf8')).toBe(String(pid)), { timeout: 5000, interval: 10 })
    // a group of its own (it was started in a session of its own): a signal to the group reaches it alone
    expect(exists(-pid)).toBe(true)
    expect(exists(pid), 'still running: nothing waits for it or kills it').toBe(true)
    fs.writeFileSync(stop, '')
    await waitGone(pid)
    expect(await myZombies()).toEqual([])
    await expect(launchDetached(join(tmp, 'no-such-app'), ['--working-directory', tmp], { pool: 'other' })).rejects.toMatchObject({ name: 'SpawnError', reason: 'not-found' })
    expect(activeCount('other')).toBe(0)
  })
})
