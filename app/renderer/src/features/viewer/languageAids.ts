// What an editable document knows of its language: what `⌘/` comments a line with, which brackets and quotes close
// themselves as they are typed, and how a new line is indented. A hand-written table keyed by `language.ts`'s ids,
// written from what each language is (no grammar is parsed). An id the table does not name gets `()[]{}`, both
// quotes, the bracket rule and no comment toggle; plain text closes brackets but not quotes. CodeMirror's
// `toggleComment`, `closeBrackets`, `indentOnInput` and `insertNewlineAndIndent` read what this gives them; the editor
// adds those.
//
// The indent rule: a new line takes the indentation of the line before it (the nearest one with text), one unit more
// after a line ending with an opening bracket (a trailing line comment aside) or with what the language adds (`:` in
// Python and YAML, an opening tag in markup). A line beginning with a closing bracket goes to the indentation of the
// line holding its opener; one beginning with what else the language closes with (`</`) goes one unit less.

import { indentService, matchBrackets, type IndentContext } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'

/** What `⌘/` writes: the line comment, and the block comment it uses where there is none. */
export interface Comments {
  line?: string
  block?: { open: string; close: string }
}

export interface Aids {
  comments: Comments | null
  /** Bracket pairs, each opener before its closer: `()[]{}`. */
  brackets: string
  /** What closes itself when typed: openers of `brackets`, and quotes. */
  close: string
  /** The indent unit of a file that shows none: a tab or a run of spaces. */
  unit: string
  /** `brackets`: the indent rule above. `follow`: a new line keeps the indentation of the line before it. */
  indent: 'brackets' | 'follow'
  /** More line endings after which the next line indents (a regular expression's source). */
  opensAlso?: string
  /** More line beginnings that outdent one unit (a regular expression's source). */
  closesAlso?: string
  /** What may stand before a quote that starts a string (Python's `f"…"`). */
  stringPrefixes?: readonly string[]
  /** A markup file: inside `<script>` a line comments as JavaScript, inside `<style>` as CSS. */
  markup?: boolean
  /** The comments of a `---` block opening the file. */
  frontMatter?: Comments
}

const TAB = '\t'
const TWO = '  '
const FOUR = '    '
const ALL = '()[]{}'
const QUOTES = '"\''

const SLASHES: Comments = { line: '//', block: { open: '/*', close: '*/' } }
const HASH: Comments = { line: '#' }
const CSS: Comments = { block: { open: '/*', close: '*/' } }
const MARKUP: Comments = { block: { open: '<!--', close: '-->' } }

/** An opening tag closing a line: not a void element, not self-closing. */
const OPEN_TAG = '<(?!(?:area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)\\b)[A-Za-z][\\w:.-]*(?:\\s[^<>]*)?(?<!/)>'
/** A Makefile rule line (`target: prerequisites`, not `X := value`): its recipe lines start with a tab. */
const MAKE_RULE = '^[^\\s#=:][^=:]*::?(?!=)[^=]*'

/** A language whose lines indent after an opening bracket. */
const code = (comments: Comments | null, close: string, unit: string, more: Partial<Aids> = {}): Aids => ({ comments, brackets: ALL, close, unit, indent: 'brackets', ...more })
/** A language of prose or records: a new line keeps the line's indentation. */
const prose = (comments: Comments | null, close: string, unit: string, more: Partial<Aids> = {}): Aids => ({ comments, brackets: ALL, close, unit, indent: 'follow', ...more })
/** A markup language: tags indent as brackets do, and a script or a style comments as its own language. */
const markup = (close: string, more: Partial<Aids> = {}): Aids => code(MARKUP, close, TWO, { opensAlso: OPEN_TAG, closesAlso: '</', markup: true, ...more })

/** Every way of writing `w` in upper and lower case. */
const cases = (w: string): string[] => (w === '' ? [''] : cases(w.slice(1)).flatMap((rest) => [(w[0] as string).toLowerCase() + rest, (w[0] as string).toUpperCase() + rest]))
const PYTHON_PREFIXES = ['r', 'u', 'b', 'f', 't', 'rb', 'br', 'fr', 'rf', 'tr', 'rt'].flatMap(cases)

const C_LIKE = code(SLASHES, `([{${QUOTES}`, FOUR)
const SCRIPT = code(SLASHES, `([{${QUOTES}\``, TWO)
const JSON_DATA = code(null, '[{"', TWO, { brackets: '[]{}' })
const JSON_COMMENTED = code(SLASHES, '[{"', TWO, { brackets: '[]{}' })

