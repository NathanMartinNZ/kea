// The session lifecycle as a kit/Fsm table: the code runs this table, and the exhaustive state × event test is
// generated from it. Lifecycle is driven only by Kea's own actions and the agent PTY; agent events never change it.
// Discard of a failed creation and the purge after the retention remove the row and are not transitions.
//
// Below the table: what `⌘Q`, the menu-bar item and the Dock badge need from the sessions, pushed to main by
// `watchMenuBar`: `needsYou` is status's attention set, an account condition counted once.

import { createFsm, type Fsm, type FsmDef } from '@kea/kit'
import {
  attentionOrder,
  conditionLabel,
  heldSessions,
  L,
  LIFECYCLE,
  type AccountCondition,
  type KeyedStore,
  type Lifecycle,
  type MenuBarSession,
  type MenuBarState,
  type PtyInfo,
  type SessionView,
} from '@kea/protocol'

export type LifecycleEvent =
  /** The agent PTY was spawned (creation's last step, Resume, Restart). */
  | { t: 'launched' }
  /** A creation step failed, or Kea quit while creating (Retry / Discard). */
  | { t: 'failed' }
  /** Retry of a failed creation. */
  | { t: 'retry' }
  /** The agent PTY exited, was stopped or its holder was lost. */
  | { t: 'agentEnded' }
  | { t: 'archive' }
  | { t: 'unarchive' }
  | { t: 'delete' }
  | { t: 'restore' }

export const LIFECYCLE_EVENTS = ['launched', 'failed', 'retry', 'agentEnded', 'archive', 'unarchive', 'delete', 'restore'] as const satisfies readonly LifecycleEvent['t'][]

export const LIFECYCLE_TABLE: FsmDef<Lifecycle, LifecycleEvent, undefined> = {
  initial: 'creating',
  transitions: {
    creating: { launched: () => 'live', failed: () => 'create_failed' },
    create_failed: { retry: () => 'creating' },
    live: { agentEnded: () => 'detached', archive: () => 'archived', delete: () => 'deleted' },
    detached: { launched: () => 'live', archive: () => 'archived', delete: () => 'deleted' },
    archived: { unarchive: () => 'detached', delete: () => 'deleted' },
    deleted: { restore: () => 'detached' },
  },
}

/** The lifecycle a session moves to on `ev`, or null when the table refuses it (the call fails with `wrong_state`). */
export function nextLifecycle(from: Lifecycle, ev: LifecycleEvent['t']): Lifecycle | null {
  const fsm: Fsm<Lifecycle, LifecycleEvent, undefined> = createFsm(LIFECYCLE_TABLE, { state: from })
  const r = fsm.send({ t: ev } as LifecycleEvent)
  return r.handled ? r.to : null
}

export { LIFECYCLE }

// ── what ⌘Q and the menu-bar item need ─────────────────────────────────────────────────────────────────────────────

/** Why a session needs you, as the menu-bar item's line says it: its attention item's kind, else what happened. */
export function needsYouReason(v: SessionView): string {
  const item = v.attention[0]
  if (item) return item.kind
  if (v.lifecycle === 'live') return v.phase === 'failed' ? 'failed' : v.phase === 'ready' ? 'finished' : v.phase === 'blocked' ? 'question' : v.phase
  return v.endReason ?? 'ended'
}

/**
 * The sessions the menu-bar item lists as needing you, and their count. First the attention set in its order (blocked,
 * then failed and crashed or lost, then unread ready; `attentionOrder`), each with its glyph and why (`permission`,
 * `question`, `failed`, `crashed`, `lost`, `finished`). Then one line per account condition holding sessions: the
 * agent's name and `limited` / `signed out` / `billing`, and a click shows its oldest session. The count is the
 * badge's: a condition counts once.
 */
export function needsYou(views: Iterable<SessionView>, conditions: Iterable<AccountCondition> = [], agentName: (agent: string) => string = (a) => a): { count: number; sessions: MenuBarSession[] } {
  const listed = [...views].filter((v) => v.lifecycle !== 'deleted' && v.lifecycle !== 'archived')
  const conds = [...conditions]
  // a session failed on an account-level kind is the condition's line while one holds it, its own line after
  const sessions: MenuBarSession[] = attentionOrder(listed, heldSessions(conds)).map((v) => ({ id: v.id, title: v.title, reason: needsYouReason(v), glyph: v.glyph }))
  for (const c of conds) {
    const first = c.sessionIds[0]
    if (first === undefined) continue
    sessions.push({ id: first, title: agentName(c.agent), reason: conditionLabel(c.kind), glyph: 'limited' })
  }
  return { count: sessions.length, sessions }
}

/** The sessions with an agent live or being created: what the menu-bar item and the Dock badge count. */
export function keptRunning(views: Iterable<SessionView>): number {
  let n = 0
  for (const v of views) if (v.lifecycle === 'live' || v.lifecycle === 'creating') n++
  return n
}

/** The terminals still running, of any session and of the shell tabs: what a quit has to stop. */
export function runningTerminals(terminals: Iterable<Pick<PtyInfo, 'state'>>): number {
  let n = 0
  for (const t of terminals) if (t.state === 'running') n++
  return n
}

export function menuBarState(
  views: Iterable<SessionView>,
  onQuit: MenuBarState['onQuit'],
  o: { conditions?: Iterable<AccountCondition>; agentName?: (agent: string) => string; badge?: boolean; terminals?: Iterable<Pick<PtyInfo, 'state'>> } = {},
): MenuBarState {
  const list = [...views]
  return { live: keptRunning(list), running: runningTerminals(o.terminals ?? []), onQuit, ...needsYou(list, o.conditions ?? [], o.agentName), badge: o.badge ?? true }
}

/**
 * Tell main the menu-bar state now and whenever it changes: a change in the `sessions` store, the `status.conditions`
 * store or the settings is sent at most once per store tick, and only when the state differs from the last one sent.
 */
export function watchMenuBar(o: {
  sessions: KeyedStore<SessionView>
  /** Account conditions: one line and one count each. */
  conditions?: KeyedStore<AccountCondition>
  /** The `terminals` store: a terminal starting or ending changes `running`. */
  terminals?: KeyedStore<PtyInfo>
  agentName?(agent: string): string
  onQuit(): MenuBarState['onQuit']
  /** `notifications.dockBadge`; default on. */
  badge?(): boolean
  onSettings(cb: () => void): () => void
  send(s: MenuBarState): void
}): { dispose(): void } {
  let last = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    const s = menuBarState(o.sessions.values(), o.onQuit(), {
      ...(o.conditions ? { conditions: o.conditions.values() } : {}),
      ...(o.terminals ? { terminals: o.terminals.values() } : {}),
      ...(o.agentName ? { agentName: (a: string) => o.agentName!(a) } : {}),
      badge: o.badge ? o.badge() : true,
    })
    const key = JSON.stringify(s)
    if (key === last) return
    last = key
    o.send(s)
  }
  const schedule = () => {
    if (timer) return
    timer = setTimeout(flush, L.storeTickMs)
    timer.unref?.()
  }
  const offStore = o.sessions.onDelta(schedule)
  const offConditions = o.conditions?.onDelta(schedule) ?? (() => undefined)
  const offTerminals = o.terminals?.onDelta(schedule) ?? (() => undefined)
  const offSettings = o.onSettings(schedule)
  flush()
  return {
    dispose() {
      offStore()
      offConditions()
      offTerminals()
      offSettings()
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
