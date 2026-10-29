import { describe, expect, it } from 'vitest'
import { DEFAULT_WRAP, toggledWrap, wrapFor, wrapKind } from './wrap.ts'

describe('word wrap in the file view', () => {
  it('U-FV-18 · Markdown and MDX wrap by default and code does not; ⌥Z flips only the kind on screen; a file the large-file policy forbids wrap for never wraps', () => {
    expect([wrapKind('markdown'), wrapKind('mdx'), wrapKind('typescript'), wrapKind(null), wrapKind(undefined)]).toEqual(['prose', 'prose', 'code', 'code', 'code'])
    // before any choice
    expect(wrapFor('markdown', DEFAULT_WRAP, true)).toBe(true)
    expect(wrapFor('mdx', DEFAULT_WRAP, true)).toBe(true)
    expect(wrapFor('typescript', DEFAULT_WRAP, true)).toBe(false)
    // plain text (no language) reads as code
    expect(wrapFor(null, DEFAULT_WRAP, true)).toBe(false)
    // ⌥Z on a Markdown file turns Markdown's off and leaves code's alone
    const proseOff = toggledWrap('markdown', DEFAULT_WRAP)
    expect(proseOff).toEqual({ prose: false, code: false })
    expect(wrapFor('mdx', proseOff, true)).toBe(false)
    // ⌥Z on a code file turns code's on and leaves Markdown's alone
    const codeOn = toggledWrap('typescript', proseOff)
    expect(codeOn).toEqual({ prose: false, code: true })
    expect([wrapFor('typescript', codeOn, true), wrapFor('markdown', codeOn, true)]).toEqual([true, false])
    // the policy wins whatever the choice
    expect(wrapFor('markdown', DEFAULT_WRAP, false)).toBe(false)
    expect(wrapFor('typescript', codeOn, false)).toBe(false)
    // the flags given are never changed
    expect(DEFAULT_WRAP).toEqual({ prose: true, code: false })
  })
})
