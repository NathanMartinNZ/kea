import fs from 'node:fs'
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state'
import { INITIAL } from 'shiki/textmate'
import { describe, expect, it } from 'vitest'
import { followEdits, lineEdits } from '../highlight.ts'
import { SYNTAX_ROLES, SYNTAX_THEME, syntaxCss, tokenClass } from '../syntax.ts'
import { TokenStore, tokenStart, tokenStyle } from '../tokens.ts'
import { HighlightEngine, type EngineHost } from './engine.ts'
import type { EditRun, FromWorker } from './protocol.ts'
import { ShikiGrammars } from './shiki.ts'
import { LineTokenizer, splitLines } from './tokenizer.ts'

const PYTHON = `"""Module docstring
spanning lines."""
import os
from typing import Optional


class Greeter:
    '''A class docstring.'''

    def __init__(self, name: str = "world") -> None:
        self.name = name  # trailing comment

    def greet(self, times: int = 1) -> Optional[str]:
        text = f"""Hello,
        {self.name}!
        """
        for i in range(times):
            if i % 2 == 0:
                print(text * 2, end="")
            else:
                continue
        return None


if __name__ == "__main__":
    Greeter(os.environ.get("USER", "you")).greet(3)
`

const GO = `// Package main is a sample.
package main

import (
	"fmt"
	"strings"
)

/* a block comment
   over two lines */
type Shape interface {
	Area() float64
}

type Rect struct{ W, H float64 }

func (r Rect) Area() float64 { return r.W * r.H }

func main() {
	raw := \`a raw string
that spans lines\`
	shapes := []Shape{Rect{2, 3}, Rect{W: 1, H: 1}}
	for i, s := range shapes {
		fmt.Printf("%d: %.2f %s\\n", i, s.Area(), strings.ToUpper(raw))
	}
}
`

const TSX = `import { useState, type ReactNode } from 'react'

interface Props {
  title: string
  children?: ReactNode
}

/**
 * A block comment
 * over several lines.
 */
export function Card({ title, children }: Props) {
  const [open, setOpen] = useState<boolean>(false)
  const label = \`\${title} is \${
    open ? 'open' : 'closed'
  }\`
  return (
    <section className="card" data-open={open}>
      <h2 onClick={() => setOpen((o) => !o)}>{label}</h2>
      {open && <div>{children}</div>}
    </section>
  )
}
`

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      body { margin: 0; color: #333; }
      /* a comment */
      .a > .b::before { content: "x"; }
    </style>
    <script>
      const a = \`template
      literal\`
      function f() { return a.length }
    </script>
  </head>
  <body>
    <!-- a comment
         over lines -->
    <p class="x" onclick="f()">Text &amp; more</p>
  </body>
</html>
`

const SHELL = `#!/usr/bin/env bash
set -euo pipefail

# a here-document keeps its state across lines
cat <<END
Hello $USER
  indented \${HOME}
END

greet() {
  local name="\${1:-world}"
  if [[ -n "$name" ]]; then
    echo "hi $name" | tr 'a-z' 'A-Z'
  fi
}

for f in *.txt; do greet "$f"; done
`

const repeat = (text: string, lines: number): string => {
  const one = text.endsWith('\n') ? text : `${text}\n`
  let out = ''
  while (out.split('\n').length < lines) out += one
  return out
}
const head = (file: string, lines: number): string => fs.readFileSync(file, 'utf8').split('\n').slice(0, lines).join('\n')

/** Twelve languages: files of this repository where it has them, samples otherwise; each longer than a few chunks. */
const SAMPLES: [lang: string, text: string][] = [
  ['typescript', head('tests/support/app.ts', 400)],
  ['tsx', repeat(TSX, 200)],
  ['json', head('package.json', 200)],
  ['css', head('app/renderer/src/shell/window.css', 400)],
  ['html', repeat(HTML, 150)],
  ['markdown', head('README.md', 200)],
  ['python', repeat(PYTHON, 200)],
  ['rust', head('native/kea-helper/src/limits.rs', 300)],
  ['go', repeat(GO, 200)],
  ['shellscript', repeat(SHELL, 150)],
  ['yaml', head('pnpm-lock.yaml', 300)],
  ['toml', head('constants/limits.toml', 300)],
]

const grammars = new ShikiGrammars()

function host(posted: FromWorker[], o: { onYield?: () => void; onPost?: (m: FromWorker) => void } = {}): EngineHost {
  let t = 0
  return {
    grammar: (lang) => grammars.grammar(lang),
    roleOf: () => grammars.roleOf(),
    grammars: () => grammars.count(),
    post: (m) => {
      posted.push(m)
      o.onPost?.(m)
    },
    // every reading is a millisecond later: a budget is spent at a known rate
    now: () => t++,
    yield: async () => {
      o.onYield?.()
      await new Promise<void>((r) => setImmediate(r))
    },
  }
}

const LIMITS = { firstLines: 5, chunkLines: 7, lineMax: 20_000, lineMs: 500, docsMax: 4 }

async function drained(engine: HighlightEngine): Promise<void> {
  while (engine.pending > 0) await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setImmediate(r))
}

