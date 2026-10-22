// Walking fixtures/: raw recordings live in `.raw/` folders (gitignored); their scrubbed copies sit at the same
// relative path without the `.raw` segment.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { type Finding, findAbsolutePaths, isEnvFile, type Identity, scanForPrivateData, scrubBuffer } from './scrub.ts'

const IGNORED = new Set(['.DS_Store'])

function walk(dir: string, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && !IGNORED.has(e.name)) out.push(p)
  }
  return out.sort()
}

const isRaw = (p: string) => p.split(sep).includes('.raw')

/** Every raw recording under `dir`, with its scrubbed destination (the path without its `.raw` segments). */
export function rawFixtures(dir: string): { src: string; dest: string }[] {
  return walk(dir)
    .filter(isRaw)
    .map((src) => ({ src, dest: src.split(sep).filter((s) => s !== '.raw').join(sep) }))
}

/** Every committed-side fixture under `dir` (not inside a `.raw` folder). */
export function fixtureFiles(dir: string): string[] {
  return walk(dir).filter((p) => !isRaw(p))
}

/** Every file under `dir` (used by `fixture:from-report` on a report bundle). */
export function allFiles(dir: string): string[] {
  return walk(dir)
}

export type TreeReport = {
  files: { src: string; dest: string; counts: Record<string, number> }[]
  /** private data still present after scrubbing (should be empty) */
  residual: { file: string; finding: Finding }[]
  /** absolute paths outside the demo repo, for review */
  paths: { file: string; path: string; line: number }[]
}

export function scrubTree(pairs: { src: string; dest: string }[], identity: Identity, opts: { demoRoots?: string[]; dryRun?: boolean } = {}): TreeReport {
  const report: TreeReport = { files: [], residual: [], paths: [] }
  for (const { src, dest } of pairs) {
    const input = readFileSync(src)
    const ctx = { identity, envFile: isEnvFile(src) }
    const { output, counts } = scrubBuffer(input, ctx)
    if (!opts.dryRun) {
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, output)
    }
    report.files.push({ src, dest, counts })
    for (const finding of scanForPrivateData(output, ctx)) report.residual.push({ file: dest, finding })
    for (const p of findAbsolutePaths(output, opts.demoRoots ?? [])) report.paths.push({ file: dest, ...p })
  }
  return report
}
