// DS-2 · token lint: components use design tokens only.
//
// Over app/renderer/src/**/*.{css,ts,svelte}, packages/ui/src/** and app/main/src/**/*.ts (window colours; generated/
// and test files excluded). The scales come from constants/tokens.json through the generated tokens.ts:
//   - no raw colours: hex (#fff, #0C0D0B), rgb()/rgba()/hsl()/hsla() unless built only from var(--…) — use a token;
//   - no font-size above the largest type size (`MAX_FONT_PX`, from the type tokens; rem counts as 16px);
//   - border-radius only var(--radius-*), 0 or 50%;
//   - padding / margin / gap only 0, 1px and 2px (hairline offsets), a step of the spacing scale (`--space-*`) in px,
//     var(--space-*) or var(--size-*), `auto` and CSS-wide keywords.
// CSS is checked in .css files, in CSS text inside TS strings and template literals, and in style objects
// (`fontSize: 16`, `padding: '10px'`; a bare number counts as px). In a .svelte component: its <style> blocks,
// its <script> blocks and markup expressions as TS, `style="…"` attributes, `style:prop="…"` directives (a value with a
// `{…}` part is checked for colours only), and raw colours in any other attribute (`fill="#fff"`).
import { SPACE_PX, TYPE_SIZE_PX } from '../../../packages/ui/src/generated/tokens.ts'
import { inString, type Lexed, lexCss, lexJs, lexSvelte, lineIndex, type SvelteAttr } from './lexer.ts'
import type { Violation } from './types.ts'

/** The spacing scale plus 0 and the 1px / 2px hairline offsets. */
const ALLOWED_SPACING_PX = new Set<number>([0, 1, 2, ...SPACE_PX])
/** The largest type size. */
const MAX_FONT_PX = Math.max(...TYPE_SIZE_PX)
const KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer'])

