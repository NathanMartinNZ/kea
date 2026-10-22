// `pnpm test:trace`, the traceability report: which tests cover the requirements of the private specification in
// .plan/, as its coverage table records them (coverage.ts). A report, not a gate: exit 0 unless --strict.
//
//   pnpm test:trace                  uncovered requirements / AC, unknown references, constants owners, summary
//   pnpm test:trace --list           every test, written and planned: ID, status, covers, location
//   pnpm test:trace --milestone M3   the exit list of M3: the tests whose covered IDs the roadmap delivers by M3
//   pnpm test:trace --check-owners   only constants/ owners; exit 1 if one does not exist (a step of pnpm verify)
//   pnpm test:trace --check-source   only the repository's files; exit 1 on a plan ID, citation, milestone, inventory
//                                    mention or covers line in them (source.ts; a step of pnpm verify). It runs on
//                                    its own: the other modes and --strict do not apply to it, --json does
//   --json                           machine-readable output of the chosen mode
//   --strict                         exit 1 on uncovered requirements / AC, unknown references, missing owners, duplicates,
//                                    tests without coverage rows, coverage rows without a test
//
// Without .plan/ (a public clone) there is nothing to trace: every mode says so and exits 0, or exits 1 when
// KEA_REQUIRE_PLAN=1 (presence.ts).
import { join } from 'node:path'
import { type ExitList, type Trace, type TestRecord, analyze, exitList } from './analyze.ts'
import { indexPlan } from './plan.ts'
import { compress, kindOf } from './refs.ts'
import { extractTests } from './tags.ts'
import { parseCoverage, parseOwners } from './coverage.ts'
import { planFiles, planTable, readIfExists, repoRoot, testFiles } from './load.ts'
import { hasPlan, NO_PLAN, planRequired } from './presence.ts'
import { scanSource } from './source.ts'

const FIXED_AREAS = ['KILL', 'UPD', 'RES', 'COR', 'FUZZ', 'SOAK', 'RACE', 'CL', 'CM', 'ED', 'FX', 'LV-CL', 'LV-CM', 'START', 'TERM', 'FT', 'GS', 'FIND', 'DF', 'FV', 'WT', 'UI', 'MEM', 'GPU', 'CPU', 'FD', 'ENERGY']

function usage(): never {
  console.error('usage: pnpm test:trace [--list | --milestone M<n> | --check-owners | --check-source] [--json] [--strict]')
  process.exit(2)
}

const args = process.argv.slice(2)
const json = args.includes('--json')
const strict = args.includes('--strict')
const list = args.includes('--list')
const checkOwners = args.includes('--check-owners')
const checkSource = args.includes('--check-source')
const mi = args.indexOf('--milestone')
let milestone: number | null = null
if (mi >= 0) {
  const m = /^M?(\d+)$/i.exec(args[mi + 1] ?? '')
  if (!m) usage()
  milestone = Number(m[1])
}
for (const a of args) if (a.startsWith('--') && !['--json', '--strict', '--list', '--check-owners', '--check-source', '--milestone'].includes(a)) usage()

const root = repoRoot()
if (!hasPlan(root)) {
  if (planRequired()) {
    console.error(`test:trace: KEA_REQUIRE_PLAN=1, but ${NO_PLAN}`)
    process.exit(1)
  }
  console.log(`test:trace: nothing to trace: ${NO_PLAN}`)
  process.exit(0)
}
const plan = indexPlan(planFiles(root))

if (checkSource) {
  const hits = scanSource(root, plan)
  if (json) console.log(JSON.stringify(hits, null, 2))
  else {
    for (const h of hits) console.log(`${h.path}:${h.line + 1}: ${h.kind} ${h.text}`)
    console.log(`source: ${hits.length} references to the private specification`)
  }
  process.exit(hits.length > 0 ? 1 : 0)
}

const areas = new Set<string>(FIXED_AREAS)
for (const id of plan.defs.keys()) if (kindOf(id) === 'requirement') areas.add(id.replace(/-\d+$/, ''))
for (const p of plan.planned) areas.add(p.id.replace(/^[A-Z]+-/, '').replace(/-\d+[a-z]?$/, ''))
const isKnownArea = (id: string) => /^(?:DS|V|A)-/.test(id) || areas.has(id.replace(/^[A-Z]+-/, '').replace(/-\d+[a-z]?$/, ''))

const written = testFiles(root).flatMap((f) => extractTests(f, isKnownArea))
const coverageFile = planTable(root, 'coverage.tsv')
const ownersFile = planTable(root, 'constants-owners.tsv')
const trace = analyze({
  plan,
  written,
  coverage: coverageFile ? parseCoverage(coverageFile) : [],
  limitsToml: readIfExists(join(root, 'constants/limits.toml')),
  budgetsToml: readIfExists(join(root, 'constants/budgets.toml')),
  owners: ownersFile ? parseOwners(ownersFile) : new Map(),
})

