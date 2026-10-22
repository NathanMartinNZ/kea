import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyze, checkOwners, exitList, Resolver } from './analyze.ts'
import { parseCoverage, parseOwners } from './coverage.ts'
import { anchorsWithin, headingId, idsDefinedIn, indexPlan, isDeferredText, resolveAlternatives, resolveAnchor } from './plan.ts'
import { compress, expandWildcard, kindOf, parseRefs, parseTokenAnchor, type Ref } from './refs.ts'
import { extractRustTests, extractTests, extractTsTests, idFromRustName } from './tags.ts'
import { planFiles, repoRoot, testFiles } from './load.ts'
import { NO_PLAN, skipsWithoutPlan } from './presence.ts'
import { scanText } from './source.ts'
import { namePattern, TIER_A } from '../../verify-tier-a.ts'
import { type Result, summaryLine } from '../../verify.ts'

// Fixture sources spell test calls with placeholders so this file's own scan by the trace tool does not mistake
// them for real tests: IT_( → it(, TEST_( → test(.
const code = (s: string) => s.replaceAll('IT_', 'it').replaceAll('TEST_', 'test')

const ids = (refs: Ref[]) => refs.flatMap((r) => (r.kind === 'id' ? [r.id] : []))

// U-TRACE-10 and U-TRACE-11 read the real plan, which a public clone does not have
const noPlan = skipsWithoutPlan(repoRoot())

/** A coverage table from rows written `ID covers` or `ID covers | for`: the first space and ` | ` become tabs. */
const coverage = (...rows: string[]) =>
  parseCoverage({ path: '.plan/coverage.tsv', text: rows.map((r) => r.replace(' ', '\t').replace(' | ', '\t')).join('\n') })

const SPEC_03 = `# Spec 03 · Terminal

## 1. The holder

| ID | Requirement |
|---|---|
| HLD-1 | **Spawn.** Opens a PTY. |
| HLD-2 | **Detach.** Survives Kea. |

## 2. Ptyhost

### 2.1 Mirrors — PTY-1

Mirrors answer queries.

| ID | Requirement |
|---|---|
| PTY-2 | Coalescer. |
| PTY-3 | Multiple starts for comparing attempts. v1.1. |
| PTY-4 | Add a project, or \`kea <path>\` from a shell (v1.1 CLI). |

## 3. Acceptance

- **AC-03.1** Kill everything; the agent survives.
- **AC-03.2** Relaunch shows the screen.
`

const ARCH = `# 03 · Architecture

## 2. Processes

Design rules:

1. **\`main\` is thin.** Nothing blocks.
2. **\`core\` is the single writer.** Of the database.

## 6. Failure and lifecycle matrix

| ID | Event | Result |
|---|---|---|
| FAIL-1 | Window closed | Keeps running |

## 10. Repository layout

### 10c. One home for every number

Numbers live in constants/.
`

const DECISIONS = `# 08 · Decisions

| # | Decision |
|---|---|
| D1 | Electron shell |
`

const PRODUCT = `# 01 · Product

## Goals

| # | Goal | Measured by |
|---|---|---|
| G1 | **Fast.** | Budgets |
`

const PERF = `# Tests 04 · Performance

| ID | Metric | Budget | Covers |
|---|---|---|---|
| P-TERM-1 | Keydown → glyph | ≤ 8 ms | HLD-1, G1 |
`

const UNIT = `# Tests 01 · Unit

| ID | Case | Covers |
|---|---|---|
| U-HLD-1 | Spawn argv | HLD-1 |
| U-PTY-1 | Mirror queries | PTY-1, D1 |
| U-PTY-3 | (v1.1) compare attempts | PTY-3 |
| U-ARCH-1 | Main stays thin | architecture §2 rule 1 |
| U-BAD-1 | Cites a missing ID | HLD-99, spec 99 §1 |
| U-ACC-1 | Acceptance only | AC-03.2 |
| U-LIM-1 | Codegen | arch-10c |
| V-1 | Gallery |  |
`

const INTEGRATION = `# Tests 02 · Integration

| ID | Scenario | Pass condition | Covers |
|---|---|---|---|
| I-PTY-2 | Flood | P-TERM-1 met | P-TERM-1, PTY-2 |
| L-PTY-1 ● | Park cycle | counts | PTY-1…2 |
| I-PTY-3 | *(Tier C)* Coverage-guided fuzz | no panic | PTY-2 |
`