const HEX_RE = /(?<![\w&#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g
const FN_COLOUR_RE = /\b(rgba?|hsla?)\(\s*([^)]*)\)/g

function colourFindings(value: string): string[] {
  const out: string[] = []
  for (const m of value.matchAll(HEX_RE)) out.push(m[0])
  for (const m of value.matchAll(FN_COLOUR_RE)) {
    // rgb(var(--x) / 50%) builds from a token; anything with a literal channel is a raw colour
    const args = m[2]!.replace(/var\(--[\w-]+\)/g, '').replace(/[\s,/%.]|\b0\b/g, '')
    if (/\d/.test(args) || !m[2]!.includes('var(')) out.push(m[0])
  }
  return out
}

type Prop = 'font-size' | 'font' | 'radius' | 'spacing'

function classify(prop: string): Prop | null {
  const p = prop.toLowerCase()
  if (p === 'font-size' || p === 'fontsize') return 'font-size'
  if (p === 'font') return 'font'
  if (/^border(?:-?(?:top|bottom|start|end)-?(?:left|right|start|end))?-?radius$/.test(p)) return 'radius'
  if (/^(?:padding|margin|scroll-?padding|scroll-?margin)(?:-?(?:top|right|bottom|left|inline|block|inline-?start|inline-?end|block-?start|block-?end|x|y))?$/.test(p)) return 'spacing'
  if (/^(?:gap|row-?gap|column-?gap|grid-?gap)$/.test(p)) return 'spacing'
  return null
}

function pxOf(token: string): number | null {
  const m = /^(-?\d*\.?\d+)(px|rem)?$/.exec(token)
  if (!m) return null
  const n = Number(m[1])
  return m[2] === 'rem' ? n * 16 : n
}

/** Problems with a CSS value for a classified property; [] when fine. */
export function checkValue(kind: Prop, value: string): string[] {
  const v = value.trim().replace(/\s*!important$/, '')
  if (kind === 'font-size' || kind === 'font') {
    const lengths = [...v.replace(/var\([^)]*\)/g, '').matchAll(/(?<![\w.-])(\d*\.?\d+)(px|rem)\b/g)]
    const sizes = kind === 'font' ? lengths.slice(0, 1) : lengths
    return sizes.filter((m) => pxOf(m[0])! > MAX_FONT_PX).map((m) => `font-size ${m[0]} exceeds ${MAX_FONT_PX}px, the largest type size`)
  }
  // the Window Controls Overlay's rectangle is the system's, not a design number: `env(titlebar-area-*)`,
  // and the viewport's width a right inset is taken from
  const overlay = /env\(\s*titlebar-area-(?:x|y|width|height)\s*(?:,[^)]*)?\)/g
  const system = overlay.test(v)
  const tokens = v
    .replace(overlay, ' ')
    .replace(system ? /(?<![\w.-])100vw\b/g : /$^/g, ' ')
    .replace(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g, ' $1 ')
    .replace(/calc\(/g, ' ( ')
    .replace(/[()]/g, ' ')
    .split(/[\s/]+/)
    .filter(Boolean)
  const inCalc = /calc\(/.test(v)
  const bad: string[] = []
  for (const t of tokens) {
    if (KEYWORDS.has(t)) continue
    if (t.startsWith('--')) {
      const ok = kind === 'radius' ? t.startsWith('--radius-') : t.startsWith('--space-') || t.startsWith('--size-')
      if (!ok) bad.push(`var(${t})`)
      continue
    }
    if (inCalc && /^[-+*]$/.test(t)) continue
    if (inCalc && /^-?\d*\.?\d+$/.test(t) && kind === 'spacing') continue // unitless multiplier
    if (kind === 'radius') {
      if (t === '0' || t === '0px' || t === '50%') continue
      bad.push(t)
      continue
    }
    if (t === 'auto') continue
    const px = /^-?\d*\.?\d+px$/.test(t) || t === '0' || t === '-0' ? pxOf(t.replace(/^-/, '')) : null
    if (px === null || !ALLOWED_SPACING_PX.has(px)) bad.push(t)
  }
  if (bad.length === 0) return []
  return kind === 'radius'
    ? [`border-radius "${v}" — use var(--radius-sm|md|lg), 0 or 50%`]
    : [`spacing "${v}" — use 0, 1px, 2px, 4/8/12/16/24/32px, var(--space-*) or var(--size-*)`]
}

const DECL_RE = /(?<![\w-])(-?[a-zA-Z][\w-]*)\s*:\s*([^;{}\n]+)/g

/** Check CSS declarations in a text (a .css file with comments blanked, or the contents of a TS string). */
function checkCssText(text: string, base: number, report: (offset: number, message: string) => void): void {
  for (const m of text.matchAll(DECL_RE)) {
    const prop = m[1]!
    const value = m[2]!
    const at = base + m.index!
    for (const c of colourFindings(value)) report(at, `raw colour "${c}" — use a colour token, var(--…)`)
    const kind = classify(prop)
    if (kind) for (const p of checkValue(kind, value)) report(at, p)
  }
}

const STYLE_PROP_RE =
  /(?<![\w$.-])(fontSize|font|borderRadius|border(?:Top|Bottom|Start|End)(?:Left|Right|Start|End)Radius|(?:padding|margin|scrollPadding|scrollMargin)(?:Top|Right|Bottom|Left|Inline|Block|InlineStart|InlineEnd|BlockStart|BlockEnd)?|gap|rowGap|columnGap)\s*:\s*(-?\d*\.?\d+|(['"`])([^'"`\n]*)\3)\s*(?=[,}\n])/g

type Report = (offset: number, message: string) => void

export function checkTokens(path: string, src: string): Violation[] {
  const out: Violation[] = []
  const line = lineIndex(src)
  const report: Report = (offset, message) => out.push({ file: path, line: line(offset), rule: 'tokens', message })
  if (path.endsWith('.css')) {
    const { code } = lexCss(src)
    checkCssText(code, 0, report)
    return dedupe(out)
  }
  if (path.endsWith('.svelte')) {
    const sv = lexSvelte(src)
    checkCssText(sv.css.code, 0, report)
    for (const a of sv.attrs) checkAttr(a, report)
    checkJs(sv.js, report)
    return dedupe(out.sort((a, b) => a.line - b.line))
  }
  checkJs(lexJs(src), report)
  return dedupe(out)
}

const rawColour = (c: string) => `raw colour "${c}" — use a colour token, var(--…)`

/** A quoted attribute value of a Svelte component (`{…}` parts are NULs). */
function checkAttr(a: SvelteAttr, report: Report): void {
  const isStyle = a.name === 'style'
  const directive = a.name.startsWith('style:') ? a.name.slice('style:'.length).split('|')[0]! : null
  if (!isStyle && directive === null) {
    for (const c of colourFindings(a.value)) report(a.start, rawColour(c))
    return
  }
  const decls = isStyle ? [...a.value.matchAll(DECL_RE)].map((m) => ({ prop: m[1]!, value: m[2]!, at: a.start + m.index! })) : [{ prop: directive!, value: a.value, at: a.start }]
  for (const d of decls) {
    for (const c of colourFindings(d.value.replace(/\0+/g, ' '))) report(d.at, rawColour(c))
    if (d.value.includes('\0')) continue // computed: only its literal colours are known
    const kind = classify(d.prop)
    if (kind) for (const p of checkValue(kind, d.value)) report(d.at, p)
  }
}

/** TS: style objects outside strings, raw colours in strings, CSS declarations inside strings. */
function checkJs({ code, strings }: Lexed, report: Report): void {
  // inline style objects
  for (const m of code.matchAll(STYLE_PROP_RE)) {
    if (inString(strings, m.index!)) continue
    const kind = classify(m[1]!)
    if (!kind) continue
    const value = m[4] !== undefined ? m[4] : `${m[2]}${m[1] === 'font' ? '' : 'px'}`
    if (m[4] === undefined && kind === 'radius' && Number(m[2]) !== 0) {
      report(m.index!, `border-radius ${m[2]} — use var(--radius-sm|md|lg), 0 or 50%`)
      continue
    }
    for (const p of checkValue(kind, value)) report(m.index!, p)
  }
  // strings: raw colours anywhere, CSS declarations inside
  for (const s of strings) {
    for (const c of colourFindings(s.value)) report(s.start, rawColour(c))
    if (/[a-z-]\s*:\s*[^:]/.test(s.value)) {
      checkCssText(s.value, s.start, (o, msg) => {
        if (!msg.startsWith('raw colour')) report(o, msg)
      })
    }
  }
}

function dedupe(v: Violation[]): Violation[] {
  const seen = new Set<string>()
  return v.filter((x) => {
    const k = `${x.line}\0${x.message}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function isTokenLinted(path: string): boolean {
  if (/(?:^|\/)generated\//.test(path)) return false
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return false
  if (path.startsWith('app/renderer/src/')) return /\.(?:css|ts|svelte)$/.test(path)
  if (path.startsWith('packages/ui/src/')) return /\.(?:css|ts|svelte)$/.test(path)
  if (path.startsWith('app/main/src/')) return /\.ts$/.test(path)
  return false
}
