// `pnpm fixtures:scrub`: scrub every `fixtures/**/.raw/**` file into the same relative path without the `.raw` segment,
// length-preserving. Reports what was replaced, absolute paths outside the demo repo (review them) and any private data
// left over (exit 1).
//
//   --demo-root <path>   a demo repo root whose paths are expected (repeatable)
//   --only <dir>         only raw files under fixtures/<dir> (repeatable), e.g. `--only cassettes`
//   --dry-run            scrub in memory only, write nothing
//   --check              scan the committed-side fixtures only (the privacy gate); exit 1 on any finding
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureFiles, rawFixtures, scrubTree } from './files.ts'
import { currentIdentity, isEnvFile, scanForPrivateData } from './scrub.ts'

function repoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const up = dirname(dir)
    if (up === dir) throw new Error('kea repo root not found')
    dir = up
  }
}

const args = process.argv.slice(2)
const demoRoots: string[] = []
const only: string[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--demo-root' && args[i + 1]) demoRoots.push(args[++i]!)
  else if (args[i] === '--only' && args[i + 1]) only.push(args[++i]!.replace(/\/+$/, ''))
  else if (!['--dry-run', '--check'].includes(args[i]!)) {
    console.error('usage: pnpm fixtures:scrub [--demo-root <path>]… [--only <dir>]… [--dry-run] [--check]')
    process.exit(2)
  }
}
const root = repoRoot()
const fixtures = join(root, 'fixtures')
const rel = (p: string) => relative(root, p)
const identity = currentIdentity(root)

if (args.includes('--check')) {
  let n = 0
  for (const f of fixtureFiles(fixtures)) {
    for (const x of scanForPrivateData(readFileSync(f), { identity, envFile: isEnvFile(f) })) {
      console.log(`${rel(f)}:${x.line} ${x.kind} ${x.label}`)
      n++
    }
  }
  console.error(`fixtures:scrub --check: ${n} finding${n === 1 ? '' : 's'}`)
  process.exit(n > 0 ? 1 : 0)
}

const pairs = rawFixtures(fixtures).filter((p) => only.length === 0 || only.some((d) => relative(join(fixtures, d), p.src).split('/')[0] !== '..'))
const report = scrubTree(pairs, identity, { demoRoots, dryRun: args.includes('--dry-run') })
for (const f of report.files) {
  const what = Object.entries(f.counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ')
  console.log(`${rel(f.src)} → ${rel(f.dest)}${what ? `  (${what})` : ''}`)
}
if (report.paths.length) {
  console.log(`\nAbsolute paths outside the demo repo — review before committing (${report.paths.length}):`)
  for (const p of report.paths) console.log(`  ${rel(p.file)}:${p.line}  ${p.path}`)
}
if (report.residual.length) {
  console.log(`\nPrivate data left after scrubbing (${report.residual.length}):`)
  for (const r of report.residual) console.log(`  ${rel(r.file)}:${r.finding.line}  ${r.finding.label}`)
}
console.error(`fixtures:scrub: ${report.files.length} raw file${report.files.length === 1 ? '' : 's'} scrubbed${args.includes('--dry-run') ? ' (dry run)' : ''}`)
process.exit(report.residual.length > 0 ? 1 : 0)
