// Where an update request may go and what it carries, for both sessions that make them: main's check (`feed.ts`) and
// the macOS updater's (`os/squirrelDriver.ts`). Every request, each redirect hop included, is judged by the session's
// own filter: only Kea's repository's releases on GitHub and the hosts GitHub serves release files from pass. The
// headers are the same for everyone (no identifier, no cookie). No imports: the updater's bundle includes this file.

/** The headers every update request carries. Accept-Language is set, as removing it may not hold. */
export const UPDATE_HEADERS: Readonly<Record<string, string>> = { 'User-Agent': 'Kea', 'Accept-Language': 'en' }

/** Headers dropped from every update request before `UPDATE_HEADERS` are added. */
const DROPPED = /^(cookie|user-agent|accept-language)$/i

/**
 * Whether an update request may go to `url`: `https://github.com/<owner>/<name>/releases/…` for Kea's repository, or
 * `https://<host>.githubusercontent.com/…`, where GitHub redirects release files. `test` is the test hooks' stand-in
 * origin (`http://127.0.0.1:<port>`), allowed only when given.
 */
export function updateUrlAllowed(repo: { owner: string; name: string }, test: string | null = null): (url: string) => boolean {
  const releases = `/${repo.owner}/${repo.name}/releases/`.toLowerCase()
  return (url) => {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return false
    }
    if (test !== null && u.origin === test) return true
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
    if (u.hostname === 'github.com') return u.pathname.toLowerCase().startsWith(releases)
    return u.hostname.endsWith('.githubusercontent.com')
  }
}

/** The headers a request leaves with: its own without a cookie or a language or agent of its own, then `headers`. */
export function updateHeaders(requestHeaders: Readonly<Record<string, string>>, headers: Readonly<Record<string, string>> = UPDATE_HEADERS): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(requestHeaders)) if (!DROPPED.test(k)) out[k] = v
  return { ...out, ...headers }
}

/** The parts of an Electron session's request filters the update sessions use. */
export interface FilterSession {
  webRequest: {
    onBeforeRequest(listener: ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void) | null): void
    onBeforeSendHeaders(listener: ((details: { requestHeaders: Record<string, string> }, cb: (r: { requestHeaders: Record<string, string> }) => void) => void) | null): void
  }
}

/** Install the filters on `ses`; a refused request is reported to `refused`. Returns their removal. */
export function installUpdateFilters(ses: FilterSession, allowed: (url: string) => boolean, headers: Readonly<Record<string, string>>, refused: (url: string) => void): () => void {
  ses.webRequest.onBeforeRequest((details, cb) => {
    const ok = allowed(details.url)
    if (!ok) refused(details.url)
    cb({ cancel: !ok })
  })
  ses.webRequest.onBeforeSendHeaders((details, cb) => cb({ requestHeaders: updateHeaders(details.requestHeaders, headers) }))
  return () => {
    ses.webRequest.onBeforeRequest(null)
    ses.webRequest.onBeforeSendHeaders(null)
  }
}
