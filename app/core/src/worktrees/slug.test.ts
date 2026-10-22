import fc from 'fast-check'
import { L } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { branchFor, projectSlug, randomSlug, SLUG_RE, slugFromPrompt, uniqueSlug } from './slug.ts'

/** A seeded RNG (mulberry32): the same seed gives the same words. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('session slugs', () => {
  it('U-WT-3 · prompt → slug: lowercase, stop-words dropped, the first L.slugMaxWords words, ≤ L.slugMaxChars of [a-z0-9-]', () => {
    expect(slugFromPrompt('Fix the auth redirect')).toBe('fix-auth-redirect')
    expect(slugFromPrompt('Please fix the login redirect loop')).toBe('fix-login-redirect-loop')
    expect(slugFromPrompt('fix the login redirect loop')).toBe('fix-login-redirect-loop')
    expect(slugFromPrompt('one two three four five six seven').split('-')).toHaveLength(L.slugMaxWords)
    expect(slugFromPrompt('Café résumé naïve')).toBe('cafe-resume-naive')
    expect(slugFromPrompt('🚀 ship it 🎉 now')).toBe('ship-now')
    expect(slugFromPrompt('修复 登录')).toBe('')
    expect(slugFromPrompt('--help; rm -rf ~ # $(whoami) `id`')).toBe('help-rm-rf-whoami-id')
    expect(slugFromPrompt('../../etc/passwd')).toBe('etc-passwd')
    expect(slugFromPrompt("don't break the build")).toBe('dont-break-build')
    const long = slugFromPrompt('internationalization localization globalization accessibility')
    expect(long.length).toBeLessThanOrEqual(L.slugMaxChars)
    expect(long).toMatch(SLUG_RE)
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 300 }), (p) => {
        const s = slugFromPrompt(p)
        expect(s.length).toBeLessThanOrEqual(L.slugMaxChars)
        if (s) expect(s).toMatch(SLUG_RE)
      }),
      { numRuns: 500 },
    )
    expect(branchFor('kea/', 'fix-auth')).toBe('kea/fix-auth')
    expect(projectSlug('/Users/x/My Project!')).toBe('my-project')
    expect(projectSlug('/x/日本')).toBe('project')
  })

  it('U-WT-4 · an empty or whitespace prompt gets two random words, the same ones for the same seed', () => {
    for (const p of ['', '   \n\t ', 'the a of']) expect(slugFromPrompt(p)).toBe('')
    const a = randomSlug(seeded(7))
    expect(a).toMatch(/^[a-z]+-[a-z]+$/)
    expect(randomSlug(seeded(7))).toBe(a)
    const seen = new Set(Array.from({ length: 50 }, (_, i) => randomSlug(seeded(i))))
    expect(seen.size).toBeGreaterThan(10)
    expect(randomSlug(() => 0.999999)).toMatch(SLUG_RE)
  })

  it('U-WT-5 · a taken slug gets -2, -3…: a session slug, an existing branch and an existing directory all count; the suffix stays within the cap', async () => {
    const sessions = new Set(['fix-auth'])
    const branches = new Set(['kea/fix-auth-2'])
    const dirs = new Set(['fix-auth-3'])
    const taken = (s: string) => sessions.has(s) || branches.has(`kea/${s}`) || dirs.has(s)
    expect(await uniqueSlug('fix-auth', taken)).toBe('fix-auth-4')
    expect(await uniqueSlug('other', taken)).toBe('other')
    const max = 'a'.repeat(L.slugMaxChars)
    const s = await uniqueSlug(max, (x) => x === max)
    expect(s).toBe(`${'a'.repeat(L.slugMaxChars - 2)}-2`)
    expect(s.length).toBeLessThanOrEqual(L.slugMaxChars)
    expect(await uniqueSlug('x', async (v) => v === 'x' || v === 'x-2')).toBe('x-3')
  })
})
