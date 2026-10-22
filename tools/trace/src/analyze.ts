// The trace report: coverage of the plan's requirements and acceptance criteria by written and planned tests, unknown
// references, constants owners, and the roadmap's milestone exit lists.
import { parse as parseToml } from 'smol-toml'
import {
  type PlanIndex,
  type ResolvedAnchor,
  ancestorKeys,
  anchorsWithin,
  idsDefinedIn,
  resolveAlternatives,
} from './plan.ts'
import { type Ref, anchorKey, compareIds, expandWildcard, isMilestoneFree, kindOf, parseRefs, parseTokenAnchor } from './refs.ts'
import type { CoverageRow, OwnerRow } from './coverage.ts'
import type { WrittenTest } from './tags.ts'

export type TestRecord = {
  id: string
  status: 'written' | 'planned'
  coversText: string
  /** Items the test covers after expansion: IDs and section anchor keys (`spec 04 §5`). */
  items: string[]
  /** Requirement / AC / FAIL IDs counted as covered (IDs, plus the IDs defined inside cited sections). */
  coveredIds: string[]
  unknown: string[]
  location: string
  /** Number of test calls carrying this ID (written tests). */
  cases: number
  /** Where the plan still lists a written test (its row should be deleted). */
  planRow?: string
  tierA: boolean
  /** Its plan row says Tier C: deferred until after v1, so in no exit list. */
  tierC: boolean
  /** Written tests: each coverage row, a case with its own items (exit lists find a case bundled with later ones). */
  cases_?: { location: string; items: string[] }[]
}

export type Expansion = { source: string; ids: string[]; citedBy: string[] }

/** `error`: the owner does not exist (fails `--check-owners`); `warning`: a mismatch to review. */
export type OwnerProblem = { file: string; name: string; owner: string; problem: string; severity: 'error' | 'warning' }

export type Trace = {
  tests: TestRecord[]
  untagged: { location: string; name: string }[]
  /** Test IDs with more than one row in the plan's tables. */
  duplicates: { id: string; locations: string[] }[]
  requirements: { id: string; deferred: boolean; written: string[]; planned: string[] }[]
  uncovered: string[]
  plannedOnly: string[]
  deferred: string[]
  unknownRefs: { test: string; location: string; refs: string[] }[]
  owners: OwnerProblem[]
  expansions: Expansion[]
  staleRows: { id: string; location: string; planRow: string }[]
  /** Written tests with no row in the coverage table: what they test counts for nothing. */
  noCovers: { id: string; location: string; name: string }[]
  /** Coverage rows whose test ID no written test carries. */
  orphanRows: { id: string; location: string }[]
  counts: Record<string, number>
}

export type TraceInput = {
  plan: PlanIndex
  written: WrittenTest[]
  /** `.plan/coverage.tsv`: what each written test covers, one row per case. */
  coverage?: CoverageRow[]
  limitsToml?: string
  budgetsToml?: string
  /** `.plan/constants-owners.tsv`: the owner of each limits.toml entry. */
  owners?: Map<string, OwnerRow>
  /** repo-relative path → display path (identity by default) */
  rel?: (p: string) => string
}

const COVERABLE = new Set(['requirement', 'ac', 'fail'])

export class Resolver {
  readonly plan: PlanIndex
  readonly testIds: Set<string>
  private universe: string[]
  private anchorCache = new Map<string, ResolvedAnchor | null>()

  constructor(plan: PlanIndex, testIds: Iterable<string>) {
    this.plan = plan
    this.testIds = new Set(testIds)
    this.universe = [...plan.defs.keys(), ...this.testIds]
  }

  isKnownId(id: string): boolean {
    return this.plan.defs.has(id) || this.testIds.has(id)
  }

  anchor(ref: Extract<Ref, { kind: 'anchor' }>): ResolvedAnchor | null {
    const k = ref.anchors.map(anchorKey).join('|')
    if (!this.anchorCache.has(k)) this.anchorCache.set(k, resolveAlternatives(this.plan, ref.anchors))
    return this.anchorCache.get(k)!
  }