/** Language id → its aids. An id of `language.ts` missing here gets `DEFAULT`. */
export const AIDS: Readonly<Record<string, Aids>> = {
  typescript: SCRIPT,
  tsx: SCRIPT,
  javascript: SCRIPT,
  jsx: SCRIPT,
  json: JSON_DATA,
  jsonc: JSON_COMMENTED,
  json5: code(SLASHES, `[{${QUOTES}`, TWO, { brackets: '[]{}' }),
  jsonl: JSON_DATA,
  html: markup(`([{${QUOTES}`),
  css: code(CSS, `([{${QUOTES}`, TWO),
  scss: code(SLASHES, `([{${QUOTES}`, TWO),
  sass: code(SLASHES, `([{${QUOTES}`, TWO),
  less: code(SLASHES, `([{${QUOTES}`, TWO),
  markdown: prose(MARKUP, '([{', TWO, { frontMatter: HASH }),
  mdx: prose({ block: { open: '{/*', close: '*/}' } }, '([{', TWO, { frontMatter: HASH }),
  // `key:` opens a mapping, `key: |` and `- >` a block of text
  yaml: code(HASH, `[{${QUOTES}`, TWO, { brackets: '[]{}', opensAlso: ':|[:-]\\s+[|>][-+\\d]*' }),
  toml: code(HASH, `[{${QUOTES}`, TWO, { brackets: '[]{}' }),
  xml: code(MARKUP, `([{${QUOTES}`, TWO, { opensAlso: OPEN_TAG, closesAlso: '</' }),
  // `{#if …}` and `{:else}` open a block, `{:else}` and `{/if}` close one
  svelte: markup(`([{${QUOTES}\``, { opensAlso: `${OPEN_TAG}|\\{[#:][^{}]*\\}`, closesAlso: '</|\\{[/:]' }),
  vue: markup(`([{${QUOTES}\``),
  astro: markup(`([{${QUOTES}\``, { frontMatter: SLASHES }),
  python: code(HASH, `([{${QUOTES}`, FOUR, { opensAlso: ':', stringPrefixes: PYTHON_PREFIXES }),
  ruby: code(HASH, `([{${QUOTES}`, TWO),
  go: code(SLASHES, `([{${QUOTES}\``, TAB),
  // `'` starts a lifetime more often than a character
  rust: code(SLASHES, '([{"', FOUR),
  java: C_LIKE,
  kotlin: C_LIKE,
  swift: code(SLASHES, '([{"', FOUR),
  c: C_LIKE,
  cpp: C_LIKE,
  csharp: C_LIKE,
  'objective-c': C_LIKE,
  'objective-cpp': C_LIKE,
  php: C_LIKE,
  lua: code({ line: '--', block: { open: '--[[', close: ']]' } }, `([{${QUOTES}`, TWO),
  perl: code(HASH, `([{${QUOTES}`, FOUR),
  r: code(HASH, `([{${QUOTES}\``, TWO),
  scala: code(SLASHES, `([{${QUOTES}`, TWO),
  dart: code(SLASHES, `([{${QUOTES}`, TWO),
  elixir: code(HASH, `([{${QUOTES}`, TWO),
  erlang: code({ line: '%' }, `([{${QUOTES}`, FOUR),
  haskell: code({ line: '--', block: { open: '{-', close: '-}' } }, `([{${QUOTES}`, TWO),
  // `'` quotes a form
  clojure: code({ line: ';' }, '([{"', TWO),
  // `'a` is a type variable
  ocaml: code({ block: { open: '(*', close: '*)' } }, '([{"', TWO),
  fsharp: code({ line: '//', block: { open: '(*', close: '*)' } }, '([{"', FOUR),
  zig: code({ line: '//' }, `([{${QUOTES}`, FOUR),
  shellscript: code(HASH, `([{${QUOTES}\``, TWO),
  fish: code(HASH, `([{${QUOTES}`, FOUR),
  powershell: code({ line: '#', block: { open: '<#', close: '#>' } }, `([{${QUOTES}`, FOUR),
  bat: code({ line: 'REM' }, '("', FOUR, { brackets: '()' }),
  docker: code(HASH, `([{${QUOTES}`, FOUR),
  make: code(HASH, `([{${QUOTES}`, TAB, { opensAlso: MAKE_RULE }),
  cmake: code({ line: '#', block: { open: '#[[', close: ']]' } }, '([{"', TWO),
  nginx: code(HASH, `([{${QUOTES}`, FOUR),
  ini: code(HASH, `([{${QUOTES}`, TWO),
  dotenv: code(HASH, `([{${QUOTES}`, TWO),
  sql: code({ line: '--', block: { open: '/*', close: '*/' } }, `([{${QUOTES}\``, TWO),
  graphql: code(HASH, '([{"', TWO),
  prisma: code({ line: '//' }, '([{"', TWO),
  proto: code(SLASHES, `([{${QUOTES}`, TWO),
  terraform: code({ line: '#', block: { open: '/*', close: '*/' } }, '([{"', TWO),
  hcl: code({ line: '#', block: { open: '/*', close: '*/' } }, '([{"', TWO),
  // `''` opens an indented string
  nix: code({ line: '#', block: { open: '/*', close: '*/' } }, '([{"', TWO),
  diff: prose(null, '([{', FOUR),
  'git-commit': prose(HASH, '([{', FOUR),
  'git-rebase': prose(HASH, '([{', FOUR),
  log: prose(null, '([{', FOUR),
  csv: prose(null, '"', FOUR),
  tsv: prose(null, '', FOUR),
  // `\begin{…}` opens an environment, `\end{` closes it
  latex: code({ line: '%' }, '([{', TWO, { opensAlso: '\\\\begin\\{[^}]*\\}(?:\\[[^\\]]*\\]|\\{[^}]*\\})*', closesAlso: '\\\\end\\{' }),
  bibtex: code({ line: '%' }, '([{"', TWO),
  // `"` starts a comment
  viml: code({ line: '"' }, "([{'", TWO),
  groovy: C_LIKE,
  jinja: code({ block: { open: '{#', close: '#}' } }, `([{${QUOTES}`, TWO),
  handlebars: code({ block: { open: '{{!--', close: '--}}' } }, `([{${QUOTES}`, TWO),
  pug: code({ line: '//-' }, `([{${QUOTES}`, TWO),
  liquid: code({ block: { open: '{% comment %}', close: '{% endcomment %}' } }, `([{${QUOTES}`, TWO),
  solidity: C_LIKE,
  wasm: code({ line: ';;', block: { open: '(;', close: ';)' } }, '("', TWO, { brackets: '()' }),
  glsl: code(SLASHES, '([{', FOUR),
  wgsl: code(SLASHES, '([{', FOUR),
  applescript: code({ line: '--', block: { open: '(*', close: '*)' } }, '([{"', FOUR),
  http: code(HASH, '([{"', TWO),
  'ssh-config': prose(HASH, '"', FOUR),
  systemd: prose(HASH, '"', FOUR),
  codeowners: prose(HASH, '', FOUR),
  julia: code({ line: '#', block: { open: '#=', close: '=#' } }, '([{"', FOUR),
}

