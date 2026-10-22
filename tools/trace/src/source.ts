// `pnpm test:trace --check-source`: the repository's own files say nothing that needs the private specification to
// read. It lists every requirement, acceptance, failure-row, decision, upstream or spike ID the plan defines, every
// section citation of a plan document, every milestone, every mention of the resource inventory, and every
// `// covers:` line (coverage lives in .plan/coverage.tsv). Test IDs are fine: they name tests that are in the
// repository.
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { walk } from './load.ts'
import type { PlanIndex } from './plan.ts'
import { kindOf } from './refs.ts'

export type SourceHit = { path: string; line: number; kind: 'id' | 'cite' | 'milestone' | 'inventory' | 'covers'; text: string }

const TEXT = /\.(?:[cm]?[jt]sx?|svelte|rs|toml|json|ya?ml|sh|md|css|html|sql|[ch])$|(?:^|\/)(?:pre-push|Cargo\.toml)$/
/**
 * What is not Kea's own prose: recorded data, upstream patches, lock files, this tool (whose tests are about IDs), and
 * the files .gitignore keeps out (the perf tool's last run, the coding-agent notes).
 */
const SKIP = [
  /^fixtures\//,
  /^patches\//,
  /^tools\/trace\//,
  /(?:^|\/)(?:pnpm-lock\.yaml|Cargo\.lock)$/,
  /^tools\/perf\/last\.json$/,
  /^CLAUDE\.md$/,
  /^\.claude\//,
]
const FLAGGED = new Set(['requirement', 'ac', 'fail', 'decision', 'upstream', 'spike'])
/**
 * IDs that stay, by file: a plan row that code reading the private specification looks up by its ID, and words of the
 * first schema, which every database made since holds (changing them takes a migration).
 */
const KEPT = new Map<string, string[]>([
  ['tests/memory/app-pins.test.ts', ['MEM-16']],
  ['app/core/src/platform/db/schema.ts', ['SES-3']],
])

const ID_RE = /(?<![A-Za-z0-9-])(?:[A-Z][A-Z0-9]{0,5}-)+\d+(?:\.\d+)?[a-z]?(?![A-Za-z0-9])|(?<![A-Za-z0-9])D\d{1,3}(?![A-Za-z0-9])/g
/**
 * A plan document by its name, with or without a section (`spec 04 §2`, `tests 00`, `architecture §6`, `design §6.1`),
 * or a section by its token anchor (`spec-04-2`, `arch-2.7`, `design-4`, `data-model-1`).
 */
const CITE_RE =
  /\b(?:spec \d{2}|tests 0\d|suite 0\d)\b|\b(?:architecture|arch|design|data model|roadmap|research|decisions|upstream)\s+§|(?<!RFC \d+\s?)§\s?\d|\b(?:spec-\d{2}-\d+|arch-\d+(?:\.\d+)?|design-\d+(?:\.\d+)?|data-model-\d+)[a-z]?\b/gi
/** `M1` … `M12`, but not SVG path data (`M6 1.75`, `M2.5`), where a number follows. */
const MILESTONE_RE = /(?<![\w-])M(?:1[0-2]|[1-9])(?![\w-])(?!\.?\s*\d)/g
const INVENTORY_RE = /\binventory\b/gi
const COVERS_RE = /^\s*(?:\/\/[/!]?|#)\s*covers\s*:/i

/** The references in one file's text, by 0-based line. */
export function scanText(path: string, text: string, plan: PlanIndex, keptByPath: ReadonlyMap<string, string[]> = KEPT): SourceHit[] {
  const hits: SourceHit[] = []
  const kept = keptByPath.get(path) ?? []
  const flagged = (id: string) => FLAGGED.has(kindOf(id) ?? '') && (plan.defs.has(id) || kindOf(id) === 'spike') && !kept.includes(id)
  text.split('\n').forEach((s, line) => {
    if (COVERS_RE.test(s)) hits.push({ path, line, kind: 'covers', text: s.trim() })
    for (const m of s.matchAll(ID_RE)) if (flagged(m[0])) hits.push({ path, line, kind: 'id', text: m[0] })
    for (const m of s.matchAll(CITE_RE)) hits.push({ path, line, kind: 'cite', text: m[0] })
    for (const m of s.matchAll(MILESTONE_RE)) hits.push({ path, line, kind: 'milestone', text: m[0] })
    for (const m of s.matchAll(INVENTORY_RE)) hits.push({ path, line, kind: 'inventory', text: m[0] })
  })
  return hits
}

export function scanSource(root: string, plan: PlanIndex): SourceHit[] {
  return walk(root, (p) => TEXT.test(p))
    .map((abs) => relative(root, abs))
    .filter((path) => !SKIP.some((re) => re.test(path)))
    .sort()
    .flatMap((path) => scanText(path, readFileSync(join(root, path), 'utf8'), plan))
}
