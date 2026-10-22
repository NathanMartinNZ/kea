# tools/trace

`pnpm test:trace` reports which tests cover which requirements of Kea's design specification. It is a maintainer
tool: it reads the specification from `.plan/`, which is private and not in this repository. Without it, every mode
prints `test:trace: nothing to trace: .plan/ (the private specification) is not in this checkout` and exits 0
(with `KEA_REQUIRE_PLAN=1` it exits 1 instead). With the plan it is a report, not a gate: it exits 0 unless `--strict`
is given.

| Command | Output |
|---|---|
| `pnpm test:trace` | Requirements, acceptance criteria and failure rows with no test ("uncovered") or with planned tests only ("planned only"); coverage rows citing IDs or sections that do not exist; constants whose owner does not exist; written tests with no coverage row, and coverage rows whose test is not in the code; the wildcards and ranges expanded; a summary |
| `pnpm test:trace --list` | Every test, written and planned: ID, status (`×n`: test calls sharing the ID; `●`: a Tier A leak cycle), covers, location |
| `pnpm test:trace --milestone M3` | A milestone's exit list: the tests with a case whose covered IDs the roadmap delivers by that milestone, split into due now and carried from earlier milestones; the tests the milestone's Exit or Behaviour text names; the IDs no milestone delivers |
| `--check-owners` | Constants owners only; exit 1 if a constant has no owner row, or its owner does not exist. `pnpm verify` runs it, and skips it where `.plan/` is absent |
| `--check-source` | The repository's own files only; exit 1 on any reference to the private specification (below). It runs on its own: the other modes and `--strict` do not apply to it, `--json` does. `pnpm verify` runs it, and skips it where `.plan/` is absent |
| `--json`, `--strict` | Machine-readable output; exit 1 on uncovered IDs, unknown references, missing owners, duplicate plan rows, tests without coverage rows or coverage rows without a test |

## What it reads

- `.plan/specs`: requirement tables (a first column `ID`), headings that define requirements (`### 3.1 Detect — AGT-12`)
  and acceptance criteria (`**AC-03.7**`).
- `.plan/plan`: the ID tables (failure matrix, decisions, upstream issues, goals, risks, spikes) and the roadmap's
  milestone tables.
- `.plan/tests`: the planned tests (the `ID` and `Covers` columns) and the performance budgets.
- `.plan/coverage.tsv`: what each written test covers, and `.plan/constants-owners.tsv`: the requirement that owns each
  constant (below).
- `constants/limits.toml` and `constants/budgets.toml`.
- Test IDs in code: `*.test.ts(x)` and `*.spec.ts(x)` under `app/`, `packages/`, `tools/` and `tests/`, and Rust tests
  under `native/`.

## Test IDs and coverage

A test's name begins with its ID (see [CONTRIBUTING.md](../../CONTRIBUTING.md#tests)). In Rust the ID comes from a
function named after it or a `// test:` line above it:

```ts
it('U-PTY-1 · coalescer flushes at once after quiet', () => {})
it.each(CASES)('U-PTY-2 · %s', () => {}) // modifiers (.each, .skipIf(…), .runIf(…), .concurrent, …) are seen through
```

```rust
#[test]
fn r_hld_1_ring_wraps() {} // the name gives the ID: R-HLD-1

// test: R-HLD-2
#[test]
fn frames_never_panic() {}
```

What a test covers is not in the code: `.plan/coverage.tsv` holds it, one row per case, `test-id<TAB>covers<TAB>for`
(`for`: other tests this one is part of). Several rows may share an ID (the cases of one planned test). Their covers
are merged, and the test is due at the earliest milestone that delivers one of its cases; a planned row, which is one
case, is due when its last covered ID is delivered. Another test's ID does not belong in the covers column (it is
reported as an unknown reference): it goes in `for`. `.plan/constants-owners.tsv` holds `name<TAB>owner`, one row per
`constants/limits.toml` entry. In both files, lines starting with `#` and blank lines are skipped, and a malformed
line is an error naming its line.

## Source check

`--check-source` reads every text file of the repository except `fixtures/`, `patches/`, lock files, this tool (whose
tests are about IDs) and what `.gitignore` keeps out, and lists, by line: an ID the plan defines that is not a test ID
(a requirement, acceptance criterion, failure row, decision, upstream issue or spike), a section citation of a plan
document (`spec 04 §5`, `tests 00`, `design §6.9`), a milestone (`M3`), a mention of the plan's resource inventory, and
a `// covers:` line. A section's token anchor (`spec-04-2`, `arch-2.7`) counts as a citation. Test IDs are fine: they
name tests that are in the repository. `source.ts` keeps a short list of IDs that stay in one file each, with the
reason: a plan row that a test reading the plan looks up by its ID, and the first schema's words, which every
database holds.

## References

The plan's Covers cells, coverage rows, roadmap Spec cells and constants owners all use one grammar:

- IDs: `HLD-7`, `AC-03.7`, `FAIL-3`, `P-MEM-2b`, `D15`, `G1`, `UP-3`;
- ranges `HLD-1…15`, `HLD-1...15`, `ST-14…ST-16`, `AC-02.1…7`; slash lists `I-AGT-1/2`; wildcards `ST-*`;
- prose sections: `spec 04 §5`, `design §6.9`, `tests 00 §2b`, `architecture §2 rule 6` (also `rules 5–6`,
  `principle 9`), `spec 02 §2 step 1`, `data model invariant 3`;
- token anchors: `arch-2.7` (§2.7 if it exists, else §2 rule 7), `spec-04-1`, `data-model-1`, `arch-10c`.

A section reference covers, or delivers, the section, its subsections and the IDs defined inside it (requirement rows,
headings, acceptance criteria), not IDs merely mentioned there. A budget is delivered when everything it covers is.
The milestone filter ignores goals, decisions, upstream issues, risks, assumptions and spikes. A requirement is
deferred, and left out of "uncovered" and of the exit lists, when its row or heading marks the whole of it v1.1 or
after v1 (a last sentence "v1.1.", "(v1.1)", "built after v1"), not when only a part is ("(v1.1 CLI)"). A test whose
plan row is marked Tier C is in no exit list either.

## Code

`refs.ts` (the ID grammar and its expansion) · `plan.ts` (markdown, sections, definitions, milestones) · `tags.ts`
(test IDs in TypeScript and Rust) · `coverage.ts` (the coverage and owners tables) · `analyze.ts` (coverage, owners,
exit lists) · `source.ts` (the source check) · `load.ts` (reading the inputs) · `presence.ts` (whether `.plan/` is
here) · `main.ts` (the CLI). Tests: `trace.test.ts`. Depends on `smol-toml`.
