// The last check before a link leaves Kea, whatever the window decided: an address no longer than
// L.linkOpenMaxChars, measured before it is parsed, whose scheme is http, https or mailto.

import { L } from '@kea/protocol'

const OPENABLE = new Set(['http:', 'https:', 'mailto:'])

/** Why a link is not handed to the system. */
export type LinkRefusal = 'long' | 'scheme' | 'malformed'

/** The URL to give the system, or why not. */
export function checkLink(raw: unknown): { url: string } | { why: LinkRefusal } {
  if (typeof raw !== 'string') return { why: 'malformed' }
  if (raw.length > L.linkOpenMaxChars) return { why: 'long' }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { why: 'malformed' }
  }
  if (!OPENABLE.has(u.protocol)) return { why: 'scheme' }
  if (u.protocol !== 'mailto:' && !u.hostname) return { why: 'malformed' }
  if (u.href.length > L.linkOpenMaxChars) return { why: 'long' }
  return { url: u.href }
}

/** The URL to give `shell.openExternal`, or null if it must not be opened. */
export function externalUrl(raw: string): string | null {
  const r = checkLink(raw)
  return 'url' in r ? r.url : null
}
