// Web addresses found in the viewer's text: VS Code's rules for where one ends, the schemes taken, the caps on what is
// read and found, and the link tip's words on each system.
import { EditorState } from '@codemirror/state'
import { L } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { linkAt } from './linkView.ts'
import { linkTipWords, scanWindow, urlAt, type LineSlice } from './links.ts'

const whole = (text: string): LineSlice => ({ text, cutStart: false, cutEnd: false })
/** The address found at the first occurrence of `at` in `line` (its first character), as written. */
const found = (line: string, at: string): string | null => urlAt(whole(line), line.indexOf(at))?.text ?? null

describe('web addresses in a line', () => {
  it('U-FV-35 · an http, https or mailto address runs to whitespace, < > " \' or a backquote, less a trailing . , ; : ! ? and an unmatched closing bracket', () => {
    expect(found('see https://x.dev/a for more', 'x.dev')).toBe('https://x.dev/a')
    for (const end of ['.', ',', ';', ':', '!', '?', '.)', '?!']) expect(found(`go to https://x.dev/a${end}`, 'x.dev'), end).toBe('https://x.dev/a')
    expect(found('(see https://x.dev/a)', 'x.dev')).toBe('https://x.dev/a')
    expect(found('{https://x.dev/a}', 'x.dev')).toBe('https://x.dev/a')
    // a bracket the address opens is its own
    expect(found('https://en.wikipedia.org/wiki/Kea_(bird) is green', 'wiki')).toBe('https://en.wikipedia.org/wiki/Kea_(bird)')
    expect(found('[https://x.dev/a[1]]', 'x.dev')).toBe('https://x.dev/a[1]')
    for (const q of ['"', "'", '`']) expect(found(`const u = ${q}https://x.dev/q?a=1${q}`, 'x.dev'), q).toBe('https://x.dev/q?a=1')
    expect(found('mailto:someone@example.com, and more', 'someone')).toBe('mailto:someone@example.com')
    expect(found('HTTPS://X.DEV/A', 'X.DEV')).toBe('HTTPS://X.DEV/A')
    // a scheme later in the same run is part of the first address
    expect(found('https://a.dev/?next=https://b.dev/x', 'b.dev')).toBe('https://a.dev/?next=https://b.dev/x')
    // the pointer on the text before the scheme, on what was trimmed, or on a stop is on nothing
    const line = '(see https://x.dev/a).'
    expect(urlAt(whole(line), line.indexOf('see'))).toBeNull()
    expect(urlAt(whole(line), line.indexOf(')'))).toBeNull()
    expect(urlAt(whole(line), line.length - 1)).toBeNull()
    expect(urlAt(whole(line), line.indexOf(' '))).toBeNull()
    expect(urlAt(whole(line), line.length)).toBeNull()
    // where it is in the slice, and what a click does with it
    expect(urlAt(whole(line), line.indexOf('x.dev'))).toEqual({ from: 5, to: 20, text: 'https://x.dev/a', action: { open: true, url: 'https://x.dev/a' } })
    // every character of the address finds it, its first and its last
    expect(urlAt(whole(line), 5)?.text).toBe('https://x.dev/a')
    expect(urlAt(whole(line), 19)?.text).toBe('https://x.dev/a')
  })

  it('U-FV-35 · the Markdown forms: [text](address), <address>, a reference definition with a title, an image', () => {
    expect(found('[the docs](https://x.dev/docs)', 'x.dev')).toBe('https://x.dev/docs')
    expect(found('[the docs](https://x.dev/docs).', 'x.dev')).toBe('https://x.dev/docs')
    expect(found('<https://x.dev/docs>', 'x.dev')).toBe('https://x.dev/docs')
    expect(found('[docs]: https://x.dev/docs "The docs"', 'x.dev')).toBe('https://x.dev/docs')
    expect(found('![logo](https://x.dev/logo.png)', 'x.dev')).toBe('https://x.dev/logo.png')
    // the link's own text is not the address
    expect(urlAt(whole('[the docs](https://x.dev/docs)'), 2)).toBeNull()
  })

  it('U-FV-35 · other schemes are not links; a scheme alone is none', () => {
    // os-ok: test data
    for (const line of ['ftp://x.dev/a', 'vscode://file/etc/passwd', 'javascript:alert(1)', 'file:///etc/passwd', 'ssh://host/x', 'data:text/html,x', 'https://', 'mailto:']) {
      expect(urlAt(whole(line), line.length - 1), line).toBeNull()
    }
  })

  it('U-FV-35 · an address with a control or bidi character is found, and the link policy refuses it, so a click offers to copy it', () => {
    const bidi = 'https://example.com/‮gnp.exe'
    expect(urlAt(whole(`see ${bidi} now`), 6)).toMatchObject({ text: bidi, action: { open: false, reason: 'malformed' } })
    const control = 'https://example.com/a\u0001b'
    expect(urlAt(whole(control), 3)).toMatchObject({ text: control, action: { open: false, reason: 'malformed' } })
  })

  it('U-FV-35 · an address is at most L.viewerLinkMaxChars long; a run the scan cut at either end is no link', () => {
    const base = 'https://x.dev/'
    const atCap = base + 'a'.repeat(L.viewerLinkMaxChars - base.length)
    expect(urlAt(whole(atCap), 3)?.text).toBe(atCap)
    expect(urlAt(whole(`${atCap}a`), 3)).toBeNull()
    // cut at its end, its start, or both: what was cut is not known
    expect(urlAt({ text: 'see https://x.dev/a', cutStart: false, cutEnd: true }, 6)).toBeNull()
    expect(urlAt({ text: 'ttps://x.dev/a and https://y.dev', cutStart: true, cutEnd: false }, 3)).toBeNull()
    // a cut away from the address changes nothing
    expect(urlAt({ text: 'x https://x.dev/a y', cutStart: true, cutEnd: true }, 4)?.text).toBe('https://x.dev/a')
  })

  it('U-FV-35 · only L.viewerLinkScanChars of a line are read, reaching the longest address on each side of the pointer, so a long minified line costs nothing', () => {
    expect(L.viewerLinkMaxChars).toBeLessThanOrEqual(L.linkOpenMaxChars)
    expect(L.viewerLinkScanChars).toBeGreaterThanOrEqual(2 * L.viewerLinkMaxChars)
    const w = scanWindow(0, 10_000_000, 5_000_000)
    // half the scan on each side of the pointer's own character
    expect(w).toEqual({ from: 5_000_000 - L.viewerLinkScanChars / 2, to: 5_000_001 + L.viewerLinkScanChars / 2 })
    expect(scanWindow(100, 120, 110)).toEqual({ from: 100, to: 120 })
    // the longest address, the pointer on its first or its last character, in the middle of a long line
    const url = 'https://x.dev/' + 'b'.repeat(L.viewerLinkMaxChars - 'https://x.dev/'.length)
    const pad = ';'.repeat(3 * L.viewerLinkScanChars)
    const state = EditorState.create({ doc: `${pad}"${url}"${pad}` })
    const start = pad.length + 1
    for (const pos of [start, start + url.length - 1, start + (url.length >> 1)]) expect(linkAt(state, pos)?.text, String(pos)).toBe(url)
    expect(linkAt(state, start)).toMatchObject({ from: start, to: start + url.length })
    expect(linkAt(state, pad.length)).toBeNull()
    // a run longer than the scan around the pointer is no link: its ends are not read
    const long = EditorState.create({ doc: `https://x.dev/${'c'.repeat(4 * L.viewerLinkScanChars)}` })
    expect(linkAt(long, 2 * L.viewerLinkScanChars)).toBeNull()
  })

  it('U-FV-35 · the tip: the whole address with its hidden characters written out, then how to open it with this system’s modifier, or why it is copied instead', () => {
    const open = { text: 'https://x.dev/a', action: { open: true as const, url: 'https://x.dev/a' } }
    expect(linkTipWords(open, 'darwin')).toEqual({ target: 'https://x.dev/a', action: '⌘-click to open' })
    expect(linkTipWords(open, 'linux')).toEqual({ target: 'https://x.dev/a', action: 'Ctrl-click to open' })
    const bidi = 'https://example.com/‮gnp.exe'
    for (const system of ['darwin', 'linux'] as const) {
      expect(linkTipWords({ text: bidi, action: { open: false, target: bidi, reason: 'malformed' } }, system)).toEqual({ target: 'https://example.com/\\u202egnp.exe', action: 'This address cannot be opened: copy it instead' })
      expect(linkTipWords({ text: 'https://x.dev/a', action: { open: false, target: 'https://x.dev/a', reason: 'long' } }, system).action).toBe('Too long to open: copy it instead')
      expect(linkTipWords({ text: 'ftp://x', action: { open: false, target: 'ftp://x', reason: 'scheme' } }, system).action).toBe('This address cannot be opened: copy it instead')
    }
  })
})
