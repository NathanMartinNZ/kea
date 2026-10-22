// `pnpm fixture:from-report <bundle dir> [--out <fixtures dir>]`: turn a status-report bundle (what Report Wrong Status
// saves in `<KEA_HOME>/reports/<time>-<sessionId>/`) into a replay fixture, `fixtures/status/<id>/`:
//
//   fixture.json     the golden: the person's expected state and note, what Kea showed, and where a replay starts
//                    (the status before the recent-signal ring's oldest input, how the agent was started)
//   signals.ndjson   the recent-signal ring as the input sequence, in arrival order (the projected envelopes the ring
//                    kept beside each input are left out: the normalised events are what the engine replays)
//
// Both are scrubbed (length-preserving placeholders for the home path, user and host names, git identity; secrets
// replaced) and scanned again: private data left over fails the command. Everything else in the bundle (transcript,
// screen, PTY ring, resources) stays in the bundle, which is never committed. The replay tests (U-ST-7, core's
// status/replay.ts) run every fixture; a new one fails until the bug it captures is fixed, and lands with that fix.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { currentIdentity, findAbsolutePaths, scanForPrivateData, scrubBuffer, type Finding, type Identity } from './scrub.ts'

function repoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const up = dirname(dir)
    if (up === dir) throw new Error('kea repo root not found')
    dir = up
  }
}

export class ReportError extends Error {}

export interface FixtureResult {
  id: string
  outDir: string
  files: string[]
  signals: number
  /** Private data still present after scrubbing (should be empty: the command fails otherwise). */
  residual: { file: string; finding: Finding }[]
  /** Absolute paths left in the fixture, for review. */
  paths: { file: string; path: string; line: number }[]
}

type Report = {
  format?: unknown
  sessionId?: unknown
  agent?: unknown
  expected?: unknown
  note?: unknown
  lifecycle?: unknown
  phase?: unknown
  start?: unknown
}

/** Convert one bundle into `<outRoot>/<id>/` (fixture.json + signals.ndjson), scrubbed. */
export function fixtureFromReport(bundle: string, outRoot: string, identity: Identity): FixtureResult {
  const reportFile = join(bundle, 'report.json')
  if (!existsSync(reportFile)) throw new ReportError(`${bundle} has no report.json: not a status-report bundle`)
  const r = JSON.parse(readFileSync(reportFile, 'utf8')) as Report
  if (r.format !== 1) throw new ReportError(`report.json format ${String(r.format)} is not one this tool reads`)
  if (!r.start || typeof r.start !== 'object') throw new ReportError('the session was not live when it was reported: there is no signal sequence to replay')
  const id = basename(bundle).replace(/[^A-Za-z0-9._-]/g, '_')
  const outDir = join(outRoot, id)
  const fixture = {
    format: 1,
    id,
    agent: String(r.agent),
    expected: r.expected,
    note: typeof r.note === 'string' ? r.note : null,
    reported: { lifecycle: String(r.lifecycle), phase: r.phase },
    start: r.start,
  }
  const lines = existsSync(join(bundle, 'signals.ndjson')) ? readFileSync(join(bundle, 'signals.ndjson'), 'utf8').split('\n').filter((l) => l.trim() !== '') : []
  const signals = lines.map((l) => {
    const s = JSON.parse(l) as Record<string, unknown>
    return JSON.stringify({ seq: s.seq, mono: s.mono, at: s.at, source: s.source, spooled: s.spooled, events: s.events })
  })
  const out: FixtureResult = { id, outDir, files: [], signals: signals.length, residual: [], paths: [] }
  mkdirSync(outDir, { recursive: true })
  for (const [name, text] of [
    ['fixture.json', `${JSON.stringify(fixture, null, 1)}\n`],
    ['signals.ndjson', signals.length ? `${signals.join('\n')}\n` : ''],
  ] as const) {
    const ctx = { identity, envFile: false }
    const { output } = scrubBuffer(Buffer.from(text, 'utf8'), ctx)
    const dest = join(outDir, name)
    writeFileSync(dest, output)
    out.files.push(dest)
    for (const finding of scanForPrivateData(output, ctx)) out.residual.push({ file: dest, finding })
    for (const p of findAbsolutePaths(output)) out.paths.push({ file: dest, ...p })
  }
  return out
}

function main(argv: string[]): number {
  const args = [...argv]
  let outRoot: string | null = null
  const at = args.indexOf('--out')
  if (at >= 0) {
    outRoot = args[at + 1] ? resolve(args[at + 1]!) : null
    args.splice(at, 2)
    if (!outRoot) {
      console.error('fixture:from-report: --out needs a directory')
      return 2
    }
  }
  const dirArg = args[0]
  if (!dirArg || args.length > 1) {
    console.error('usage: pnpm fixture:from-report <report bundle dir> [--out <fixtures dir>]')
    return 2
  }
  const bundle = resolve(dirArg)
  if (!existsSync(bundle) || !statSync(bundle).isDirectory()) {
    console.error(`fixture:from-report: ${dirArg} is not a directory`)
    return 2
  }
  const root = repoRoot()
  if (bundle.startsWith(join(root, 'fixtures'))) {
    console.error('fixture:from-report: the bundle must come from <KEA_HOME>/reports/, not from fixtures/')
    return 2
  }
  let res: FixtureResult
  try {
    res = fixtureFromReport(bundle, outRoot ?? join(root, 'fixtures', 'status'), currentIdentity(root))
  } catch (e) {
    console.error(`fixture:from-report: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
  const show = (p: string) => (p.startsWith(root) ? relative(root, p) : p)
  for (const f of res.files) console.log(show(f))
  if (res.paths.length) {
    console.log(`\nAbsolute paths in the fixture — review before committing (${res.paths.length}):`)
    for (const p of res.paths) console.log(`  ${show(p.file)}:${p.line}  ${p.path}`)
  }
  if (res.residual.length) {
    console.log(`\nPrivate data left after scrubbing (${res.residual.length}):`)
    for (const r of res.residual) console.log(`  ${show(r.file)}:${r.finding.line}  ${r.finding.label}`)
  }
  console.error(`fixture:from-report: ${res.signals} signals into ${show(res.outDir)}/ — the replay tests (U-ST-7) run it`)
  return res.residual.length > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)))
