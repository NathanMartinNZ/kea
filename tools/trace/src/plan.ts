// Reading the plan (.plan/): documents and their numbered sections, the IDs each document defines, the planned test
// rows of tests 01–08, the budgets of tests 04 and the roadmap's milestone deliverable tables.
import { type Anchor, type DocKey, type Ref, anchorKey, kindOf, parseRefs, TEST_ID_RE } from './refs.ts'

export type SourceFile = { path: string; text: string }

export type Heading = {
  level: number
  /** Section number as cited with § (`2`, `6.1`, `10b`, `A`), or the slug of an unnumbered heading (`invariants`). */
  id: string
  text: string
  line: number // 0-based
  end: number // exclusive: the next heading of the same or a higher level
}

export type Doc = { key: DocKey; path: string; lines: string[]; headings: Heading[] }

export type Definition = {
  id: string
  doc: DocKey
  path: string
  line: number // 0-based
  text: string
  /** v1.1 or after v1 (excluded from "uncovered" and from exit lists). */
  deferred: boolean
}

export type PlannedTest = {
  id: string
  covers: Ref[]
  coversText: string
  path: string
  line: number
  tierA: boolean // marked ● in suite 08
  tierC: boolean // the row says Tier C: not built in v1
}

export type Budget = { id: string; covers: Ref[]; coversText: string; path: string; line: number }

export type Milestone = {
  n: number
  title: string
  line: number
  /** Every reference in the milestone's Deliverable/Spec table. */
  delivers: Ref[]
  /** Test IDs (or test wildcards such as `K-LV-CL-*`) the milestone's Exit / Behaviour text names explicitly. */
  namedTests: string[]
}

export type PlanIndex = {
  docs: Map<DocKey, Doc>
  defs: Map<string, Definition>
  /** IDs defined more than once (first definition wins). */
  duplicateDefs: Definition[]
  planned: PlannedTest[]
  budgets: Map<string, Budget>
  milestones: Milestone[]
}

