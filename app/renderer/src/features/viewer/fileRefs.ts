// File references in the viewer's text, found in one line's slice around the pointer or the cursor by the document's
// language id. Whether one leads to a file is core's answer (`viewer.resolveRefs`); nothing here asks or opens.
//
//   imports    javascript, jsx, typescript, tsx, and every line of svelte, vue and astro: the string of `import … from`,
//              `export … from`, a wrapped list's `} from '…'`, `import '…'`, `import('…')`, `require('…')` and
//              `/// <reference path="…" />`
//   styles     css, scss, sass, less: `@import`, `@use`, `@forward` and `url()`; `~pkg` is not a reference
//   markup     html, and every line of svelte, vue and astro: `src="…"` and `href="…"`; `#L10` names a line
//   markdown   markdown, mdx: `[t](…)`, `![a](…)`, a definition `[id]: …` and raw `<a href>` / `<img src>`, resolved as
//              the preview resolves them (`markdown.ts`); `#L10` and `#L10-L20` name a line
//   json       json, jsonc, json5: a string starting `./` or `../`; in a `tsconfig*.json` or `jsconfig*.json` also
//              `extends` and `references[].path`
//   python     python: the module of a line's `import a.b, c as d` or `from .a import b` (`.` alone included)
//   rust       rust: the name of a line's `mod name;`, its attributes and `pub(…)` allowed before it
//   include    c, cpp, objective-c, objective-cpp: a line's `#include "…"` or `#import "…"`, never `<…>`
//   ruby       ruby: the string of `require_relative '…'`
//   paths      every language: a path as a terminal prints it (`features/terminal/links.ts`), with `:line[:col]`. In
//              code a path needs a `/` or a position and is never the `(line,col)` form, so `console.log` and
//              `foo.bar(1, 2)` are none; in prose (Markdown, plain text) a bare `name.ext` is one too
//
// A reference the slice cuts at either end is none (what was cut is not known). Web addresses are `links.ts`'s.

import { L, type RefFamily } from '@kea/protocol'
import { detectFileRefs } from '../terminal/links.ts'
import type { LineSlice } from './links.ts'
import { worktreeTarget } from './markdown.ts'

/** A file reference in a slice: the part that is underlined (UTF-16 offsets, `to` exclusive), what core is asked about, and the position it names. */
export interface FoundRef {
  from: number
  to: number
  family: RefFamily
  /** What core is asked about: the specifier as written, or for Markdown the worktree path the preview's resolver gives. */
  spec: string
  /** 1-based. */
  line?: number
  col?: number
  /** As written: the underlined text. */
  text: string
}

/** What the document is: its language id (null for plain text) and its path in the worktree. */
export interface RefScope {
  lang: string | null
  path: string
}

const SCRIPT = new Set(['javascript', 'jsx', 'typescript', 'tsx'])
const COMPONENT = new Set(['svelte', 'vue', 'astro'])
const STYLE = new Set(['css', 'scss', 'sass', 'less'])
const MARKDOWN = new Set(['markdown', 'mdx'])
const JSON_LANGS = new Set(['json', 'jsonc', 'json5'])
const C_LANGS = new Set(['c', 'cpp', 'objective-c', 'objective-cpp'])
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const CONFIG_NAME = /^[tj]sconfig[^/]*\.json$/i

