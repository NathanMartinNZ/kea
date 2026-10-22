// IDs and references: classifying IDs, parsing a free-text list of references (a Covers cell, a `// covers:` line, a
// roadmap Spec cell) and expanding ranges, slash lists and wildcards.

export type IdKind =
  | 'ac'
  | 'fail'
  | 'upstream'
  | 'decision'
  | 'goal'
  | 'risk'
  | 'assumption'
  | 'spike'
  | 'budget'
  | 'test'
  | 'requirement'

/** A test ID: `<suite>-<AREA>-<n>`, or numbered-only for DS / V / A. P-IDs are budgets and perf tests. */
export const TEST_ID_RE = /^(?:(?:DS|V|A)-\d+[a-z]?|(?:U|R|I|E|P|C|K|L)-[A-Z]+(?:-[A-Z]+)*-\d+[a-z]?)$/

export function kindOf(id: string): IdKind | null {
  if (/^AC-\d{2}\.\d+$/.test(id)) return 'ac'
  if (/^FAIL-\d+$/.test(id)) return 'fail'
  if (/^UP-\d+$/.test(id)) return 'upstream'
  if (/^D\d+$/.test(id)) return 'decision'
  if (/^G\d+$/.test(id)) return 'goal'
  if (/^R\d+$/.test(id)) return 'risk'
  if (/^A\d+$/.test(id)) return 'assumption'
  if (/^S-\d+$/.test(id)) return 'spike'
  if (/^P-[A-Z]+-\d+[a-z]?$/.test(id)) return 'budget'
  if (TEST_ID_RE.test(id)) return 'test'
  if (/^[A-Z]{2,6}-\d+$/.test(id)) return 'requirement'
  return null
}

/**
 * IDs the milestone filter ignores: goals, decisions, upstream issues — and, by the same logic, risks, assumptions and
 * spikes.
 */
export function isMilestoneFree(id: string): boolean {
  const k = kindOf(id)
  return k === 'goal' || k === 'decision' || k === 'upstream' || k === 'risk' || k === 'assumption' || k === 'spike'
}

// ── anchors ──────────────────────────────────────────────────────────────────────────────────────

/** Canonical plan documents, as prose names them ("spec 04", "architecture", "data model", "tests 00"). */
export type DocKey = string

/** A plan section: `{ doc: 'spec 04', section: '5' }`, `{ doc: 'architecture', section: '2', rule: 7 }`. */
export type Anchor = { doc: DocKey; section: string; rule?: number }

const PROSE_DOCS: Record<string, DocKey> = {
  architecture: 'architecture',
  arch: 'architecture',
  design: 'design',
  'design system': 'design',
  'data model': 'data model',
  research: 'research',
  product: 'product',
  roadmap: 'roadmap',
  risks: 'risks',
  decisions: 'decisions',
  upstream: 'upstream',
}

/** Token form used as owners in constants/ (`arch-2.7`, `spec-04-1`, `data-model-1`, `design-6.9`, `tests-00-2b`). */
const TOKEN_DOCS: Record<string, DocKey> = {
  arch: 'architecture',
  architecture: 'architecture',
  design: 'design',
  'data-model': 'data model',
  research: 'research',
  product: 'product',
  roadmap: 'roadmap',
}

export function anchorKey(a: Anchor): string {
  return `${a.doc} §${a.section}${a.rule !== undefined ? ` rule ${a.rule}` : ''}`
}

/** Parse a token anchor (`arch-2.7`, `spec-13-3`) into one or two candidate anchors: a dotted suffix is a subsection if
 *  one exists, else a numbered rule of the section (`arch-2.7` = architecture §2 rule 7). Resolution picks the candidate. */
export function parseTokenAnchor(token: string): Anchor[] | null {
  let m = /^(spec|tests)-(\d{2})-([0-9]+[a-z]?|[A-Z])(?:\.(\d+[a-z]?))?$/.exec(token)
  let doc: DocKey
  let sec: string
  let sub: string | undefined
  if (m) {
    doc = `${m[1]} ${m[2]}`
    sec = m[3]!
    sub = m[4]
  } else {
    m = /^(arch|architecture|design|data-model|research|product|roadmap)-([0-9]+[a-z]?)(?:\.(\d+[a-z]?))?$/.exec(token)
    if (!m) return null
    doc = TOKEN_DOCS[m[1]!]!
    sec = m[2]!
    sub = m[3]
  }
  if (sub === undefined) return [{ doc, section: sec }]
  const out: Anchor[] = [{ doc, section: `${sec}.${sub}` }]
  if (/^\d+$/.test(sub)) out.push({ doc, section: sec, rule: Number(sub) })
  return out
}

// ── reference parsing ───────────────────────────────────────────────────────────────────────────

