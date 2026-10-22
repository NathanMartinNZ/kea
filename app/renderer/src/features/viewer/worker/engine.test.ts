import fs from 'node:fs'
import { INITIAL } from 'shiki/textmate'
import { describe, expect, it } from 'vitest'
import { SYNTAX_ROLES, SYNTAX_THEME, syntaxCss, tokenClass } from '../syntax.ts'
import { TokenStore, tokenStart, tokenStyle } from '../tokens.ts'
import { HighlightEngine, type EngineHost } from './engine.ts'
import type { FromWorker } from './protocol.ts'
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

function host(posted: FromWorker[], o: { onYield?: () => void } = {}): EngineHost {
  let t = 0
  return {
    grammar: (lang) => grammars.grammar(lang),
    roleOf: () => grammars.roleOf(),
    grammars: () => grammars.count(),
    post: (m) => void posted.push(m),
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
