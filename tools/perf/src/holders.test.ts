import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fnv1a64, runDir } from '../../../packages/kit/src/rundir.ts'
import { kitOs } from '../../../packages/kit/src/os/index.ts'
import { L } from '../../../packages/protocol/src/generated/limits.ts'
import { assertHarnessHome, isSameHolder, killOwnHolders, startSeconds } from './holders.ts'
import { cleanupRun } from './launch.ts'
import { procRow } from './procs.ts'

const procs: ChildProcess[] = []
const dirs: string[] = []
const grandchildren: number[] = []
afterEach(() => {
  for (const pid of grandchildren.splice(0))
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  for (const p of procs.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL')
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null || p.signalCode !== null ? r() : p.once('exit', () => r())))

/** A stand-in holder: a shell with one child, which prints the child's pid. */
async function fakeHolder(): Promise<{ holder: ChildProcess; childPid: number }> {
  const holder = spawn('/bin/sh', ['-c', '/bin/sleep 60 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] })
  procs.push(holder)
  const line = await new Promise<string>((r) => holder.stdout!.once('data', (b: Buffer) => r(b.toString())))
  const childPid = Number(line.trim())
  grandchildren.push(childPid)
  return { holder, childPid }
}

function home(states: Record<string, unknown>[]): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-perf-test-'))
  dirs.push(h)
  const s = path.join(h, 'sessions', 'shell')
  fs.mkdirSync(s, { recursive: true })
  states.forEach((j, i) => fs.writeFileSync(path.join(s, `p${i}.json`), JSON.stringify(j)))
  return h
}

describe('perf harness cleanup', () => {
  it('U-PERF-1 · a pid is trusted only with the start time its holder recorded', () => {
    const now = startSeconds(process.pid)
    expect(now).not.toBeNull()
    expect(Math.abs(now! - Math.floor(Date.now() / 1000 - process.uptime()))).toBeLessThanOrEqual(2)
    const me = path.basename(process.execPath)
    expect(isSameHolder({ pid: process.pid, pidStartTime: now! * 1e6 }, me)).toBe(true)
    expect(isSameHolder({ pid: process.pid, pidStartTime: now! * 1e6 })).toBe(false) // not a kea-helper
    expect(isSameHolder({ pid: process.pid, pidStartTime: (now! - 3600) * 1e6 }, me)).toBe(false)
    expect(isSameHolder({ pid: process.pid }, me)).toBe(false)
    // where the holder and procs both have the raw start ticks (Linux), they decide, not the second
    const ticks = procRow(process.pid)!.startTicks
    if (ticks !== null) {
      expect(isSameHolder({ pid: process.pid, pidStartTime: now! * 1e6, pidStartTicks: ticks }, me)).toBe(true)
      expect(isSameHolder({ pid: process.pid, pidStartTime: now! * 1e6, pidStartTicks: ticks + 1 }, me)).toBe(false)
    }
  })

  it('U-PERF-1 · kills its own holders and their children, never a reused pid or a child that is not the holder’s', async () => {
    const own = await fakeHolder()
    const reused = await fakeHolder()
    const strangerHolder = await fakeHolder()
    const t = (p: number) => startSeconds(p)! * 1e6
    const h = home([
      { pid: own.holder.pid, pidStartTime: t(own.holder.pid!), childPid: own.childPid },
      // the pid now belongs to a process that started an hour later than the file says
      { pid: reused.holder.pid, pidStartTime: t(reused.holder.pid!) - 3600e6, childPid: reused.childPid },
      // a live holder (the test's) whose recorded child pid is now another process's child
      { pid: strangerHolder.holder.pid, pidStartTime: t(strangerHolder.holder.pid!), childPid: reused.childPid },
    ])
    const r = killOwnHolders(h, { name: 'sh' })
    await exited(own.holder)
    expect(r.killed).toContain(own.holder.pid)
    expect(r.killed).toContain(own.childPid)
    expect(r.killed).not.toContain(reused.holder.pid)
    expect(r.killed).not.toContain(reused.childPid)
    expect(reused.holder.exitCode).toBeNull()
    expect(() => process.kill(reused.childPid, 0)).not.toThrow()
    expect(r.skipped.map((s) => s.pid)).toContain(reused.holder.pid)
    expect(r.killed).toContain(strangerHolder.holder.pid)
    expect(r.killed).not.toContain(strangerHolder.childPid) // not named in its state file
  })

  it('U-PERF-6 · cleanup refuses every home but a harness’s own temporary one: ~/.kea, ~/.kea-dev, a relative path, an unprefixed or nested temp path', () => {
    const tmp = fs.realpathSync(os.tmpdir())
    // the real homes are only ever given to the check itself, never to a cleanup
    const refused = [
      path.join(os.homedir(), '.kea'),
      path.join(os.homedir(), '.kea-dev'),
      os.homedir(),
      '/',
      'kea-test-relative',
      path.join(tmp, 'kea-other-x'),
      path.join(tmp, 'kea-test-'),
      path.join(tmp, 'kea-test-x', 'kea-test-nested'),
      path.join(tmp, '..', 'kea-test-up'),
      path.join(os.homedir(), 'kea-test-x'),
    ]
    for (const h of refused) expect(() => assertHarnessHome(h), h).toThrow(/refusing to clean up/)
    for (const h of [path.join(tmp, 'kea-test-app-abc-XYZ'), path.join(os.tmpdir(), 'kea-s7-x'), '/tmp/kea-test-abc', path.join(tmp, 'kea-perf-test-q')]) expect(() => assertHarnessHome(h), h).not.toThrow()
    // both cleanups check before touching anything: an unprefixed temp directory of this test's own survives them
    const other = fs.mkdtempSync(path.join(tmp, 'kea-perf-unprefixed-'))
    dirs.push(other)
    fs.mkdirSync(path.join(other, 'sessions', 'shell'), { recursive: true })
    expect(() => killOwnHolders(other)).toThrow(/refusing to clean up/)
    expect(() => cleanupRun(other)).toThrow(/refusing to clean up/)
    expect(fs.existsSync(path.join(other, 'sessions', 'shell')), 'nothing removed').toBe(true)
  })

  it('U-PERF-9 · a run whose home is too long for its sockets leaves no socket folder behind: cleanup removes the home’s own folder under /tmp/kea-<uid> (or the user’s runtime folder’s kea/) without being told of it, and neither that shared folder nor another home’s folder in it; a home whose sockets fit has none', () => {
    const tmp = fs.realpathSync(os.tmpdir())
    const longHome = (): string => {
      // too long for its sockets whatever the temp folder (macOS's is long, Linux's /tmp short)
      const h = fs.mkdtempSync(path.join(tmp, `kea-perf-test-${'x'.repeat(L.socketPathMaxBytes)}-`))
      dirs.push(h)
      return h
    }
    const [mine, other] = [longHome(), longHome()]
    const [a, b] = [runDir(mine), runDir(other)]
    const shared = path.dirname(a)
    // macOS: the shared folder under /tmp; Linux: the user's runtime folder's kea/ when there is one
    expect(a).toMatch(kitOs.system === 'darwin' ? /^\/tmp\/kea-\d+\/[0-9a-f]{16}$/ : /^(?:\/tmp\/kea-\d+|\/.+\/kea)\/[0-9a-f]{16}$/)
    expect(path.basename(a)).toBe(fnv1a64(mine))
    expect(b).not.toBe(a)
    const sharedWasThere = fs.existsSync(shared)
    try {
      for (const d of [a, b]) {
        fs.mkdirSync(d, { recursive: true, mode: 0o700 })
        dirs.push(d)
        // what a killed holder leaves: its socket's name (a plain file here; nothing listens)
        fs.writeFileSync(path.join(d, 'p0.sock'), '')
      }
      // found from the home alone: a caller that names no socket folder (the update chaos tests, the survival check)
      // leaves none behind
      const r = cleanupRun(mine)
      expect(r.removed).toEqual([mine, a])
      expect(fs.existsSync(a)).toBe(false)
      expect(fs.existsSync(path.join(b, 'p0.sock')), 'another home’s sockets').toBe(true)
      expect(fs.existsSync(shared), 'the shared folder itself').toBe(true)
      // named as well (tests/support/app.ts does): removed once, reported once
      fs.mkdirSync(mine)
      fs.mkdirSync(a, { mode: 0o700 })
      expect(cleanupRun(mine, { dirs: [a] }).removed).toEqual([mine, a])

      const short = home([])
      expect(runDir(short)).toBe(path.join(short, 'run'))
      expect(cleanupRun(short).removed).toEqual([short])
    } finally {
      for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true })
      // a machine that had no shared folder gets none from this test (never removed when it was there, or holds anything)
      if (!sharedWasThere) {
        try {
          fs.rmdirSync(shared)
        } catch (e) {
          // gone already, or another run uses it now: not the test's to remove
          const code = (e as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw e
        }
      }
    }
  })
})
