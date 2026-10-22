// The window's sessions state: core's `projects`, `sessions` and `terminals` stores as the lists read them
// (frame-coalesced), what the main pane shows, the sidebar's filter and open Archived groups, the
// most-recently-used order (⌃Tab), and the one sheet, menu or toast showing. Ids and small values only; heavy objects
// stay in their registries. The window's UI state is a runes store: one `$state.raw` per field of `SessionsUi`,
// replaced, never mutated; components read `ui.<field>`, code writes a field or `ui.set(patch)`.

import { PROJECTS_STORE, SESSIONS_STORE, TERMINALS_STORE, type ComposerDraft, type Project, type ProjectRemoval, type PtyInfo, type SessionView } from '@kea/protocol'
import { FrameStore, nextFrame } from '../../lib/frameStore.ts'
import { subscribe } from '../../lib/rpc.ts'
import { settings } from '../settings/store.ts'
import { listed, MruCycle, projectStructure, sessionStructure, type SessionOrder } from './model.ts'

// ── core's stores, as the lists read them ─────────────────────────────────────────────────────

export const projects = new FrameStore<Project>({ schedule: nextFrame, structure: projectStructure })
export const sessions = new FrameStore<SessionView>({ schedule: nextFrame, structure: sessionStructure('stable'), group: (s) => s.projectId })
/**
 * Every session's row as it is now. `sessions.values()` is a snapshot of the list's structure (it changes when a row
 * comes, goes or moves): a row's status can change under it, so what reads statuses (⌘J, the needs-you count) reads
 * the rows through this.
 */
export function sessionRows(): SessionView[] {
  return sessions.values().map((v) => sessions.get(v.id) ?? v)
}
/**
 * Every PTY of the window's sessions and of the `shells` pseudo-session (the tab strips read it). What a tab shows is
 * its structure: its kind and state, its program's title and its foreground process's name.
 */
export const terminalsList = new FrameStore<PtyInfo>({ schedule: nextFrame, structure: (t) => `${t.sessionId}|${t.state}|${t.kind}|${t.title ?? ''}|${t.foreground ?? ''}` })

/** The setting `general.sessionOrder`, followed live. */
export function sessionOrder(): SessionOrder {
  return settings.get<SessionOrder>('general.sessionOrder')
}

// ── what the window shows ────────────────────────────────────────────────────────────────────

/** The main pane: a session, the composer for a project, or the plain shell tabs (the `shells` pseudo-session). */
export type Pane = { kind: 'session'; id: string } | { kind: 'composer'; projectId: string; pickProject?: boolean } | { kind: 'shells' }

export type Sheet =
  /** `removal` is core's answer to a refused remove; null until the sheet's own preview arrives. */
  | { kind: 'removeProject'; projectId: string; removal: ProjectRemoval | null }
  /** Settings (`features/settings`): the page it shows; on Projects, the project picked (null: the first). */
  | { kind: 'settings'; page: string; projectId: string | null }
  | { kind: 'archive'; sessionId: string; reasons: { kind: string; detail: string }[] }
  | { kind: 'delete'; sessionId: string }
  | { kind: 'restoreDeleted'; projectId: string }
  /** "View log": the session's log (`creation.log`); for one just deleted, the log its delete returned. */
  | { kind: 'log'; sessionId: string; title: string; log?: { text: string; truncated: boolean } }
  /** The first `⌘Q` with sessions running; `live` is how many keep running. */
  | { kind: 'quit'; live: number; background: boolean }
  /** Keyboard Shortcuts (`app.shortcuts`): every command and its key now (`features/commands`). */
  | { kind: 'shortcuts' }
  /** Remove Build Folders… run from the palette, the menu bar or a key asks first (`features/disk`). */
  | { kind: 'removeBuildFolders'; sessionId: string }

export interface Toast {
  message: string
  action?: { label: string; run(): void }
}

