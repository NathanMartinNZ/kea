// Test IDs in code: a written test's name begins with its ID. What it covers is in .plan/coverage.tsv (coverage.ts).
//
// TypeScript / TSX (Vitest, Playwright):
//   it('U-PTY-1 · coalescer flushes at once after quiet', () => { … })
//   `it` / `test` with modifiers (`.skip`, `.only`, `.todo`, `.concurrent`, `.fails`), including those that take
//   arguments of their own (`.skipIf(…)`, `.runIf(…)`, `.each(…)`, `.for(…)`), however deeply those nest.
//
// Rust (`cargo test`, proptest):
//   #[test]                          // test: R-HLD-1
//   fn r_hld_1_ring_wraps() {}       #[test]
//                                    fn ring_wraps() {}
//   The ID comes from a `// test:` line or from a test-ID-prefixed function name (`r_hld_1_…` → R-HLD-1,
//   `k_lv_cl_3_…` → K-LV-CL-3). Comments and attributes directly above `fn` belong to it.
import type { SourceFile } from './plan.ts'
import { TEST_ID_RE } from './refs.ts'

export type WrittenTest = {
  /** null when the test name does not start with a test ID (counted as untagged). */
  id: string | null
  name: string
  path: string
  line: number // 0-based
  lang: 'ts' | 'rust'
}

const NAME_ID_RE = /^((?:DS|V|A)-\d+[a-z]?|(?:U|R|I|E|P|C|K|L)-[A-Z]+(?:-[A-Z]+)*-\d+[a-z]?)(?![\w-])/

const CALL_START_RE = /(?<![\w.$])(?:it|test)\b/g
const MODIFIER_RE = /\.(skip|only|todo|concurrent|sequential|fails|skipIf|runIf|each|for)\b\s*/y
const TAKES_ARGS = new Set(['skipIf', 'runIf', 'each', 'for'])
const NAME_RE = /\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/y

/** The offset just past the bracket that closes the one at `open`, skipping string literals; -1 when none does. */
function pastClose(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]!
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++
    } else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) return i + 1
    }
  }
  return -1
}

/** Every `it(…)` / `test(…)` call with a string name, past its modifiers: where it starts, and its name. */
function* testCalls(text: string): Generator<{ index: number; name: string }> {
  for (const m of text.matchAll(CALL_START_RE)) {
    let at = m.index + m[0].length
    for (;;) {
      MODIFIER_RE.lastIndex = at
      const mod = MODIFIER_RE.exec(text)
      if (!mod) break
      at = MODIFIER_RE.lastIndex
      if (TAKES_ARGS.has(mod[1]!)) at = text[at] === '(' ? pastClose(text, at) : -1
      if (at < 0) break
    }
    if (at < 0) continue
    NAME_RE.lastIndex = at
    const name = NAME_RE.exec(text)
    if (name) yield { index: m.index, name: name[2]! }
  }
}

function lineStarts(text: string): number[] {
  const out = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1)
  return out
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The comment and attribute lines directly above `line`, nearest first. */
function commentBlockAbove(lines: string[], line: number, allowAttributes: boolean): string[] {
  const out: string[] = []
  for (let i = line - 1; i >= 0; i--) {
    const t = lines[i]!.trim()
    if (t.startsWith('//')) out.push(t)
    else if (allowAttributes && t.startsWith('#[')) continue
    else break
  }
  return out
}

export function extractTsTests(file: SourceFile): WrittenTest[] {
  const out: WrittenTest[] = []
  const starts = lineStarts(file.text)
  for (const call of testCalls(file.text)) {
    const name = call.name.replace(/\\(.)/g, '$1')
    const idm = NAME_ID_RE.exec(name)
    out.push({ id: idm ? idm[1]! : null, name, path: file.path, line: lineAt(starts, call.index), lang: 'ts' })
  }
  return out
}

/** `r_hld_1_ring_wraps` → `R-HLD-1`; `ds_1_contrast` → `DS-1`; null when the name does not start with a test ID. */
export function idFromRustName(name: string): string | null {
  const m = /^([a-z]+(?:_[a-z]+)*)_(\d+[a-z]?)(?:_|$)/.exec(name)
  if (!m) return null
  const id = `${m[1]!.toUpperCase().replace(/_/g, '-')}-${m[2]}`
  return TEST_ID_RE.test(id) ? id : null
}

export function extractRustTests(file: SourceFile, isKnownArea: (id: string) => boolean = () => true): WrittenTest[] {
  const out: WrittenTest[] = []
  const lines = file.text.split('\n')
  lines.forEach((l, i) => {
    const fm = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*[(<]/.exec(l)
    if (!fm) return
    let isTest = false
    for (let j = i - 1; j >= 0; j--) {
      const t = lines[j]!.trim()
      if (t.startsWith('#[')) {
        if (/^#\[(?:[\w:]*::)?test\b|^#\[(?:rstest|test_case|quickcheck)\b/.test(t)) isTest = true
        continue
      }
      if (t.startsWith('//')) continue
      break
    }
    if (!isTest) return
    const testLine = commentBlockAbove(lines, i, true)
      .map((c) => /^\/\/[/!]?\s*test\s*:\s*(\S+)/i.exec(c))
      .find((x) => x)
    const fromName = idFromRustName(fm[1]!)
    const id = testLine ? testLine[1]!.replace(/[.,;]$/, '') : fromName && isKnownArea(fromName) ? fromName : null
    out.push({ id, name: fm[1]!, path: file.path, line: i, lang: 'rust' })
  })
  return out
}

export function extractTests(file: SourceFile, isKnownArea?: (id: string) => boolean): WrittenTest[] {
  if (file.path.endsWith('.rs')) return extractRustTests(file, isKnownArea)
  return extractTsTests(file)
}