  /** Expand references into items (IDs and anchor keys); `defined` adds the IDs defined inside cited sections. */
  expand(refs: Ref[]): { items: string[]; defined: string[]; unknown: string[]; expansions: { source: string; ids: string[] }[] } {
    const items: string[] = []
    const defined: string[] = []
    const unknown: string[] = []
    const expansions: { source: string; ids: string[] }[] = []
    const rangeSources = new Map<string, string[]>()
    for (const r of refs) {
      if (r.kind === 'unparsed') {
        unknown.push(r.text)
      } else if (r.kind === 'id') {
        if (this.isKnownId(r.id)) items.push(r.id)
        else unknown.push(r.id)
        if (r.source !== r.id && /…|\.\.\.|–|\//.test(r.source)) {
          const list = rangeSources.get(r.source) ?? []
          list.push(r.id)
          rangeSources.set(r.source, list)
        }
      } else if (r.kind === 'wildcard') {
        const ids = expandWildcard(r.prefix, this.universe)
        if (ids.length === 0) unknown.push(r.source)
        items.push(...ids)
        expansions.push({ source: r.source, ids })
      } else {
        const res = this.anchor(r)
        if (!res) {
          unknown.push(r.source)
          continue
        }
        items.push(anchorKey(res.anchor))
        defined.push(...idsDefinedIn(this.plan, res))
      }
    }
    for (const [source, ids] of rangeSources) expansions.push({ source, ids })
    return { items: [...new Set(items)], defined: [...new Set(defined)], unknown, expansions }
  }
}

function loc(rel: (p: string) => string, path: string, line: number): string {
  return `${rel(path)}:${line + 1}`
}

