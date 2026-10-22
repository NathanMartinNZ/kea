// The two private tables the trace report reads beside the plan: what each test covers, and the requirement that
// owns each constant.
//
// `.plan/coverage.tsv`, one row per case: `test-id <TAB> covers <TAB> for`. Several rows may share a test ID (the
// cases of one test, each with its own covers); `for` names other tests this one is part of.
// `.plan/constants-owners.tsv`: `name <TAB> owner`, one row per constants/limits.toml entry.
// Lines starting with `#` and blank lines are ignored. A malformed line throws, naming its file and line.
import type { SourceFile } from './plan.ts'
import { type Ref, parseRefs, TEST_ID_RE } from './refs.ts'

export type CoverageRow = { id: string; coversText: string; covers: Ref[]; for: string; path: string; line: number }

export type OwnerRow = { name: string; owner: string; path: string; line: number }

function rows(file: SourceFile): { cells: string[]; line: number }[] {
  const out: { cells: string[]; line: number }[] = []
  file.text.split('\n').forEach((text, line) => {
    if (text.trim() === '' || text.startsWith('#')) return
    out.push({ cells: text.split('\t').map((c) => c.trim()), line })
  })
  return out
}

export function parseCoverage(file: SourceFile): CoverageRow[] {
  return rows(file).map(({ cells, line }) => {
    const [id = '', coversText = '', forText = '', ...rest] = cells
    if (!TEST_ID_RE.test(id) || rest.length > 0) throw new Error(`${file.path}:${line + 1}: expected test-id<TAB>covers<TAB>for`)
    return { id, coversText, covers: parseRefs(coversText), for: forText, path: file.path, line }
  })
}

export function parseOwners(file: SourceFile): Map<string, OwnerRow> {
  const out = new Map<string, OwnerRow>()
  for (const { cells, line } of rows(file)) {
    const [name = '', owner = '', ...rest] = cells
    if (!/^[a-z][a-z0-9_]*$/.test(name) || owner === '' || rest.length > 0) throw new Error(`${file.path}:${line + 1}: expected name<TAB>owner`)
    if (out.has(name)) throw new Error(`${file.path}:${line + 1}: ${name} already has an owner at line ${out.get(name)!.line + 1}`)
    out.set(name, { name, owner, path: file.path, line })
  }
  return out
}