const ROADMAP = `# 06 · Roadmap

## Exit lists

Rules.

## M0 · Skeleton

| Deliverable | Spec |
|---|---|
| Holder | spec 03 §1 |
| Constants | architecture §10 |

**Exit (explicit):** U-HLD-1 and K-LV-CL-* green.

## M1 · Terminal

| Deliverable | Spec |
|---|---|
| Ptyhost | spec 03 §2, FAIL-1, architecture §2 |
| Acceptance | AC-03.1 |
`

const PLAN_FILES = [
  { path: '.plan/specs/03-terminal.md', text: SPEC_03 },
  { path: '.plan/plan/03-architecture.md', text: ARCH },
  { path: '.plan/plan/08-decisions.md', text: DECISIONS },
  { path: '.plan/plan/01-product.md', text: PRODUCT },
  { path: '.plan/plan/06-roadmap.md', text: ROADMAP },
  { path: '.plan/tests/04-performance.md', text: PERF },
  { path: '.plan/tests/01-unit.md', text: UNIT },
  { path: '.plan/tests/02-integration.md', text: INTEGRATION },
]

describe('references', () => {
  it('U-TRACE-1 · IDs, ranges, slash lists and wildcards expand', () => {
    expect(ids(parseRefs('HLD-1…3'))).toEqual(['HLD-1', 'HLD-2', 'HLD-3'])
    expect(ids(parseRefs('HLD-1...3'))).toEqual(['HLD-1', 'HLD-2', 'HLD-3'])
    expect(ids(parseRefs('ST-14…ST-16'))).toEqual(['ST-14', 'ST-15', 'ST-16'])
    expect(ids(parseRefs('AC-02.1…3, AC-03.6…AC-03.7'))).toEqual(['AC-02.1', 'AC-02.2', 'AC-02.3', 'AC-03.6', 'AC-03.7'])
    expect(ids(parseRefs('I-AGT-1/2, C-KILL-1/2/11'))).toEqual(['I-AGT-1', 'I-AGT-2', 'C-KILL-1', 'C-KILL-2', 'C-KILL-11'])
    expect(ids(parseRefs('P-START-3/4, P-MEM-2b'))).toEqual(['P-START-3', 'P-START-4', 'P-MEM-2b'])
    expect(ids(parseRefs('FAIL-5, D15, AC-03.1, G1, UP-3, K-LV-CL-3'))).toEqual(['FAIL-5', 'D15', 'AC-03.1', 'G1', 'UP-3', 'K-LV-CL-3'])
    expect(parseRefs('ST-*, SRV-*')).toEqual([
      { kind: 'wildcard', prefix: 'ST-', source: 'ST-*' },
      { kind: 'wildcard', prefix: 'SRV-', source: 'SRV-*' },
    ])
    expect(expandWildcard('ST-', ['ST-2', 'ST-10', 'ST-1', 'STX-1', 'U-ST-1'])).toEqual(['ST-1', 'ST-2', 'ST-10'])
    expect(parseRefs('—')).toEqual([])
    expect(parseRefs('HLD-7 and some prose').at(-1)).toMatchObject({ kind: 'unparsed' })
    expect(parseRefs('HLD-7 (the holder half), P-TERM-4 (`flood --bytes 100M`)').map((r) => r.kind)).toEqual(['id', 'id'])
    expect(parseRefs('HLD-7 (see notes) and prose').at(-1)).toMatchObject({ kind: 'unparsed' })
    expect(kindOf('DS-2')).toBe('test')
    expect(kindOf('P-MEM-2b')).toBe('budget')
    expect(kindOf('SB-3')).toBe('requirement')
    expect(kindOf('S-7')).toBe('spike')
    expect(compress(['HLD-3', 'HLD-1', 'HLD-2', 'HLD-5', 'AC-02.1', 'AC-02.2'])).toBe('AC-02.1…2, HLD-1…3, HLD-5')
  })

  it('U-TRACE-2 · section references in prose and token form', () => {
    const anchors = (t: string) => parseRefs(t).flatMap((r) => (r.kind === 'anchor' ? [r.anchors] : []))
    expect(anchors('spec 04 §5')).toEqual([[{ doc: 'spec 04', section: '5' }]])
    expect(anchors('design §6.9, tests 00 §2b, data model §1a')).toEqual([
      [{ doc: 'design', section: '6.9' }],
      [{ doc: 'tests 00', section: '2b' }],
      [{ doc: 'data model', section: '1a' }],
    ])
    expect(anchors('architecture §2 rule 6')).toEqual([[{ doc: 'architecture', section: '2', rule: 6 }]])
    expect(anchors('architecture §2 rules 5–6')).toEqual([
      [{ doc: 'architecture', section: '2', rule: 5 }],
      [{ doc: 'architecture', section: '2', rule: 6 }],
    ])
    expect(anchors('spec 02 §2 step 1')).toEqual([[{ doc: 'spec 02', section: '2' }]])
    expect(anchors('data model invariant 3')).toEqual([[{ doc: 'data model', section: 'invariants', rule: 3 }]])
    expect(parseTokenAnchor('arch-2.7')).toEqual([
      { doc: 'architecture', section: '2.7' },
      { doc: 'architecture', section: '2', rule: 7 },
    ])
    expect(parseTokenAnchor('spec-04-1')).toEqual([{ doc: 'spec 04', section: '1' }])
    expect(parseTokenAnchor('data-model-1')).toEqual([{ doc: 'data model', section: '1' }])
    expect(parseTokenAnchor('arch-10c')).toEqual([{ doc: 'architecture', section: '10c' }])
    expect(parseTokenAnchor('HLD-7')).toBeNull()
    expect(anchors('arch-2.7, spec-13-3')).toHaveLength(2)
  })
})