export function analyze(input: TraceInput): Trace {
  const { plan } = input
  const rel = input.rel ?? ((p: string) => p)
  const writtenTagged = input.written.filter((w) => w.id !== null)
  const resolver = new Resolver(plan, [...plan.planned.map((p) => p.id), ...writtenTagged.map((w) => w.id!)])

  const tests: TestRecord[] = []
  const expansionsBySource = new Map<string, Expansion>()
  const noteExpansions = (testId: string, ex: { source: string; ids: string[] }[]) => {
    for (const e of ex) {
      const cur = expansionsBySource.get(e.source) ?? { source: e.source, ids: e.ids, citedBy: [] }
      if (!cur.citedBy.includes(testId)) cur.citedBy.push(testId)
      expansionsBySource.set(e.source, cur)
    }
  }
  const coveredOf = (items: string[], defined: string[]) =>
    [...new Set([...items, ...defined])].filter((i) => COVERABLE.has(kindOf(i) ?? '') && plan.defs.has(i)).sort(compareIds)

  const plannedById = new Map<string, (typeof plan.planned)[number][]>()
  for (const p of plan.planned) plannedById.set(p.id, [...(plannedById.get(p.id) ?? []), p])

  const writtenById = new Map<string, WrittenTest[]>()
  for (const w of writtenTagged) writtenById.set(w.id!, [...(writtenById.get(w.id!) ?? []), w])

  const coverageById = new Map<string, CoverageRow[]>()
  for (const r of input.coverage ?? []) coverageById.set(r.id, [...(coverageById.get(r.id) ?? []), r])

  const duplicates: Trace['duplicates'] = []
  const staleRows: Trace['staleRows'] = []
  for (const [id, ws] of writtenById) {
    // several test calls may share one ID (the cases of one planned test): one record, its coverage rows merged
    const w = ws[0]!
    const tagged = (coverageById.get(id) ?? []).filter((x) => x.covers.length > 0)
    // a written test's covers are its coverage rows; when it has none yet, fall back to its plan row
    const row = plannedById.get(id)?.[0]
    const refs = tagged.length > 0 ? tagged.flatMap((x) => x.covers) : (row?.covers ?? [])
    const coversText =
      tagged.length > 0 ? [...new Set(tagged.flatMap((x) => x.coversText.split(/\s*,\s*/)))].join(', ') : (row?.coversText ?? '')
    const ex = resolver.expand(refs)
    noteExpansions(id, ex.expansions)
    // The covers column names what is covered; another test's ID belongs in the `for` column.
    const testIds = tagged.flatMap((x) => x.covers).flatMap((r) => (r.kind === 'id' && kindOf(r.id) === 'test' ? [`${r.id} (a test ID: put it in the for column)`] : []))
    const rec: TestRecord = {
      id,
      status: 'written',
      coversText,
      items: ex.items,
      coveredIds: coveredOf(ex.items, ex.defined),
      unknown: [...new Set([...ex.unknown, ...testIds])],
      location: loc(rel, w.path, w.line),
      cases: ws.length,
      tierA: row?.tierA ?? false,
      tierC: row?.tierC ?? false,
      cases_: tagged.map((x) => ({ location: loc(rel, x.path, x.line), items: resolver.expand(x.covers).items })),
    }
    if (row) {
      rec.planRow = loc(rel, row.path, row.line)
      // a budget's row in tests 04 defines the budget, so it stays when the test measuring it is written
      if (kindOf(id) !== 'budget') staleRows.push({ id, location: rec.location, planRow: rec.planRow })
    }
    tests.push(rec)
  }
  for (const [id, rows] of plannedById) {
    if (rows.length > 1) duplicates.push({ id, locations: rows.map((r) => loc(rel, r.path, r.line)) })
    if (writtenById.has(id)) continue
    const row = rows[0]!
    const ex = resolver.expand(row.covers)
    noteExpansions(id, ex.expansions)
    tests.push({
      id,
      status: 'planned',
      coversText: row.coversText,
      items: ex.items,
      coveredIds: coveredOf(ex.items, ex.defined),
      unknown: ex.unknown,
      location: loc(rel, row.path, row.line),
      cases: 0,
      tierA: row.tierA,
      tierC: row.tierC,
    })
  }
  tests.sort((a, b) => compareIds(a.id, b.id))

  // coverage
  const requirements: Trace['requirements'] = []
  const byReq = new Map<string, { written: string[]; planned: string[] }>()
  for (const t of tests) {
    for (const id of t.coveredIds) {
      const e = byReq.get(id) ?? { written: [], planned: [] }
      e[t.status].push(t.id)
      byReq.set(id, e)
    }
  }
  const uncovered: string[] = []
  const plannedOnly: string[] = []
  const deferred: string[] = []
  for (const d of [...plan.defs.values()].sort((a, b) => compareIds(a.id, b.id))) {
    if (!COVERABLE.has(kindOf(d.id) ?? '')) continue
    const e = byReq.get(d.id) ?? { written: [], planned: [] }
    requirements.push({ id: d.id, deferred: d.deferred, ...e })
    if (d.deferred) {
      deferred.push(d.id)
      continue
    }
    if (e.written.length === 0 && e.planned.length === 0) uncovered.push(d.id)
    else if (e.written.length === 0) plannedOnly.push(d.id)
  }

  const unknownRefs = tests.filter((t) => t.unknown.length > 0).map((t) => ({ test: t.id, location: t.location, refs: t.unknown }))

  const owners = checkOwners(plan, resolver, input.limitsToml, input.budgetsToml, input.owners)

  const untagged = input.written.filter((w) => w.id === null).map((w) => ({ location: loc(rel, w.path, w.line), name: w.name }))
  const noCovers: Trace['noCovers'] = [...writtenById]
    .filter(([id]) => !coverageById.get(id)?.some((r) => r.coversText !== ''))
    .map(([id, ws]) => ({ id, location: loc(rel, ws[0]!.path, ws[0]!.line), name: ws[0]!.name }))
  const orphanRows: Trace['orphanRows'] = (input.coverage ?? []).filter((r) => !writtenById.has(r.id)).map((r) => ({ id: r.id, location: loc(rel, r.path, r.line) }))

  const kinds = (k: string) => [...plan.defs.values()].filter((d) => kindOf(d.id) === k).length
  const counts: Record<string, number> = {
    requirements: kinds('requirement'),
    acceptance: kinds('ac'),
    failureRows: kinds('fail'),
    budgets: plan.budgets.size,
    decisions: kinds('decision'),
    upstream: kinds('upstream'),
    deferred: deferred.length,
    testsWritten: tests.filter((t) => t.status === 'written').length,
    testsPlanned: tests.filter((t) => t.status === 'planned').length,
    untagged: untagged.length,
    noCovers: noCovers.length,
    orphanRows: orphanRows.length,
    uncovered: uncovered.length,
    plannedOnly: plannedOnly.length,
    coveredByWritten: requirements.filter((r) => !r.deferred && r.written.length > 0).length,
    unknownRefs: unknownRefs.reduce((n, u) => n + u.refs.length, 0),
    ownerProblems: owners.length,
    duplicates: duplicates.length,
  }

  return {
    tests,
    untagged,
    duplicates,
    requirements,
    uncovered,
    plannedOnly,
    deferred,
    unknownRefs,
    owners,
    expansions: [...expansionsBySource.values()].sort((a, b) => compareIds(a.source, b.source)),
    staleRows,
    noCovers,
    orphanRows,
    counts,
  }
}