function storeOf(posted: FromWorker[], id: number): TokenStore {
  const store = new TokenStore()
  for (const m of posted) if (m.t === 'chunk' && m.id === id) store.put(m)
  return store
}

const lineOf = (s: TokenStore, n: number): number[] | null => {
  const t = s.line(n)
  return t ? [...t.data.subarray(t.from, t.to)] : null
}

describe('chunked tokenisation', () => {
  it('U-FV-5 · chunks that resume from the saved grammar state equal a whole-file run in every language; a cancelled request posts no tokens; a reload resumes at the last boundary before its change; the budget stops a run', async () => {
    for (const [lang, text] of SAMPLES) {
      const lines = splitLines(text)
      const grammar = await grammars.grammar(lang)
      expect(grammar, lang).not.toBeNull()
      const whole = new TokenStore()
      whole.put(new LineTokenizer(grammar!, grammars.roleOf(), LIMITS).run(lines, 0, lines.length, INITIAL).chunk)
      // the sample has something to colour
      let coloured = 0
      for (let n = 0; n < lines.length; n++) for (const v of lineOf(whole, n) ?? []) if (tokenStyle(v) !== 0) coloured++
      expect(coloured, `${lang} has coloured tokens`).toBeGreaterThan(lines.length / 4)

      const posted: FromWorker[] = []
      const engine = new HighlightEngine(host(posted), LIMITS)
      engine.handle({ t: 'tokenize', id: 1, doc: `d:${lang}`, lang, text, from: 0, budgetMs: null })
      await drained(engine)
      const chunks = posted.filter((m) => m.t === 'chunk')
      // the first chunk is the first lines, the rest come in chunks, in order and with no gap
      expect(chunks[0]).toMatchObject({ from: 0, to: Math.min(lines.length, LIMITS.firstLines) })
      expect(chunks.length, lang).toBe(1 + Math.ceil(Math.max(0, lines.length - LIMITS.firstLines) / LIMITS.chunkLines))
      for (let i = 1; i < chunks.length; i++) expect((chunks[i] as { from: number }).from).toBe((chunks[i - 1] as { to: number }).to)
      expect(posted.at(-1)).toMatchObject({ t: 'done', id: 1, lines: lines.length, stoppedAt: null })
      const store = storeOf(posted, 1)
      expect(store.lines, lang).toBe(lines.length)
      const differing: number[] = []
      for (let n = 0; n < lines.length; n++) {
        const a = lineOf(store, n) as number[]
        const b = lineOf(whole, n) as number[]
        if (a.length !== b.length || a.some((v, i) => v !== b[i])) differing.push(n)
        // token starts ascend within a line and stay inside it
        for (let i = 0; i < a.length; i++) {
          if (tokenStart(a[i] as number) >= Math.max(1, (lines[n] as string).length)) differing.push(-n)
          if (i > 0 && tokenStart(a[i] as number) <= tokenStart(a[i - 1] as number)) differing.push(-n)
        }
      }
      expect(differing, `${lang}: lines whose chunked tokens differ from the whole-file run`).toEqual([])
    }

    // ── a reload: the same document key, changed from one line on ─────────
    const [, tsText] = SAMPLES[0]!
    const before = splitLines(tsText)
    const changedAt = 61
    const after = [...before.slice(0, changedAt), '/* a comment opened by the change', ...before.slice(changedAt, 200), '*/ const closed = 1', ...before.slice(200)]
    const posted: FromWorker[] = []
    const engine = new HighlightEngine(host(posted), LIMITS)
    engine.handle({ t: 'tokenize', id: 1, doc: 'reload', lang: 'typescript', text: before.join('\n'), from: 0, budgetMs: null })
    await drained(engine)
    posted.length = 0
    engine.handle({ t: 'tokenize', id: 2, doc: 'reload', lang: 'typescript', text: after.join('\n'), from: changedAt, budgetMs: null })
    await drained(engine)
    const first = posted.find((m) => m.t === 'chunk') as { from: number }
    // it starts at the last chunk boundary at or before the change, not at the top
    expect(first.from).toBeGreaterThan(0)
    expect(first.from).toBeLessThanOrEqual(changedAt)
    expect(changedAt - first.from).toBeLessThan(LIMITS.chunkLines)
    const ts = await grammars.grammar('typescript')
    const wholeAfter = new TokenStore()
    wholeAfter.put(new LineTokenizer(ts!, grammars.roleOf(), LIMITS).run(after, 0, after.length, INITIAL).chunk)
    const resumed = storeOf(posted, 2)
    const wrong: number[] = []
    for (let n = first.from; n < after.length; n++) if (JSON.stringify(lineOf(resumed, n)) !== JSON.stringify(lineOf(wholeAfter, n))) wrong.push(n)
    expect(wrong).toEqual([])
    // another language under the same key starts from the top
    posted.length = 0
    engine.handle({ t: 'tokenize', id: 3, doc: 'reload', lang: 'json', text: '{"a": 1}', from: 5, budgetMs: null })
    await drained(engine)
    expect(posted.find((m) => m.t === 'chunk')).toMatchObject({ from: 0 })

    // ── cancel: nothing is posted for a request cancelled before its first chunk, and nothing more after a later one ──
    posted.length = 0
    engine.handle({ t: 'tokenize', id: 10, doc: 'c1', lang: 'typescript', text: tsText, from: 0, budgetMs: null })
    engine.handle({ t: 'cancel', id: 10 })
    await drained(engine)
    expect(posted.filter((m) => m.id === 10)).toEqual([])
    let yields = 0
    const posted2: FromWorker[] = []
    const engine2: HighlightEngine = new HighlightEngine(
      host(posted2, {
        onYield: () => {
          if (++yields === 3) engine2.handle({ t: 'cancel', id: 11 })
        },
      }),
      LIMITS,
    )
    engine2.handle({ t: 'tokenize', id: 11, doc: 'c2', lang: 'typescript', text: tsText, from: 0, budgetMs: null })
    await drained(engine2)
    expect(posted2.filter((m) => m.t === 'chunk')).toHaveLength(3)
    expect(posted2.some((m) => m.t === 'done' || m.t === 'failed')).toBe(false)
    expect(engine2.pending).toBe(0)
    // a newer request for the same document replaces the older one; `forget` drops the document's marks
    posted2.length = 0
    engine2.handle({ t: 'tokenize', id: 12, doc: 'c3', lang: 'json', text: '{}\n'.repeat(40), from: 0, budgetMs: null })
    engine2.handle({ t: 'tokenize', id: 13, doc: 'c3', lang: 'json', text: '[]\n'.repeat(40), from: 0, budgetMs: null })
    await drained(engine2)
    expect(posted2.filter((m) => m.id === 12)).toEqual([])
    expect(posted2.at(-1)).toMatchObject({ t: 'done', id: 13 })
    expect(engine2.documents).toBeGreaterThan(0)
    for (const d of ['c1', 'c2', 'c3']) engine2.handle({ t: 'forget', doc: d })
    expect(engine2.documents).toBe(0)
    // marks are kept for at most `docsMax` documents
    for (let i = 0; i < LIMITS.docsMax + 3; i++) engine2.handle({ t: 'tokenize', id: 20 + i, doc: `many:${i}`, lang: 'json', text: '{}', from: 0, budgetMs: null })
    await drained(engine2)
    expect(engine2.documents).toBe(LIMITS.docsMax)

    // ── A budget stops the run and says where; two requests take turns ──
    const posted3: FromWorker[] = []
    const engine3 = new HighlightEngine(host(posted3), LIMITS)
    // the test clock adds a millisecond per chunk: a budget of 4 is four chunks
    engine3.handle({ t: 'tokenize', id: 30, doc: 'budget', lang: 'typescript', text: tsText, from: 0, budgetMs: 4 })
    await drained(engine3)
    expect(posted3.at(-1)).toMatchObject({ t: 'done', id: 30, stoppedAt: LIMITS.firstLines + 3 * LIMITS.chunkLines })
    expect(posted3.filter((m) => m.t === 'chunk')).toHaveLength(4)
    posted3.length = 0
    engine3.handle({ t: 'tokenize', id: 31, doc: 'turn-a', lang: 'json', text: '{}\n'.repeat(30), from: 0, budgetMs: null })
    engine3.handle({ t: 'tokenize', id: 32, doc: 'turn-b', lang: 'json', text: '[]\n'.repeat(30), from: 0, budgetMs: null })
    await drained(engine3)
    const order = posted3.filter((m) => m.t === 'chunk').map((m) => m.id)
    expect(order.slice(0, 4)).toEqual([31, 32, 31, 32])

    // ── what cannot be tokenised: an unknown language fails the request; a line over the limit stays plain ──
    posted3.length = 0
    engine3.handle({ t: 'tokenize', id: 40, doc: 'none', lang: 'no-such-language', text: 'x', from: 0, budgetMs: null })
    engine3.handle({ t: 'tokenize', id: 41, doc: 'proto', lang: '__proto__', text: 'x', from: 0, budgetMs: null })
    await drained(engine3)
    expect(posted3.filter((m) => m.t === 'failed').map((m) => m.id)).toEqual([40, 41])
    const longLine = `const s = "${'x'.repeat(50)}"`
    const tk = new LineTokenizer(ts!, grammars.roleOf(), { lineMax: 20, lineMs: 500 })
    const s = new TokenStore()
    s.put(tk.run(['const a = 1', longLine, '/* open', '*/ let b = 2'], 0, 4, INITIAL).chunk)
    expect(lineOf(s, 1)).toEqual([])
    expect((lineOf(s, 0) as number[]).length).toBeGreaterThan(1)
    // the state carried on past the skipped line: the comment that opens after it still closes
    expect((lineOf(s, 3) as number[]).length).toBeGreaterThan(1)
  })
})

