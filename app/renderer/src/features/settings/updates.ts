// The window's copy of main's update state (`kea:updateState`, checked against `zUpdateState` in the bridge), and what
// Settings › About and the sidebar footer draw from it. Main owns the state; the window only shows it and asks for a
// check, a restart, or records that the one-time line was seen. The texts are pure functions of the state.

import { L, NO_UPDATE_STATE, releaseUrls, RELEASE_REPOSITORY, type UpdateState } from '@kea/protocol'
import { onUpdateState } from '../../lib/bridge.ts'

let current: UpdateState = NO_UPDATE_STATE
const listeners = new Set<() => void>() // bounded: About's block, the footer and the command's title
let installed: (() => void) | null = null
/** "Kea 1.0.3 is out" lines closed with ✕, until Kea next starts (by version). */
const dismissed = new Set<string>() // bounded: one per version main offered in this run, a handful at most
/**
 * The one-time line stays in this window once main said it was due, until ✕ or the next start, though main stops
 * saying so as soon as the line has been in view.
 */
let notice: 'no' | 'shown' | 'closed' = 'no'

function changed(): void {
  for (const l of [...listeners]) l()
}

function install(): void {
  installed ??= onUpdateState((s) => {
    current = s
    if (s.notice && notice === 'no') notice = 'shown'
    changed()
  })
}

/** Main's update state, as the window last heard it. */
export const updates = {
  get state(): UpdateState {
    install()
    return current
  },
  subscribe(cb: () => void): () => void {
    install()
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  /** Hide "Kea <version> is out" for that version until Kea next starts. */
  dismiss(version: string): void {
    dismissed.add(version)
    changed()
  },
  dismissed(version: string): boolean {
    return dismissed.has(version)
  },
  /** The one-time line is drawn in this window now. */
  get notice(): boolean {
    install()
    return notice === 'shown'
  },
  /** ✕ on the one-time line. */
  closeNotice(): void {
    notice = 'closed'
    changed()
  },
}

/** The update command's title now: Restart to Update (macOS, ready), Restart Kea (Linux, replaced), else Check for Updates…. */
export function updateTitle(s: UpdateState): string {
  return s.phase.k === 'ready' ? 'Restart to Update' : s.phase.k === 'upgraded' ? 'Restart Kea' : 'Check for Updates…'
}

/** How often Kea checks by itself, in words (L.updateCheckIntervalMs). */
export function checkInterval(ms: number = L.updateCheckIntervalMs): string {
  const hours = Math.round(ms / 3_600_000)
  if (hours === 24) return 'once a day'
  if (hours % 24 === 0) return `every ${hours / 24} days`
  return hours === 1 ? 'every hour' : `every ${hours} hours`
}

/** About's one action for the state. */
export type UpdateAction = 'check' | 'retry' | 'restartUpdate' | 'restartKea' | 'copy' | null

/** What About's Updates block says: the line, its action, the version whose release notes it links, the command to copy. */
export interface AboutUpdate {
  line: string
  action: UpdateAction
  /** The version whose release page "Release notes" opens; null for none. */
  notes: string | null
  command: string | null
}

/** The text after "Kea <v> is out." for the install command where the person runs it. */
function commandLine(s: UpdateState): string {
  const cmd = s.command ?? ''
  if (s.mode === 'packageManager') return `Your system’s updates install it, or run \`${cmd}\`.`
  if (cmd.includes('--no-repo')) return `Run \`${cmd}\`.`
  return `Quit Kea completely (sessions keep running), then run \`${cmd}\`.`
}

export function aboutUpdate(s: UpdateState): AboutUpdate {
  const p = s.phase
  const none = (line: string, action: UpdateAction = null): AboutUpdate => ({ line, action, notes: null, command: null })
  if (s.mode === 'none') return none('This build was not installed from a release, so it does not check for updates.')
  switch (p.k) {
    case 'idle':
      return none(s.auto ? `Kea checks for a newer version ${checkInterval()}.` : 'Kea checks for a newer version when you ask.', 'check')
    case 'checking':
      return none('Checking for updates…')
    case 'current':
      return none(`Kea ${p.version} is the newest version.`, 'check')
    case 'downloading':
      return { line: `Downloading Kea ${p.version}… ${p.percent} %`, action: null, notes: p.version, command: null }
    case 'ready':
      return { line: `Kea ${p.version} is ready. Kea restarts; sessions keep running.`, action: 'restartUpdate', notes: p.version, command: null }
    case 'available':
      return { line: `Kea ${p.version} is out. ${commandLine(s)}`, action: s.command ? 'copy' : null, notes: p.version, command: s.command }
    case 'upgraded':
      return { line: `Kea was updated${p.version ? ` to ${p.version}` : ''}. Restart Kea to use it; sessions keep running.`, action: 'restartKea', notes: p.version, command: null }
    case 'removed':
      return none('Kea’s files were removed while it ran. Quit Kea; sessions keep running.')
    case 'didNotInstall':
      return { line: `Kea ${p.version} did not install. Install it with the command instead.`, action: s.command ? 'copy' : null, notes: p.version, command: s.command }
    case 'failed':
      return none(`Couldn’t check for updates: ${p.reason}. Kea tries again at the next check.`, 'retry')
  }
}

/** The release page of `version`, for its notes; null where Kea names no repository. */
export function releaseNotesUrl(version: string): string | null {
  return RELEASE_REPOSITORY ? releaseUrls(RELEASE_REPOSITORY).tag(version) : null
}

/** "Last checked 14:05" (today) or with the day; null before the first check. */
export function lastCheckedText(t: number | null, now: number = Date.now()): string | null {
  if (t === null) return null
  const d = new Date(t)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return sameDay ? `Last checked ${time}` : `Last checked ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}

/** The sidebar footer's update line: what it says, what a click does, and whether it has ✕. */
export interface FooterUpdate {
  kind: 'notice' | 'out' | 'ready' | 'upgraded'
  text: string
  /** A click on the line: About, or the restart it offers. */
  click: 'about' | 'restart'
  /** ✕ hides it: the notice for good, "is out" for that version until Kea next starts. */
  close: boolean
  version: string | null
}

export function footerUpdate(s: UpdateState, o: { dismissed(version: string): boolean; notice: boolean }): FooterUpdate | null {
  const p = s.phase
  if (p.k === 'ready') return { kind: 'ready', text: `Kea ${p.version} is ready — Restart to Update`, click: 'restart', close: false, version: p.version }
  if (p.k === 'upgraded') return { kind: 'upgraded', text: 'Kea was updated — Restart Kea', click: 'restart', close: false, version: p.version }
  if (p.k === 'available' && !o.dismissed(p.version)) return { kind: 'out', text: `Kea ${p.version} is out`, click: 'about', close: true, version: p.version }
  if (o.notice) return { kind: 'notice', text: `Kea checks GitHub ${checkInterval()} for a newer version · Settings`, click: 'about', close: true, version: null }
  return null
}
