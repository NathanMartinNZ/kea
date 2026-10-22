// What the header control shows for a dev server: pure, so the control, the commands and their tests agree.

import { serverPortLabel, serverPortUrl, type ServerState, type ServerView } from '@kea/protocol'
import type { SessionView } from '@kea/protocol'

/**
 * Hidden with nothing to run and in a session that can run none (`canRun`: an archived one, a worktree that is
 * gone; the command says why), unless a server is there to be stopped or looked at.
 */
export function controlShown(v: ServerView, canRun = true): boolean {
  return v.state !== 'stopped' || (canRun && v.source !== 'none')
}

/** A server whose process exists: `⌘R` stops it; otherwise it runs one. */
export function serverUp(state: ServerState): boolean {
  return state === 'starting' || state === 'running' || state === 'stopping'
}

export interface PortLink {
  port: number
  url: string
  /** `:5173` */
  label: string
}

/** The port of a URL core gave, or null. */
export function urlPort(url: string | null): number | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.port) return Number(u.port)
    return u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : null
  } catch {
    return null
  }
}

/**
 * The URL chip's links while the server runs: the primary URL first, then every other listening port, lowest
 * first. One link: a click opens it; several: the chip opens a menu.
 */
export function portLinks(v: ServerView): PortLink[] {
  if (v.state !== 'running' || v.url === null) return []
  const primary = urlPort(v.url)
  const out: PortLink[] = primary === null ? [] : [{ port: primary, url: v.url, label: serverPortLabel(primary) }]
  for (const port of v.ports) if (port !== primary) out.push({ port, url: serverPortUrl(port), label: serverPortLabel(port) })
  return out
}

/** A session a dev server can be run in (core checks the same: `wrongState`). */
export function canRunIn(s: SessionView | undefined): boolean {
  return !!s && (s.lifecycle === 'live' || s.lifecycle === 'detached') && !s.worktreeMissing
}

/** Why Run is unavailable. */
export const NO_START_SCRIPT = 'No start.sh in this worktree'
