import { describe, expect, it } from 'vitest'
import { externalUrl } from './links.ts'

describe('external links', () => {
  it('U-TERM-13 · main hands only http, https and mailto URLs to the system, whatever the renderer asked for', () => {
    expect(externalUrl('https://example.com/x')).toBe('https://example.com/x')
    expect(externalUrl('http://example.com')).toBe('http://example.com/')
    expect(externalUrl('mailto:a@example.com')).toBe('mailto:a@example.com')
    // os-ok: test data
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://x', 'data:text/plain,x', 'kea://app/index.html', 'not a url', 'https://']) expect(externalUrl(u), u).toBeNull()
  })
})