export type Ref =
  | { kind: 'id'; id: string; source: string }
  | { kind: 'anchor'; anchors: Anchor[]; source: string } // alternatives (token anchors); the first that exists wins
  | { kind: 'wildcard'; prefix: string; source: string } // `ST-*` → every known ID starting with `ST-`
  | { kind: 'unparsed'; text: string; source: string }

const DOC_ALT = 'spec \\d{2}|tests \\d{2}|architecture|arch|design system|design|data model|research|product|roadmap|risks|decisions|upstream'
const SECTION = '[0-9A-Z][0-9A-Za-z]*(?:\\.\\d+[a-z]?)*'
const RANGE_SEP = '\\s*(?:…|\\.\\.\\.|–)\\s*'
const ID_BODY = '[A-Z][A-Z0-9]*(?:-[A-Z]+)*'

const PATTERNS: { name: string; re: string }[] = [
  // "architecture §2 rules 5–6", "spec 02 §2 step 1", "design §6.9", "tests 00 §2b"
  { name: 'section', re: `(?:${DOC_ALT})\\s*§\\s*${SECTION}(?:\\s+(?:rules?|principles?|items?|steps?|invariants?)\\s+\\d+(?:${RANGE_SEP}\\d+)?)?` },
  // "data model invariant 3"
  { name: 'invariant', re: `data model invariants?\\s+\\d+(?:${RANGE_SEP}\\d+)?` },
  // token anchors as used in constants/ owners
  { name: 'token', re: `\\b(?:spec-\\d{2}|tests-\\d{2}|arch|architecture|design|data-model|research|product|roadmap)-(?:\\d+[a-z]?|[A-Z])(?:\\.\\d+[a-z]?)?\\b` },
  // AC-02.1…7, AC-02.1…AC-02.7
  { name: 'ac', re: `\\bAC-\\d{2}\\.\\d+(?:${RANGE_SEP}(?:AC-\\d{2}\\.)?\\d+)?` },
  // HLD-1…15, ST-14…ST-16, I-AGT-1/2, C-KILL-1/2/3, ST-*, P-MEM-2b
  { name: 'id', re: `\\b${ID_BODY}-(?:\\*|\\d+[a-z]?(?:(?:${RANGE_SEP}(?:${ID_BODY}-)?\\d+)|(?:\\/\\d+[a-z]?)+)?)` },
  // D15, G1, R30, A6
  { name: 'single', re: '\\b[DGRA]\\d+\\b' },
]

const COMBINED = new RegExp(PATTERNS.map((p) => `(${p.re})`).join('|'), 'g')

function rangeNumbers(a: number, b: number): number[] {
  if (b < a || b - a > 500) return [a]
  const out: number[] = []
  for (let i = a; i <= b; i++) out.push(i)
  return out
}

function expandSectionRef(text: string): Ref {
  const m = new RegExp(`^(${DOC_ALT})\\s*§\\s*(${SECTION})(?:\\s+(rules?|principles?|items?|steps?|invariants?)\\s+(\\d+)(?:${RANGE_SEP}(\\d+))?)?$`).exec(text)
  if (!m) return { kind: 'unparsed', text, source: text }
  const docName = m[1]!
  const doc = /^(spec|tests) \d{2}$/.test(docName) ? docName : PROSE_DOCS[docName]!
  const section = m[2]!
  const word = m[3]
  if (!word || word.startsWith('step')) return { kind: 'anchor', anchors: [{ doc, section }], source: text }
  const from = Number(m[4])
  const to = m[5] !== undefined ? Number(m[5]) : from
  // A rule range becomes one anchor per rule; callers flatten `anchors` only as alternatives, so return the first and
  // let parseRefs push the rest.
  return { kind: 'anchor', anchors: rangeNumbers(from, to).map((rule) => ({ doc, section, rule })), source: text }
}

function expandIdRef(text: string): Ref[] {
  const compact = text.replace(/\s+/g, '')
  const wild = /^(.+-)\*$/.exec(compact)
  if (wild) return [{ kind: 'wildcard', prefix: wild[1]!, source: text }]
  const ac = /^AC-(\d{2})\.(\d+)(?:(?:…|\.\.\.|–)(?:AC-\d{2}\.)?(\d+))?$/.exec(compact)
  if (ac) {
    const from = Number(ac[2])
    const to = ac[3] !== undefined ? Number(ac[3]) : from
    return rangeNumbers(from, to).map((n) => ({ kind: 'id', id: `AC-${ac[1]}.${n}`, source: text }) as Ref)
  }
  const range = /^(.+-)(\d+)(?:…|\.\.\.|–)(?:(.+-))?(\d+)$/.exec(compact)
  if (range) {
    const prefix = range[1]!
    if (range[3] !== undefined && range[3] !== prefix) return [{ kind: 'unparsed', text, source: text }]
    return rangeNumbers(Number(range[2]), Number(range[4])).map((n) => ({ kind: 'id', id: `${prefix}${n}`, source: text }) as Ref)
  }
  const slash = /^(.+-)(\d+[a-z]?)((?:\/\d+[a-z]?)+)$/.exec(compact)
  if (slash) {
    const nums = [slash[2]!, ...slash[3]!.split('/').filter(Boolean)]
    return nums.map((n) => ({ kind: 'id', id: `${slash[1]}${n}`, source: text }) as Ref)
  }
  return [{ kind: 'id', id: compact, source: text }]
}

