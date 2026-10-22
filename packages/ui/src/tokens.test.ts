// Design-token checks computed from constants/tokens.json and the generated syntax theme.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const up = dirname(dir)
    if (up === dir) throw new Error('kea repo root not found')
    dir = up
  }
  return dir
}

const root = repoRoot()
// The private specification (.plan/) is not in a public clone: the comparison with it skips there, unless
// KEA_REQUIRE_PLAN=1. This is the check of tools/trace/src/presence.ts, repeated because a package's tests cannot
// import from tools/.
const NO_PLAN = '.plan/ (the private specification) is not in this checkout'
const noPlan = !existsSync(join(root, '.plan')) && process.env.KEA_REQUIRE_PLAN !== '1'
type Leaf = { $value: string }
type Tokens = {
  color: Record<string, Leaf>
  contrast: { text: string[]; surfaces: string[]; min: number }
  terminalContrast: { text: string[]; dark: string[]; light: string[]; min: number; cursorMin: number }
  terminal: Record<string, Record<string, Leaf> & { $extensions?: { kea?: { label?: string; scheme?: string } } }>
  syntax: Record<string, Leaf & { scopes: string[]; fontStyle?: string }>
}
const tokens = JSON.parse(readFileSync(join(root, 'constants/tokens.json'), 'utf8')) as Tokens
type Theme = { colors: Record<string, string>; tokenColors: { name: string; scope: string[]; settings: { foreground: string; fontStyle?: string } }[] }
const theme = JSON.parse(readFileSync(join(root, 'packages/ui/src/generated/syntax-theme.json'), 'utf8')) as Theme

/** sRGB colour → [r, g, b, alpha]; null for anything that is not #rgb / #rrggbb / rgb() / rgba(). */
function parseColour(c: string): [number, number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((x) => x + x).join('') : hex[1]!
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c.trim())
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] === undefined ? 1 : Number(fn[4])]
  return null
}

/** WCAG 2.x relative luminance and contrast ratio. */
function luminance([r, g, b]: [number, number, number, number]): number {
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: string, b: string): number {
  const ca = parseColour(a)
  const cb = parseColour(b)
  if (!ca || !cb) throw new Error(`not a colour: ${a} / ${b}`)
  const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const opaque = (c: string) => parseColour(c)?.[3] === 1
const resolve = (ref: string): string => {
  const m = /^\{([^}]+)\}$/.exec(ref)
  if (!m) return ref
  let node: unknown = tokens
  for (const part of m[1]!.split('.')) node = (node as Record<string, unknown>)[part]
  return resolve((node as Leaf).$value)
}

