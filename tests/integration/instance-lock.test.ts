// The instance lock on Linux (`instanceLock`): a `flock` on `<KEA_HOME>/run/<name>.lock`, in a run directory
// that is the user's alone, held for the process's life. macOS's lock is tested in packages/kit/src/flock.test.ts, as
// is the lock's behaviour inside one process on both systems.
import fs from 'node:fs'
import path from 'node:path'
import { runProcess, tryLock } from '@kea/kit'
import { afterEach, describe, expect, it } from 'vitest'
import { kitOs } from '../../packages/kit/src/os/index.ts'
import { tempKeaHome } from '../support/helpers.ts'

const CHILD = path.join(import.meta.dirname, 'instance-lock-child.ts')
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c()
})

/** Runs the stand-in for `name` in `home`; `held` resolves with its pid and its own child's once it holds the lock. */
function start(home: string, name: string): { held: Promise<{ pid: number; child: number }>; done: ReturnType<typeof runProcess> } {
  let held!: (pids: { pid: number; child: number }) => void
  const pids = new Promise<{ pid: number; child: number }>((r) => (held = r))
  const done = runProcess(process.execPath, [CHILD, home, name], {
    pool: 'other',
    timeoutMs: 60_000,
    collect: true, // the second's `locked` line is read from its result
    onStdout: (c) => {
      const m = /held (\d+) (\d+)/.exec(c.toString('utf8'))
      if (m) held({ pid: Number(m[1]), child: Number(m[2]) })
    },
  })
  return { held: pids, done }
}

describe('the instance lock on Linux', () => {
  // Two cores for one home: the second says `locked` and exits 3 while the first holds it; this process cannot take it
  // either, while another lock of the home (ptyhost's) and the same lock of another home can; a child the first started
  // does not hold it (the descriptor is close-on-exec), so once the first is SIGKILLed the lock is free; the lock file
  // stays, empty, and the next holder takes the same file. A run directory open to other users is refused.
  it.runIf(kitOs.system === 'linux')('I-PLT-4 · a second core for the same home exits; the lock is free after SIGKILL of the first, not kept by its child; the lock file stays and is reused; a run directory that is not the user’s alone is refused', async () => {
    const [a, b] = [await tempKeaHome(), await tempKeaHome()]
    cleanup.push(a.dispose, b.dispose)
    const first = start(a.home, 'core')
    const { pid, child } = await first.held
    let ended = false
    void first.done.then(() => (ended = true))
    cleanup.push(async () => {
      // the test's own children, still running when an expectation below failed
      if (!ended) process.kill(pid, 'SIGKILL')
      await first.done
      try {
        process.kill(child, 'SIGKILL')
      } catch {
        // gone already
      }
    })
    const lockPath = path.join(a.home, 'run', 'core.lock')
    const file = fs.statSync(lockPath)
    expect([file.mode & 0o777, file.size, fs.statSync(path.dirname(lockPath)).mode & 0o777]).toEqual([0o600, 0, 0o700])
    const second = await start(a.home, 'core').done
    expect([second.code, second.stdout?.toString('utf8')]).toEqual([3, 'locked\n'])
    expect(tryLock(lockPath), 'this process cannot take it either').toBeNull()
    for (const other of [path.join(a.home, 'run', 'ptyhost.lock'), path.join(b.home, 'run', 'core.lock')]) {
      const l = tryLock(other)
      expect(l, other).not.toBeNull()
      l!.dispose()
    }
    process.kill(pid, 'SIGKILL') // the test's own child
    expect((await first.done).signal).toBe('SIGKILL')
    expect(() => process.kill(child, 0), 'its child lives on').not.toThrow()
    const mine = tryLock(lockPath)
    expect(mine, 'free after SIGKILL, though the child lives').not.toBeNull()
    expect(fs.statSync(lockPath).ino, 'the same file, kept').toBe(file.ino)
    expect(fs.statSync(lockPath).size).toBe(0)
    mine!.dispose()
    expect(fs.readdirSync(path.join(a.home, 'run')).sort()).toEqual(['core.lock', 'ptyhost.lock'])

    // a run directory other users can reach: refused, nothing made in it
    const c = await tempKeaHome()
    cleanup.push(c.dispose)
    fs.mkdirSync(path.join(c.home, 'run'))
    fs.chmodSync(path.join(c.home, 'run'), 0o755)
    const refused = await start(c.home, 'core').done
    expect(refused.code, refused.stderr).not.toBe(0)
    expect(refused.stderr).toMatch(/is accessible to other users \(mode 755\)/)
    expect(fs.readdirSync(path.join(c.home, 'run'))).toEqual([])
  })
})
