import { L } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { checkLink, externalUrl } from './links.ts'

describe('external links', () => {
  it('U-TERM-13 · main hands only http, https and mailto URLs to the system, whatever the renderer asked for', () => {
    expect(externalUrl('https://example.com/x')).toBe('https://example.com/x')
    expect(externalUrl('http://example.com')).toBe('http://example.com/')
    expect(externalUrl('mailto:a@example.com')).toBe('mailto:a@example.com')
    // os-ok: test data
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://x', 'data:text/plain,x', 'kea://app/index.html', 'not a url', 'https://']) expect(externalUrl(u), u).toBeNull()
  })

  it('U-TERM-63 · main refuses an address longer than L.linkOpenMaxChars before parsing it, and one that grows past it once encoded', () => {
    const base = 'https://x.dev/'
    const atCap = base + 'a'.repeat(L.linkOpenMaxChars - base.length)
    expect(checkLink(atCap)).toEqual({ url: atCap })
    expect(checkLink(atCap + 'a')).toEqual({ why: 'long' })
    // too long to be worth parsing: refused for its length whatever it holds
    expect(checkLink('x'.repeat(L.linkOpenMaxChars + 1))).toEqual({ why: 'long' })
    // short as sent, long once parsed (the window sends URL.href, so this comes only from elsewhere)
    expect(checkLink(base + '😀'.repeat(Math.ceil((L.linkOpenMaxChars - base.length) / 12) + 1))).toEqual({ why: 'long' })
    expect(checkLink('vscode://x')).toEqual({ why: 'scheme' })
    expect(checkLink('not a url')).toEqual({ why: 'malformed' })
    expect(checkLink(42)).toEqual({ why: 'malformed' })
  })
})