/** Resolve a constants/ owner: a defined ID (`HLD-7`, `FAIL-3`) or a plan anchor (`arch-2.7`, `spec-04-1`). */
export function ownerExists(plan: PlanIndex, resolver: Resolver, owner: string): boolean {
  const token = parseTokenAnchor(owner)
  if (token) return resolveAlternatives(plan, token) !== null
  const refs = parseRefs(owner)
  if (refs.length === 0) return false
  return refs.every((r) => {
    if (r.kind === 'id') return resolver.isKnownId(r.id)
    if (r.kind === 'anchor') return resolver.anchor(r) !== null
    return false
  })
}

export function checkOwners(
  plan: PlanIndex,
  resolver: Resolver,
  limitsToml?: string,
  budgetsToml?: string,
  owners: Map<string, OwnerRow> = new Map(),
): OwnerProblem[] {
  const out: OwnerProblem[] = []
  if (limitsToml !== undefined) {
    const raw = parseToml(limitsToml) as Record<string, unknown>
    for (const name of Object.keys(raw)) {
      const owner = owners.get(name)?.owner ?? ''
      if (!owner) out.push({ file: 'constants/limits.toml', name, owner, problem: 'no row in .plan/constants-owners.tsv', severity: 'error' })
      else if (!ownerExists(plan, resolver, owner)) out.push({ file: 'constants/limits.toml', name, owner, problem: 'owner not found in the plan', severity: 'error' })
    }
    for (const row of owners.values()) {
      if (!(row.name in raw)) out.push({ file: `${row.path}:${row.line + 1}`, name: row.name, owner: row.owner, problem: 'no such entry in constants/limits.toml', severity: 'error' })
    }
  }
  if (budgetsToml !== undefined) {
    const raw = parseToml(budgetsToml) as Record<string, unknown>
    for (const id of Object.keys(raw)) {
      if (!plan.budgets.has(id)) out.push({ file: 'constants/budgets.toml', name: id, owner: id, problem: 'budget not in the plan', severity: 'error' })
    }
    for (const id of plan.budgets.keys()) {
      if (!(id in raw)) out.push({ file: 'constants/budgets.toml', name: id, owner: id, problem: 'a budget of the plan has no entry', severity: 'warning' })
    }
  }
  return out
}

// ── milestone exit lists ─────────────────────────────────────────────────────────────────────────

export type ExitEntry = { test: TestRecord; due: number }

export type ExitList = {
  milestone: number
  title: string
  dueNow: ExitEntry[]
  carried: ExitEntry[]
  /** Tests named in the milestone's Exit / Behaviour text (explicit exit tests), whatever the tables say. */
  named: { id: string; test: TestRecord | null; due: number | null }[]
  /** Tests that cite an ID placed in no milestone, or one that does not exist (so they appear in no exit list). */
  blocked: { test: TestRecord; unplaced: string[] }[]
  /** Tests covering a v1.1 / after-v1 requirement, and Tier C rows. */
  deferred: TestRecord[]
  /** Tests whose covers are all milestone-free (goals, decisions, upstream) or empty. */
  unbound: TestRecord[]
  /** Requirements, acceptance criteria and failure rows that no milestone delivers. */
  unplacedIds: string[]
  /** Items cited by tests that no milestone delivers. */
  unplacedCited: string[]
}

export class Milestones {
  private at = new Map<string, number>() // ID or anchor key → first milestone delivering it
  private plan: PlanIndex
  private resolver: Resolver
  private memo = new Map<string, number | null>()

  constructor(plan: PlanIndex, resolver: Resolver) {
    this.plan = plan
    this.resolver = resolver
    const set = (k: string, n: number) => {
      const cur = this.at.get(k)
      if (cur === undefined || n < cur) this.at.set(k, n)
    }
    for (const m of plan.milestones) {
      for (const r of m.delivers) {
        if (r.kind === 'id') set(r.id, m.n)
        else if (r.kind === 'wildcard') for (const id of expandWildcard(r.prefix, plan.defs.keys())) set(id, m.n)
        else if (r.kind === 'anchor') {
          const res = resolver.anchor(r)
          if (!res) continue
          for (const k of anchorsWithin(res)) set(k, m.n)
          for (const id of idsDefinedIn(plan, res)) set(id, m.n)
        }
      }
    }
  }

  /** The milestone that delivers an item, or null when none does. Milestone-free IDs → -1. */
  of(item: string): number | null {
    if (this.memo.has(item)) return this.memo.get(item)!
    this.memo.set(item, null) // cycle guard
    const v = this.compute(item)
    this.memo.set(item, v)
    return v
  }

  private compute(item: string): number | null {
    if (item.includes('§')) return this.ofAnchor(item)
    const kind = kindOf(item)
    if (isMilestoneFree(item) || kind === 'test') return -1
    if (kind === 'budget') {
      const b = this.plan.budgets.get(item)
      if (!b) return null
      return this.maxOf(this.resolver.expand(b.covers).items)
    }
    return this.at.get(item) ?? null
  }

