// The notification policy (`status/` decides, `main` shows): the status engine's notices (N1…N5 and their withdrawals,
// notices.ts) in, what main posts and withdraws out, one live notification per tag.
//
//   viewed  a session's notice is dropped while the window views that session (the engine's `viewingId`); with
//           `notifications.onlyWhenUnfocused` (the default) while any Kea window has focus. The trust question is
//           posted only while no window has focus, whatever the setting
//   merging one live notification per session (tag `s:<id>`: a new one replaces it); N2 only for a turn of at least
//           L.notifyMinTurnMs, as the engine measured it on the hooks' monotonic clock; when L.notifyBurstCount sessions
//           or more post within L.notifyBurstMs, the ones posted are withdrawn and one "N sessions need you" stands for
//           them (tag `burst`), counting the ones that join while the burst lasts
//   retract withdrawn when the reason goes: the engine's `withdraw` (an attention item answered — only that item's
//           notification —, the session viewed, the agent ended, a finished turn that goes on), a condition that clears, a
//           session deleted or archived; a hook item that replaces the status file's item for the same prompt takes over its
//           notification (`rekey`: one prompt, one N1)
//   sound   the alert sound only for N1, and only when `notifications.sound` is on
//   kinds   per kind: N1 `notifications.needsYou`, N2 `notifications.finished`, N3, N4 and N5 `notifications.failed`
//   N4, N5  one per account condition (tag `c:<agent>`), updated in place as sessions join, then the reset (N5)
//   summary after a relaunch, the sessions that came to need you while Kea was closed (restored statuses, drained
//           spools and the launch reconcile notify nothing) get one summary at most, once startup has settled: of
//           the sessions core started with, those that need you then but did not at the start, were not notified since,
//           and are not the one the window views
//   texts   title `<session> · needs permission`, subtitle the project, body the tool and its one-line summary,
//           the last message or the error kind: one line each, control characters removed, cut at L.notifyBodyMaxChars
//           on a grapheme boundary. Never file contents: an item's summary is the adapter's one-line input summary, and
//           only its first line is used. A permission item's key is its tool and that summary (`Bash: npm test`), shown
//           as it is; one raised without a tool shows its summary
//   TTL     a notification is forgotten L.notificationTtlMs after it was posted, on the monotonic clock: a sleep or a
//           wall-clock jump expires nothing early. One timer, while any is live

import type { Disposable } from '@kea/kit'
import { attentionOrder, clockTime, heldSessions, L, type AccountCondition, type AttentionItem, type KeyedStore, type NotificationOp, type SessionView } from '@kea/protocol'
import type { StatusNotice } from './notices.ts'

/** The `notifications.*` settings the policy reads. */
export interface NotifySettings {
  needsYou: boolean
  finished: boolean
  failed: boolean
  sound: boolean
  onlyWhenUnfocused: boolean
}

export interface NotificationPolicyOptions {
  /** The engine's notices (`StatusEngine.notices.event`). */
  notices: (cb: (n: StatusNotice) => void) => Disposable
  /** Core's `sessions` store: titles, projects, lifecycles. */
  sessions: KeyedStore<SessionView>
  /** The `status.conditions` store: a condition that clears withdraws its notification. */
  conditions: KeyedStore<AccountCondition>
  projectName(projectId: string): string | null
  /** An agent's display name (the adapter's): `Claude Code`. */
  agentName(agent: string): string
  settings(): NotifySettings
  /** The session the window views, or null. */
  viewing(): string | null
  /** How a session's agent PTY ended (N3's `exited 1`), when known. */
  exitOf?(sessionId: string): { code: number | null; signal: number | null } | null
  /** Monotonic ms (bursts, the time-to-live). Default `performance.now`. */
  mono?: () => number
  /** To main (core's `notify` message). */
  out(op: NotificationOp): void
}

type Live = { sessionId: string | null; key: string | null; at: number }

const BURST_TAG = 'burst'
const SUMMARY_TAG = 'summary'
export const sessionTag = (id: string) => `s:${id}`
export const conditionTag = (agent: string) => `c:${agent}`