/** A seeded random number generator (mulberry32): the same edits on every run. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Tokens of every line of `text` from one run over the whole of it. */
async function wholeRun(lang: string, text: string): Promise<TokenStore> {
  const lines = splitLines(text)
  const store = new TokenStore()
  store.put(new LineTokenizer((await grammars.grammar(lang))!, grammars.roleOf(), LIMITS).run(lines, 0, lines.length, INITIAL).chunk)
  return store
}

/**
 * The window's side of an edit run, kept as `EditTokens` keeps it: the store follows each change (the edited lines keep
 * their colours), requests carry the line edits since the previous one, and a chunk that arrives after the text changed
 * is dropped.
 */
class EditSide {
  doc: Text
  readonly lang: string
  readonly store = new TokenStore()
  readonly engine: HighlightEngine
  /** Each request's chunks as the worker posted them. */
  readonly runs = new Map<number, [number, number][]>()
  /** The current request's chunks put in the store before the rest are lost, as when the text changes meanwhile. */
  keep = Infinity
  /** Done at the worker's next return to its event loop. */
  atYield: (() => void) | null = null
  id = 0
  private sent: Text | null = null
  private changes: ChangeSet | null = null
  private count = 0
  private sentCount = 0
  private applied = 0
  private moved = false

  constructor(lang: string, text: string) {
    this.lang = lang
    this.doc = Text.of(splitLines(text))
    const onYield = () => {
      const f = this.atYield
      this.atYield = null
      f?.()
    }
    this.engine = new HighlightEngine(host([], { onPost: (m) => this.received(m), onYield }), LIMITS)
  }

