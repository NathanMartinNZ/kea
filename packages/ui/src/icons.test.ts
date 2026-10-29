// The icon set and the status glyphs as data: drawn in their box, one stroked family, hidden from or named for
// assistive technology, and sized and stroked by tokens. The components are rendered to markup with `svelte/server`
// (no DOM needed) and read back as elements.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Component } from 'svelte'
import { render } from 'svelte/server'
import { describe, expect, it } from 'vitest'
import { GLYPH_KINDS, GLYPH_LABELS, glyphTone, TONED_GLYPHS } from './glyphs.ts'
import Icon from './Icon.svelte'
import { ICON_NAMES } from './icons.ts'
import MoreIcon from './MoreIcon.svelte'
import StatusGlyph from './StatusGlyph.svelte'

type El = { tag: string; attrs: Record<string, string> }
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, 'ui.css'), 'utf8')

/** A component's markup as elements in document order (Svelte's hydration comments left out): its root, then the shapes under it. */
function rendered(component: Component<any>, props: Record<string, unknown> = {}): { root: El; shapes: El[] } {
  const html = render(component, { props }).body.replace(/<!--[\s\S]*?-->/g, '')
  const els = [...html.matchAll(/<([a-z]+)\b([^>]*)>/g)].map((m) => ({ tag: m[1]!, attrs: Object.fromEntries([...m[2]!.matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!])) }))
  const [root, ...shapes] = els
  if (!root) throw new Error(`nothing rendered: ${html}`)
  return { root, shapes }
}

/** The absolute end points of every segment of an SVG path (M L H V A Z, absolute or relative). */
function points(d: string): [number, number][] {
  const tokens = [...d.matchAll(/[MLHVAZmlhvaz]|-?\d*\.?\d+/g)].map((m) => m[0])
  const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, A: 7, Z: 0 }
  const out: [number, number][] = []
  let x = 0
  let y = 0
  let start: [number, number] = [0, 0]
  let cmd = ''
  for (let i = 0; i < tokens.length; ) {
    if (/[a-z]/i.test(tokens[i]!)) cmd = tokens[i++]!
    const up = cmd.toUpperCase()
    const rel = cmd !== up
    const n = arity[up]
    if (n === undefined) throw new Error(`path command ${cmd} not handled`)
    const a = tokens.slice(i, i + n).map(Number)
    i += n
    if (up === 'Z') [x, y] = start
    else if (up === 'H') x = rel ? x + a[0]! : a[0]!
    else if (up === 'V') y = rel ? y + a[0]! : a[0]!
    else {
      const [px, py] = up === 'A' ? [a[5]!, a[6]!] : [a[0]!, a[1]!]
      ;[x, y] = rel ? [x + px, y + py] : [px, py]
    }
    if (up === 'M') start = [x, y]
    out.push([x, y])
    if (n === 0 && i < tokens.length && !/[a-z]/i.test(tokens[i]!)) throw new Error('numbers after Z')
  }
  return out
}