export interface MenuRequest {
  kind: 'session' | 'project' | 'header'
  id: string
  at: { x: number; y: number }
}

export interface SessionsUi {
  pane: Pane
  /** The filter text while the sidebar filter is on; null when off. */
  filter: string | null
  /** Projects whose Archived group is open. */
  archivedOpen: ReadonlySet<string>
  sheet: Sheet | null
  toast: Toast | null
  menu: MenuRequest | null
  /** A composer opened by Duplicate or Add Project starts from this, once. */
  composerSeed: { projectId: string; draft?: ComposerDraft; note?: string } | null
  /** The session whose title is being renamed in the header (session.rename). */
  renaming: string | null
  /** Bumped to move keyboard focus into the sidebar, to `focusRow` when set (a row key of model.ts). */
  sidebarFocus: number
  focusRow: string | null
  /** Bumped by every opening of the composer, so it takes the keyboard even when it is already open. */
  composerFocus: number
}

class SessionsUiState implements SessionsUi {
  pane = $state.raw<Pane>({ kind: 'shells' })
  filter = $state.raw<string | null>(null)
  // bounded: one per project whose Archived group is open, pruned with the projects list
  archivedOpen = $state.raw<ReadonlySet<string>>(new Set<string>())
  sheet = $state.raw<Sheet | null>(null)
  toast = $state.raw<Toast | null>(null)
  menu = $state.raw<MenuRequest | null>(null)
  composerSeed = $state.raw<SessionsUi['composerSeed']>(null)
  renaming = $state.raw<string | null>(null)
  sidebarFocus = $state(0)
  focusRow = $state.raw<string | null>(null)
  composerFocus = $state(0)

  /** Change several fields at once (one update for every reader). */
  set(patch: Partial<SessionsUi>): void {
    Object.assign(this, patch)
  }
}

export const ui = new SessionsUiState()

/** ⌃Tab's order. */
export const mru = new MruCycle()

const LAST_SESSION_KEY = 'kea.lastSession'

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** The session a window that opens now shows again once core lists it (the one last selected), if any is remembered. */
export function lastSessionId(): string | null {
  try {
    return storage()?.getItem(LAST_SESSION_KEY) ?? null
  } catch {
    return null
  }
}

/** The session selected, if the pane shows one. */
export function activeSessionId(): string | null {
  const p = ui.pane
  return p.kind === 'session' ? p.id : null
}

export function activeSession(): SessionView | undefined {
  const id = activeSessionId()
  return id ? sessions.get(id) : undefined
}

/** The project the window is working in: the active session's, the composer's, else the only or the first project. */
export function contextProjectId(): string | null {
  const p = ui.pane
  if (p.kind === 'session') return sessions.get(p.id)?.projectId ?? null
  if (p.kind === 'composer') return p.projectId
  const all = projects.values()
  if (all.length === 0) return null
  const last = lastUsedProject()
  return last && projects.get(last) ? last : ([...all].sort((a, b) => a.sortOrder - b.sortOrder)[0]?.id ?? null)
}

/** The project of the most recently used session. */
function lastUsedProject(): string | null {
  for (const id of mru.list()) {
    const s = sessions.get(id)
    if (s) return s.projectId
  }
  return null
}

/** A session just created or restored whose row may reach the window after the call's reply. */
let pendingSession: string | null = null

/** The session just created or restored whose row has not reached the window yet, if any (it keeps its ⌃Tab place, shell/forget.ts). */
export function pendingSessionId(): string | null {
  return pendingSession
}

/**
 * Select a session (all three columns follow). `cycling`: ⌃Tab is stepping, the MRU order waits for ⌃'s release.
 * `arriving`: it was just created or restored, so its row may not be here yet: core publishes the row apart from the
 * call's reply, and a deleted session is in no store; the pane shows it as soon as it is.
 */
