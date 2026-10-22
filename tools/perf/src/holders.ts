// Cleanup for harness runs: kill exactly the holders (and their children) that a run spawned under its own KEA_HOME,
// and nothing else. A state file names a pid; the pid is trusted only while the process started when the file says, so
// a reused pid is never signalled. Processes are read with `kea-helper procs` (procs.ts), on both systems.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { kitOs } from '../../../packages/kit/src/os/index.ts'
import { isAvailable, need } from '../../../packages/protocol/src/platform.ts'
import { procRow } from './procs.ts'

type HolderState = { pid?: number; pidStartTime?: number; pidStartTicks?: number; childPid?: number; exited?: boolean }

const US_PER_S = 1_000_000

/** Start time of `pid` in whole seconds since the epoch, or null if it is gone. */
export function startSeconds(pid: number): number | null {
  const r = procRow(pid)
  return r ? Math.floor(r.startUs / US_PER_S) : null
}

export function parentPid(pid: number): number | null {
  return procRow(pid)?.ppid ?? null
}

/**
 * The holder recorded in `state` is still that process: same pid, the start the holder wrote (its raw ticks where it
 * and `procs` both have them, as on Linux; else µs, to the second), and started as `name` (`argv[0]`, what
 * `ps` named it; kea-helper, or a test's stand-in).
 */
export function isSameHolder(state: HolderState, name = 'kea-helper'): boolean {
  if (!state.pid || !state.pidStartTime) return false
  const now = procRow(state.pid)
  if (!now) return false
  const started =
    state.pidStartTicks !== undefined && now.startTicks !== null
      ? now.startTicks === state.pidStartTicks
      : Math.abs(Math.floor(now.startUs / US_PER_S) - Math.floor(state.pidStartTime / US_PER_S)) <= 1
  return started && path.basename(now.argv[0] ?? now.exe ?? '') === name
}

export type KillReport = { killed: number[]; skipped: { pid: number; why: string }[] }

/**
 * Prefixes of every harness's temporary KEA_HOME: the suites' (tests/support, `kea-test-`), the survival check's
 * (survival.ts, `kea-s7-`) and this package's own tests' (`kea-perf-test-`).
 */
export const HARNESS_HOME_PREFIXES = ['kea-test-', 'kea-s7-', 'kea-perf-test-'] as const

const realOr = (p: string) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/**
 * A cleanup signals and deletes what lives under `home`, so it refuses anything but a harness's own temporary home: a
 * directory directly in the temp directory (or /tmp) whose name starts with a harness prefix. ~/.kea, ~/.kea-dev and
 * every other path fail: a harness never touches the user's own Kea data.
 */
export function assertHarnessHome(home: string): void {
  const roots = new Set([os.tmpdir(), '/tmp'].map(realOr))
  const abs = path.resolve(home)
  const name = path.basename(abs)
  if (!path.isAbsolute(home) || !roots.has(realOr(path.dirname(abs))) || !HARNESS_HOME_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length))
    throw new Error(`refusing to clean up ${home}: not a harness's temporary KEA_HOME (${HARNESS_HOME_PREFIXES.join(', ')}* in ${[...roots].join(' or ')})`)
}

/** SIGKILL every live holder whose state file is under `home/sessions`, and its child if the child is still its own. */
export function killOwnHolders(home: string, o: { name?: string } = {}): KillReport {
  assertHarnessHome(home)
  const report: KillReport = { killed: [], skipped: [] }
  const dir = path.join(home, 'sessions')
  if (!fs.existsSync(dir)) return report
  for (const s of fs.readdirSync(dir)) {
    for (const f of fs.readdirSync(path.join(dir, s))) {
      if (!f.endsWith('.json')) continue
      let j: HolderState
      try {
        j = JSON.parse(fs.readFileSync(path.join(dir, s, f), 'utf8')) as HolderState
      } catch {
        continue // partial file
      }
      if (!j.pid) continue
      if (!isSameHolder(j, o.name)) {
        report.skipped.push({ pid: j.pid, why: 'not running, or the pid now belongs to another process' })
        continue
      }
      // The child first, and only while it is still the holder's own child.
      if (j.childPid && !j.exited && parentPid(j.childPid) === j.pid) kill(j.childPid, report)
      kill(j.pid, report)
    }
  }
  return report
}

function kill(pid: number, report: KillReport): void {
  try {
    process.kill(pid, 'SIGKILL')
    report.killed.push(pid)
  } catch {
    report.skipped.push({ pid, why: 'gone before the signal' })
  }
}

/** Chromium's userData directory for a run with this KEA_HOME (the naming in app/main/src/main.ts). */
export function userDataDir(home: string, packaged: boolean): string {
  let h = 0x811c9dc5
  for (let i = 0; i < home.length; i++) h = Math.imul(h ^ home.charCodeAt(i), 0x01000193) >>> 0
  // Electron's appData: on macOS the account's home folder's, whatever HOME says; on Linux the run's own HOME's
  // (launch.ts `harnessUserHome`: a launch leaves XDG_CONFIG_HOME out, `launchEnv`)
  const env = { HOME: path.join(home, 'user-home') }
  return need(kitOs.paths).appData({ accountHome: os.userInfo().homedir, env }, `${packaged ? 'Kea' : 'Kea-dev'}-${h.toString(16)}`)
}

/** `userDataDir`, or null where the OS layer has no data folder (macOS and Linux both have one). */
export function userDataDirIfKnown(home: string, packaged: boolean): string | null {
  return isAvailable(kitOs.paths) ? userDataDir(home, packaged) : null
}
