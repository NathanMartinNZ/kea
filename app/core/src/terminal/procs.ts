// Is a holder process still alive (C-COR-6)? A pid alone is never trusted: pids are reused. A holder counts
// as alive only while a process with its state file's pid exists, started when the state file records (on Linux
// the raw start in clock ticks, `pidStartTicks`, exactly; otherwise `pidStartTime`, to the second), and runs
// the `kea-helper` executable. One `kea-helper procs` run answers for every pid, on both systems.
// Where `/proc` hides the user's own non-dumpable holders (`hidepid`), a pid it does not list but that still
// exists (`kill(pid, 0)`) cannot be told: it is not taken as gone, and ptyhost's connect to its socket settles it.

import path from 'node:path'
import { holdersHidden, runProcess } from '@kea/kit'
import { L, parseProcs } from '@kea/protocol'

export interface ProcessInfo {
  pid: number
  /** Start time, whole seconds since the epoch. */
  startSec: number
  /** Linux: the raw start, clock ticks since boot; null where `procs` prints none. */
  startTicks: number | null
  /** The path it was started by (`argv[0]`, what `ps -o comm` printed), else its executable file. */
  command: string
  /** Not listed, yet the pid exists: `/proc` hides it (`hidepid`), so nothing else is known of it. */
  hidden?: true
}

/** Facts about the given pids; a pid that is not running is absent. Throws when it cannot tell. */
export type ProcessProbe = (pids: readonly number[]) => Promise<Map<number, ProcessInfo>>

/** The executable every holder runs. */
export const HELPER_EXECUTABLE = 'kea-helper'

const US_PER_S = 1_000_000

/** Pids worth asking about: positive, and never 0 or init (1). */
export function probeable(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1
}

/**
 * The real probe: one `<helper> procs <pid…>` run through `kit/runProcess`, for the probeable pids. Without a helper
 * (`null`: a core started without the one Kea ships) only an empty question has an answer; any pid cannot be told, so
 * nothing is judged by it.
 */
export function procsProbe(helper: string | null, hidden: () => string | null = holdersHidden, exists: (pid: number) => boolean = pidExists): ProcessProbe {
  return async (pids) => {
    const list = [...new Set(pids.filter(probeable))]
    if (list.length === 0) return new Map()
    if (!helper) throw new Error('no kea-helper to list the processes with')
    const res = await runProcess(helper, ['procs', ...list.map(String)], { pool: 'other', env: {}, timeoutMs: L.processProbeTimeoutMs })
    if (res.timedOut || res.cancelled || res.truncated || res.code !== 0) throw new Error(`kea-helper procs did not answer: ${res.stderr.trim() || `exit ${res.code}`}`)
    const info = new Map<number, ProcessInfo>()
    for (const r of parseProcs(res.stdout?.toString('utf8') ?? '')) {
      info.set(r.pid, { pid: r.pid, startSec: Math.floor(r.startUs / US_PER_S), startTicks: r.startTicks, command: r.argv[0] ?? r.exe ?? '' })
    }
    if (hidden() !== null) {
      for (const pid of list) if (!info.has(pid) && exists(pid)) info.set(pid, { pid, startSec: 0, startTicks: null, command: '', hidden: true })
    }
    return info
  }
}

/** Does a process with this pid exist (`kill(pid, 0)`: EPERM is another user's, which exists too)? */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The fields of a holder's state file that identify its process (`pidStartTicks` only where the OS records it). */
export interface HolderIdentity {
  pid: number
  pidStartTime: number
  pidStartTicks?: number | null
}

/**
 * The holder a state file names is this very process: same pid, the same start (the raw ticks when both sides have
 * them, so a stepped wall clock does not matter; else the same second), the helper executable.
 */
export function isHolderProcess(state: HolderIdentity, info: ProcessInfo | undefined): boolean {
  if (!info || info.hidden || info.pid !== state.pid) return false
  const ticks = state.pidStartTicks ?? null
  const sameStart = ticks !== null && info.startTicks !== null ? info.startTicks === ticks : info.startSec === Math.floor(state.pidStartTime / US_PER_S)
  return sameStart && path.basename(info.command) === HELPER_EXECUTABLE
}

/** A holder's liveness: as `isHolderProcess` says, or null when `/proc` hides the process. */
export function holderAlive(state: HolderIdentity, info: ProcessInfo | undefined): boolean | null {
  return info?.hidden ? null : isHolderProcess(state, info)
}
