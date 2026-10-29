// The update check where Kea's own updater does not run: one GET of the newest release's SHA256SUMS through the update
// session, the version taken from this install's own file name, every failure one short line.
import { describe, expect, it, vi } from 'vitest'
import { checkFeed, updateSessionFetch, type FeedInput, type UpdateFetch } from './feed.ts'

const SUMS = [
  `${'a'.repeat(64)}  kea-app_1.0.3_amd64.deb`,
  `${'b'.repeat(64)}  kea-app_1.0.3_arm64.deb`,
  `${'c'.repeat(64)}  kea-app-1.0.3-1.x86_64.rpm`,
  `${'d'.repeat(64)}  kea-app-1.0.3-linux-arm64.tar.gz`,
  `${'e'.repeat(64)}  Kea-1.0.3-arm64-mac.zip`,
  `${'f'.repeat(64)}  install.sh`,
].join('\n')

const input = (fetch: UpdateFetch, o: Partial<FeedInput> = {}): FeedInput => ({ fetch, url: 'https://github.com/o/n/releases/latest/download/SHA256SUMS', kind: 'deb', arch: 'arm64', timeoutMs: 1000, maxBytes: 65536, ...o })

describe('the release’s list of files', () => {
  it('U-DST-12 · the version in this install’s own file name, for each kind and architecture; none when the release lacks it; one GET that follows redirects and is never cached', async () => {
    const fetch = vi.fn<UpdateFetch>(() => Promise.resolve(new Response(SUMS)))
    expect(await checkFeed(input(fetch))).toBe('1.0.3')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![0]).toBe('https://github.com/o/n/releases/latest/download/SHA256SUMS')
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'follow', cache: 'no-store' })
    expect(await checkFeed(input(() => Promise.resolve(new Response(SUMS)), { kind: 'rpm', arch: 'x64' }))).toBe('1.0.3')
    expect(await checkFeed(input(() => Promise.resolve(new Response(SUMS)), { kind: 'tarball' }))).toBe('1.0.3')
    expect(await checkFeed(input(() => Promise.resolve(new Response(SUMS)), { kind: 'zip' }))).toBe('1.0.3')
    expect(await checkFeed(input(() => Promise.resolve(new Response(SUMS)), { kind: 'rpm', arch: 'arm64' })), 'no arm64 rpm in this release').toBeNull()
    expect(await checkFeed(input(() => Promise.resolve(new Response(`${'a'.repeat(64)}  kea-app_1.1.0-rc.1_arm64.deb\n`)))), 'a prerelease').toBeNull()
  })

  it('U-DST-13 · a 404, another status, a body over L.updateFeedMaxBytes, no answer in time and no connection each fail with one short line', async () => {
    await expect(checkFeed(input(() => Promise.resolve(new Response('no', { status: 404 }))))).rejects.toThrow('the newest release has no list of files')
    await expect(checkFeed(input(() => Promise.resolve(new Response('busy', { status: 503 }))))).rejects.toThrow('GitHub answered 503')
    await expect(checkFeed(input(() => Promise.resolve(new Response('x'.repeat(100))), { maxBytes: 50 }))).rejects.toThrow('larger than expected')
    await expect(checkFeed(input(() => Promise.resolve(new Response('x'.repeat(100), { headers: { 'content-length': '100' } })), { maxBytes: 50 }))).rejects.toThrow('larger than expected')
    await expect(checkFeed(input(() => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')), {}))).rejects.toThrow('could not reach GitHub (net::ERR_NAME_NOT_RESOLVED)')
    // a fetch that answers only when it is aborted
    const hangs: UpdateFetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    await expect(checkFeed(input(hangs, { timeoutMs: 1 }))).rejects.toThrow('GitHub did not answer in time')
  })

  it('U-DST-14 · the request goes through the update session’s own fetch', async () => {
    const ses = { fetch: vi.fn(() => Promise.resolve(new Response(SUMS))) }
    expect(await checkFeed(input(updateSessionFetch(ses)))).toBe('1.0.3')
    expect(ses.fetch).toHaveBeenCalledTimes(1)
  })
})