// ── formatting ──────────────────────────────────────────────────────────────────────────────────

function wrap(text: string, indent: string, width = 110): string {
  const words = text.split(' ')
  const lines: string[] = []
  let cur = indent
  for (const w of words) {
    if (cur.length + w.length + 1 > width && cur.trim().length > 0) {
      lines.push(cur)
      cur = indent
    }
    cur += (cur.trim().length > 0 ? ' ' : '') + w
  }
  if (cur.trim().length > 0) lines.push(cur)
  return lines.join('\n')
}

function byKind(ids: string[]): { label: string; ids: string[] }[] {
  const groups = [
    { label: 'requirements', ids: ids.filter((i) => kindOf(i) === 'requirement') },
    { label: 'acceptance  ', ids: ids.filter((i) => kindOf(i) === 'ac') },
    { label: 'failure rows', ids: ids.filter((i) => kindOf(i) === 'fail') },
  ]
  return groups.filter((g) => g.ids.length > 0)
}

function section(title: string, n: number): string {
  return `\n${title} (${n})`
}

function printReport(t: Trace): void {
  const c = t.counts
  const out: string[] = []
  out.push('Kea trace report (a report, not a gate)')
  out.push('')
  out.push(`Plan    ${c.requirements} requirements (${c.deferred} deferred: v1.1 / after v1), ${c.acceptance} acceptance criteria, ${c.failureRows} failure rows, ${c.budgets} budgets`)
  out.push(`Tests   ${c.testsWritten} written (tagged in code), ${c.testsPlanned} planned (rows in .plan/tests), ${c.untagged} untagged test calls in code`)

  out.push(section('Uncovered — no written or planned test', t.uncovered.length))
  for (const g of byKind(t.uncovered)) out.push(wrap(`${g.label}  ${compress(g.ids)}`, '  '))

  out.push(section('Planned only — covered by planned rows, no written test yet', t.plannedOnly.length))
  for (const g of byKind(t.plannedOnly)) out.push(wrap(`${g.label}  ${compress(g.ids)}`, '  '))

  const covered = t.requirements.filter((r) => !r.deferred && r.written.length > 0).map((r) => r.id)
  out.push(section('Covered by written tests', covered.length))
  if (covered.length) out.push(wrap(compress(covered), '  '))

  out.push(section('Tests citing IDs or sections that do not exist', t.unknownRefs.length))
  for (const u of t.unknownRefs) out.push(`  ${u.test.padEnd(12)} ${u.location}  →  ${u.refs.join('; ')}`)

  const errors = t.owners.filter((o) => o.severity === 'error')
  const warnings = t.owners.filter((o) => o.severity === 'warning')
  out.push(section('Constants whose owner does not exist', errors.length))
  for (const o of errors) out.push(`  ${o.file} [${o.name}] owner "${o.owner}": ${o.problem}`)
  if (warnings.length) {
    out.push(section('Constants to review', warnings.length))
    for (const o of warnings) out.push(`  ${o.file} [${o.name}] ${o.problem}`)
  }

  if (t.duplicates.length) {
    out.push(section('Test IDs with more than one row in the plan', t.duplicates.length))
    for (const d of t.duplicates) out.push(`  ${d.id}: ${d.locations.join(', ')}`)
  }
  if (t.staleRows.length) {
    out.push(section('Written tests whose plan row still exists (the change that writes a test deletes its row)', t.staleRows.length))
    for (const s of t.staleRows) out.push(`  ${s.id.padEnd(12)} ${s.location}   row: ${s.planRow}`)
  }
  if (t.noCovers.length) {
    out.push(section('Written tests with no row in .plan/coverage.tsv (what they test is not counted)', t.noCovers.length))
    for (const n of t.noCovers) out.push(`  ${n.id.padEnd(12)} ${n.location}`)
  }
  if (t.orphanRows.length) {
    out.push(section('Rows in .plan/coverage.tsv for a test that is not in the code', t.orphanRows.length))
    for (const o of t.orphanRows) out.push(`  ${o.id.padEnd(12)} ${o.location}`)
  }
  if (t.untagged.length) {
    out.push(section('Untagged test calls (name does not start with a test ID)', t.untagged.length))
    for (const u of t.untagged.slice(0, 20)) out.push(`  ${u.location}  ${JSON.stringify(u.name)}`)
    if (t.untagged.length > 20) out.push(`  … ${t.untagged.length - 20} more`)
  }

  out.push(section('Wildcards and ranges expanded', t.expansions.length))
  for (const e of t.expansions) {
    const cited = e.citedBy.length > 4 ? `${e.citedBy.slice(0, 4).join(', ')} +${e.citedBy.length - 4}` : e.citedBy.join(', ')
    out.push(`  ${e.source.padEnd(22)} → ${e.ids.length ? compress(e.ids) : '(nothing)'}   [${cited}]`)
  }

  out.push(section('Deferred — v1.1 / after v1, excluded from "uncovered"', t.deferred.length))
  if (t.deferred.length) out.push(wrap(compress(t.deferred), '  '))

  out.push('')
  out.push(
    `Summary: ${c.coveredByWritten} covered by written tests · ${c.plannedOnly} planned only · ${c.uncovered} uncovered · ` +
      `${c.unknownRefs} unknown references · ${errors.length} missing constant owners · ${c.duplicates} duplicate plan rows · ` +
      `${c.noCovers} tests without coverage rows · ${c.orphanRows} coverage rows without a test`,
  )
  console.log(out.join('\n'))
}

