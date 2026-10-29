// Where an update request may go and what it carries: Kea's repository's releases on GitHub and GitHub's release-asset
// hosts only, each redirect hop judged; the same headers for every request, no cookie.
import { describe, expect, it } from 'vitest'
import { installUpdateFilters, UPDATE_HEADERS, updateHeaders, updateUrlAllowed, type FilterSession } from './net.ts'

describe('the update requests’ rules', () => {
  it('U-DST-15 · only Kea’s releases on GitHub and the release-asset hosts, over https; the test stand-in only when given', () => {
    const allowed = updateUrlAllowed({ owner: 'NathanMartinNZ', name: 'kea' })
    for (const ok of [
      'https://github.com/NathanMartinNZ/kea/releases/latest/download/SHA256SUMS',
      'https://github.com/nathanmartinnz/kea/releases/download/v1.0.3/SHA256SUMS',
      'https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x',
      'https://objects.githubusercontent.com/x',
    ])
      expect(allowed(ok), ok).toBe(true)
    for (const no of [
      'http://github.com/NathanMartinNZ/kea/releases/latest/download/SHA256SUMS',
      'https://github.com/NathanMartinNZ/kea/archive/main.zip',
      'https://github.com/someone/kea/releases/latest/download/SHA256SUMS',
      'https://github.com.evil.example/NathanMartinNZ/kea/releases/',
      'https://githubusercontent.com.evil.example/x',
      'https://user:pw@github.com/NathanMartinNZ/kea/releases/x',
      'https://github.com:8443/NathanMartinNZ/kea/releases/x',
      'http://127.0.0.1:4000/releases/latest/download/SHA256SUMS',
      'not a url',
    ])
      expect(allowed(no), no).toBe(false)
    const standIn = updateUrlAllowed({ owner: 'NathanMartinNZ', name: 'kea' }, 'http://127.0.0.1:4000')
    expect(standIn('http://127.0.0.1:4000/releases/latest/download/SHA256SUMS')).toBe(true)
    expect(standIn('http://127.0.0.1:4001/x')).toBe(false)
  })

  it('U-DST-16 · every request leaves with User-Agent Kea and Accept-Language en, its cookie dropped; a refused one is cancelled and reported; the removal clears both filters', () => {
    expect(updateHeaders({ Cookie: 'a=b', 'user-agent': 'Electron/44', 'accept-language': 'de', Accept: '*/*' })).toEqual({ Accept: '*/*', ...UPDATE_HEADERS })
    expect(UPDATE_HEADERS).toEqual({ 'User-Agent': 'Kea', 'Accept-Language': 'en' })
    const listeners: { req: unknown; headers: unknown } = { req: null, headers: null }
    const ses: FilterSession = {
      webRequest: {
        onBeforeRequest: (l) => void (listeners.req = l),
        onBeforeSendHeaders: (l) => void (listeners.headers = l),
      },
    }
    const refused: string[] = []
    const remove = installUpdateFilters(ses, (u) => u.startsWith('https://ok/'), UPDATE_HEADERS, (u) => refused.push(u))
    const answers: unknown[] = []
    ;(listeners.req as (d: { url: string }, cb: (r: unknown) => void) => void)({ url: 'https://ok/a' }, (r) => answers.push(r))
    ;(listeners.req as (d: { url: string }, cb: (r: unknown) => void) => void)({ url: 'https://elsewhere/b' }, (r) => answers.push(r))
    expect(answers).toEqual([{ cancel: false }, { cancel: true }])
    expect(refused).toEqual(['https://elsewhere/b'])
    ;(listeners.headers as (d: { requestHeaders: Record<string, string> }, cb: (r: unknown) => void) => void)({ requestHeaders: { Cookie: 'x' } }, (r) => answers.push(r))
    expect(answers.at(-1)).toEqual({ requestHeaders: UPDATE_HEADERS })
    remove()
    expect(listeners).toEqual({ req: null, headers: null })
  })
})