describe('plan', () => {
  const plan = indexPlan(PLAN_FILES)

  it('U-TRACE-3 · headings, definitions and deferral are read from the plan', () => {
    expect(headingId('2. Create — WT-19')).toBe('2')
    expect(headingId('6.8b Menu-bar item')).toBe('6.8b')
    expect(headingId('A. Holder (`kea-helper pty`)')).toBe('A')
    expect(headingId('10b. `CLAUDE.md` — instructions')).toBe('10b')
    expect(headingId('3.10 First-party status sources — AGT-20')).toBe('3.10')
    expect(headingId('Invariants (checked by tests)')).toBe('invariants')
    expect([...plan.defs.keys()].sort()).toEqual(
      ['AC-03.1', 'AC-03.2', 'D1', 'G1', 'FAIL-1', 'HLD-1', 'HLD-2', 'P-TERM-1', 'PTY-1', 'PTY-2', 'PTY-3', 'PTY-4'].sort(),
    )
    expect(plan.defs.get('PTY-1')!.text).toContain('Mirrors')
    expect(plan.defs.get('PTY-3')!.deferred).toBe(true)
    expect(plan.defs.get('PTY-4')!.deferred).toBe(false)
    expect(isDeferredText('Custom command adapter (v1.1) — AGT-27')).toBe(true)
    expect(isDeferredText('5. Codex adapter (designed now, built after v1) — AGT-26')).toBe(true)
    expect(isDeferredText('v1 ships the file format; a rebinding UI is v1.1.')).toBe(false)
    expect(isDeferredText('a lint rule enforcing it is deferred until after v1 (tests 00 §1, Tier C).')).toBe(false)
    expect(plan.planned.map((p) => p.id)).toContain('L-PTY-1')
    expect(plan.planned.find((p) => p.id === 'L-PTY-1')!.tierA).toBe(true)
    expect(plan.budgets.get('P-TERM-1')!.coversText).toBe('HLD-1, G1')
    expect(plan.milestones.map((m) => [m.n, m.title])).toEqual([
      [0, 'Skeleton'],
      [1, 'Terminal'],
    ])
    expect(plan.milestones[0]!.namedTests).toEqual(['U-HLD-1', 'K-LV-CL-*'])
  })

  it('U-TRACE-4 · sections resolve with their subsections, rules and defined IDs', () => {
    const s2 = resolveAnchor(plan, { doc: 'spec 03', section: '2' })!
    expect(idsDefinedIn(plan, s2).sort()).toEqual(['PTY-1', 'PTY-2', 'PTY-3', 'PTY-4'])
    expect(anchorsWithin(s2)).toEqual(['spec 03 §2', 'spec 03 §2.1'])
    expect(resolveAnchor(plan, { doc: 'architecture', section: '2', rule: 2 })).not.toBeNull()
    expect(resolveAnchor(plan, { doc: 'architecture', section: '2', rule: 9 })).toBeNull()
    expect(resolveAnchor(plan, { doc: 'spec 03', section: '9' })).toBeNull()
    expect(resolveAlternatives(plan, parseTokenAnchor('arch-2.1')!)!.anchor).toEqual({ doc: 'architecture', section: '2', rule: 1 })
    expect(resolveAlternatives(plan, parseTokenAnchor('arch-10c')!)).not.toBeNull()
  })
})