function row(t: TestRecord): string {
  const status = `${t.status}${t.cases > 1 ? ` ×${t.cases}` : ''}${t.tierA ? ' ●' : ''}`
  return `${t.id.padEnd(12)} ${status.padEnd(10)} ${(t.coversText || '—').slice(0, 70).padEnd(70)} ${t.location}`
}

function printList(t: Trace): void {
  console.log(`${'ID'.padEnd(12)} ${'status'.padEnd(10)} ${'covers'.padEnd(70)} location`)
  for (const test of t.tests) console.log(row(test))
  console.log(`\n${t.counts.testsWritten} written, ${t.counts.testsPlanned} planned (×n = test calls sharing the ID; ● = Tier A leak cycle)`)
}

function printExit(e: ExitList): void {
  const out: string[] = []
  out.push(`Exit list for M${e.milestone} · ${e.title}`)
  out.push('(roadmap "Exit lists": every test with a case whose covered IDs are all delivered by M0…M' + e.milestone + '; goals, decisions and upstream IDs ignored)')
  const written = [...e.dueNow, ...e.carried].filter((x) => x.test.status === 'written').length
  out.push(section(`Due at M${e.milestone}`, e.dueNow.length))
  for (const x of e.dueNow) out.push(`  ${row(x.test)}`)
  out.push(section(`Carried from earlier milestones`, e.carried.length))
  for (const x of e.carried) out.push(`  M${x.due}  ${row(x.test)}`)
  if (e.named.length) {
    out.push(section('Named in the roadmap as exit tests', e.named.length))
    for (const n of e.named) {
      const where = n.test ? `${n.test.status}, due ${n.due === null ? '—' : `M${n.due}`}` : 'no such test'
      out.push(`  ${n.id.padEnd(12)} ${where}`)
    }
  }
  out.push(section('Tests citing IDs no milestone delivers (in no exit list)', e.blocked.length))
  for (const b of e.blocked) out.push(`  ${b.test.id.padEnd(12)} ${b.test.location}  unplaced: ${b.unplaced.join(', ')}`)
  out.push(section('Requirements, AC and failure rows no milestone delivers (unplaced)', e.unplacedIds.length))
  if (e.unplacedIds.length) out.push(wrap(compress(e.unplacedIds), '  '))
  out.push(section('Tests without milestone-bound covers (no covers, or only goals / decisions / upstream)', e.unbound.length))
  if (e.unbound.length) out.push(wrap(e.unbound.map((t) => t.id).join(', '), '  '))
  out.push(section('Deferred tests (of v1.1 / after-v1 requirements, or Tier C rows)', e.deferred.length))
  if (e.deferred.length) out.push(wrap(e.deferred.map((t) => t.id).join(', '), '  '))
  out.push('')
  out.push(`Summary: ${e.dueNow.length + e.carried.length} tests in the M${e.milestone} exit list (${e.dueNow.length} due now), ${written} written`)
  console.log(out.join('\n'))
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────

if (checkOwners) {
  const errors = trace.owners.filter((o) => o.severity === 'error')
  if (json) console.log(JSON.stringify(trace.owners, null, 2))
  else {
    for (const o of trace.owners) console.log(`${o.severity}: ${o.file} [${o.name}] owner "${o.owner}": ${o.problem}`)
    console.log(`constants owners: ${errors.length} missing, ${trace.owners.length - errors.length} to review`)
  }
  process.exit(errors.length > 0 ? 1 : 0)
}

if (milestone !== null) {
  if (!plan.milestones.some((m) => m.n === milestone)) {
    console.error(`no milestone M${milestone} in .plan/plan/06-roadmap.md`)
    process.exit(2)
  }
  const e = exitList(plan, trace, milestone)
  if (json) console.log(JSON.stringify(e, null, 2))
  else printExit(e)
} else if (list) {
  if (json) console.log(JSON.stringify(trace.tests, null, 2))
  else printList(trace)
} else if (json) {
  console.log(JSON.stringify(trace, null, 2))
} else {
  printReport(trace)
}

if (strict) {
  const bad =
    trace.uncovered.length +
    trace.unknownRefs.length +
    trace.owners.filter((o) => o.severity === 'error').length +
    trace.duplicates.length +
    trace.noCovers.length +
    trace.orphanRows.length
  process.exit(bad > 0 ? 1 : 0)
}