/** Each form's string: group 1 its quote, group 2 its text. */
const IMPORT_FORMS = [/\bfrom\s*(['"])((?:(?!\1)[^\\\n])+)\1/dg, /\bimport\s*(['"])((?:(?!\1)[^\\\n])+)\1/dg, /\bimport\s*\(\s*(['"`])((?:(?!\1)[^\\\n])+)\1/dg, /\brequire\s*\(\s*(['"`])((?:(?!\1)[^\\\n])+)\1/dg]
const REFERENCE_PATH = /^\s*\/\/\/\s*<reference\s+path\s*=\s*(['"])((?:(?!\1)[^\n])+)\1/d
const STYLE_AT = /@(?:import|use|forward)\b/g
const STYLE_STRING = /\s*(['"])((?:(?!\1)[^\\\n])+)\1\s*,?/dy
const URL_FN = /\burl\(\s*(['"]?)([^'"()\s]+)\1\s*\)/dg
const ATTR = /\b(?:src|href)\s*=\s*(["'])((?:(?!\1)[^\n])*)\1/dg
const MD_DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/d
const JSON_RELATIVE = /(["'])(\.\.?\/(?:(?!\1)[^\\\n])*)\1/dg
const CONFIG_EXTENDS = /"extends"\s*:\s*"([^"\\\n]+)"/dg
const CONFIG_EXTENDS_LIST = /"extends"\s*:\s*\[([^\]\n]*)\]/dg
const CONFIG_PATH = /"path"\s*:\s*"([^"\\\n]+)"/dg
const LIST_STRING = /"([^"\\\n]+)"/dg
const PY_DOTTED = '[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*'
const PY_FROM = new RegExp(`^[ \\t]*from[ \\t]+(\\.+(?:${PY_DOTTED})?|${PY_DOTTED})[ \\t]+import\\b`, 'd')
const PY_IMPORT = /^[ \t]*import[ \t]+/
const PY_ITEM = new RegExp(`^[ \\t]*(${PY_DOTTED})(?:[ \\t]+as[ \\t]+[A-Za-z_]\\w*)?[ \\t]*$`, 'd')
const RUST_MOD = /^[ \t]*(?:#!?\[[^\]\n]*\][ \t]*)*(?:pub(?:[ \t]*\([^)\n]*\))?[ \t]+)?mod[ \t]+(?:r#)?([A-Za-z_]\w*)[ \t]*;/d
const C_INCLUDE = /^[ \t]*#[ \t]*(?:include|import)[ \t]*"([^"\n]+)"/d
const RUBY_REQUIRE = /\brequire_relative[ \t]*\(?[ \t]*(['"])((?:(?!\1)[^\\\n])+)\1/dg

const groupAt = (m: RegExpExecArray, g: number): [number, number] => (m.indices?.[g] ?? [m.index, m.index]) as [number, number]

function found(family: RefFamily, from: number, to: number, text: string, spec: string, pos: { line?: number; col?: number } = {}): FoundRef | null {
  if (spec === '' || to <= from || spec.length > L.viewerLinkMaxChars) return null
  return { from, to, family, spec, ...pos, text: text.slice(from, to) }
}

/** A target that names no file of the worktree: another scheme, a host, an in-page anchor, a template's expression. */
const notAFile = (t: string): boolean => t === '' || HAS_SCHEME.test(t) || t.startsWith('//') || t.startsWith('#') || t.includes('{') || t.includes('\0')

/** A `#L10` (or `#L10-L20`) fragment's line. */
function fragmentLine(t: string): number | undefined {
  const m = /#L(\d+)(?:-L?\d+)?$/.exec(t)
  const n = m ? Number(m[1]) : NaN
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined
}

function imports(text: string): FoundRef[] {
  const out: FoundRef[] = []
  for (const re of IMPORT_FORMS) {
    for (const m of text.matchAll(re)) {
      const spec = m[2] as string
      if (spec.includes('${')) continue
      const [a, b] = groupAt(m, 2)
      const r = found('import', a, b, text, spec)
      if (r) out.push(r)
    }
  }
  const ref = REFERENCE_PATH.exec(text)
  if (ref) {
    const spec = ref[2] as string
    const [a, b] = groupAt(ref, 2)
    // a reference path is relative to the file, with or without `./`
    const r = found('import', a, b, text, spec.startsWith('.') || spec.startsWith('/') ? spec : `./${spec}`)
    if (r) out.push(r)
  }
  return out
}

function styles(text: string): FoundRef[] {
  const out: FoundRef[] = []
  const push = (a: number, b: number, spec: string): void => {
    if (spec.startsWith('~') || notAFile(spec)) return
    const r = found('style', a, b, text, spec)
    if (r) out.push(r)
  }
  for (const at of text.matchAll(STYLE_AT)) {
    STYLE_STRING.lastIndex = at.index + at[0].length
    for (let m = STYLE_STRING.exec(text); m; m = STYLE_STRING.exec(text)) {
      const [a, b] = groupAt(m, 2)
      push(a, b, m[2] as string)
    }
  }
  for (const m of text.matchAll(URL_FN)) {
    const [a, b] = groupAt(m, 2)
    push(a, b, m[2] as string)
  }
  return out
}

function markup(text: string): FoundRef[] {
  const out: FoundRef[] = []
  for (const m of text.matchAll(ATTR)) {
    // a bound attribute (`:src="expr"`, `v-bind:src`) holds an expression, not a path
    if (text[m.index - 1] === ':') continue
    const value = m[2] as string
    if (notAFile(value)) continue
    const [a, b] = groupAt(m, 2)
    const spec = value.replace(/[?#].*$/, '')
    const line = fragmentLine(value)
    const r = found('markup', a, b, text, spec, line !== undefined ? { line } : {})
    if (r) out.push(r)
  }
  return out
}

/** The end of a Markdown link's destination starting at `i` (just after `](`): the destination's range, or null. */
function destination(text: string, i: number): [number, number] | null {
  while (text[i] === ' ' || text[i] === '\t') i++
  if (text[i] === '<') {
    const end = text.indexOf('>', i + 1)
    return end < 0 ? null : [i + 1, end]
  }
  let depth = 0
  let j = i
  for (; j < text.length; j++) {
    const c = text[j] as string
    if (c === '\\') {
      j++
      continue
    }
    if (c === ' ' || c === '\t') break
    if (c === '(') depth++
    else if (c === ')') {
      if (depth === 0) break
      depth--
    }
  }
  // the link must close on this slice
  if (j >= text.length) return null
  return j > i ? [i, j] : null
}

/** A Markdown file's links; `claimed` gets every destination's range, one that leads nowhere included (it is no path either). */
function markdownRefs(text: string, scope: RefScope, cutStart: boolean, claimed: { from: number; to: number }[]): FoundRef[] {
  const out: FoundRef[] = []
  const push = (a: number, b: number): void => {
    claimed.push({ from: a, to: b })
    const target = text.slice(a, b)
    if (notAFile(target)) return
    const file = worktreeTarget({ path: scope.path }, target)
    if (file === null) return
    const line = fragmentLine(target)
    const r = found('markdown', a, b, text, file, line !== undefined ? { line } : {})
    if (r) out.push(r)
  }
  for (let at = text.indexOf(']('); at >= 0; at = text.indexOf('](', at + 2)) {
    const d = destination(text, at + 2)
    if (d) push(d[0], d[1])
  }
  // a definition is one only at the line's start, which a slice that was cut there does not hold
  const def = cutStart ? null : MD_DEFINITION.exec(text)
  if (def) {
    let [a, b] = groupAt(def, 1)
    if (text[a] === '<') {
      a++
      b--
    }
    push(a, b)
  }
  // raw HTML: shown as text by the preview, followed here
  for (const r of markup(text)) push(r.from, r.to)
  return out
}

function jsonRefs(text: string, scope: RefScope): FoundRef[] {
  const out: FoundRef[] = []
  const name = scope.path.slice(scope.path.lastIndexOf('/') + 1)
  if (CONFIG_NAME.test(name)) {
    for (const m of text.matchAll(CONFIG_EXTENDS)) {
      const [a, b] = groupAt(m, 1)
      const r = found('extends', a, b, text, m[1] as string)
      if (r) out.push(r)
    }
    for (const m of text.matchAll(CONFIG_EXTENDS_LIST)) {
      const [start] = groupAt(m, 1)
      for (const s of (m[1] as string).matchAll(LIST_STRING)) {
        const [a, b] = groupAt(s, 1)
        const r = found('extends', start + a, start + b, text, s[1] as string)
        if (r) out.push(r)
      }
    }
    for (const m of text.matchAll(CONFIG_PATH)) {
      const [a, b] = groupAt(m, 1)
      const r = found('reference', a, b, text, m[1] as string)
      if (r) out.push(r)
    }
  }
  for (const m of text.matchAll(JSON_RELATIVE)) {
    const [a, b] = groupAt(m, 2)
    const r = found('json', a, b, text, m[2] as string)
    if (r) out.push(r)
  }
  return out
}

/** A Python line's modules: `from <module> import …`, or each module of `import a.b, c as d` (up to a `;` or a comment). */
function pythonRefs(text: string): FoundRef[] {
  const from = PY_FROM.exec(text)
  if (from) {
    const [a, b] = groupAt(from, 1)
    const r = found('python', a, b, text, from[1] as string)
    return r ? [r] : []
  }
  const imp = PY_IMPORT.exec(text)
  if (!imp) return []
  const out: FoundRef[] = []
  const start = imp[0].length
  const end = text.slice(start).search(/[;#]/)
  const clause = end < 0 ? text.slice(start) : text.slice(start, start + end)
  let at = start
  for (const part of clause.split(',')) {
    const m = PY_ITEM.exec(part)
    if (m) {
      const [a, b] = groupAt(m, 1)
      const r = found('python', at + a, at + b, text, m[1] as string)
      if (r) out.push(r)
    }
    at += part.length + 1
  }
  return out
}

/** The reference of a one-reference statement: `re`'s group 1. */
function single(family: RefFamily, re: RegExp, text: string): FoundRef[] {
  const m = re.exec(text)
  if (!m) return []
  const [a, b] = groupAt(m, 1)
  const r = found(family, a, b, text, m[1] as string)
  return r ? [r] : []
}

function rubyRefs(text: string): FoundRef[] {
  const out: FoundRef[] = []
  for (const m of text.matchAll(RUBY_REQUIRE)) {
    const spec = m[2] as string
    // a double-quoted string with an interpolation names no one file
    if (m[1] === '"' && spec.includes('#{')) continue
    const [a, b] = groupAt(m, 2)
    const r = found('ruby', a, b, text, spec)
    if (r) out.push(r)
  }
  return out
}

function paths(text: string, prose: boolean): FoundRef[] {
  const out: FoundRef[] = []
  for (const p of detectFileRefs(text, L.viewerLinkScanChars)) {
    const round = text[p.index + p.path.length] === '('
    // in code a path needs a folder or a position, and `name(1, 2)` is a call; `</a>` is a closing tag
    if (!prose && (round || (!p.path.includes('/') && p.line === null))) continue
    if (text[p.index - 1] === '<') continue
    const r = found('path', p.index, p.index + p.length, text, p.path, { ...(p.line !== null ? { line: p.line } : {}), ...(p.line !== null && p.col !== null ? { col: p.col } : {}) })
    if (r) out.push(r)
  }
  return out
}

const overlaps = (a: Pick<FoundRef, 'from' | 'to'>, b: Pick<FoundRef, 'from' | 'to'>): boolean => a.from < b.to && b.from < a.to

/**
 * The file references in `slice`, left to right, none overlapping another: each family's of the document's language
 * first, then the paths outside them. One the slice cut at either end is left out.
 */
export function refsIn(slice: LineSlice, scope: RefScope): FoundRef[] {
  const text = slice.text
  const lang = scope.lang
  const prose = lang === null || MARKDOWN.has(lang)
  const own: FoundRef[] = []
  const claimed: { from: number; to: number }[] = []
  if (lang !== null && (SCRIPT.has(lang) || COMPONENT.has(lang))) own.push(...imports(text))
  if (lang !== null && (lang === 'html' || COMPONENT.has(lang))) own.push(...markup(text))
  if (lang !== null && STYLE.has(lang)) own.push(...styles(text))
  if (lang !== null && MARKDOWN.has(lang)) own.push(...markdownRefs(text, scope, slice.cutStart, claimed))
  if (lang !== null && JSON_LANGS.has(lang)) own.push(...jsonRefs(text, scope))
  // these are statements at the line's start, which a slice that was cut there does not hold
  if (!slice.cutStart && lang === 'python') own.push(...pythonRefs(text))
  if (!slice.cutStart && lang === 'rust') own.push(...single('rust', RUST_MOD, text))
  if (!slice.cutStart && lang !== null && C_LANGS.has(lang)) own.push(...single('include', C_INCLUDE, text))
  if (lang === 'ruby') own.push(...rubyRefs(text))
  const kept: FoundRef[] = []
  for (const r of own.sort((a, b) => a.from - b.from)) if (!kept.some((k) => overlaps(k, r))) kept.push(r)
  for (const r of paths(text, prose)) if (!kept.some((k) => overlaps(k, r)) && !claimed.some((c) => overlaps(c, r))) kept.push(r)
  return kept.filter((r) => !(r.from === 0 && slice.cutStart) && !(r.to === text.length && slice.cutEnd)).sort((a, b) => a.from - b.from)
}

/** The reference under `offset` in `slice`, or null. */
export function refAt(slice: LineSlice, offset: number, scope: RefScope): FoundRef | null {
  return refsIn(slice, scope).find((r) => offset >= r.from && offset < r.to) ?? null
}

/** What is asked of core with the reference at `offset`: it first, then the slice's others nearest it, at most L.viewerLinkRefsMax in all. */
export function refsAround(refs: readonly FoundRef[], hit: FoundRef): FoundRef[] {
  const others = refs.filter((r) => r !== hit).sort((a, b) => Math.abs(a.from - hit.from) - Math.abs(b.from - hit.from))
  return [hit, ...others].slice(0, L.viewerLinkRefsMax)
}

/** `src/a.ts:40`: a reference's target as its tip and Copy Path give it. */
export function targetText(t: { path: string; line?: number; col?: number }): string {
  if (t.line === undefined) return t.path
  return t.col === undefined ? `${t.path}:${t.line}` : `${t.path}:${t.line}:${t.col}`
}

/** Follow Link's words when the reference at the cursor leads to no file. */
export const NO_FILE = 'No file found'
/** The menu's file items' reason while core's answer is out. */
export const LOOKING = 'Looking for the file'