  private ofAnchor(key: string): number | null {
    // `doc §section[ rule n]` → resolve via the plan to find its ancestors
    const m = /^(.*) §(\S+)(?: rule (\d+))?$/.exec(key)!
    const anchor = { doc: m[1]!, section: m[2]!, ...(m[3] !== undefined ? { rule: Number(m[3]) } : {}) }
    const res = resolveAlternatives(this.plan, [anchor])
    if (!res) return null
    let best: number | null = null
    for (const k of [key, ...ancestorKeys(res)]) {
      const n = this.at.get(k)
      if (n !== undefined && (best === null || n < best)) best = n
    }
    if (best !== null) return best
    // not named itself: delivered when every ID defined inside it is
    const ids = idsDefinedIn(this.plan, res).filter((i) => !this.plan.defs.get(i)?.deferred)
    return ids.length > 0 ? this.maxOf(ids) : null
  }

  maxOf(items: string[]): number | null {
    let max = -1
    for (const i of items) {
      const n = this.of(i)
      if (n === null) return null
      if (n > max) max = n
    }
    return max
  }

  isDeferredTest(t: TestRecord): boolean {
    return t.tierC || t.items.some((i) => this.plan.defs.get(i)?.deferred)
  }
}

export function exitList(plan: PlanIndex, trace: Trace, milestone: number): ExitList {
  const resolver = new Resolver(plan, trace.tests.map((t) => t.id))
  const ms = new Milestones(plan, resolver)
  const title = plan.milestones.find((m) => m.n === milestone)?.title ?? ''
  const out: ExitList = { milestone, title, dueNow: [], carried: [], named: [], blocked: [], deferred: [], unbound: [], unplacedIds: [], unplacedCited: [] }
  const cited = new Set<string>()
  const dueOf = new Map<string, number | null>()
  for (const t of trace.tests) {
    if (ms.isDeferredTest(t)) {
      out.deferred.push(t)
      dueOf.set(t.id, null)
      continue
    }
    if (t.unknown.length > 0) {
      // a test citing something that does not exist cannot be placed
      out.blocked.push({ test: t, unplaced: t.unknown })
      dueOf.set(t.id, null)
      continue
    }
    const bound = t.items.filter((i) => ms.of(i) !== -1)
    if (bound.length === 0) {
      out.unbound.push(t)
      dueOf.set(t.id, null)
      continue
    }
    const unplaced = bound.filter((i) => ms.of(i) === null)
    if (unplaced.length > 0) {
      out.blocked.push({ test: t, unplaced })
      for (const u of unplaced) cited.add(u)
      dueOf.set(t.id, null)
      continue
    }
    // A case is due when the last ID it covers is delivered; a written test with several cases is due at its earliest
    // case (the later cases run anyway once written), a planned row, which is one case, at its last ID.
    const caseDue = (items: string[]) => {
      const b = items.filter((i) => ms.of(i) !== -1)
      return b.length === 0 ? null : ms.maxOf(b)
    }
    const caseDues = (t.cases_ ?? []).map((c) => caseDue(c.items)).filter((d): d is number => d !== null)
    const due = caseDues.length > 0 ? Math.min(...caseDues) : ms.maxOf(bound)!
    dueOf.set(t.id, due)
    if (due === milestone) out.dueNow.push({ test: t, due })
    else if (due < milestone) out.carried.push({ test: t, due })
  }
  const byId = new Map(trace.tests.map((t) => [t.id, t]))
  const m = plan.milestones.find((x) => x.n === milestone)
  for (const named of m?.namedTests ?? []) {
    const ids = named.endsWith('*') ? expandWildcard(named.slice(0, -1), byId.keys()) : [named]
    if (ids.length === 0) out.named.push({ id: named, test: null, due: null })
    for (const id of ids) out.named.push({ id, test: byId.get(id) ?? null, due: dueOf.get(id) ?? null })
  }
  for (const d of plan.defs.values()) {
    if (!COVERABLE.has(kindOf(d.id) ?? '') || d.deferred) continue
    if (ms.of(d.id) === null) out.unplacedIds.push(d.id)
  }
  out.unplacedIds.sort(compareIds)
  out.unplacedCited = [...cited].sort(compareIds)
  out.carried.sort((a, b) => a.due - b.due || compareIds(a.test.id, b.test.id))
  return out
}