  private received(m: FromWorker): void {
    if (m.t !== 'chunk') return
    this.runs.get(m.id)?.push([m.from, m.to])
    if (m.id !== this.id || this.moved || this.applied >= this.keep) return
    this.store.put(m)
    this.applied++
  }

  edit(spec: ChangeSpec): void {
    const changes = ChangeSet.of(spec, this.doc.length)
    const next = changes.apply(this.doc)
    followEdits(this.store, changes, this.doc, next, true)
    this.changes = this.changes ? this.changes.compose(changes) : changes
    this.doc = next
    this.count++
    this.moved = true
  }

  request(o: { since?: number | null } = {}): number {
    const from = this.sent
    const edit: EditRun = {
      since: o.since !== undefined ? o.since : from === null ? null : this.sentCount,
      count: this.count,
      edits: from !== null && this.changes ? lineEdits(this.changes, from, this.doc) : [],
      applied: this.applied,
    }
    this.sent = this.doc
    this.changes = null
    this.sentCount = this.count
    this.applied = 0
    this.moved = false
    this.keep = Infinity
    this.runs.set(++this.id, [])
    this.engine.handle({ t: 'tokenize', id: this.id, doc: 'edited', lang: this.lang, text: this.doc.toString(), from: 0, budgetMs: null, edit })
    return this.id
  }

