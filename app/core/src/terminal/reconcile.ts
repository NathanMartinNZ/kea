// Launch reconciliation as a pure function: core's records + ptyhost's holder list + what is on disk
// (holders.ts) → what to change. Terminals applies the plan. It runs whenever the control port connects (at launch and
// after core or ptyhost restarts), so it never signals, releases or otherwise disturbs a live holder; its only effects
// on disk are removing sockets of dead holders and, for the `shells` pseudo-session, the state files of PTYs that have
// neither a record nor a holder.
//
//   holder listed, record running, same session  → attached (record refreshed from the holder)
//   holder listed, no record                     → orphan "noRecord" (Adopt as shell / Terminate); after a lost
//                                                  records store, adopted instead (the records rebuilt)
//   holder listed, record ended, child exited    → attached, then released (it lingers until released; the
//                                                  exit note ended the record first, ptyhost having adopted it sooner)
//   holder listed, record ended, child running   → orphan "recordEnded" (Terminate). Never from an exit that came
//                                                  while this run read the list and the disk: Terminals lays every
//                                                  exit note of that time over the list first (U-PTY-66)
//   holder listed, record of another session     → never attached: orphan "sessionMismatch"; the record ends (lost)
//   holder listed, state file foreign            → never attached and never acted on; a running record ends (lost)
//   record running, no holder listed:
//     holder process alive (same session)        → unreachable: record kept, not attached (ptyhost may adopt it later)
//     holder process gone, or no state file      → record ended: exited (its state file has the exit) or lost;
//                                                  an agent PTY's session becomes detached
//     liveness unknown (`ps` failed)             → nothing decided
//   no record, holder process alive, not listed  → orphan, unreachable (Terminate by pid, identity checked)

import type { OrphanInfo, PtyInfo, PtyState } from '@kea/protocol'
import type { HolderEntry, HolderJson, HolderScan } from './holders.ts'
import type { TerminalRecord } from './records.ts'

/** The pseudo-session of shell tabs that belong to no session (the `shells` pane); their state files live under it. */
export const SHELLS_SESSION = 'shells'

const US_PER_MS = 1_000

export interface ReconcileInput {
  records: readonly TerminalRecord[]
  /** Ptyhost's `pty.list`. */
  holders: readonly PtyInfo[]
  /** What is on disk; null when core has no KEA_HOME to look in (unit tests). */
  scan: HolderScan | null
  /** PTYs being spawned right now: left alone. */
  spawning: ReadonlySet<string>
  /**
   * The records store had nothing to load: every listed, trusted holder gets a record. A function decides per session
   * (the database's sessions are rebuilt before reconciliation).
   */
  rebuild: boolean | ((sessionId: string) => boolean)
  now: number
}

export interface ReconcilePlan {
  /** Records to write, changed or new. */
  put: TerminalRecord[]
  /** PTYs whose record and holder agree: shown and attachable. */
  attached: string[]
  /** Running records whose holder process is alive but not connected to ptyhost (refused or too slow). */
  unreachable: string[]
  orphans: OrphanInfo[]
  /** Records this run marked exited or lost. */
  ended: TerminalRecord[]
  /** Sessions whose agent PTY ended here: they become `detached` (core's `detachSessions`). */
  detachedSessions: string[]
  /** Run-directory sockets of holders known to be dead. */
  staleSockets: string[]
  /** Shells pseudo-session: files of PTYs with neither a record nor a holder. */
  deadFiles: { sessionId: string; ptyId: string; files: string[] }[]
  /** What was never trusted, and why. */
  ignored: { ptyId: string; why: string }[]
  /** Attached PTYs whose record had already ended: their holders linger until released, which they now are. */
  release: string[]
}

export const startedAtMs = (j: HolderJson): number => Math.floor(j.pidStartTime / US_PER_MS)

function orphanFromHolder(h: PtyInfo, reason: OrphanInfo['reason'], canAdopt: boolean): OrphanInfo {
  return {
    ptyId: h.ptyId,
    sessionId: h.sessionId,
    kind: h.kind,
    argv: h.argv,
    cwd: h.cwd,
    holderPid: h.holderPid,
    holderStartedAt: h.holderStartedAt,
    state: h.state,
    reason,
    reachable: true,
    canAdopt,
  }
}

function orphanFromState(j: HolderJson, reason: OrphanInfo['reason']): OrphanInfo {
  return {
    ptyId: j.ptyId,
    sessionId: j.sessionId,
    kind: j.kind,
    argv: j.argv,
    cwd: j.cwd,
    holderPid: j.pid,
    holderStartedAt: startedAtMs(j),
    state: j.exited ? 'exited' : 'running',
    reason,
    reachable: false,
    canAdopt: false,
  }
}