export function selectSession(id: string, o: { cycling?: boolean; arriving?: boolean } = {}): void {
  if (o.arriving) pendingSession = id
  else if (!sessions.get(id)) return
  if (!o.cycling) mru.visit(id)
  ui.set({ pane: { kind: 'session', id }, renaming: null })
  try {
    storage()?.setItem(LAST_SESSION_KEY, id)
  } catch {
    // not remembered this time
  }
}

/** Open the composer. */
export function openComposer(projectId: string, o: { pickProject?: boolean; seed?: SessionsUi['composerSeed'] } = {}): void {
  ui.set({ pane: { kind: 'composer', projectId, ...(o.pickProject ? { pickProject: true } : {}) }, composerSeed: o.seed ?? null, renaming: null, composerFocus: ui.composerFocus + 1 })
}

/** Leave the composer (Esc, the draft stays): back to the last session, else the shells. */
export function closeComposer(): void {
  const back = mru.list().find((id) => {
    const s = sessions.get(id)
    return s && listed(s)
  })
  ui.set({ pane: back ? { kind: 'session', id: back } : { kind: 'shells' }, composerSeed: null })
}

export function showToast(t: Toast): void {
  ui.toast = t
}

/** A failed call that has no place in the UI, as a toast: its message, or the error's. */
export function failed(what: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e)
  showToast({ message: `${what}: ${msg}` })
}

// ── wiring ───────────────────────────────────────────────────────────────────────────────────

let installed = false

let firstSnapshot!: (anyListed: boolean) => void
/**
 * Whether core's first `sessions` snapshot lists any session; resolves once, on that snapshot (the shells pane
 * opens a first shell only when none survived and no session is listed, since the last session comes back instead).
 * Taken from the subscription's own data: the store's flush comes a frame later, and an empty snapshot calls no list
 * subscriber.
 */
export const sessionsListedAtStart: Promise<boolean> = new Promise((resolve) => (firstSnapshot = resolve))

/** Follow core's stores; restore the last session once it is listed. */
export function installSessionsState(): void {
  if (installed) return
  installed = true
  subscribe<Project>(PROJECTS_STORE, (d, c) => projects.push(d, c))
  subscribe<SessionView>(SESSIONS_STORE, (d, c) => {
    sessions.push(d, c)
    if (c === null) firstSnapshot([...d.values()].some(listed)) // a later snapshot (core restarted) changes nothing
  })
  subscribe<PtyInfo>(TERMINALS_STORE, (d, c) => terminalsList.push(d, c))

  // The layout follows general.sessionOrder
  let order = sessionOrder()
  settings.subscribe(() => {
    const next = sessionOrder()
    if (next === order) return
    order = next
    sessions.setStructure(sessionStructure(order))
  })

  // the last session comes back once core lists it; sessions that are gone leave the pane (and the MRU order, which
  // the window prunes with what else it keeps per session: shell/forget.ts)
  let restore: string | null = null
  try {
    restore = storage()?.getItem(LAST_SESSION_KEY) ?? null
  } catch {
    restore = null
  }
  sessions.subscribeList(() => {
    if (restore && ui.pane.kind === 'shells' && sessions.get(restore) && listed(sessions.get(restore)!)) selectSession(restore)
    restore = null
    const p = ui.pane
    if (p.kind === 'session') {
      const s = sessions.get(p.id)
      if (s && p.id === pendingSession) pendingSession = null
      if ((!s && p.id !== pendingSession) || (s && !listed(s))) closeComposer()
    }
  })
  projects.subscribeList(() => {
    const p = ui.pane
    if (p.kind === 'composer' && !projects.get(p.projectId)) closeComposer()
  })
}

/** The window's copies of core's stores and its MRU order, for the resource report. */
export function sessionsResources(): { projects: number; sessions: number; terminals: number; listeners: number; mru: number } {
  return {
    projects: projects.size,
    sessions: sessions.size,
    terminals: terminalsList.size,
    listeners: projects.subscribers + sessions.subscribers + terminalsList.subscribers,
    mru: mru.size,
  }
}