describe('test tags in code', () => {
  it('U-TRACE-5 · TypeScript: the name begins with the test ID', () => {
    const src = code(`import { it, test } from 'vitest'

IT_('U-PTY-1 · coalescer flushes', () => {})

TEST_('U-PTY-2 · options form', { timeout: 1 }, () => {})

IT_.skipIf(!signed)('I-HLD-24 · admission', async () => {})

// a comment
IT_('no id here', () => {})
const x = { fit: 1 }; x.it?.('U-NOT-1 · member call is ignored')
`)
    const tests = extractTsTests({ path: 'a.test.ts', text: src })
    expect(tests.map((t) => [t.id, t.line])).toEqual([
      ['U-PTY-1', 2],
      ['U-PTY-2', 4],
      ['I-HLD-24', 6],
      [null, 9],
    ])
  })

  it('U-TRACE-6 · Rust: test-ID-prefixed fn names and `// test:` lines', () => {
    const src = `#[cfg(test)]
mod tests {
    #[test]
    fn r_hld_1_ring_wraps() {}

    // test: R-HLD-2
    #[test]
    fn frames_never_panic() {}

    fn helper_1_not_a_test() {}

    proptest! {
        #[test]
        fn r_hld_3_flow(x in 0u8..) {}
    }

    #[test]
    fn plain_test() {}
}
`
    const tests = extractRustTests({ path: 'native/kea-helper/src/ring.rs', text: src })
    expect(tests.map((t) => t.id)).toEqual(['R-HLD-1', 'R-HLD-2', 'R-HLD-3', null])
    expect(idFromRustName('k_lv_cl_3_help_lists_flags')).toBe('K-LV-CL-3')
    expect(idFromRustName('ds_1_contrast')).toBe('DS-1')
    expect(idFromRustName('ring_wraps_2_times')).toBeNull()
  })
})

describe('test calls the extractor must see', () => {
  it('U-TRACE-18 · modifiers with arguments of their own: nested calls in skipIf / runIf, and each tables', () => {
    const src = code(`IT_.runIf(isAvailable(os.trash))('U-FT-21 · nested call', () => {})
IT_.each([
  ['a', 1],
  ['b', (2)],
])('U-HLD-4 · table case %s', (c) => {})
TEST_.skipIf(!ok(x, [1, ')']))('I-PLT-5 · a paren inside a string', async () => {})
IT_.concurrent.each(cases)('U-PTY-8 · chained', () => {})
`)
    expect(extractTsTests({ path: 'a.test.ts', text: src }).map((t) => [t.id, t.line])).toEqual([
      ['U-FT-21', 0],
      ['U-HLD-4', 1],
      ['I-PLT-5', 5],
      ['U-PTY-8', 6],
    ])
  })
})

describe('this file', () => {
  it('U-TRACE-21 · its fixtures declare no test the extractor sees: every test call in it is a U-TRACE test', () => {
    const self = { path: 'tools/trace/src/trace.test.ts', text: readFileSync(join(repoRoot(), 'tools/trace/src/trace.test.ts'), 'utf8') }
    expect(extractTsTests(self).filter((t) => !t.id?.startsWith('U-TRACE-')).map((t) => `${t.id} @${t.line}`)).toEqual([])
  })
})