  /** Lines request `id` tokenised. */
  tokenised(id: number): number {
    let n = 0
    for (const [from, to] of this.runs.get(id) ?? []) n += to - from
    return n
  }

  /** Lines whose tokens differ from a whole-file run of the text as it is now (stale kept ones included). */
  async differing(): Promise<number[]> {
    const whole = await wholeRun(this.lang, this.doc.toString())
    const out: number[] = []
    for (let n = 0; n < this.doc.lines; n++) if (JSON.stringify(lineOf(this.store, n)) !== JSON.stringify(lineOf(whole, n))) out.push(n)
    if (this.store.lines !== this.doc.lines) out.push(-1)
    return out
  }
}

/** A random edit of `doc`: typing one character, a deletion, a paste of a few lines, a comment or string opened, or several cursors typing at once. */
function randomEdit(rng: () => number, doc: Text, pool: readonly string[]): { spec: ChangeSpec; typing: boolean } {
  const pos = () => Math.floor(rng() * (doc.length + 1))
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T
  const kind = rng()
  if (kind < 0.4) return { spec: { from: pos(), insert: pick(['a', 'x', 'Q', '1', ' ', '_', '.', '\n']) }, typing: true }
  if (kind < 0.5) return { spec: { from: pos(), insert: pick(['"', "'", '`', '/*', '*/', '<!--', '-->', '"""', '#', '{', '}', '(', ')', '\\', '[[', ']]']) }, typing: false }
  if (kind < 0.65) {
    const from = pos()
    return { spec: { from, to: Math.min(doc.length, from + Math.floor(rng() * 120)) }, typing: false }
  }
  if (kind < 0.8) {
    const at = Math.floor(rng() * pool.length)
    return { spec: { from: pos(), insert: pool.slice(at, at + 1 + Math.floor(rng() * 6)).join('\n') }, typing: false }
  }
  // several cursors type the same text; two of them may share a line
  const line = doc.line(1 + Math.floor(rng() * doc.lines))
  const at = new Set([line.from + Math.floor(rng() * (line.length + 1)), line.from + Math.floor(rng() * (line.length + 1))])
  for (let i = 0, n = 1 + Math.floor(rng() * 4); i < n; i++) at.add(pos())
  const insert = pick(['a', 'z9', ' ', '\n', '//'])
  return { spec: [...at].sort((a, b) => a - b).map((from) => ({ from, insert })), typing: false }
}

