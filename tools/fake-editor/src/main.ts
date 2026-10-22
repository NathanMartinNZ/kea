// fake-editor: the stand-in for everything Kea launches outside itself for a folder: an editor's bundled CLI (`code`,
// `cursor`, `zed` …), the system's `open`, Spotlight's `mdfind`, the GitHub CLI (`gh`, for `session.createPR`). It
// opens nothing. It appends one JSON line with what it was asked to do to its log and exits; a test reads the log
// (`readCalls`, index.ts).
//
//   node main.ts --as code --log <file> [--exit N] [--stderr TEXT] [--bundles <json file>] -- <the argv it stands for>
//
// `installTool` (index.ts) writes the small executable that runs this with the options fixed, so what Kea runs is an
// ordinary program at the path it expects.

import { appendFileSync, readFileSync } from 'node:fs'

export interface FakeCall {
  /** What it stood for: `code`, `open`, `mdfind`, `gh` … */
  tool: string
  /** The arguments it was run with. */
  argv: string[]
  cwd: string
  /** Its whole environment. */
  env: Record<string, string>
}

export const USAGE = `fake-editor: a stand-in that records how it was run and opens nothing (tools/fake-editor/README.md)

usage: node tools/fake-editor/src/main.ts --as NAME --log FILE [options] -- [ARGS…]
  --as NAME        what it stands for (recorded as "tool")
  --log FILE       append one JSON line per run: {"tool","argv","cwd","env"}
  --exit N         exit with N (default 0)
  --stderr TEXT    write TEXT and a newline to stderr
  --bundles FILE   mdfind's part: FILE is JSON {"<bundle id>": "<app path>"}; for every bundle id quoted in ARGS that it
                   lists, print "<app path>   kMDItemCFBundleIdentifier = <bundle id>"
  -h, --help       this text
`

export interface FakeOptions {
  as: string
  log: string
  exit: number
  stderr: string | null
  bundles: string | null
  argv: string[]
}

export function parseFakeArgs(argv: readonly string[]): FakeOptions {
  const o: FakeOptions = { as: '', log: '', exit: 0, stderr: null, bundles: null, argv: [] }
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--') {
      i++
      break
    }
    const v = argv[i + 1]
    if (!['--as', '--log', '--exit', '--stderr', '--bundles'].includes(a)) throw new Error(`unknown option ${a}`)
    if (v === undefined) throw new Error(`${a} needs a value`)
    i++
    if (a === '--as') o.as = v
    else if (a === '--log') o.log = v
    else if (a === '--stderr') o.stderr = v
    else if (a === '--bundles') o.bundles = v
    else {
      if (!/^\d{1,3}$/.test(v) || Number(v) > 255) throw new Error(`--exit must be 0…255, got "${v}"`)
      o.exit = Number(v)
    }
  }
  o.argv = argv.slice(i)
  if (!o.as) throw new Error('--as is required')
  if (!o.log) throw new Error('--log is required')
  return o
}

/** mdfind's answer for the bundle ids quoted in a query: one `-attr` line per id the map lists. */
export function bundleLines(args: readonly string[], bundles: Readonly<Record<string, string>>): string {
  const asked = new Set<string>()
  for (const a of args) for (const m of a.matchAll(/'([^']+)'/g)) asked.add(m[1] as string)
  let out = ''
  for (const id of asked) if (typeof bundles[id] === 'string') out += `${bundles[id]}   kMDItemCFBundleIdentifier = ${id}\n`
  return out
}

function main(argv: readonly string[]): number {
  // its own options end at `--`: a `--help` after it belongs to the argv it stands for, and is recorded
  const dashes = argv.indexOf('--')
  const own = dashes < 0 ? argv : argv.slice(0, dashes)
  if (own.includes('--help') || own.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }
  let o: FakeOptions
  try {
    o = parseFakeArgs(argv)
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n(see --help)\n`)
    return 2
  }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  const call: FakeCall = { tool: o.as, argv: o.argv, cwd: process.cwd(), env }
  appendFileSync(o.log, `${JSON.stringify(call)}\n`)
  if (o.bundles) process.stdout.write(bundleLines(o.argv, JSON.parse(readFileSync(o.bundles, 'utf8')) as Record<string, string>))
  if (o.stderr !== null) process.stderr.write(`${o.stderr}\n`)
  return o.exit
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