describe('report', () => {
  const plan = indexPlan(PLAN_FILES)
  const written = extractTsTests({
    path: 'packages/x/src/a.test.ts',
    text: code(`IT_('U-PTY-9 · first case', () => {})
IT_('U-PTY-9 · second case', () => {})
IT_('U-PTY-10 · cites a test', () => {})
`),
  })
  const trace = analyze({ plan, written, coverage: coverage('U-PTY-9 PTY-2', 'U-PTY-9 AC-03.1', 'U-PTY-10 PTY-2, U-PTY-9') })

  it('U-TRACE-7 · uncovered, planned-only, written, unknown references and deferred', () => {
    const t9 = trace.tests.find((t) => t.id === 'U-PTY-9')!
    expect(t9).toMatchObject({ status: 'written', cases: 2, coveredIds: ['AC-03.1', 'PTY-2'] })
    expect(trace.uncovered).toEqual(['FAIL-1', 'HLD-2', 'PTY-4'])
    expect(trace.plannedOnly).toEqual(['AC-03.2', 'HLD-1', 'PTY-1'])
    expect(trace.deferred).toEqual(['PTY-3'])
    expect(trace.unknownRefs).toEqual([
      { test: 'U-BAD-1', location: '.plan/tests/01-unit.md:9', refs: ['HLD-99', 'spec 99 §1'] },
      { test: 'U-PTY-10', location: 'packages/x/src/a.test.ts:3', refs: ['U-PTY-9 (a test ID: put it in the for column)'] },
    ])
    expect(trace.expansions.map((e) => [e.source, e.ids])).toEqual([['PTY-1…2', ['PTY-1', 'PTY-2']]])
  })

  it('U-TRACE-12 · a written test keeps its plan row stale until deleted, except a budget row, which defines the budget', () => {
    const w = extractTsTests({
      path: 'tests/perf/x.test.ts',
      text: code(`IT_('P-TERM-1 · keydown to glyph', () => {})
IT_('U-HLD-1 · spawn argv', () => {})
`),
    })
    const t = analyze({ plan, written: w, coverage: coverage('P-TERM-1 HLD-1', 'U-HLD-1 HLD-1') })
    expect(t.staleRows.map((s) => s.id)).toEqual(['U-HLD-1'])
    expect(t.tests.find((x) => x.id === 'P-TERM-1')).toMatchObject({ status: 'written' })
  })

  it('U-TRACE-8 · exit lists follow the roadmap tables (sections, budgets, ignored and unplaced IDs)', () => {
    const m0 = exitList(plan, trace, 0)
    expect(m0.dueNow.map((e) => e.test.id).sort()).toEqual(['P-TERM-1', 'U-HLD-1', 'U-LIM-1'])
    expect(m0.named.map((n) => [n.id, n.due])).toEqual([
      ['U-HLD-1', 0],
      ['K-LV-CL-*', null],
    ])
    const m1 = exitList(plan, trace, 1)
    // U-PTY-9 (written) covers PTY-2 (M1 via spec 03 §2) and AC-03.1 (M1); I-PTY-2's budget P-TERM-1 lands at M0
    expect(m1.dueNow.map((e) => e.test.id).sort()).toEqual(['I-PTY-2', 'L-PTY-1', 'U-ARCH-1', 'U-PTY-1', 'U-PTY-9'])
    expect(m1.carried.map((e) => [e.test.id, e.due])).toEqual([
      ['P-TERM-1', 0],
      ['U-HLD-1', 0],
      ['U-LIM-1', 0],
    ])
    expect(m1.blocked.map((b) => [b.test.id, b.unplaced])).toEqual([
      ['U-ACC-1', ['AC-03.2']],
      ['U-BAD-1', ['HLD-99', 'spec 99 §1']],
      ['U-PTY-10', ['U-PTY-9 (a test ID: put it in the for column)']],
    ])
    expect(m1.unplacedIds).toEqual(['AC-03.2'])
    // U-PTY-3 covers a v1.1 requirement; I-PTY-3's row is Tier C, not built in v1
    expect(m1.deferred.map((t) => t.id).sort()).toEqual(['I-PTY-3', 'U-PTY-3'])
    expect(m1.unbound.map((t) => t.id)).toEqual(['V-1'])
  })

  it('U-TRACE-17 · a written test with no coverage row is listed, and so is a row whose test is not in the code', () => {
    const w = extractTsTests({
      path: 'packages/x/src/b.test.ts',
      text: code(`IT_('U-PTY-11 · covered', () => {})
const x = 1
IT_('U-PTY-12 · no row', () => {})
IT_('U-PTY-13 · a row with only a for', () => {})
`),
    })
    const t = analyze({ plan, written: w, coverage: coverage('U-PTY-11 PTY-2 | C-COR-6', 'U-PTY-13  | C-COR-6', 'U-PTY-14 PTY-2') })
    expect(t.noCovers).toEqual([
      { id: 'U-PTY-12', location: 'packages/x/src/b.test.ts:3', name: 'U-PTY-12 · no row' },
      { id: 'U-PTY-13', location: 'packages/x/src/b.test.ts:4', name: 'U-PTY-13 · a row with only a for' },
    ])
    expect(t.orphanRows).toEqual([{ id: 'U-PTY-14', location: '.plan/coverage.tsv:3' }])
    expect([t.counts.noCovers, t.counts.orphanRows]).toEqual([2, 1])
  })

  it('U-TRACE-14 · a written test is due at the earliest milestone that delivers one of its cases; a single case waits for its last covered ID', () => {
    const roadmap = `${ROADMAP}\n## M2 · Later\n\n| Deliverable | Spec |\n|---|---|\n| More | AC-03.2 |\n`
    const later = indexPlan(PLAN_FILES.map((f) => (f.path.endsWith('06-roadmap.md') ? { ...f, text: roadmap } : f)))
    const w = extractTsTests({
      path: 'packages/x/src/c.test.ts',
      text: code(`IT_('U-PTY-20 · a case M1 delivers', () => {})
IT_('U-PTY-20 · a case M2 delivers', () => {})
IT_('U-PTY-21 · one case, covering what M1 and M2 deliver', () => {})
`),
    })
    // one coverage row per case
    const t = analyze({ plan: later, written: w, coverage: coverage('U-PTY-20 PTY-2', 'U-PTY-20 PTY-2, AC-03.2', 'U-PTY-21 PTY-2, AC-03.2') })
    const m1 = exitList(later, t, 1)
    // U-PTY-20's first case is delivered by M1, so the test is due there; U-PTY-21's one case needs M2 as well
    expect(m1.dueNow.map((e) => e.test.id)).toContain('U-PTY-20')
    expect(m1.dueNow.map((e) => e.test.id)).not.toContain('U-PTY-21')
    const m2 = exitList(later, t, 2)
    expect(m2.carried.map((e) => [e.test.id, e.due])).toContainEqual(['U-PTY-20', 1])
    expect(m2.dueNow.map((e) => e.test.id)).toContain('U-PTY-21')
  })

  it('U-TRACE-9 · every limit has an owner the plan defines, every owner row a limit; every budget is in the plan', () => {
    const resolver = new Resolver(plan, [])
    const limits = ['a', 'b', 'c', 'd', 'e'].map((n) => `[${n}]\nvalue = 1\nunit = "ms"\nwhy = "x"\n`).join('\n')
    const owners = parseOwners({ path: '.plan/constants-owners.tsv', text: 'a\tHLD-1\nb\tarch-2.2\nc\tHLD-42\nd\tarch-2.9\nz\tHLD-1\n' })
    const budgets = `["P-TERM-1"]\nmetric = "m"\nmax = 1\nunit = "ms"\n\n["P-NOPE-1"]\nmetric = "m"\nmax = 1\nunit = "ms"\n`
    expect(checkOwners(plan, resolver, limits, budgets, owners).map((p) => [p.file, p.name, p.severity, p.problem])).toEqual([
      ['constants/limits.toml', 'c', 'error', 'owner not found in the plan'],
      ['constants/limits.toml', 'd', 'error', 'owner not found in the plan'],
      ['constants/limits.toml', 'e', 'error', 'no row in .plan/constants-owners.tsv'],
      ['.plan/constants-owners.tsv:5', 'z', 'error', 'no such entry in constants/limits.toml'],
      ['constants/budgets.toml', 'P-NOPE-1', 'error', 'budget not in the plan'],
    ])
  })

  it('U-TRACE-19 · the coverage and owners tables skip comments and blank lines; a malformed row or a second owner throws with its line', () => {
    const rows = parseCoverage({ path: '.plan/coverage.tsv', text: '# header\n\nU-PTY-1\tPTY-2, spec 04 §5\tC-COR-6\nV-1\n' })
    expect(rows.map((r) => [r.id, r.coversText, r.for, r.line])).toEqual([
      ['U-PTY-1', 'PTY-2, spec 04 §5', 'C-COR-6', 2],
      ['V-1', '', '', 3],
    ])
    expect(ids(rows[0]!.covers)).toEqual(['PTY-2'])
    expect(() => parseCoverage({ path: '.plan/coverage.tsv', text: 'PTY-2\tHLD-1\n' })).toThrow('.plan/coverage.tsv:1: expected test-id<TAB>covers<TAB>for')
    expect(() => parseCoverage({ path: 'c', text: 'U-PTY-1\ta\tb\tc\n' })).toThrow('c:1:')
    expect(() => parseOwners({ path: 'o', text: 'a_ms\tHLD-1\na_ms\tHLD-2\n' })).toThrow('o:2: a_ms already has an owner at line 1')
    expect(() => parseOwners({ path: 'o', text: 'a_ms\n' })).toThrow('o:1: expected name<TAB>owner')
  })

  it('U-TRACE-20 · --check-source flags plan IDs, plan citations, milestones, inventory rows and covers lines, and nothing else', () => {
    const plan = indexPlan(PLAN_FILES)
    const hits = (text: string) => scanText('a.ts', text, plan).map((h) => [h.line, h.kind, h.text])
    expect(hits('// the mirror replays it (PTY-2; spec 03 §1), see AC-03.1\n// covers: PTY-2')).toEqual([
      [0, 'id', 'PTY-2'],
      [0, 'id', 'AC-03.1'],
      [0, 'cite', 'spec 03'],
      [0, 'cite', '§1'],
      [1, 'covers', '// covers: PTY-2'],
      [1, 'id', 'PTY-2'],
    ])
    expect(hits(code("// added in M2, made two-system in M8/M9\nIT_('U-PTY-9 · M4’s journey')"))).toEqual([
      [0, 'milestone', 'M2'],
      [0, 'milestone', 'M8'],
      [0, 'milestone', 'M9'],
      [1, 'milestone', 'M4'],
    ])
    expect(hits('// bounded: L.x (inventory: agent signal state)\n// pruned with it (inventory row "File tabs")')).toEqual([
      [0, 'inventory', 'inventory'],
      [1, 'inventory', 'inventory'],
    ])
    // the plan's token anchors are citations too
    expect(hits("serves: 'spec-04-2', 'arch-2.7', 'design-4', 'data-model-1'")).toEqual([
      [0, 'cite', 'spec-04-2'],
      [0, 'cite', 'arch-2.7'],
      [0, 'cite', 'design-4'],
      [0, 'cite', 'data-model-1'],
    ])
    // a plan row that code reading the plan looks up is not a reference there, and is one anywhere else
    expect(scanText('b.test.ts', "l.startsWith('| PTY-2 |')", plan, new Map([['b.test.ts', ['PTY-2']]]))).toEqual([])
    expect(hits("l.startsWith('| PTY-2 |')")).toEqual([[0, 'id', 'PTY-2']])
    // test IDs, IDs the plan does not define, RFC sections and SVG path data are not references
    expect(hits(code("IT_('U-PTY-9 · x') // PTY-99, RFC 8259 §7\nconst d = 'M6 1.75 A4.25 4.25 0 1 1 1.75 6 M10 8 M2.5 3.5h11'"))).toEqual([])
  })

  it('U-TRACE-10 · the real plan parses: IDs, sections, budgets and milestones are found', ({ skip }) => {
    skip(noPlan, NO_PLAN)
    const real = indexPlan(planFiles(repoRoot()))
    for (const id of ['HLD-1', 'AGT-12', 'ST-14', 'AC-03.7', 'FAIL-23', 'P-TERM-1', 'D37', 'UP-1']) expect(real.defs.has(id), id).toBe(true)
    expect(real.milestones.map((m) => m.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    for (const token of ['arch-2.7', 'arch-3', 'data-model-1', 'spec-04-1', 'spec-13-3']) {
      expect(resolveAlternatives(real, parseTokenAnchor(token)!), token).not.toBeNull()
    }
    expect(real.defs.get('CMP-11')!.deferred).toBe(true)
    expect(real.defs.get('PRJ-1')!.deferred).toBe(false)
  })

  it('U-TRACE-11 · the Tier A data of pnpm verify matches the plan: its strategy table and its ● leak-cycle rows', ({ skip }) => {
    skip(noPlan, NO_PLAN)
    const real = indexPlan(planFiles(repoRoot()))
    // a ● row leaves suite 08 once its test is written; from then on the written test stands for it
    const marked = real.planned.filter((p) => p.tierA).map((p) => p.id)
    const written = new Set(testFiles(repoRoot()).flatMap((f) => extractTests(f).map((t) => t.id)))
    for (const id of marked) expect(TIER_A.memory, id).toContain(id)
    for (const id of TIER_A.memory) expect(marked.includes(id) || written.has(id), `${id}: a ● row or a written test`).toBe(true)
    const strategy = planFiles(repoRoot()).find((f) => f.path.endsWith('00-strategy.md'))!.text
    const row = strategy.split('\n').find((l) => l.startsWith('| **A — gate**'))!
    for (const e of [...TIER_A.integration, ...TIER_A.contract, ...TIER_A.chaos]) expect(row, e).toContain(e)
    const re = new RegExp(namePattern(['I-HLD-*', 'I-PTY-1…6', 'I-PTY-13', 'I-AGT-1/2']))
    for (const yes of ['I-HLD-24 · admission', 'holder I-PTY-6 · rebuild', 'I-PTY-13 · x', 'I-AGT-2 · y']) expect(re.test(yes), yes).toBe(true)
    for (const no of ['I-PTY-7 · x', 'I-PTY-13b', 'U-I-HLD-1 · x', 'I-AGT-3 · y']) expect(re.test(no), no).toBe(false)
  })
})

describe('a checkout without .plan/', () => {
  it('U-TRACE-15 · pnpm test:trace, --check-owners and --check-source say there is nothing to trace and exit 0; with KEA_REQUIRE_PLAN=1 they exit 1', () => {
    // this tool's sources under a repository root of their own, which has no .plan/
    const clone = mkdtempSync(join(tmpdir(), 'kea-trace-'))
    try {
      writeFileSync(join(clone, 'pnpm-workspace.yaml'), '')
      const tool = join(repoRoot(), 'tools/trace')
      mkdirSync(join(clone, 'tools/trace/src'), { recursive: true })
      for (const f of readdirSync(join(tool, 'src'))) if (f.endsWith('.ts') && !f.endsWith('.test.ts')) copyFileSync(join(tool, 'src', f), join(clone, 'tools/trace/src', f))
      symlinkSync(join(tool, 'node_modules'), join(clone, 'tools/trace/node_modules'))
      const env = { ...process.env }
      delete env.KEA_REQUIRE_PLAN
      const trace = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
        spawnSync(process.execPath, [join(clone, 'tools/trace/src/main.ts'), ...args], { cwd: clone, encoding: 'utf8', env: { ...env, ...extra } })
      for (const args of [[], ['--check-owners'], ['--check-source'], ['--list']]) {
        const free = trace(args)
        expect([free.status, free.stdout.trim()], args.join(' ')).toEqual([0, `test:trace: nothing to trace: ${NO_PLAN}`])
        const required = trace(args, { KEA_REQUIRE_PLAN: '1' })
        expect([required.status, required.stderr.trim()], args.join(' ')).toEqual([1, `test:trace: KEA_REQUIRE_PLAN=1, but ${NO_PLAN}`])
      }
    } finally {
      rmSync(clone, { recursive: true, force: true })
    }
  })

  it('U-TRACE-16 · pnpm verify skips what reads the plan when .plan/ is absent, unless KEA_REQUIRE_PLAN=1, and its last line names every skipped step', () => {
    const clone = mkdtempSync(join(tmpdir(), 'kea-verify-'))
    try {
      expect(skipsWithoutPlan(clone, {})).toBe(true)
      expect(skipsWithoutPlan(clone, { KEA_REQUIRE_PLAN: '1' })).toBe(false)
      mkdirSync(join(clone, '.plan'))
      expect(skipsWithoutPlan(clone, {})).toBe(false)
    } finally {
      rmSync(clone, { recursive: true, force: true })
    }
    const step = (name: string, status: Result['status'], note = ''): Result => ({ name, status, ms: 1, note })
    // steps their run() skips (constants owners, rust), one left out with --skip, one this system cannot run
    const results = [
      step('lint', 'pass'),
      step('constants owners', 'skip', NO_PLAN),
      step('rust', 'skip', 'native/kea-helper has no Cargo.toml yet'),
      step('memory (Tier A)', 'skip', 'left out with --skip'),
      step('chaos (Tier A)', 'skip', 'not on linux yet: no X server'),
    ]
    expect(summaryLine(results, 61_000)).toBe('verify: Tier A green in 1m01s; 4 steps skipped: constants owners, rust, memory (Tier A), chaos (Tier A)')
    expect(summaryLine([step('lint', 'FAIL', 'exit 1'), step('constants owners', 'skip', NO_PLAN)], 2_000)).toBe('verify: 1 step failed (lint) in 2.0s; 1 step skipped: constants owners')
    expect(summaryLine([step('lint', 'pass')], 2_000)).toBe('verify: Tier A green in 2.0s')
  })
})