describe('highlighting while the user types', () => {
  it('U-FV-26 · an edit run with per-line states equals a whole-file run after random edits, multi-line and multi-cursor ones included, in every language, and stops early', async () => {
    let typed = 0
    let toEnd = 0
    for (const [i, [lang, text]] of SAMPLES.entries()) {
      const side = new EditSide(lang, text)
      const first = side.request()
      await drained(side.engine)
      // a first request tokenises the whole text from the top, its first chunk L.viewerFirstLines long
      expect(side.runs.get(first)?.[0], lang).toEqual([0, LIMITS.firstLines])
      expect(side.tokenised(first), lang).toBe(side.doc.lines)
      expect(side.engine.endStates('edited'), lang).toBe(side.doc.lines)
      expect(await side.differing(), lang).toEqual([])
      const rng = random(0x5eed + i)
      const pool = splitLines(text)
      for (let step = 0; step < 14; step++) {
        const mode = rng()
        // one to three changes between two requests, as typing between two frames gives
        let typing = true
        let firstLine = side.doc.lines
        for (let n = 1 + Math.floor(rng() * 3); n > 0; n--) {
          const e = randomEdit(rng, side.doc, pool)
          const changes = ChangeSet.of(e.spec, side.doc.length)
          changes.iterChangedRanges((fromA) => void (firstLine = Math.min(firstLine, side.doc.lineAt(fromA).number - 1)))
          typing &&= e.typing
          side.edit(e.spec)
        }
        const id = side.request()
        const label = `${lang}, step ${step}`
        if (mode < 0.15) {
          // the window put only some of this request's chunks in its store: the next request has the rest done again
          side.keep = Math.floor(rng() * 2)
          await drained(side.engine)
          side.edit(randomEdit(rng, side.doc, pool).spec)
          side.request()
        } else if (mode < 0.3) {
          // the text changes while the run is under way: the newer request takes over from where the run had got to
          side.atYield = () => {
            side.edit(randomEdit(rng, side.doc, pool).spec)
            side.request()
          }
        }
        await drained(side.engine)
        expect(await side.differing(), label).toEqual([])
        if (mode >= 0.3 && typing) {
          typed += side.tokenised(id)
          toEnd += side.doc.lines - firstLine
        }
      }
    }
    // typing a character mostly leaves the line's end state as it was: the runs stop long before the end of the file
    expect(typed).toBeGreaterThan(0)
    expect(typed / toEnd).toBeLessThan(0.25)
  })

  it('U-FV-26 · a run tokenises the edited lines and stops at the first that ends as before; one that changes the state runs on in chunks, the first L.viewerFirstLines long', async () => {
    const text = Array.from({ length: 60 }, (_, n) => `const v${n} = ${n}`).join('\n')
    const side = new EditSide('typescript', text)
    side.request()
    await drained(side.engine)
    const at = (line: number, col: number) => side.doc.line(line + 1).from + col
    // a letter typed in a name: that line alone
    side.edit({ from: at(30, 7), insert: 'x' })
    expect(side.runs.get(side.request())).toEqual([])
    await drained(side.engine)
    expect(side.runs.get(side.id)).toEqual([[30, 31]])
    // a line broken in two: both halves
    side.edit({ from: at(10, 5), insert: '\n' })
    side.request()
    await drained(side.engine)
    expect(side.runs.get(side.id)).toEqual([[10, 12]])
    // two cursors far apart: each place on its own, the lines between left alone
    side.edit([
      { from: at(5, 7), insert: 'y' },
      { from: at(50, 7), insert: 'y' },
    ])
    side.request()
    await drained(side.engine)
    expect(side.runs.get(side.id)).toEqual([
      [5, 6],
      [50, 51],
    ])
    // a comment opened: everything after it changes, chunk by chunk to the end
    side.edit({ from: at(20, 0), insert: '/*' })
    side.request()
    await drained(side.engine)
    const run = side.runs.get(side.id)!
    expect(run[0]).toEqual([20, 20 + LIMITS.firstLines])
    expect(run[1]).toEqual([20 + LIMITS.firstLines, 20 + LIMITS.firstLines + LIMITS.chunkLines])
    expect(run.at(-1)?.[1]).toBe(side.doc.lines)
    // closed again: the lines after it come back, then a letter typed far below is one line again
    side.edit({ from: side.doc.line(26).to, insert: ' */' })
    side.request()
    await drained(side.engine)
    expect(side.runs.get(side.id)?.[0]?.[0]).toBe(25)
    side.edit({ from: at(55, 7), insert: 'z' })
    side.request()
    await drained(side.engine)
    expect(side.runs.get(side.id)).toEqual([[55, 56]])
    expect(await side.differing()).toEqual([])

    // a comment opened, the run's first chunk ending past the edited line and lost on the way, and a newer request
    // before the second: the newer one tokenises that chunk again and goes on past it, to the end
    side.edit({ from: at(40, 0), insert: '/*' })
    side.request()
    side.keep = 0
    side.atYield = () => side.request()
    await drained(side.engine)
    expect(side.runs.get(side.id)?.at(-1)?.[1]).toBe(side.doc.lines)
    expect(await side.differing()).toEqual([])
  })

  it('U-FV-26 · a request whose count does not follow on from the one the worker holds drops the line states and starts from the top', async () => {
    const [, text] = SAMPLES[0]!
    const side = new EditSide('typescript', text)
    side.request()
    await drained(side.engine)
    // a count the worker does not hold: from the top, over every line
    side.edit({ from: side.doc.line(100).from, insert: 'let a = 1\n' })
    const mismatched = side.request({ since: 41 })
    await drained(side.engine)
    expect(side.runs.get(mismatched)?.[0]?.[0]).toBe(0)
    expect(side.tokenised(mismatched)).toBe(side.doc.lines)
    expect(side.engine.endStates('edited')).toBe(side.doc.lines)
    expect(await side.differing()).toEqual([])
    // a first request (no count to follow on from), and one after the document was read as read-only, do the same
    side.edit({ from: side.doc.line(200).from, insert: 'x' })
    const fresh = side.request({ since: null })
    await drained(side.engine)
    expect(side.tokenised(fresh)).toBe(side.doc.lines)
    side.engine.handle({ t: 'tokenize', id: 900, doc: 'edited', lang: 'typescript', text: side.doc.toString(), from: 0, budgetMs: null })
    await drained(side.engine)
    expect(side.engine.endStates('edited')).toBe(0)
    side.edit({ from: side.doc.line(300).from, insert: 'y' })
    const after = side.request()
    await drained(side.engine)
    expect(side.tokenised(after)).toBe(side.doc.lines)
    expect(await side.differing()).toEqual([])
    // and the state goes with `forget`
    side.engine.handle({ t: 'forget', doc: 'edited' })
    expect(side.engine.endStates('edited')).toBe(0)
  })
})

