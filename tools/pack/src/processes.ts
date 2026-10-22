// The process table as `pnpm kea:install` reads it: a read-only look with `kea-helper procs --args`, this user's
// processes. Each row carries what identifies a process for good: its pid, when it started and the executable it runs.
// A pid alone is never trusted (pids are reused), so anything that signals a process looks it up again first
// (`sameProcess`).

import { execFileSync } from 'node:child_process'
import { parseProcs, type ProcRow } from '../../../packages/protocol/src/procs.ts'

export interface Proc {
  pid: number
  ppid: number
  /** Start time, whole seconds since the epoch. */
  start: number
  /** The path it was started by (`argv[0]`, what `ps -o comm` printed), else its executable file. */
  comm: string
  /** The command line, its words joined by spaces (as `ps -o args` printed it). */
  args: string
  /** The executable file, or null when it cannot be read (a set-uid or a sandboxed process on Linux). */
  exe: string | null
}

const US_PER_S = 1_000_000

/** Table rows from `kea-helper procs --args` rows; a process with neither arguments nor an executable (a zombie) is left out. */
export function tableOf(rows: readonly ProcRow[]): Proc[] {
  return rows.flatMap((r) => {
    const comm = r.argv[0] ?? r.exe
    return comm === null ? [] : [{ pid: r.pid, ppid: r.ppid, start: Math.floor(r.startUs / US_PER_S), comm, args: r.argv.join(' '), exe: r.exe }]
  })
}

const PROCS_MAX_BYTES = 64 * 1024 * 1024 // a full listing with every argument

/** Every process of this user, as it is now, listed by `helper` (the build's own release kea-helper). */
export function processTable(helper: string): Proc[] {
  return tableOf(parseProcs(execFileSync(helper, ['procs', '--args'], { encoding: 'utf8', env: {}, maxBuffer: PROCS_MAX_BYTES, stdio: ['ignore', 'pipe', 'ignore'] })))
}

/** `now` is the process `known` was: same pid, same start second, same executable. */
export function sameProcess(known: Pick<Proc, 'pid' | 'start' | 'comm'>, now: Proc | undefined): boolean {
  return !!now && now.pid === known.pid && now.start === known.start && now.comm === known.comm
}

/** Every process below `pid` in `table`: children, grandchildren and so on. */
export function descendantsOf(pid: number, table: readonly Proc[]): Proc[] {
  const byParent = new Map<number, Proc[]>()
  for (const p of table) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p])
  const out: Proc[] = []
  const seen = new Set<number>([pid])
  const queue = [pid]
  while (queue.length) {
    for (const c of byParent.get(queue.shift() as number) ?? []) {
      if (seen.has(c.pid)) continue
      seen.add(c.pid)
      out.push(c)
      queue.push(c.pid)
    }
  }
  return out
}
