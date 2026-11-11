// The window's one scrollbar as data. Every hand-written stylesheet of the window (the renderer's and `packages/ui`'s,
// a component's <style> included; generated tokens left out) is read as rules, and every script and component as text
// for the standard scrollbar properties. Nothing here renders.
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
  /** Its place among all the rules read. */
  at: number
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

function parse(file: string, text: string, rules: Rule[]): void {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '')
  let i = 0
  for (;;) {
    const open = css.indexOf('{', i)
    if (open < 0) return
    const close = closing(css, open)
    const prelude = css.slice(i, open).trim()
    const body = css.slice(open + 1, close)
    i = close + 1
    if (prelude.startsWith('@keyframes') || prelude.startsWith('@font-face')) continue
    if (prelude.startsWith('@property')) rules.push({ file, selector: prelude.replace(/\s+/g, ' '), decls: declarations(body), at: rules.length })
    else if (prelude.startsWith('@')) parse(file, body, rules)
    else for (const selector of selectors(prelude)) rules.push({ file, selector, decls: declarations(body), at: rules.length })
  }
}

const all = SOURCES.flatMap((d) => files(d)).filter((f) => !f.endsWith('.test.ts'))
const rules: Rule[] = []
for (const f of all) {
  const name = relative(ROOT, f)
  if (f.endsWith('.css')) parse(name, readFileSync(f, 'utf8'), rules)
  else if (f.endsWith('.svelte')) for (const m of readFileSync(f, 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) parse(name, m[1]!, rules)
}

/** What the rules of `selector` set `prop` to, the last one winning; undefined when none does. */
function value(selector: string, prop: string): string | undefined {
  return rules.filter((r) => r.selector === selector && r.decls.has(prop)).at(-1)?.decls.get(prop)
}

/** `--text-1` at an opacity token, over whatever is behind. */
const mix = (opacity: string) => `color-mix(in srgb, var(--text-1) calc(var(${opacity}) * 100%), transparent)`
const SHOWN = mix('--opacity-scrollbar')
const UNDER_POINTER = mix('--opacity-scrollbar-hover')
/** xterm's own rule for its slider, into which it writes the theme's colours. */
const XTERM_SLIDER = '.xterm .xterm-scrollable-element > .xterm-scrollbar > .xterm-slider'

describe('scrollbars', () => {
  it('DS-12 · one scrollbar for the window: a single block in styles.css draws every scrolling container’s bar --size-scrollbar wide with no arrows on a transparent track, its thumb hidden until the pointer is over the container or the keyboard is inside it (a colour the container itself takes, which nothing inherits, so Chromium paints the thumb again) and wider under the pointer, every size and colour a token; xterm’s viewport keeps its own; the tab strip shows none; nothing sets the standard scrollbar properties; the terminal’s slider takes the same width and colours', () => {
    expect(rules.length, 'the stylesheets were read').toBeGreaterThan(200)
    const custom = rules.filter((r) => r.selector.includes('::-webkit-scrollbar'))
    // one block, in one stylesheet: no container draws a bar of its own
    expect([...new Set(custom.map((r) => r.file))]).toEqual(['app/renderer/src/styles.css'])

    // never the standard properties: either one set on an element turns its ::-webkit-scrollbar styles off
    const standard = /^scrollbar-(width|color)$/
    expect(rules.filter((r) => [...r.decls.keys()].some((p) => standard.test(p))).map((r) => `${r.file} ${r.selector}`)).toEqual([])
    const scripts = all.filter((f) => f.endsWith('.ts') || f.endsWith('.svelte'))
    expect(scripts.length).toBeGreaterThan(100)
    expect(scripts.filter((f) => /scrollbar-(width|color)|scrollbar(Width|Color)/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f))).toEqual([])

    // the bar: --size-scrollbar either way, no arrows, nothing drawn but the thumb; xterm's viewport, which never
    // scrolls itself and lays xterm's own scrollbar out beside the system's, is left as it is
    const BAR = ':not(.xterm-viewport)::-webkit-scrollbar'
    expect(custom.filter((r) => /(^|[^-\w])::-webkit-scrollbar$/.test(r.selector) && r.decls.has('width')).map((r) => r.selector)).toEqual([BAR])
    expect([value(BAR, 'width'), value(BAR, 'height'), value(BAR, 'background')]).toEqual(['var(--size-scrollbar)', 'var(--size-scrollbar)', 'transparent'])
    expect([value('::-webkit-scrollbar-track', 'background'), value('::-webkit-scrollbar-corner', 'background')]).toEqual(['transparent', 'transparent'])
    expect(value('::-webkit-scrollbar-button', 'display')).toBe('none')
    // the thumb: its colour is the container's --scrollbar-thumb, a hairline of transparent border on each side so it
    // reads narrower than the bar
    const THUMB = '::-webkit-scrollbar-thumb'
    expect([value(THUMB, 'background-color'), value(THUMB, 'border'), value(THUMB, 'background-clip'), value(THUMB, 'border-radius')]).toEqual(['var(--scrollbar-thumb)', 'var(--size-hairline) solid transparent', 'padding-box', 'var(--radius-sm)'])
    // Chromium paints the thumb again only when the container's own style changes, never for a state in the thumb's
    // selector: so the container takes the colour while the pointer is over it or the keyboard is inside it, no
    // element inherits it (transparent otherwise: hidden at rest), and the thumb reads it from its container
    expect(custom.filter((r) => /:(hover|focus-within)::-webkit-scrollbar/.test(r.selector)).map((r) => r.selector)).toEqual([])
    const prop = rules.filter((r) => r.selector === '@property --scrollbar-thumb')
    expect(prop.map((r) => [r.file, r.decls.get('syntax'), r.decls.get('inherits'), r.decls.get('initial-value')])).toEqual([['app/renderer/src/styles.css', "'<color>'", 'false', 'transparent']])
    const setting = rules.filter((r) => r.decls.has('--scrollbar-thumb'))
    expect(setting.map((r) => `${r.file} ${r.selector} ${r.decls.get('--scrollbar-thumb')}`)).toEqual([
      `app/renderer/src/styles.css :hover ${SHOWN}`,
      `app/renderer/src/styles.css :focus-within ${SHOWN}`,
      `app/renderer/src/styles.css ${THUMB} inherit`,
    ])
    // brighter and the bar's full width under the pointer and while dragged; later than the thumb's own rule
    const base = rules.filter((r) => r.selector === THUMB)
    for (const s of [`${THUMB}:hover`, `${THUMB}:active`]) {
      expect([value(s, 'background-color'), value(s, 'border-width')], s).toEqual([UNDER_POINTER, '0'])
      const own = rules.filter((r) => r.selector === s)
      expect(Math.min(...own.map((r) => r.at)), s).toBeGreaterThan(Math.max(...base.map((r) => r.at)))
    }
    // the tab strip scrolls without one
    expect(value('.tabs::-webkit-scrollbar', 'display')).toBe('none')
    // every size and colour in the block is a token or a keyword
    const literal = [...custom, ...setting, ...prop].flatMap((r) => [...r.decls].filter(([, v]) => /\d/.test(v.replace(/var\(--[\w-]+\)/g, '').replace(/\* 100%/g, '').replace(/\b0\b/g, ''))).map(([p, v]) => `${r.selector} { ${p}: ${v} }`))
    expect(literal).toEqual([])

    // the terminal: xterm's slider, --size-scrollbar wide, in the same two colours, with the same thumb shape; each rule
    // is xterm's own with one class more, so it wins over the colours xterm writes for it
    expect(value('.kea-terminal .xterm-scrollbar.xterm-vertical > .xterm-slider', 'width')).toBe('var(--size-scrollbar) !important')
    const slider = `.kea-terminal ${XTERM_SLIDER}`
    expect([value(slider, 'background-color'), value(slider, 'border'), value(slider, 'background-clip'), value(slider, 'border-radius'), value(slider, 'box-sizing')]).toEqual([
      SHOWN,
      'var(--size-hairline) solid transparent',
      'padding-box',
      'var(--radius-sm)',
      'border-box',
    ])
    for (const s of [`${slider}:hover`, `${slider}.xterm-active`]) expect([value(s, 'background-color'), value(s, 'border-width')], s).toEqual([UNDER_POINTER, '0'])
  })
})
