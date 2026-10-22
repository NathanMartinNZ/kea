// The syntax theme over the grammars the viewer bundles: every TextMate scope a bundled grammar can give, the
// grammars it embeds included, is read from the grammar itself and resolved by the generated theme. A scope class
// either has a row of the `syntax` table (constants/tokens.json) or is on the short list of classes drawn as the text
// around them. Nothing is tokenised: a class no file happens to use counts all the same.
import type { LanguageRegistration } from 'shiki/types'
import { describe, expect, it } from 'vitest'
import { SYNTAX_ROLES, SYNTAX_THEME } from './syntax.ts'
import { GRAMMARS } from './worker/grammars.ts'

/** TextMate's classes of things to colour (its naming convention); `meta`, `source` and `text` name structure. */
const ROOTS = ['comment', 'constant', 'entity', 'invalid', 'keyword', 'markup', 'punctuation', 'storage', 'string', 'support', 'variable'] as const

/**
 * Scope classes the `syntax` table gives no row: a token of one keeps the colour of what it stands in (the text's, a
 * string's, a comment's). By root, the second segment (`''`: the bare root). A class a grammar starts to use that is
 * neither here nor in the theme fails DS-4, and so does an entry no grammar uses any more.
 */
const AS_TEXT: Readonly<Record<string, readonly string[]>> = {
  // constants that are not a number, a language constant or a character: a name the code gives (a symbol, an enum
  // member, a date in TOML), and a character class inside a regex, which keeps the regex's colour
  constant: ['', 'codepoint-range', 'dec', 'enum', 'global', 'hex', 'keyword', 'name', 'object', 'other', 'regexp', 'sha', 'source', 'string', 'variable'],
  // names with no row of their own (a label, a package, a variable where it is declared): the table colours the names
  // of functions, types, tags, attributes and sections
  entity: ['directive', 'global', 'name', 'other', 'scalar', 'scope', 'source'],
  // prose: no italics, bold only for headings; the lines of a diff file are not syntax
  markup: ['bold', 'changed', 'deleted', 'inserted', 'italic', 'list', 'punctuation', 'quote', 'strikethrough', 'table', 'underline'],
  // what a library gives other than its functions, types and constants: its variables are variables, text
  support: ['attribute', 'keyword', 'other', 'unicode-range', 'variable'],
}

/** A theme selector that names one scope (a selector with an ancestor, `a b`, needs a stack and is left to DS-3). */
const SELECTORS = SYNTAX_THEME.tokenColors.flatMap((r) => r.scope.filter((s) => !s.includes(' ')).map((sel) => ({ sel, role: r.name })))

/** The role the theme gives a scope by itself: its longest selector that is the scope or a prefix of it; null: none. */
function roleOf(scope: string): string | null {
  let best: { sel: string; role: string } | null = null
  for (const s of SELECTORS) if ((scope === s.sel || scope.startsWith(`${s.sel}.`)) && (!best || s.sel.length > best.sel.length)) best = s
  return best?.role ?? null
}

/** Every scope name in a grammar: `name` and `contentName` of its rules and captures, wherever they nest. */
function scopesOf(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) scopesOf(n, into)
    return
  }
  if (!node || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'name' || k === 'contentName') && typeof v === 'string') {
      // (a scope built from a capture, `…$1`, has no fixed name)
      for (const s of v.split(/\s+/)) if (s && !s.includes('$')) into.add(s)
    } else scopesOf(v, into)
  }
}

describe('the syntax theme over the bundled grammars', () => {
  it('DS-4 · every TextMate scope class the bundled grammars use maps to a syntax token: the theme gives it a row’s colour, or it is one of the classes drawn as the text around them; every row is used; character constants are escapes and raw text is a string’s colour, in Markdown and in MDX alike', async () => {
    const loaded = await Promise.all(Object.values(GRAMMARS).map((load) => load()))
    const grammars = new Map<string, LanguageRegistration>()
    for (const mod of loaded) for (const g of mod.default) grammars.set(g.name, g)
    expect(grammars.size, 'the bundle and what it embeds').toBeGreaterThanOrEqual(Object.keys(GRAMMARS).length)
    const scopes = new Set<string>()
    for (const g of grammars.values()) {
      // the registration's own `name` is the language's, not a scope
      const { name: _name, scopeName: _scopeName, displayName: _displayName, aliases: _aliases, ...rules } = g
      scopesOf(rules, scopes)
    }
    expect(scopes.size, 'scopes read from the grammars').toBeGreaterThan(5000)

    const roles = new Set<string>()
    const unmapped = new Map<string, string>() // bounded: one entry per scope class without a theme rule (a few dozen)
    const perRoot = new Map<string, number>(ROOTS.map((r) => [r, 0]))
    for (const scope of scopes) {
      const [root = '', second = ''] = scope.split('.')
      const role = roleOf(scope)
      if (role) roles.add(role)
      if (!(ROOTS as readonly string[]).includes(root)) continue
      perRoot.set(root, (perRoot.get(root) ?? 0) + 1)
      if (!role) unmapped.set(`${root}.${second}`, scope)
    }
    // every class of TextMate's convention is used by some grammar (or this checks less than it says)
    expect([...perRoot].filter(([, n]) => n === 0)).toEqual([])
    // the classes with no row are exactly the ones named above: a new one must be given a row or named there
    const named = Object.entries(AS_TEXT).flatMap(([root, seconds]) => seconds.map((s) => `${root}.${s}`))
    expect([...unmapped].filter(([cls]) => !named.includes(cls)).map(([cls, scope]) => `${cls} (${scope})`), 'scope classes with no syntax token').toEqual([])
    expect(named.filter((cls) => !unmapped.has(cls)), 'classes named as text that no grammar leaves unmapped any more').toEqual([])
    // so comments, invalid code, keywords, punctuation, storage, strings and variables are covered whole
    expect(ROOTS.filter((r) => !Object.hasOwn(AS_TEXT, r))).toEqual(['comment', 'invalid', 'keyword', 'punctuation', 'storage', 'string', 'variable'])
    // every row of the table is a colour some grammar's scope takes
    expect(SYNTAX_ROLES.filter((r) => !roles.has(r))).toEqual([])

    // two of the table's rules, checked by name: escapes and constants in strings are one colour; inline code and
    // code fences take the string's colour, whichever grammar names them (Markdown `markup.inline.raw` /
    // `markup.fenced_code`, MDX `markup.raw.code` / `markup.code.<lang>`)
    const under = (prefix: string): string[] => [...scopes].filter((s) => s === prefix || s.startsWith(`${prefix}.`))
    for (const [prefix, role] of [['constant.character', 'escape'], ['markup.raw', 'string'], ['markup.code', 'string'], ['markup.inline.raw', 'string'], ['markup.fenced_code', 'string']] as const) {
      const list = under(prefix)
      expect(list.length, prefix).toBeGreaterThan(0)
      expect(list.filter((s) => roleOf(s) !== role), `${prefix} → ${role}`).toEqual([])
    }
    expect(roleOf('markup.raw.code.fenced.mdx')).toBe('string')
    expect(roleOf('constant.character.entity.tsx')).toBe('escape')
  })
})