/** `.plan/specs/04-files.md` → `spec 04`; `.plan/plan/03-architecture.md` → `architecture`; `.plan/tests/00-strategy.md` → `tests 00`. */
export function docKeyOf(path: string): DocKey | null {
  const m = /(specs|plan|tests)\/(\d{2})-([a-z0-9-]+)\.md$/.exec(path)
  if (!m) return null
  if (m[1] === 'specs') return `spec ${m[2]}`
  if (m[1] === 'tests') return `tests ${m[2]}`
  const names: Record<string, DocKey> = {
    product: 'product',
    research: 'research',
    architecture: 'architecture',
    'data-model': 'data model',
    'design-system': 'design',
    roadmap: 'roadmap',
    risks: 'risks',
    decisions: 'decisions',
    upstream: 'upstream',
  }
  return names[m[3]!] ?? m[3]!
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/

/** Section id of a heading: `## 2. Create — WT-19` → `2`; `### 6.8b Menu-bar…` → `6.8b`; `## A. Holder` → `A`;
 *  `### Invariants (checked…)` → `invariants`. */
export function headingId(text: string): string {
  const m = /^([0-9]+[a-z]?(?:\.[0-9]+[a-z]?)*|[A-Z])\.?\s/.exec(text + ' ')
  if (m && (/\d/.test(m[1]!) || /^[A-Z]\.\s/.test(text))) return m[1]!
  return text
    .replace(/\(.*$/, '')
    .replace(/[`*]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function parseDoc(file: SourceFile): Doc | null {
  const key = docKeyOf(file.path)
  if (!key) return null
  const lines = file.text.split('\n')
  const headings: Heading[] = []
  let fence = false
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence
    if (fence) return
    const m = HEADING_RE.exec(l)
    if (!m) return
    headings.push({ level: m[1]!.length, id: headingId(m[2]!), text: m[2]!, line: i, end: lines.length })
  })
  for (let i = 0; i < headings.length; i++) {
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j]!.level <= headings[i]!.level) {
        headings[i]!.end = headings[j]!.line
        break
      }
    }
  }
  return { key, path: file.path, lines, headings }
}

/** Split a markdown table row into trimmed cells (`| a | b |` → [a, b]). Escaped pipes are kept. */
export function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split(/(?<!\\)\|/).map((c) => c.trim())
}

export type Table = { header: string[]; rows: { cells: string[]; line: number }[]; line: number }

export function tables(doc: Doc): Table[] {
  const out: Table[] = []
  let cur: Table | null = null
  let fence = false
  doc.lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence
    if (fence || !l.trimStart().startsWith('|')) {
      cur = null
      return
    }
    const c = cells(l)
    if (!cur) {
      cur = { header: c, rows: [], line: i }
      out.push(cur)
      return
    }
    if (c.every((x) => /^:?-{2,}:?$/.test(x))) return
    cur.rows.push({ cells: c, line: i })
  })
  return out
}

/** A requirement is deferred when its row or heading marks it v1.1 / after v1 as a whole — the last sentence is
 *  "v1.1." (CMP-11), or "(v1.1)" / "built after v1" / "(after v1)" — not when only a part of it is deferred
 *  ("`kea <path>` (v1.1 CLI)", "a rebinding UI is v1.1"). */
export function isDeferredText(text: string): boolean {
  const t = text.replace(/\s*\|\s*$/, '').trim()
  return (
    /(?:^|[.;—]\s+)v1\.1\.?$/.test(t) ||
    /\((?:v1\.1|after v1)\)/i.test(t) ||
    /\bbuilt after v1\b/i.test(t) ||
    /^\(v1\.1\b/.test(t)
  )
}

const REQ_ID_CELL = /^([A-Z]{2,6}-\d+)$/

function firstId(cell: string): string | null {
  const m = /^\**([A-Z][A-Z0-9]*(?:-[A-Z]+)*-\d+[a-z]?|[DGRA]\d+|AC-\d{2}\.\d+)\**/.exec(cell)
  return m ? m[1]! : null
}

export function indexPlan(files: SourceFile[]): PlanIndex {
  const docs = new Map<DocKey, Doc>()
  for (const f of files) {
    const d = parseDoc(f)
    if (d) docs.set(d.key, d)
  }
  const defs = new Map<string, Definition>()
  const duplicateDefs: Definition[] = []
  const define = (d: Definition) => {
    const prev = defs.get(d.id)
    if (prev) {
      // the same requirement in a heading and in a summary table is one definition; a deferral mark on either counts
      if (prev.doc !== d.doc) duplicateDefs.push(d)
      prev.deferred ||= d.deferred
      return
    }
    defs.set(d.id, d)
  }
  const planned: PlannedTest[] = []
  const budgets = new Map<string, Budget>()
  const milestones: Milestone[] = []

  for (const doc of docs.values()) {
    const isSpec = doc.key.startsWith('spec ')
    const isTests = doc.key.startsWith('tests ')

    // Headings that define requirements: "### 3.1 Detect — AGT-12", "## 4b. Account conditions — ST-14…ST-16"
    if (isSpec) {
      for (const h of doc.headings) {
        const m = /—\s*([A-Z]{2,6}-\d+(?:\s*(?:…|\.\.\.)\s*(?:[A-Z]{2,6}-)?\d+)?)/.exec(h.text)
        if (!m) continue
        for (const r of parseRefs(m[1]!)) {
          if (r.kind === 'id') define({ id: r.id, doc: doc.key, path: doc.path, line: h.line, text: h.text, deferred: isDeferredText(h.text) })
        }
      }
      // Acceptance criteria: "- **AC-03.7** …"
      doc.lines.forEach((l, i) => {
        for (const m of l.matchAll(/\*\*(AC-\d{2}\.\d+)\*\*/g)) {
          define({ id: m[1]!, doc: doc.key, path: doc.path, line: i, text: l.slice(m.index + m[0].length).trim(), deferred: isDeferredText(l) })
        }
      })
    }

    for (const t of tables(doc)) {
      // specs and tests: tables whose first column is "ID"; other plan docs: any table whose rows start with an ID
      // (decisions "#", risks "#", spikes "Spike", the failure matrix "ID")
      if ((isSpec || isTests) && t.header[0] !== 'ID') continue
      const coversCol = t.header.findIndex((h) => h === 'Covers')
      for (const row of t.rows) {
        const cell0 = row.cells[0] ?? ''
        const rest = row.cells.slice(1).join(' | ')
        if (isSpec) {
          const m = REQ_ID_CELL.exec(cell0)
          if (m) define({ id: m[1]!, doc: doc.key, path: doc.path, line: row.line, text: rest, deferred: isDeferredText(rest) })
          continue
        }
        const id = firstId(cell0)
        if (!id) continue
        const kind = kindOf(id)
        if (isTests && (kind === 'test' || kind === 'budget')) {
          const coversText = coversCol >= 0 ? (row.cells[coversCol] ?? '') : ''
          const covers = parseRefs(coversText)
          planned.push({ id, covers, coversText, path: doc.path, line: row.line, tierA: cell0.includes('●'), tierC: /\bTier C\b/.test(rest) })
          if (kind === 'budget' && doc.key === 'tests 04') {
            budgets.set(id, { id, covers, coversText, path: doc.path, line: row.line })
            define({ id, doc: doc.key, path: doc.path, line: row.line, text: rest, deferred: false })
          }
          continue
        }
        if (kind && kind !== 'test' && kind !== 'requirement' && kind !== 'ac' && kind !== 'budget') {
          define({ id, doc: doc.key, path: doc.path, line: row.line, text: rest, deferred: false })
        }
      }
    }

    if (doc.key === 'roadmap') {
      for (const h of doc.headings) {
        const m = /^M(\d+)\s*·\s*(.*)$/.exec(h.text)
        if (!m || h.level !== 2) continue
        const ms: Milestone = { n: Number(m[1]), title: m[2]!.trim(), line: h.line, delivers: [], namedTests: [] }
        let inTable = false
        let specCol = -1
        for (let i = h.line + 1; i < h.end; i++) {
          const l = doc.lines[i]!
          if (!l.trimStart().startsWith('|')) {
            inTable = false
            if (/^\*\*(Exit|Behaviour)/.test(l)) {
              for (const r of parseRefs(l)) {
                if (r.kind === 'id' && kindOf(r.id) === 'test') ms.namedTests.push(r.id)
                if (r.kind === 'wildcard' && TEST_ID_RE.test(`${r.prefix}1`) && !r.prefix.startsWith('P-')) ms.namedTests.push(`${r.prefix}*`)
              }
            }
            continue
          }
          const c = cells(l)
          if (!inTable) {
            inTable = true
            specCol = c.findIndex((x) => x === 'Spec')
            continue
          }
          if (specCol < 0 || c.every((x) => /^:?-{2,}:?$/.test(x))) continue
          ms.delivers.push(...parseRefs(c[specCol] ?? '').filter((r) => r.kind !== 'unparsed'))
        }
        milestones.push(ms)
      }
    }
  }
  milestones.sort((a, b) => a.n - b.n)
  return { docs, defs, duplicateDefs, planned, budgets, milestones }
}

// ── sections ────────────────────────────────────────────────────────────────────────────────────

export type ResolvedAnchor = { anchor: Anchor; doc: Doc; heading: Heading; start: number; end: number }

/** Find a section (and, for a rule, its numbered item). Rules are looked up in the section's own text first. */
export function resolveAnchor(plan: PlanIndex, a: Anchor): ResolvedAnchor | null {
  const doc = plan.docs.get(a.doc)
  if (!doc) return null
  const heading = doc.headings.find((h) => h.id === a.section)
  if (!heading) return null
  if (a.rule === undefined) return { anchor: a, doc, heading, start: heading.line, end: heading.end }
  const child = doc.headings.find((h) => h.line > heading.line && h.line < heading.end)
  const ownEnd = child ? child.line : heading.end
  const find = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      if (new RegExp(`^${a.rule}\\.\\s`).test(doc.lines[i]!)) {
        let j = i + 1
        while (j < to && !/^\d+\.\s/.test(doc.lines[j]!) && !HEADING_RE.test(doc.lines[j]!)) j++
        return { anchor: a, doc, heading, start: i, end: j }
      }
    }
    return null
  }
  return find(heading.line + 1, ownEnd) ?? find(heading.line + 1, heading.end)
}

/** Resolve a reference's alternatives: the first anchor that exists. */
export function resolveAlternatives(plan: PlanIndex, anchors: Anchor[]): ResolvedAnchor | null {
  for (const a of anchors) {
    const r = resolveAnchor(plan, a)
    if (r) return r
  }
  return null
}

/** IDs defined inside a resolved section (requirement rows, headings, AC bullets, FAIL rows …). */
export function idsDefinedIn(plan: PlanIndex, r: ResolvedAnchor): string[] {
  const out: string[] = []
  for (const d of plan.defs.values()) {
    if (d.doc === r.doc.key && d.line >= r.start && d.line < r.end) out.push(d.id)
  }
  return out
}

/** The anchor itself plus every subsection and numbered rule inside it (as anchor keys). */
export function anchorsWithin(r: ResolvedAnchor): string[] {
  const out = [anchorKey(r.anchor)]
  if (r.anchor.rule !== undefined) return out
  for (const h of r.doc.headings) {
    if (h.line > r.heading.line && h.line < r.heading.end) out.push(anchorKey({ doc: r.doc.key, section: h.id }))
  }
  return out
}

/** Ancestor anchors (the enclosing sections, and for a rule its section) — used to decide "delivered". */
export function ancestorKeys(r: ResolvedAnchor): string[] {
  const out: string[] = []
  if (r.anchor.rule !== undefined) out.push(anchorKey({ doc: r.doc.key, section: r.heading.id }))
  for (const h of r.doc.headings) {
    if (h.line < r.heading.line && h.end > r.heading.line && h.level < r.heading.level) out.push(anchorKey({ doc: r.doc.key, section: h.id }))
  }
  return out
}
