// The check where Kea's own updater does not run (Linux, and macOS when the updater cannot install): one GET of the
// newest release's `SHA256SUMS`, which names every file of the release with its version. The version offered is the
// one in this install's own file name, so a release published without this system's files offers nothing, and a
// prerelease is never offered. The request goes through main's in-memory `kea-updates` session (no cookie jar, no
// cache on disk), whose filters (`net.ts`) judge each redirect hop; it ends after L.updateFetchTimeoutMs, and a body
// larger than L.updateFeedMaxBytes is refused unread past that size. Proxy authentication gets no credentials, so it
// fails at once.

import { offeredVersion, type ReleaseArch, type ReleaseFileKind } from '@kea/protocol'

/** A `fetch` through the update session. */
export type UpdateFetch = (url: string, init: { redirect: 'follow'; cache: 'no-store'; signal: AbortSignal }) => Promise<Response>

/** The update session's own `fetch` (Electron's `net.fetch` always uses the default session). */
export function updateSessionFetch(updateSession: { fetch(url: string, init: RequestInit): Promise<Response> }): UpdateFetch {
  return (url, init) => updateSession.fetch(url, init)
}

export interface FeedInput {
  fetch: UpdateFetch
  /** The release's `SHA256SUMS` (`releaseUrls(…).latest + 'SHA256SUMS'`). */
  url: string
  kind: ReleaseFileKind
  arch: ReleaseArch
  timeoutMs: number
  maxBytes: number
}

/** The version the newest release offers this install; null when it offers none. Throws one short line on failure. */
export async function checkFeed(f: FeedInput): Promise<string | null> {
  const signal = AbortSignal.timeout(f.timeoutMs)
  let res: Response
  try {
    res = await f.fetch(f.url, { redirect: 'follow', cache: 'no-store', signal })
  } catch (e) {
    throw new Error(signal.aborted ? 'GitHub did not answer in time' : `could not reach GitHub (${errorText(e)})`)
  }
  if (res.status === 404) throw new Error('the newest release has no list of files')
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const text = await readCapped(res, f.maxBytes, signal)
  return offeredVersion(text, f.kind, f.arch)
}

/** The body as text, refused once it passes `max` bytes. */
async function readCapped(res: Response, max: number, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) throw new Error('the list of files is larger than expected')
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel().catch(() => undefined)
        throw new Error('the list of files is larger than expected')
      }
      chunks.push(value)
    }
  } catch (e) {
    if (signal.aborted) throw new Error('GitHub did not answer in time')
    throw e
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function errorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  return (text.split('\n')[0] ?? '').replace(/(https?:\/\/[^\s?#"']+)\?[^\s"']*/g, '$1').slice(0, 120)
}