/** A language the table does not name. */
export const DEFAULT: Aids = code(null, `([{${QUOTES}`, FOUR)
/** Plain text: brackets close, quotes do not (they are apostrophes as often). */
export const PLAIN: Aids = prose(null, '([{', FOUR)

/** The aids of a language id; null is plain text. */
export function aidsOf(languageId: string | null): Aids {
  if (languageId === null) return PLAIN
  return Object.hasOwn(AIDS, languageId) ? (AIDS[languageId] as Aids) : DEFAULT
}

/** The indent unit of a file of this language with no indentation of its own to read: a tab or a run of spaces. */
export function defaultIndent(languageId: string | null): string {
  return aidsOf(languageId).unit
}

// ── the patterns ───────────────────────────────────────────────────────────────────────────────────

const literal = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const anyOf = (chars: string): string => `[${chars.replace(/[\\\]^-]/g, '\\$&')}]`
const everyOther = (s: string, from: 0 | 1): string => [...s].filter((_, i) => i % 2 === from).join('')

export interface Patterns {
  /** The line before a new one ends with an opener: the new line indents. */
  opens: RegExp | null
  /** A line begins with a closer: it outdents. */
  closes: RegExp | null
  /** The text before the cursor is a closer at a line's start: `indentOnInput` indents the line again. */
  onInput: RegExp | null
  /** A trailing line comment, left out when a line's ending is read. */
  trailing: RegExp | null
}