describe('token colours', () => {
  it('U-FV-5 · a token is drawn in the role its theme colour stands for, also after Shiki has taken the theme: comment, keyword, string, number, function', async () => {
    const g = await grammars.grammar('javascript')
    const t = new LineTokenizer(g!, grammars.roleOf(), { lineMax: 20000, lineMs: 500 })
    const lines = ['// note', 'const n = 42', 'function f() { return "s" }']
    const { chunk } = t.run(lines, 0, lines.length, INITIAL)
    const store = new TokenStore()
    store.put(chunk)
    /** The class of the token that covers `text` on line `n`. */
    const classOf = (n: number, text: string): string => {
      const col = (lines[n] as string).indexOf(text)
      const l = store.line(n)!
      let cls = ''
      for (let i = l.from; i < l.to; i++) if (tokenStart(l.data[i] as number) <= col) cls = tokenClass(tokenStyle(l.data[i] as number))
      return cls
    }
    expect(classOf(0, '// note')).toBe('kea-tok-comment')
    expect(classOf(1, 'const')).toBe('kea-tok-keyword')
    expect(classOf(1, '42')).toBe('kea-tok-constant')
    expect(classOf(2, 'function')).toBe('kea-tok-keyword')
    expect(classOf(2, 'f()')).toBe('kea-tok-function')
    expect(classOf(2, '"s"')).toBe('kea-tok-string')
    // the role names and the stylesheet still agree with the theme as generated (Shiki must not have changed Kea's)
    expect(SYNTAX_ROLES.slice(0, 4)).toEqual(['text', 'comment', 'keyword', 'string'])
    expect(SYNTAX_THEME.tokenColors.map((r) => r.name)).toEqual([...SYNTAX_ROLES])
    expect(syntaxCss()).toContain('.kea-tok-comment{color:')
  })
})
