// The design's motion table as data: what may move, and that it stands still under reduced motion. Every hand-written
// stylesheet of the window (the renderer's and `packages/ui`'s; generated tokens left out) is read as rules, and every
// script and component as text. Nothing here renders: a rule that is not in the styles cannot run.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '../../../..')
const SOURCES = [join(ROOT, 'app/renderer/src'), join(ROOT, 'packages/ui/src')]

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== 'generated' && e.name !== 'node_modules') files(join(dir, e.name), out)
    } else out.push(join(dir, e.name))
  }
  return out
}

interface Rule {
  file: string
  selector: string
  decls: Map<string, string>
  /** Inside `@media (prefers-reduced-motion: reduce)`. */
  reduced: boolean
  /** Its place in its file. */
  at: number
}
interface Keyframes {
  file: string
  name: string
  props: Set<string>
}

/** The index of the brace that closes the block opened at `open`. */
function closing(css: string, open: number): number {
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return i
  }
  throw new Error('unbalanced braces')
}

/** Selectors of a list, split at its top-level commas. */
function selectors(prelude: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < prelude.length; i++) {
    if (prelude[i] === '(') depth++
    else if (prelude[i] === ')') depth--
    else if (prelude[i] === ',' && depth === 0) {
      out.push(prelude.slice(from, i))
      from = i + 1
    }
  }
  out.push(prelude.slice(from))
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const d of body.split(';')) {
    const colon = d.indexOf(':')
    if (colon > 0) out.set(d.slice(0, colon).trim(), d.slice(colon + 1).replace(/\s+/g, ' ').trim())
  }
  return out
}

function parse(file: string, text: string, sheet: { rules: Rule[]; keyframes: Keyframes[] }, reduced = false): void {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '')
  let i = 0
  for (;;) {
    const open = css.indexOf('{', i)
    if (open < 0) return
    const close = closing(css, open)
    const prelude = css.slice(i, open).trim()
    const body = css.slice(open + 1, close)
    i = close + 1
    if (prelude.startsWith('@keyframes')) {
      const props = new Set<string>()
      for (const step of body.matchAll(/\{([^}]*)\}/g)) for (const p of declarations(step[1]!).keys()) props.add(p)
      sheet.keyframes.push({ file, name: prelude.slice('@keyframes'.length).trim(), props })
    } else if (prelude.startsWith('@font-face')) {
      // no selector
    } else if (prelude.startsWith('@')) {
      parse(file, body, sheet, reduced || /prefers-reduced-motion:\s*reduce/.test(prelude))
    } else {
      for (const selector of selectors(prelude)) sheet.rules.push({ file, selector, decls: declarations(body), reduced, at: sheet.rules.length })
    }
  }
}

