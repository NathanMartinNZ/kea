// The last check before a link leaves Kea: the renderer opens links through `window.open`, which main denies after
// handing the URL to the system, but only for http, https and mailto, whatever the renderer decided.

const OPENABLE = new Set(['http:', 'https:', 'mailto:'])

/** The URL to give `shell.openExternal`, or null if it must not be opened. */
export function externalUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (!OPENABLE.has(u.protocol)) return null
  if (u.protocol !== 'mailto:' && !u.hostname) return null
  return u.href
}