/**
 * Parse a list of references: IDs, ranges (`HLD-1…15`, `HLD-1...15`, `ST-14…ST-16`, `AC-02.1…7`), slash lists
 * (`I-AGT-1/2`), wildcards (`ST-*`), prose section references (`spec 04 §5`, `architecture §2 rule 6`,
 * `data model invariant 3`) and token anchors (`arch-2.7`, `spec-04-1`). Text that is none of these (other than
 * separators and "—") is returned as `unparsed`.
 */
export function parseRefs(text: string): Ref[] {
  const out: Ref[] = []
  let last = 0
  const leftovers: string[] = []
  for (const m of text.matchAll(COMBINED)) {
    leftovers.push(text.slice(last, m.index))
    last = m.index + m[0].length
    const which = PATTERNS[m.slice(1).findIndex((g) => g !== undefined)]!.name
    const s = m[0]
    if (which === 'section') {
      const r = expandSectionRef(s.replace(/\s+/g, ' '))
      // a rule range ("rules 5–6") is several anchors that are all covered, not alternatives
      if (r.kind === 'anchor' && r.anchors.length > 1 && r.anchors[0]!.rule !== undefined) {
        for (const a of r.anchors) out.push({ kind: 'anchor', anchors: [a], source: s })
      } else out.push(r)
    } else if (which === 'invariant') {
      const im = /(\d+)(?:\s*(?:…|\.\.\.|–)\s*(\d+))?$/.exec(s)!
      for (const n of rangeNumbers(Number(im[1]), im[2] !== undefined ? Number(im[2]) : Number(im[1]))) {
        out.push({ kind: 'anchor', anchors: [{ doc: 'data model', section: 'invariants', rule: n }], source: s })
      }
    } else if (which === 'token') {
      out.push({ kind: 'anchor', anchors: parseTokenAnchor(s)!, source: s })
    } else {
      out.push(...expandIdRef(s))
    }
  }
  leftovers.push(text.slice(last))
  // a parenthesised note without references (`data model §1 (ids)`) annotates; it is not a reference
  const rest = leftovers.join(' ').replace(/\([^()]*\)/g, '').replace(/[\s,;.:()[\]'"`—–\-+&/]|\band\b|\bor\b/g, '')
  if (rest.length > 0) out.push({ kind: 'unparsed', text: leftovers.join(' ').replace(/\s+/g, ' ').trim(), source: text })
  return out
}

/** Expand wildcards against a universe of known IDs. Returns the matching IDs (sorted naturally). */
export function expandWildcard(prefix: string, universe: Iterable<string>): string[] {
  const out: string[] = []
  for (const id of universe) {
    if (!id.startsWith(prefix)) continue
    const rest = id.slice(prefix.length)
    if (/^\d+[a-z]?$/.test(rest)) out.push(id)
  }
  return out.sort(compareIds)
}

/** Natural sort for IDs: `HLD-2` < `HLD-10`, `AC-02.3` < `AC-02.10`. */
export function compareIds(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true })
}

/** Compress IDs into runs: HLD-1, HLD-2, HLD-3, HLD-5 → HLD-1…3, HLD-5. */
export function compress(ids: string[]): string {
  const sorted = [...ids].sort(compareIds)
  const parts: string[] = []
  let i = 0
  while (i < sorted.length) {
    const m = /^(.*?)(\d+)$/.exec(sorted[i]!)
    if (!m) {
      parts.push(sorted[i]!)
      i++
      continue
    }
    let j = i
    while (j + 1 < sorted.length) {
      const n = /^(.*?)(\d+)$/.exec(sorted[j + 1]!)
      if (!n || n[1] !== m[1] || Number(n[2]) !== Number(/(\d+)$/.exec(sorted[j]!)![1]) + 1) break
      j++
    }
    parts.push(j > i ? `${sorted[i]}…${/(\d+)$/.exec(sorted[j]!)![1]}` : sorted[i]!)
    i = j + 1
  }
  return parts.join(', ')
}