/** The block of declarations of a CSS rule whose selector is exactly `sel`. */
function rule(sel: string): string {
  const m = new RegExp(`(?:^|\\n)${sel.replace(/[.*]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)
  if (!m) throw new Error(`no rule ${sel} in ui.css`)
  return m[1]!
}

describe('icons and status glyphs', () => {
  it('DS-5 · every icon is a 16-unit stroked path in currentColor, sized and stroked by tokens, hidden from assistive technology', () => {
    expect(ICON_NAMES.length).toBeGreaterThan(0)
    for (const name of ICON_NAMES) {
      const { root: el, shapes: paths } = rendered(Icon, { name })
      expect(el.tag, name).toBe('svg')
      expect(el.attrs.viewBox, name).toBe('0 0 16 16')
      expect(el.attrs['aria-hidden'], name).toBe('true')
      expect(el.attrs.class, name).toBe('kea-icon')
      expect(paths.length, name).toBe(1)
      const d = String(paths[0]!.attrs.d)
      const pts = points(d)
      expect(pts.length, name).toBeGreaterThan(1)
      for (const [x, y] of pts) expect(x >= 0 && x <= 16 && y >= 0 && y <= 16, `${name}: ${x},${y} outside the 16-unit box`).toBe(true)
      expect(paths[0]!.attrs.fill, `${name} has no fill of its own`).toBeUndefined()
    }
    // the overflow dots are the one filled glyph, in the same box
    const more = rendered(MoreIcon).root
    expect(more.attrs.viewBox).toBe('0 0 16 16')
    expect(more.attrs.class).toBe('kea-icon kea-icon-filled')
    // sized and stroked by tokens, in the current text colour
    const icon = rule('.kea-icon')
    expect(icon).toMatch(/width:\s*var\(--size-icon\)/)
    expect(icon).toMatch(/height:\s*var\(--size-icon\)/)
    expect(icon).toMatch(/stroke:\s*currentColor/)
    expect(icon).toMatch(/stroke-width:\s*var\(--size-icon-stroke\)/)
    expect(icon).toMatch(/fill:\s*none/)
  })

  it('DS-6 · every status glyph has its own shape, its colour token and an accessible label; the spinner turns once a second and stops under reduced motion', () => {
    expect(GLYPH_KINDS).toEqual(['working', 'needsYou', 'unread', 'idle', 'detached', 'failed', 'limited'])
    const colour: Record<string, string> = { working: '--text-2', needsYou: '--accent', unread: '--text-1', idle: '--text-3', detached: '--text-3', failed: '--danger', limited: '--text-3' }
    const signature = new Map<string, string>()
    for (const kind of GLYPH_KINDS) {
      const { root: el, shapes } = rendered(StatusGlyph, { kind })
      expect(el.attrs.role, kind).toBe('img')
      expect(el.attrs['aria-label'], kind).toBe(GLYPH_LABELS[kind])
      expect(el.attrs.viewBox, kind).toBe('0 0 12 12')
      // the shape: element types, radii, fills and dashes (colour aside)
      const sig = shapes.map((s) => `${s.tag}:${s.attrs.r ?? ''}:${s.attrs.class ?? ''}:${s.attrs.d ? 'path' : ''}`).join('|')
      expect(sig, `${kind} draws something`).not.toBe('')
      signature.set(kind, sig)
      // its colour is the glyph's own token
      const block = css.match(new RegExp(`\\.kea-glyph-${kind}[^{]*\\{([^}]*)\\}`))
      expect(block?.[1], `${kind} colour`).toContain(`var(${colour[kind]})`)
    }
    // shapes are distinct except where two states share one glyph in different colours; needs-you's dot sits in a ring
    const sameShape = [['failed', 'limited']]
    const groups = new Map<string, string[]>()
    for (const [k, s] of signature) groups.set(s, [...(groups.get(s) ?? []), k])
    expect([...groups.values()].filter((g) => g.length > 1).map((g) => g.join()).sort()).toEqual(sameShape.map((g) => g.join()).sort())
    // a session's colour: the glyphs that say working, unread, idle and detached take it, the others keep their own
    for (const kind of GLYPH_KINDS) {
      const style = rendered(StatusGlyph, { kind, tone: 6 }).root.attrs.style ?? ''
      expect(style, kind).toContain('--glyph-tone: var(--session-2)')
      const block = css.match(new RegExp(`\\.kea-glyph-${kind}[^{]*\\{([^}]*)\\}`))![1]!
      expect(block.includes('var(--glyph-tone'), `${kind} takes the session colour`).toBe(TONED_GLYPHS.includes(kind))
    }
    expect(rendered(StatusGlyph, { kind: 'idle' }).root.attrs.style).toBeUndefined()
    expect(glyphTone(0)).toBe('var(--session-1)')
    expect(glyphTone(-1)).toBeUndefined()
    // a row's own label wins (e.g. "permission", "limited")
    expect(rendered(StatusGlyph, { kind: 'needsYou', label: 'permission' }).root.attrs['aria-label']).toBe('permission')
    // the working arc turns once per --motion-spinner, linearly; reduced motion stops it
    expect(rule('.kea-glyph-working')).toMatch(/animation:\s*kea-spin var\(--motion-spinner\) linear infinite/)
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.kea-glyph-working\s*\{\s*animation:\s*none/)
  })
})