/** C0 and C1 control characters and DEL, which a title or a message may carry from an agent (data). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g

/** One line: control characters and line breaks become single spaces. */
export function oneLine(s: string): string {
  return s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** At most `max` UTF-16 units, cut between graphemes (an emoji or an accented letter is never split), with `…` when cut. */
export function clip(s: string, max: number = L.notifyBodyMaxChars): string {
  if (s.length <= max) return s
  let out = ''
  for (const { segment } of graphemes.segment(s)) {
    if (out.length + segment.length > max - 1) break
    out += segment
  }
  return `${out.trimEnd()}…`
}

/** A notice's body: one line, cut at L.notifyBodyMaxChars. */
const body = (s: string) => clip(oneLine(s))

export class NotificationPolicy {
  private readonly o: NotificationPolicyOptions
  private readonly mono: () => number
  // bounded: one per tag — a session's (≤ the sessions store), an account condition's (≤ one per adapter), the burst's and
  // the summary's; each forgotten after L.notificationTtlMs
  private readonly live = new Map<string, Live>()
  // bounded: the sessions that posted within L.notifyBurstMs (≤ the sessions store), pruned at each post
  private readonly recent = new Map<string, number>()
  // bounded: the sessions one burst stands for (≤ the sessions store); gone with the burst
  private burst: { sessions: Set<string>; lastAt: number } | null = null
  private focused = false
  private ttlTimer: ReturnType<typeof setTimeout> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * The sessions core started with, those of them that needed you then, and the sessions notified since; null
   * once startup has settled (bounded: each ≤ the sessions store)
   */
  private startup: { known: Set<string>; before: Set<string>; notified: Set<string> } | null
  private readonly offs: (() => void)[] = []
  private disposed = false

  constructor(o: NotificationPolicyOptions) {
    this.o = o
    this.mono = o.mono ?? (() => performance.now())
    this.startup = { known: new Set([...o.sessions.values()].map((v) => v.id)), before: this.needing(), notified: new Set() }
    const sub = o.notices((n) => this.onNotice(n))
    this.offs.push(() => sub.dispose())
    this.offs.push(
      o.sessions.onDelta((d) => {
        for (const id of d.del ?? []) this.withdrawSession(id)
        for (const [id, v] of Object.entries(d.set ?? {})) if (v.lifecycle === 'archived' || v.lifecycle === 'deleted') this.withdrawSession(id)
      }),
    )
    this.offs.push(
      o.conditions.onDelta((d) => {
        for (const agent of d.del ?? []) this.withdraw(conditionTag(agent))
      }),
    )
  }

  /** Whether a Kea window has keyboard focus (main tells core). */
  setAppFocused(focused: boolean): void {
    this.focused = focused
  }

  get appFocused(): boolean {
    return this.focused
  }

  /**
   * Once `started` resolves (core's startup work) and L.unconfirmedStatusMs more have passed (every restored
   * status confirmed), post one summary of the sessions that came to need you while Kea was closed, if any.
   */
  settleAfter(started: Promise<unknown>): void {
    void started.then(
      () => this.armStartup(),
      () => this.armStartup(),
    )
  }

  /** The tags live now (tests, the resource report). */
  liveTags(): string[] {
    return [...this.live.keys()]
  }

  /** The `core.notifications` gauge. */
  get resourceCounts(): { live: number; recent: number; burst: number; timers: number } {
    return { live: this.live.size, recent: this.recent.size, burst: this.burst?.sessions.size ?? 0, timers: (this.ttlTimer ? 1 : 0) + (this.startupTimer ? 1 : 0) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.offs.splice(0)) off()
    if (this.ttlTimer) clearTimeout(this.ttlTimer)
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.ttlTimer = null
    this.startupTimer = null
    this.live.clear()
    this.recent.clear()
    this.burst = null
    this.startup = null
  }

  // ── notices ───────────────────────────────────────────────────────────────────────────────

  private onNotice(n: StatusNotice): void {
    if (this.disposed) return
    switch (n.k) {
      case 'withdraw':
        this.withdrawSession(n.sessionId, n.keys)
        return
      case 'rekey':
        this.rekey(n.sessionId, n.from, n.to)
        return
      case 'N4':
      case 'N5':
        this.condition(n.k, n.condition)
        return
      default:
        this.sessionNotice(n)
    }
  }

  private sessionNotice(n: Extract<StatusNotice, { k: 'N1' | 'N2' | 'N3' }>): void {
    const s = this.o.settings()
    const v = this.o.sessions.get(n.sessionId)
    if (!v) return
    // each kind has its own setting
    if ((n.k === 'N1' && !s.needsYou) || (n.k === 'N2' && !s.finished) || (n.k === 'N3' && !s.failed)) return
    // A short turn finishing is not news
    if (n.k === 'N2' && n.turnMs !== null && n.turnMs < L.notifyMinTurnMs) return
    // not while the window views the session; the trust question only while unfocused
    if (this.o.viewing() === n.sessionId) return
    if (this.focused && (s.onlyWhenUnfocused || (n.k === 'N1' && n.trust))) return
    const title = oneLine(v.title) || 'Session'
    let text: { title: string; body: string }
    let key: string | null = null
    if (n.k === 'N1') {
      key = n.item.key
      text = { title: `${title} · ${n.item.kind === 'permission' ? 'needs permission' : 'has a question'}`, body: body(itemText(n.item)) }
    } else if (n.k === 'N2') {
      const msg = n.lastMessage ? body(n.lastMessage) : ''
      const bg = n.background ? '(background tasks still running)' : ''
      text = { title: `${title} · finished`, body: [msg, bg].filter(Boolean).join('\n') }
    } else text = { title: `${title} · failed`, body: body(this.failure(n.sessionId, n.reason)) }
    this.startup?.notified.add(n.sessionId)
    const post: NotificationOp = { op: 'post', tag: sessionTag(n.sessionId), sessionId: n.sessionId, title: text.title, subtitle: oneLine(this.o.projectName(v.projectId) ?? ''), body: text.body, sound: n.k === 'N1' && s.sound }
    this.postSession(n.sessionId, key, post)
  }

  /** Posted at once, unless it makes (or joins) a burst. */
  private postSession(sessionId: string, key: string | null, op: Extract<NotificationOp, { op: 'post' }>): void {
    const now = this.mono()
    for (const [id, at] of this.recent) if (now - at > L.notifyBurstMs) this.recent.delete(id)
    this.recent.set(sessionId, now)
    if (this.burst && now - this.burst.lastAt > L.notifyBurstMs) this.burst = null
    if (this.burst) {
      this.burst.sessions.add(sessionId)
      this.burst.lastAt = now
      this.withdraw(sessionTag(sessionId))
      this.postBurst(op.sound)
      return
    }
    if (this.recent.size >= L.notifyBurstCount) {
      this.burst = { sessions: new Set(this.recent.keys()), lastAt: now }
      for (const id of this.burst.sessions) this.withdraw(sessionTag(id))
      this.postBurst(op.sound)
      return
    }
    this.post(op, { sessionId, key })
  }

  private postBurst(sound: boolean): void {
    const b = this.burst!
    const titles = [...b.sessions].map((id) => oneLine(this.o.sessions.get(id)?.title ?? '')).filter(Boolean)
    this.post({ op: 'post', tag: BURST_TAG, sessionId: null, title: `${b.sessions.size} sessions need you`, subtitle: '', body: body(titles.join(', ')), sound }, { sessionId: null, key: null })
  }

  /** N4 (opened, or a session joined: the same notification, updated) and N5 (the limit reset), one per agent. */
  private condition(k: 'N4' | 'N5', c: AccountCondition): void {
    const s = this.o.settings()
    if (!s.failed) return
    if (this.focused && s.onlyWhenUnfocused) return
    const name = oneLine(this.o.agentName(c.agent)) || c.agent
    const n = c.sessionIds.length
    const waiting = `${n} ${n === 1 ? 'session' : 'sessions'} waiting`
    const what = k === 'N5' ? 'limit reset' : c.kind === 'rate_limit' ? 'usage limit reached' : c.kind === 'auth' ? 'signed out' : 'billing problem'
    const text = k === 'N4' && c.resetsAt !== null ? `${waiting} · resets ${clockTime(c.resetsAt)}` : waiting
    this.post({ op: 'post', tag: conditionTag(c.agent), sessionId: c.sessionIds[0] ?? null, title: `${name} · ${what}`, subtitle: '', body: body(text), sound: false }, { sessionId: null, key: null })
  }

  /** N3's body: the error kind, or how the agent ended (`exited 1`). */
  private failure(sessionId: string, reason: string): string {
    if (reason === 'lost') return 'terminal lost'
    if (reason !== 'crashed') return reason
    const e = this.o.exitOf?.(sessionId)
    if (e?.code !== null && e?.code !== undefined) return `exited ${e.code}`
    if (e?.signal !== null && e?.signal !== undefined) return `killed by signal ${e.signal}`
    return 'crashed'
  }

  // ── withdrawing ───────────────────────────────────────────────────────────────────────────

  /** The session's notification goes; with `keys`, only when it is one of those attention items'. */
  private withdrawSession(sessionId: string, keys?: string[]): void {
    const tag = sessionTag(sessionId)
    const l = this.live.get(tag)
    if (l && (!keys || (l.key !== null && keys.includes(l.key)))) this.withdraw(tag)
    if (!keys && this.burst?.sessions.delete(sessionId) && this.burst.sessions.size === 0) {
      this.burst = null
      this.withdraw(BURST_TAG)
    }
  }

  /** One prompt, one N1: the session's notification for the status file's item `from` is the hook item `to`'s now, so answering it withdraws it. */
  private rekey(sessionId: string, from: string, to: string): void {
    const l = this.live.get(sessionTag(sessionId))
    if (l && l.key === from) l.key = to
  }

  private post(op: Extract<NotificationOp, { op: 'post' }>, l: { sessionId: string | null; key: string | null }): void {
    this.live.set(op.tag, { ...l, at: this.mono() })
    this.o.out(op)
    this.armTtl()
  }

  private withdraw(tag: string): void {
    if (!this.live.delete(tag)) return
    this.o.out({ op: 'withdraw', tag })
    if (this.live.size === 0 && this.ttlTimer) {
      clearTimeout(this.ttlTimer)
      this.ttlTimer = null
    }
  }

  // ── time ──────────────────────────────────────────────────────────────────────────────────

  /** One timer, for the oldest live notification's time-to-live (main expires its own the same way). */
  private armTtl(): void {
    if (this.ttlTimer || this.live.size === 0 || this.disposed) return
    let oldest = Number.POSITIVE_INFINITY
    for (const l of this.live.values()) oldest = Math.min(oldest, l.at)
    this.ttlTimer = setTimeout(
      () => {
        this.ttlTimer = null
        const now = this.mono()
        for (const [tag, l] of this.live) if (now - l.at >= L.notificationTtlMs) this.live.delete(tag)
        if (this.burst && !this.live.has(BURST_TAG)) this.burst = null
        this.armTtl()
      },
      Math.max(0, oldest + L.notificationTtlMs - this.mono()),
    )
    this.ttlTimer.unref?.()
  }

  private armStartup(): void {
    if (this.disposed || !this.startup || this.startupTimer) return
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      this.summarise()
    }, L.unconfirmedStatusMs)
    this.startupTimer.unref?.()
  }

  /** The relaunch summary: at most one, for the sessions that came to need you while Kea was closed. */
  private summarise(): void {
    const st = this.startup
    this.startup = null
    if (!st || this.disposed) return
    // sessions started since the launch did not change while Kea was closed; the one the window views is not news
    const viewed = this.o.viewing()
    const changed = [...this.needing()].filter((id) => st.known.has(id) && !st.before.has(id) && !st.notified.has(id) && id !== viewed)
    const s = this.o.settings()
    if (changed.length === 0 || !(s.needsYou || s.finished || s.failed)) return
    if (this.focused && s.onlyWhenUnfocused) return
    const titles = changed.map((id) => oneLine(this.o.sessions.get(id)?.title ?? '')).filter(Boolean)
    const n = changed.length
    this.post({ op: 'post', tag: SUMMARY_TAG, sessionId: null, title: `${n} ${n === 1 ? 'session' : 'sessions'} changed while Kea was closed`, subtitle: '', body: body(titles.join(', ')), sound: false }, { sessionId: null, key: null })
  }

  /** The sessions that need you now (those ⌘J visits), and those an account condition holds. */
  private needing(): Set<string> {
    const out = new Set<string>()
    const held = heldSessions(this.o.conditions.values())
    for (const v of attentionOrder(this.o.sessions.values(), held)) out.add(v.id)
    for (const id of held) out.add(id)
    return out
  }
}

/** The first line of an item's summary: the adapter's one-line input summary, never more (U-NT-3). */
function firstLine(s: string): string {
  return s.split(/\r\n|\r|\n/, 1)[0] ?? ''
}

/** N1's body: a permission item's key when it is the tool and the summary's first line (`Bash: npm test`), else that line. */
function itemText(a: AttentionItem): string {
  const line = firstLine(a.summary)
  if (a.kind === 'permission' && line && a.key !== line && a.key.endsWith(line) && !/[\r\n]/.test(a.key)) return a.key
  return line || a.key
}
