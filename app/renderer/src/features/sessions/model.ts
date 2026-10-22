// The sidebar as data: which rows show, in which order, and what `⌘1…9`, `⌘J` and `⌃Tab` go to. Pure, so ordering,
// filtering and the jump targets are unit-tested (model.test.ts).
//
//   projects   manual order (`sortOrder`, then age); a collapsed one hides its sessions
//   sessions   `stable`: the project's own order (`sortOrder`, newest first by creation, drag reorder kept);
//              `attention`: sessions needing you first, in attention order (`attentionOrder`: blocked oldest
//              first, then failed and crashed, then unread ready), then by last activity. Rows never move because of
//              status in `stable` mode.
//   archived   one collapsed "Archived (n)" row per project, only when n > 0; expanded on request
//   filter     typing in the focused sidebar filters sessions by title or branch; projects without a match hide,
//              collapsed ones open while the filter is on
//   ⌘1…9       the first nine visible session rows, top to bottom across projects
//   ⌘J         the next session that needs you, in attention order (`nextNeedingYou`)

import { attentionGroup, attentionOrder, conditionLabel, isAccountKind, type Project, type SessionView } from '@kea/protocol'
import type { SESSION_ORDER } from '@kea/protocol'

export type SessionOrder = (typeof SESSION_ORDER)[number]

export type SidebarRow =
  | { kind: 'project'; key: string; projectId: string; collapsed: boolean; sessions: number }
  | { kind: 'session'; key: string; projectId: string; sessionId: string; archived: boolean }
  | { kind: 'archived'; key: string; projectId: string; count: number; expanded: boolean }

export interface SidebarInput {
  projects: readonly Project[]
  sessions: readonly SessionView[]
  order: SessionOrder
  /** The type-to-filter text; empty when off. */
  filter: string
  /** Projects whose Archived group is open. */
  archivedOpen: ReadonlySet<string>
  /** The sessions account conditions hold (`heldSessions`): left out of the attention group. */
  held?: ReadonlySet<string>
}

