// `pnpm perf`: runs Vitest's perf project, that is the app-level budgets (tests/perf/app-*.test.ts: a release build
// launched unfocused on temporary KEA_HOMEs, each result recorded in tools/perf/last.json) and the in-process
// benchmarks (tests/perf/ptyhost-*.test.ts, core-*.test.ts), then prints the summary table of the results this run
// recorded: budget, measured, margin and the previous value. Exits as Vitest did (1 if a budget was missed or a test
// failed) on macOS; on Linux it reports and exits 0, since no budget there is judged until a Linux reference machine
// measures it.
//
// Every measurement lives in the tests (one implementation each, tests/perf/app-harness.ts); this is only a front door.
//
//   node tools/perf/src/main.ts [--only P-TERM-1,P-START-3,…] [--app] [--long] [--keys N] [--flood-mb N]
//                               [--contention [--busy <ms>:<everyMs>]]
//     --only        only these budgets (test names begin with their P-ID)
//     --app         only the app-level files (no in-process benchmarks)
//     --long        also the long tests (KEA_LONG): the two-hour GPU memory run, P-GPU-2 (tools/perf/src/gpu-soak.ts
//                   runs it alone, with its report), and the full window-cycle run
//     --keys        keys per echo budget (P-TERM-1/2/3; default 1 000)
//     --flood-mb    the size of the output floods in MiB (default 100)
//     --contention  also the contention run (P-TERM-1 while five other terminals replay cassettes), optionally with
//                   ptyhost stalled `--busy <ms>:<everyMs>` (a stand-in for a snapshot serialisation)

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { harnessOs } from './os/index.ts'
import { readLast, summaryTable } from './record.ts'

const root = path.resolve(import.meta.dirname, '..', '..', '..')
const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const known = new Set(['--only', '--app', '--long', '--keys', '--flood-mb', '--contention', '--busy'])
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string
  if (!known.has(a)) {
    console.error(`pnpm perf: unknown option ${a}\nusage: node tools/perf/src/main.ts [--only P-…,P-…] [--app] [--long] [--keys N] [--flood-mb N] [--contention [--busy <ms>:<everyMs>]]`)
    process.exit(2)
  }
  if (['--only', '--keys', '--flood-mb', '--busy'].includes(a)) i++
}

const only = value('only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
if (only?.some((id) => !/^P-[A-Z]+-\d+[a-z]?$/.test(id))) {
  console.error(`pnpm perf: --only takes P-IDs (e.g. P-TERM-1,P-START-3), got ${value('only')}`)
  process.exit(2)
}

const env: Record<string, string | undefined> = { ...process.env }
if (value('keys')) env.KEA_PERF_KEYS = value('keys')
if (value('flood-mb')) env.KEA_PERF_FLOOD_MB = value('flood-mb')
if (flag('long')) env.KEA_LONG = '1'
if (flag('contention')) env.KEA_PERF_CONTENTION = '1'
if (value('busy')) env.KEA_PERF_BUSY = value('busy')

const vitest = path.join(path.dirname(createRequire(path.join(root, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs')
const args = ['run', '--project', 'perf', ...(flag('app') ? ['tests/perf/app-'] : [])]
// a test's full name is its describe block's and its own; its own begins with its P-ID and " · "
if (only) args.push('-t', `(${only.join('|')}) ·`)

const started = new Date().toISOString()
// the machine (on macOS the display too) kept awake while the budgets are measured, by an assertion held by a process
// for as long as Vitest runs, not a setting (the harness's OS layer: `caffeinate -di`, `systemd-inhibit`). With the
// display off, Electron's main keeps memory for each window made and closed. Linux reports, and gates nothing: the
// budgets are the macOS reference machine's.
const awake = harnessOs.keepAwake.wrap([process.execPath, vitest, ...args])
if (awake.warning) console.warn(`pnpm perf: ${awake.warning}`)
if (harnessOs.system !== 'darwin') console.log(`pnpm perf: on ${harnessOs.system} the results are reported, never judged: the budgets are the macOS reference machine's`)
const r = spawnSync(awake.file, awake.args, { cwd: root, env, stdio: 'inherit' })

const last = readLast()
const recorded = Object.values(last.results).filter((e) => e.at >= started)
console.log(`\n## pnpm perf: ${recorded.length} result(s) recorded in tools/perf/last.json\n`)
if (recorded.length) {
  const e = recorded[0] as (typeof recorded)[number]
  console.log(`${e.env.machine.cpu} (${e.env.machine.model ?? '?'}, ${e.env.machine.cores} cores, ${e.env.machine.memGb} GB) · ${e.env.os} · Electron ${e.env.electron} · ${e.env.commit ?? 'no commit'} · power ${e.env.power ?? '?'} · load ${e.env.load.join(' ')}\n`)
  console.log(summaryTable(last, { since: started }))
  const missed = recorded.filter((x) => !x.pass).map((x) => x.id)
  if (missed.length) console.log(`\nMissed: ${missed.join(', ')}`)
}
// Only the macOS reference machine is judged; elsewhere a miss or a failed test is reported above and gates nothing
if (harnessOs.system === 'darwin') process.exitCode = r.status ?? 1
else if (r.status !== 0) console.log(`\npnpm perf: Vitest exited ${r.status ?? r.signal}; on ${harnessOs.system} that gates nothing: the misses and failures above are reported, not judged`)