/** The regular expressions of a language's aids. */
export function patternsOf(a: Aids): Patterns {
  const line = a.comments?.line
  const trailing = line === undefined ? null : new RegExp(`(?:^|\\s)${literal(line)}.*$`)
  if (a.indent === 'follow') return { opens: null, closes: null, onInput: null, trailing }
  const openers = [anyOf(everyOther(a.brackets, 0)), ...(a.opensAlso === undefined ? [] : [a.opensAlso])].join('|')
  const closers = [anyOf(everyOther(a.brackets, 1)), ...(a.closesAlso === undefined ? [] : [a.closesAlso])].join('|')
  return { opens: new RegExp(`(?:${openers})\\s*$`), closes: new RegExp(`^\\s*(?:${closers})`), onInput: new RegExp(`^\\s*(?:${closers})$`), trailing }
}

// ── comments where a file holds another language ───────────────────────────────────────────────────

const SCRIPT_OR_STYLE = /<(\/?)(script|style)\b[^>]*(>?)/gi

/** Is `pos` inside a `---` block that opens the file? */
function inFrontMatter(state: EditorState, pos: number): boolean {
  const doc = state.doc
  const first = doc.line(1)
  if (first.text.trimEnd() !== '---' || pos <= first.to) return false
  for (let n = 2; n <= doc.lines; n++) {
    const line = doc.line(n)
    if (line.text.trimEnd() === '---') return pos < line.from
  }
  return false
}

/** The comments at `pos`: a front matter's, a markup file's script's or style's, or the language's own. */
function commentsAt(state: EditorState, pos: number, a: Aids): Comments {
  if (a.frontMatter && inFrontMatter(state, pos)) return a.frontMatter
  if (a.markup) {
    let last: RegExpExecArray | null = null
    for (const m of state.sliceDoc(0, pos).matchAll(SCRIPT_OR_STYLE)) last = m
    // inside an element whose opening tag has ended before `pos`
    if (last && last[1] === '' && last[3] === '>') return (last[2] as string).toLowerCase() === 'script' ? SLASHES : CSS
  }
  return a.comments ?? {}
}

// ── indentation ────────────────────────────────────────────────────────────────────────────────────

/** The line a new line's indentation follows: the text before `pos` on its line, or the nearest line above with text. */
function baseLine(cx: IndentContext, pos: number): { from: number; text: string } | null {
  let { text, from } = cx.lineAt(pos, -1)
  text = text.slice(0, Math.max(0, pos - from))
  while (!/\S/.test(text)) {
    if (from === 0) return null
    ;({ text, from } = cx.lineAt(from - 1, -1))
  }
  return { from, text }
}

/** The indentation, in columns, of the line starting at `pos` (or of the new line a break at `pos` makes). */
function indentAt(cx: IndentContext, pos: number, a: Aids, p: Patterns): number {
  const base = baseLine(cx, pos)
  let indent = base ? cx.lineIndent(base.from, -1) : 0
  if (base && p.opens?.test(p.trailing ? base.text.replace(p.trailing, '') : base.text)) indent += cx.unit
  if (!p.closes) return indent
  const { text, from } = cx.lineAt(pos, 1)
  const after = text.slice(Math.max(0, pos - from))
  if (!p.closes.test(after)) return indent
  const lead = after.length - after.trimStart().length
  if (a.brackets.indexOf(after.charAt(lead)) % 2 === 1) {
    const match = matchBrackets(cx.state, pos + lead + 1, -1, { brackets: a.brackets })
    if (match?.end) return cx.lineIndent(match.end.from, -1)
  }
  return Math.max(0, indent - cx.unit)
}

/** What an editable document of this language reads: comment tokens, closing brackets, the indent rule. */
export function languageAids(languageId: string | null): Extension {
  const a = aidsOf(languageId)
  const p = patternsOf(a)
  const data: Record<string, unknown> = { closeBrackets: { brackets: [...a.close], ...(a.stringPrefixes ? { stringPrefixes: a.stringPrefixes } : {}) } }
  if (p.onInput) data.indentOnInput = p.onInput
  const inner = a.markup === true || a.frontMatter !== undefined
  if (a.comments && !inner) data.commentTokens = a.comments
  const all = [data]
  return [
    EditorState.languageData.of(
      inner
        ? (state, pos) => [
            data,
            {
              // read only by `⌘/`, so the file is searched only then
              get commentTokens() {
                return commentsAt(state, pos, a)
              },
            },
          ]
        : () => all,
    ),
    indentService.of((cx, pos) => indentAt(cx, pos, a, p)),
  ]
}