/** A record for a holder found without one (rebuild, or "Adopt as shell"). */
export function recordFromHolder(h: PtyInfo, json: HolderJson | null, now: number, over: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    ptyId: h.ptyId,
    sessionId: h.sessionId,
    kind: h.kind,
    argv: h.argv,
    cwd: h.cwd,
    title: h.title,
    holderPid: h.holderPid,
    holderStartedAt: json ? startedAtMs(json) : h.holderStartedAt,
    childPid: h.childPid,
    cols: h.cols,
    rows: h.rows,
    state: h.state,
    exitCode: h.exitCode,
    exitSignal: h.exitSignal,
    tabOrder: 0,
    createdAt: now,
    endedAt: h.state === 'running' ? null : now,
    ...over,
  }
}

export function planReconcile(i: ReconcileInput): ReconcilePlan {
  const plan: ReconcilePlan = { put: [], attached: [], unreachable: [], orphans: [], ended: [], detachedSessions: [], staleSockets: [], deadFiles: [], ignored: [], release: [] }
  const records = new Map(i.records.map((r) => [r.ptyId, r]))
  const holders = new Map(i.holders.map((h) => [h.ptyId, h]))
  const disk = i.scan?.entries ?? new Map<string, HolderEntry>()

  const end = (r: TerminalRecord, state: Exclude<PtyState, 'running'>, exitCode: number | null = null, exitSignal: number | null = null) => {
    const next = { ...r, state, exitCode, exitSignal, endedAt: i.now }
    plan.put.push(next)
    plan.ended.push(next)
  }

  for (const id of [...new Set([...records.keys(), ...holders.keys(), ...disk.keys()])].sort()) {
    if (i.spawning.has(id)) continue
    const r = records.get(id)
    const h = holders.get(id)
    const e = disk.get(id)
    const json = e?.identity === 'trusted' ? e.json : null
    if (e?.identity === 'foreign') plan.ignored.push({ ptyId: id, why: e.why ?? 'untrusted state file' })

    if (h) {
      if (e?.identity === 'foreign') {
        if (r?.state === 'running') end(r, 'lost')
      } else if (r && r.state === 'running' && r.sessionId === h.sessionId) {
        plan.attached.push(id)
        const next: TerminalRecord = {
          ...r,
          holderPid: h.holderPid,
          holderStartedAt: json ? startedAtMs(json) : (r.holderStartedAt ?? h.holderStartedAt),
          childPid: h.childPid,
          cols: h.cols,
          rows: h.rows,
          title: h.title ?? r.title,
        }
        if (h.state !== 'running') end(next, h.state, h.exitCode, h.exitSignal)
        else if (JSON.stringify(next) !== JSON.stringify(r)) plan.put.push(next)
      } else if (r && r.sessionId !== h.sessionId) {
        if (r.state === 'running') end(r, 'lost')
        plan.orphans.push(orphanFromHolder(h, 'sessionMismatch', false))
      } else if (r && h.state !== 'running') {
        // its own session's ended PTY (an exit note got here before this): nothing to show the user, only to let go
        plan.attached.push(id)
        plan.release.push(id)
      } else if (r) {
        plan.orphans.push(orphanFromHolder(h, 'recordEnded', false))
      } else if (typeof i.rebuild === 'function' ? i.rebuild(h.sessionId) : i.rebuild) {
        plan.put.push(recordFromHolder(h, json, i.now))
        plan.attached.push(id)
      } else {
        plan.orphans.push(orphanFromHolder(h, 'noRecord', true))
      }
      continue
    }

    const alive = json ? e!.alive : null
    if (r?.state === 'running') {
      if (alive === true && json!.sessionId === r.sessionId) plan.unreachable.push(id)
      else if (alive === true) {
        end(r, 'lost')
        plan.orphans.push(orphanFromState(json!, 'sessionMismatch'))
      } else if (alive === false || !json) {
        if (json?.exited) end(r, 'exited', json.exitCode, json.exitSignal)
        else end(r, 'lost')
      }
      // alive === null with a trusted state file: `ps` failed, decide next time
    } else if (alive === true) {
      plan.orphans.push(orphanFromState(json!, r ? 'recordEnded' : 'noRecord'))
    }

    if (e?.socket && i.scan?.socketsKnown && alive === false) plan.staleSockets.push(id)
    else if (e?.socket && e.identity === 'missing') plan.ignored.push({ ptyId: id, why: 'socket without a state file' })

    const dead = (e?.identity === 'missing' && !e.socket) || alive === false
    if (!r && e && dead) {
      for (const d of e.dirs) if (d.sessionId === SHELLS_SESSION) plan.deadFiles.push({ sessionId: d.sessionId, ptyId: id, files: d.files })
    }
  }

  plan.detachedSessions = [...new Set(plan.ended.filter((r) => r.kind === 'agent').map((r) => r.sessionId))]
  return plan
}