describe('design tokens', () => {
  it('DS-1 · every text and semantic token reaches contrast.min on every listed surface', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    const failures: string[] = []
    let checked = 0
    for (const surface of tokens.contrast.surfaces) {
      const bg = tokens.color[surface]!.$value
      expect(opaque(bg), `${surface} must be opaque`).toBe(true)
      for (const name of tokens.contrast.text) {
        const fg = tokens.color[name]!.$value
        if (!opaque(fg)) continue // a wash over an unknown backdrop has no single ratio
        checked++
        const ratio = contrast(fg, bg)
        if (ratio < tokens.contrast.min) failures.push(`${name} ${fg} on ${surface} ${bg}: ${ratio.toFixed(2)} : 1`)
      }
    }
    expect(checked).toBeGreaterThan(0)
    expect(failures, `below ${tokens.contrast.min} : 1`).toEqual([])
  })

  it('DS-7 · every bundled terminal theme: its text colours reach terminalContrast.min on its own background, its cursor cursorMin, and its scheme is the one its colours make', () => {
    const spec = tokens.terminalContrast
    const failures: string[] = []
    const themes = Object.entries(tokens.terminal)
    expect(themes.map(([id]) => id), 'Kea Dark and at least one light theme').toEqual(expect.arrayContaining(['kea-dark', 'kea-light']))
    for (const [id, t] of themes) {
      const scheme = t.$extensions?.kea?.scheme
      expect(t.$extensions?.kea?.label, `${id} has a name`).toBeTruthy()
      expect(['dark', 'light'], `${id} names its scheme`).toContain(scheme)
      const bg = t.background!.$value
      const fg = t.foreground!.$value
      // the scheme a program is told (the mirror's answer to CSI ? 996 n) is decided from these two colours
      const dark = luminance(parseColour(bg)!) < luminance(parseColour(fg)!)
      expect(dark ? 'dark' : 'light', `${id}: its colours make the scheme it names`).toBe(scheme)
      for (const name of [...spec.text, ...(dark ? spec.dark : spec.light)]) {
        const ratio = contrast(t[name]!.$value, bg)
        if (ratio < spec.min) failures.push(`${id}: ${name} ${t[name]!.$value} on ${bg}: ${ratio.toFixed(2)} : 1`)
      }
      const cursor = contrast(t.cursor!.$value, bg)
      if (cursor < spec.cursorMin) failures.push(`${id}: cursor ${t.cursor!.$value} on ${bg}: ${cursor.toFixed(2)} : 1`)
      // selected text stays readable: the foreground on the selection, active and inactive
      for (const sel of ['selectionBackground', 'selectionInactiveBackground']) {
        const ratio = contrast(fg, t[sel]!.$value)
        if (ratio < spec.min) failures.push(`${id}: foreground on ${sel}: ${ratio.toFixed(2)} : 1`)
      }
      // every theme states the same colours (the xterm theme and the mirror's 16-colour palette are built from them)
      expect(Object.keys(t).filter((k) => !k.startsWith('$')).sort(), `${id} states every colour Kea Dark does`).toEqual(Object.keys(tokens.terminal['kea-dark']!).filter((k) => !k.startsWith('$')).sort())
    }
    expect(failures, `below the terminal contrast minimum`).toEqual([])
  })

  it('DS-3 · the syntax theme covers every syntax class with its named colour, each ≥ 4.5 : 1 on surface-0', ({ skip }) => {
    const surface0 = tokens.color['surface-0']!.$value
    expect(theme.colors['editor.background']).toBe(surface0)

    // contrast of every syntax colour on the canvas
    const low = theme.tokenColors
      .map((t) => ({ name: t.name, fg: t.settings.foreground, ratio: contrast(t.settings.foreground, surface0) }))
      .filter((t) => t.ratio < 4.5)
      .map((t) => `${t.name} ${t.fg}: ${t.ratio.toFixed(2)} : 1`)
    expect(low, 'syntax colours below 4.5 : 1 on surface-0').toEqual([])

    // every row of the private specification's syntax-theme table maps to theme scopes in the colour it names
    skip(noPlan, NO_PLAN)
    const design = readFileSync(join(root, '.plan/plan/05-design-system.md'), 'utf8')
    const section = design.slice(design.indexOf('**Syntax theme "Kea Dark"**'), design.indexOf('The accent orange is never used for syntax'))
    const rows = [...section.matchAll(/^\| ([^|]+?) \| ([^|]+?) \|$/gm)].map((m) => [m[1]!.trim(), m[2]!.trim()] as const).filter(([k]) => k !== 'Token' && !/^-+$/.test(k))
    // the TextMate scopes each design row stands for (DS-3: every class maps to a token)
    const SCOPES: Record<string, string[]> = {
      'Text, variables, parameters': ['variable', 'variable.parameter'],
      Comments: ['comment'],
      'Keywords, storage, control flow': ['keyword', 'storage', 'keyword.control'],
      Strings: ['string'],
      'Escapes, regex, constants in strings': ['constant.character.escape', 'string.regexp'],
      'Numbers, booleans, language constants': ['constant.numeric', 'constant.language'],
      'Function and method names': ['entity.name.function', 'support.function'],
      'Types, classes, interfaces': ['entity.name.type', 'entity.name.class'],
      'Properties, object keys': ['variable.other.property', 'meta.object-literal.key'],
      'Tags (HTML / JSX)': ['entity.name.tag'],
      Attributes: ['entity.other.attribute-name'],
      'Operators, punctuation': ['keyword.operator', 'punctuation'],
      'Markdown headings': ['markup.heading'],
      Links: ['markup.underline.link'],
      Invalid: ['invalid'],
    }
    const term = tokens.terminal['kea-dark']!
    const colourOf = (named: string): string => {
      const n = named.replace(/,.*$/, '').replace(/`/g, '').trim()
      if (n === 'terminal foreground') return term.foreground!.$value
      if (n.startsWith('--')) return tokens.color[n.slice(2)]!.$value
      const key = n.replace(/ (\w)/g, (_, c: string) => c.toUpperCase()) // "bright blue" → brightBlue
      return term[key]!.$value
    }
    expect(rows.length).toBe(Object.keys(SCOPES).length)
    const problems: string[] = []
    for (const [cls, named] of rows) {
      const scopes = SCOPES[cls]
      if (!scopes) {
        problems.push(`syntax class "${cls}" has no scope mapping in DS-3`)
        continue
      }
      const want = colourOf(named).toUpperCase()
      for (const scope of scopes) {
        const entry = theme.tokenColors.find((t) => t.scope.includes(scope))
        if (!entry) problems.push(`${cls}: scope ${scope} missing from the theme`)
        else if (entry.settings.foreground.toUpperCase() !== want) problems.push(`${cls}: ${scope} is ${entry.settings.foreground}, design says ${named} (${want})`)
      }
    }
    expect(problems).toEqual([])

    // no italics; bold only for Markdown headings; the accent orange never used for syntax
    for (const t of theme.tokenColors) {
      expect(t.settings.fontStyle ?? '', t.name).not.toMatch(/italic/)
      if (/bold/.test(t.settings.fontStyle ?? '')) expect(t.scope, t.name).toContain('markup.heading')
      expect(t.settings.foreground.toUpperCase(), t.name).not.toBe(resolve('{color.accent}').toUpperCase())
    }
  })
})