/** Projects in their manual order: ascending `sortOrder`, then the older first. */
export function orderProjects(projects: readonly Project[]): Project[] {
  return [...projects].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** One project's sessions in sidebar order (`held`: the sessions account conditions hold). */
export function orderSessions(sessions: readonly SessionView[], order: SessionOrder, held?: ReadonlySet<string>): SessionView[] {
  const stable = (a: SessionView, b: SessionView) => a.sortOrder - b.sortOrder || b.createdAt - a.createdAt || a.id.localeCompare(b.id)
  if (order === 'stable') return [...sessions].sort(stable)
  // The same order as ⌘J, then everything else by last activity
  const first = attentionOrder(sessions, held)
  const listed = new Set(first.map((s) => s.id))
  const rest = sessions.filter((s) => !listed.has(s.id)).sort((a, b) => b.lastActivityAt - a.lastActivityAt || stable(a, b))
  return [...first, ...rest]
}

/**
 * The row's trailing label: the first attention item's kind (`permission`, `question`), or for a row an account
 * condition holds `limited` / `signed out` / `billing`; null otherwise.
 */
export function rowLabel(s: SessionView): string | null {
  const label = s.label ?? s.attention[0]?.kind
  if (label) return label
  if (s.glyph === 'limited' && isAccountKind(s.failureKind)) return conditionLabel(s.failureKind)
  return null
}

/** A row's trailing label as a status in words: the label alone ("permission", "billing") is not one. */
const LABEL_WORDS: Readonly<Record<string, string>> = {
  permission: 'Needs permission',
  question: 'Needs an answer',
  limited: 'Waiting on a usage limit',
  'signed out': 'Signed out',
  billing: 'Waiting on billing',
}

/**
 * What a row's glyph says to assistive technology (status is never colour-only, A-4): the status in words. The glyph is
 * the row's only sign of most statuses, so this is where a screen reader hears them.
 */
export function statusWords(s: SessionView): string {
  const label = rowLabel(s)
  if (label) return LABEL_WORDS[label] ?? label
  if (s.lifecycle === 'creating') return 'Creating'
  if (s.lifecycle === 'create_failed') return 'Creation failed'
  if (s.glyph === 'failed' && (s.endReason === 'crashed' || s.endReason === 'lost')) return s.endReason === 'lost' ? 'Lost' : 'Crashed'
  return { working: 'Working', needsYou: 'Needs you', unread: 'Finished, unread', idle: 'Idle', detached: 'Detached', failed: 'Failed', limited: 'Waiting on an account condition' }[s.glyph]
}

/** The row's tooltip: a failed creation's error, else a finished turn's background work. */
export function rowTitle(s: SessionView): string | undefined {
  if (s.creation?.error) return s.creation.error
  if (s.lifecycle === 'live' && s.phase === 'ready' && s.background) return 'Background tasks running'
  return undefined
}

/** A session matches when its title or branch contains the text, ignoring case. */
export function matchesFilter(s: Pick<SessionView, 'title' | 'branch'>, filter: string): boolean {
  const f = filter.trim().toLowerCase()
  if (!f) return true
  return s.title.toLowerCase().includes(f) || (s.branch ?? '').toLowerCase().includes(f)
}

/** Sessions the sidebar lists at all: deleted ones are gone from it. */
export function listed(s: SessionView): boolean {
  return s.lifecycle !== 'deleted'
}

export function sidebarRows(input: SidebarInput): SidebarRow[] {
  const filtering = input.filter.trim() !== ''
  const byProject = new Map<string, SessionView[]>()
  for (const s of input.sessions) {
    if (!listed(s) || !matchesFilter(s, input.filter)) continue
    const list = byProject.get(s.projectId)
    if (list) list.push(s)
    else byProject.set(s.projectId, [s])
  }
  const rows: SidebarRow[] = []
  for (const p of orderProjects(input.projects)) {
    const mine = byProject.get(p.id) ?? []
    if (filtering && mine.length === 0) continue
    const active = orderSessions(
      mine.filter((s) => s.lifecycle !== 'archived'),
      input.order,
      input.held,
    )
    const archived = orderSessions(
      mine.filter((s) => s.lifecycle === 'archived'),
      'stable',
    )
    const collapsed = p.collapsed && !filtering
    rows.push({ kind: 'project', key: `p:${p.id}`, projectId: p.id, collapsed, sessions: active.length + archived.length })
    if (collapsed) continue
    for (const s of active) rows.push({ kind: 'session', key: `s:${s.id}`, projectId: p.id, sessionId: s.id, archived: false })
    if (archived.length === 0) continue
    const expanded = filtering || input.archivedOpen.has(p.id)
    rows.push({ kind: 'archived', key: `a:${p.id}`, projectId: p.id, count: archived.length, expanded })
    if (expanded) for (const s of archived) rows.push({ kind: 'session', key: `s:${s.id}`, projectId: p.id, sessionId: s.id, archived: true })
  }
  return rows
}

/** `⌘1…9` → the first nine visible session rows, top to bottom. */
export function jumpTargets(rows: readonly SidebarRow[], max = 9): string[] {
  const out: string[] = []
  for (const r of rows) {
    if (r.kind !== 'session') continue
    out.push(r.sessionId)
    if (out.length === max) break
  }
  return out
}

/**
 * `⌘J`: the next session that needs you, in `attentionOrder` (blocked oldest first, then failed and crashed,
 * then unread ready; sessions an account condition holds, `held`, are left out — once none holds one it is a failure like
 * any other): the one after `current` when it is in that order (round again from the first), else the first. Null when
 * nobody needs you, or only `current` does.
 */
export function nextNeedingYou(sessions: readonly SessionView[], current: string | null = null, held?: ReadonlySet<string>): string | null {
  const order = attentionOrder(sessions.filter((s) => listed(s) && s.lifecycle !== 'archived'), held)
  if (order.length === 0) return null
  const at = current === null ? -1 : order.findIndex((s) => s.id === current)
  const next = order[(at + 1) % order.length]!
  return next.id === current ? null : next.id
}

/** What a list lays out of a session (FrameStore `structure`): a status change in `stable` order changes none of it. */
export function sessionStructure(order: SessionOrder): (s: SessionView) => string {
  return order === 'stable'
    ? (s) => `${s.projectId}|${s.sortOrder}|${s.createdAt}|${s.lifecycle === 'archived' ? 'a' : s.lifecycle === 'deleted' ? 'd' : 'l'}|${s.title}|${s.branch ?? ''}`
    : (s) => `${s.projectId}|${s.sortOrder}|${s.createdAt}|${s.lifecycle}|${s.title}|${s.branch ?? ''}|${attentionGroup(s) ?? '-'}|${s.attention.reduce((m, a) => Math.min(m, a.at), Number.POSITIVE_INFINITY)}|${s.lastActivityAt}`
}

export function projectStructure(p: Project): string {
  return `${p.sortOrder}|${p.createdAt}|${p.collapsed ? 1 : 0}`
}

// ── reordering: drag, or ⌥↑ / ⌥↓ on a focused row ────────────────────────────────────────────

/**
 * The index `projects.move` / `sessions.move` take (core's: into the order without the moved row) that puts `id` just
 * past `target`: after it when `id` comes from above, before it when from below. `all` is core's whole order — every
 * project, or every listed session of the project, archived ones included — so rows the sidebar shows apart (the
 * Archived group) cannot shift the result. Null when there is nothing to move.
 */
export function moveIndex(all: readonly string[], id: string, target: string): number | null {
  const from = all.indexOf(id)
  const to = all.indexOf(target)
  if (from < 0 || to < 0 || from === to) return null
  const at = all.filter((x) => x !== id).indexOf(target)
  return from < to ? at + 1 : at
}

/** ⌥↑ (-1) / ⌥↓ (1) on a row: the visible neighbour it moves past, if any (`siblings` in the order shown). */
export function neighbour(siblings: readonly string[], id: string, dir: 1 | -1): string | null {
  const i = siblings.indexOf(id)
  return i < 0 ? null : (siblings[i + dir] ?? null)
}

// ── ⌃Tab: most recently used ─────────────────────────────────────────────────────────────────

/**
 * Sessions in the order they were last looked at. `⌃Tab` steps back through that order while `⌃` is held (the order is
 * frozen for the cycle), and the session reached counts as visited when `⌃` is released; a single press visits at once.
 * `⌃⇧Tab` steps the other way.
 */
export class MruCycle {
  private order: string[] = [] // bounded: one entry per listed session, pruned on every list change
  private cycle: { order: string[]; index: number } | null = null

  /** A session was selected by any other means. */
  visit(id: string): void {
    this.cycle = null
    this.order = [id, ...this.order.filter((x) => x !== id)]
  }

  /** Drop sessions that are gone (or no longer listed). */
  prune(exists: (id: string) => boolean): void {
    this.order = this.order.filter(exists)
    if (this.cycle) this.cycle.order = this.cycle.order.filter(exists)
  }

  /** `⌃Tab` (1) or `⌃⇧Tab` (-1); `held`: ⌃ is still down, so the cycle goes on. Returns the session to show. */
  step(dir: 1 | -1, held: boolean, current: string | null): string | null {
    if (!this.cycle) {
      const order = current && !this.order.includes(current) ? [current, ...this.order] : [...this.order]
      // the cycle starts from the session on screen
      const at = current ? Math.max(0, order.indexOf(current)) : -1
      if (at > 0) order.unshift(...order.splice(at, 1))
      this.cycle = { order, index: current ? 0 : -1 }
    }
    const n = this.cycle.order.length
    if (n === 0) {
      this.cycle = null
      return null
    }
    this.cycle.index = (((this.cycle.index + dir) % n) + n) % n
    const target = this.cycle.order[this.cycle.index]!
    if (!held) this.visit(target)
    return target
  }

  /** `⌃` released: the session reached is now the most recent. */
  release(): void {
    if (!this.cycle) return
    const target = this.cycle.order[this.cycle.index]
    this.cycle = null
    if (target) this.visit(target)
  }

  get cycling(): boolean {
    return this.cycle !== null
  }

  get size(): number {
    return this.order.length
  }

  list(): readonly string[] {
    return this.order
  }
}

/** Trailing meta's relative time: `now`, `2m`, `3h`, `4d`. */
export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