const all = SOURCES.flatMap((d) => files(d)).filter((f) => !f.endsWith('.test.ts'))
const sheet: { rules: Rule[]; keyframes: Keyframes[] } = { rules: [], keyframes: [] }
for (const f of all) {
  const name = relative(ROOT, f)
  if (f.endsWith('.css')) parse(name, readFileSync(f, 'utf8'), sheet)
  else if (f.endsWith('.svelte')) for (const m of readFileSync(f, 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) parse(name, m[1]!, sheet)
}

const MOVES = /^(transition|animation)(-|$)/
/** The one transition: the columns, when a panel collapses or comes back. */
const PANEL = 'grid-template-columns var(--motion-panel) ease-out'
const SPINNER = 'kea-spin var(--motion-spinner) linear infinite'
/** A floating layer coming in: its keyframes over `--motion-float-in`, once (a tooltip after its delay). */
const FLOAT_IN = /^([\w-]+) var\(--motion-float-in\) linear( var\(--motion-tooltip-delay\))?( both)?$/

describe('motion', () => {
  it('DS-8 · the only things that move are the working spinner, the panel collapse and a floating layer’s 80 ms fade-in: no other transition or animation is declared, no keyframes move anything but opacity (the spinner: a rotation), nothing but the spinner repeats, and no script animates', () => {
    expect(sheet.rules.length, 'the stylesheets were read').toBeGreaterThan(200)
    const moving = sheet.rules.filter((r) => !r.reduced).flatMap((r) => [...r.decls].filter(([p]) => MOVES.test(p)).map(([prop, value]) => ({ where: `${r.file} ${r.selector}`, prop, value })))
    const still = moving.filter((m) => m.value === 'none')
    const live = moving.filter((m) => m.value !== 'none')
    // every declaration is the shorthand, so nothing hides in a `transition-duration` or an `animation-delay`
    expect(moving.filter((m) => m.prop !== 'transition' && m.prop !== 'animation')).toEqual([])
    // hover, selection and tab switches are instant: one transition in all, the columns'
    const transitions = live.filter((m) => m.prop === 'transition')
    expect(transitions.map((m) => `${m.where}: ${m.value}`)).toEqual([`app/renderer/src/shell/window.css .window: ${PANEL}`])
    // dragging the divider follows the pointer at once
    expect(still.map((m) => m.where)).toContain('app/renderer/src/shell/window.css .window.resizing')
    // animations: the spinner, and floating layers coming in
    const animations = live.filter((m) => m.prop === 'animation')
    const spinners = animations.filter((m) => m.value === SPINNER)
    expect(spinners.map((m) => m.where)).toEqual(['packages/ui/src/ui.css .kea-glyph-working'])
    const floats = animations.filter((m) => m.value !== SPINNER)
    expect(floats.length, 'floating layers fade in').toBeGreaterThan(3)
    expect(floats.filter((m) => !FLOAT_IN.test(m.value)).map((m) => `${m.where}: ${m.value}`)).toEqual([])
    // a pulse would repeat: nothing but the spinner does (the needs-you dot is static)
    expect(animations.filter((m) => /infinite|alternate|\b\d+\b(?!ms|s)/.test(m.value) && m.value !== SPINNER)).toEqual([])
    // keyframes: a fade in is opacity alone (out is instant: no keyframes end at 0), the spinner a rotation alone
    const frames = new Map(sheet.keyframes.map((k) => [k.name, k]))
    expect(frames.size, 'no two keyframes share a name').toBe(sheet.keyframes.length)
    const used = new Set([...floats.map((m) => FLOAT_IN.exec(m.value)![1]!), 'kea-spin'])
    expect([...frames.keys()].sort(), 'every keyframes is used, and every one used exists').toEqual([...used].sort())
    for (const [name, k] of frames) expect([...k.props], name).toEqual([name === 'kea-spin' ? 'transform' : 'opacity'])
    // nothing scrolls smoothly, and no script or component animates (Svelte's transitions, the Web Animations API)
    expect(sheet.rules.filter((r) => r.decls.has('scroll-behavior')).map((r) => `${r.file} ${r.selector}`)).toEqual([])
    const scripted = /svelte\/(transition|animate|motion|easing)|\.animate\(|behavior:\s*['"]smooth|\s(transition|in|out|animate):[a-zA-Z]+[\s=>|]/
    const sources = all.filter((f) => f.endsWith('.ts') || f.endsWith('.svelte'))
    expect(sources.length).toBeGreaterThan(100)
    expect(sources.filter((f) => scripted.test(readFileSync(f, 'utf8').replace(/<style[^>]*>[\s\S]*?<\/style>/g, ''))).map((f) => relative(ROOT, f))).toEqual([])
  })

  it('DS-8 · under reduced motion nothing moves: every rule that animates or transitions is switched off by a later rule of the same selector in the same file, the spinner (a static glyph) and the panel collapse (instant) among them', () => {
    const live = sheet.rules.filter((r) => !r.reduced).flatMap((r) => [...r.decls].filter(([p, v]) => MOVES.test(p) && v !== 'none').map(([prop]) => ({ r, prop })))
    expect(live.length).toBeGreaterThan(4)
    const left: string[] = []
    for (const { r, prop } of live) {
      // the same selector, later in the same file: the same specificity, so the later rule wins the cascade
      const off = sheet.rules.find((x) => x.reduced && x.file === r.file && x.selector === r.selector && x.at > r.at && x.decls.get(prop) === 'none')
      if (!off) left.push(`${r.file} ${r.selector} { ${prop} }`)
    }
    expect(left).toEqual([])
    // the two the design names, by name: the spinner and the panel collapse
    const reduced = sheet.rules.filter((r) => r.reduced)
    expect(reduced.find((r) => r.selector === '.kea-glyph-working')?.decls.get('animation')).toBe('none')
    expect(reduced.find((r) => r.selector === '.window')?.decls.get('transition')).toBe('none')
    // and a reduced-motion rule only ever switches motion off
    expect(reduced.flatMap((r) => [...r.decls].filter(([p, v]) => !MOVES.test(p) || v !== 'none').map(([p, v]) => `${r.file} ${r.selector} { ${p}: ${v} }`))).toEqual([])
  })
})
