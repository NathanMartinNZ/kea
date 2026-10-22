// Account conditions: a usage limit, signed out, a billing problem belong to the account, not the session. One per
// agent, held here, persisted in `kv` as `condition:<agent>`, and shown to the window as the `status.conditions` store
// (one footer line each).
//
//   join       a session's `turn.failed` with an account-level kind opens the agent's condition, or joins it
//                      (N4, updated in place as sessions join); the session still enters `failed`
//   reset      a usage limit with a known reset time moves to `reset` at it (N5): the footer offers Continue all.
//                      Checked against the wall clock at least every L.conditionCheckMs, so a sleep cannot delay it.
//                      One whose sessions all moved on (left) before its reset ends at it, with no N5
//   clear      any `turn.finished` of that agent ends it; a `reset` one also ends on Continue all, or when its
//                      last session leaves `failed`
//   restart    restored from `kv` and re-evaluated against the sessions' reconciled state

import type { Logger } from '@kea/kit'
import { CONDITIONS_STORE, KeyedStore, L, RpcError, zAccountCondition, type AccountCondition, type AccountKind } from '@kea/protocol'
import { kvDelete, kvSet, type KeaDb } from '../platform/db/db.ts'
import type { StatusNotice } from './notices.ts'

const KEY_PREFIX = 'condition:'

export interface ConditionsOptions {
  db: KeaDb
  log: Logger
  /** Wall clock (ms). */
  now: () => number
  notify(n: StatusNotice): void
}

export class Conditions {
  /** `status.conditions`: AccountCondition by agent (bounded: one per adapter). */
  readonly store = new KeyedStore<AccountCondition>(CONDITIONS_STORE)
  private readonly o: ConditionsOptions
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(o: ConditionsOptions) {
    this.o = o
  }

  /**
   * Restore the conditions `kv` holds. `held(sessionId, kind)`: the session is live and `failed` with that kind
   * (its reconciled state); the others leave. A condition that reset while Kea was away posts N5 on the next turn.
   */
  load(held: (sessionId: string, kind: AccountKind) => boolean): void {
    for (const r of this.o.db.all<{ key: string; value: string }>(`SELECT key, value FROM kv WHERE key LIKE '${KEY_PREFIX}%'`)) {
      let c: AccountCondition
      try {
        c = zAccountCondition.parse(JSON.parse(r.value))
      } catch (e) {
        this.o.log.warn('account condition unreadable; dropped', { key: r.key, error: String(e) })
        kvDelete(this.o.db, r.key)
        continue
      }
      const next = { ...c, sessionIds: c.sessionIds.filter((id) => held(id, c.kind)) }
      if (next.state === 'reset' && next.sessionIds.length === 0) {
        kvDelete(this.o.db, r.key)
        continue
      }
      this.put(next)
    }
    // the first check runs on the next turn, not now: whoever listens for N5 subscribes after construction
    this.schedule(0)
  }

  get(agent: string): AccountCondition | undefined {
    return this.store.get(agent)
  }

  /** The condition holding a session, if any. */
  holding(sessionId: string): AccountCondition | undefined {
    for (const c of this.store.values()) if (c.sessionIds.includes(sessionId)) return c
    return undefined
  }

  /** Open or join the agent's condition. `silent`: no N4 (an unconfirmed or reconciled status). */
  join(agent: string, sessionId: string, kind: AccountKind, resetsAt: number | null, at: number, silent = false): void {
    const cur = this.store.get(agent)
    const open = !cur || cur.state === 'reset'
    const base: AccountCondition = open ? { agent, kind, state: 'active', since: at, resetsAt: null, sessionIds: cur?.sessionIds ?? [] } : cur
    const next: AccountCondition = {
      ...base,
      kind,
      // a newer reset time (or the first one) wins; a failure without one keeps what is known
      resetsAt: kind === 'rate_limit' ? (resetsAt ?? (base.kind === 'rate_limit' ? base.resetsAt : null)) : null,
      sessionIds: base.sessionIds.includes(sessionId) ? base.sessionIds : [...base.sessionIds, sessionId],
    }
    if (!open && JSON.stringify(next) === JSON.stringify(cur)) return
    this.put(next)
    this.checkResets()
    if (!silent) this.o.notify({ k: 'N4', condition: next })
  }

  /** A turn of the agent finished — its condition ends. */
  clear(agent: string): void {
    if (!this.store.has(agent)) return
    this.remove(agent)
  }

  /** A session is no longer held (a new turn, detached, deleted): it leaves its condition; a `reset` one with no sessions left ends. */
  leave(sessionId: string): void {
    const c = this.holding(sessionId)
    if (!c) return
    const next = { ...c, sessionIds: c.sessionIds.filter((id) => id !== sessionId) }
    if (next.state === 'reset' && next.sessionIds.length === 0) this.remove(c.agent)
    else this.put(next)
  }

  /** Continue all: the sessions to continue; the condition ends. Once it has reset, on the click. */
  continueAll(agent: string): string[] {
    const c = this.store.get(agent)
    if (!c) throw new RpcError('not_found', `no account condition for ${agent}`)
    if (c.state !== 'reset') throw new RpcError('wrong_state', 'Continue all is offered once the limit has reset')
    this.remove(agent)
    return c.sessionIds
  }

  /** Move usage limits whose reset time has passed to `reset` (N5; one no session holds any more ends), and schedule the next check. */
  checkResets(): void {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const now = this.o.now()
    let next = Number.POSITIVE_INFINITY
    for (const c of [...this.store.values()]) {
      if (c.state !== 'active' || c.resetsAt === null) continue
      if (c.resetsAt <= now) {
        const r: AccountCondition = { ...c, state: 'reset' }
        // every session moved on before the reset: nothing is left to continue, so it ends without N5
        if (r.sessionIds.length === 0) {
          this.remove(c.agent)
          continue
        }
        this.put(r)
        this.o.notify({ k: 'N5', condition: r })
      } else next = Math.min(next, c.resetsAt)
    }
    if (Number.isFinite(next)) this.schedule(next - now)
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.checkResets(), Math.max(0, Math.min(ms, L.conditionCheckMs)))
  }

  /** The `core.status` gauge's row: conditions held, reset checks scheduled. */
  get resourceCounts(): { conditions: number; conditionTimers: number } {
    return { conditions: this.store.size, conditionTimers: this.timer ? 1 : 0 }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.store.dispose()
  }

  private put(c: AccountCondition): void {
    kvSet(this.o.db, KEY_PREFIX + c.agent, JSON.stringify(c))
    this.store.set(c.agent, c)
  }

  private remove(agent: string): void {
    kvDelete(this.o.db, KEY_PREFIX + agent)
    this.store.delete(agent)
  }
}
