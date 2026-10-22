// `pnpm verify`: Tier A, the local gate before every push (pre-push hook: tools/git-hooks/pre-push).
// Target < 5 min. Runs every step (stopping at nothing), then prints a table and exits 1 if any step failed.
//
//   codegen --check      R-LIM-1: generated files equal codegen output
//   constants owners     every constants/limits.toml entry has an owner in the private specification (tools/trace)
//   private references   no file of the repository refers to the private specification (tools/trace --check-source);
//                        these two read .plan/ and are skipped where it is absent, unless KEA_REQUIRE_PLAN=1
//                        (tools/trace/src/presence.ts)
//   lint                 U-LINT-1 boundaries · DS-2 tokens · U-AGT-11 agent strings
//   typecheck            tsc --noEmit over the workspace, then svelte-check over the renderer and packages/ui
//   unit                 the unit project in full (DS-* and the U-ST-7 replays included)
//   rust                 cargo test for native/kea-helper (incl. proptest)
//   integration/contract/chaos/memory   the Tier A IDs of tools/verify-tier-a.ts, by test-name pattern
//
// Each system runs its own set: a step this system cannot run yet is shown as skipped with the reason, and the gate is
// green when every step the system has passes. Linux runs every step: its chaos and memory tests launch Kea on an X
// server of the harness's own (Xvfb), and a test that needs a macOS tool or macOS-only behaviour skips by name there,
// with the reason (tests/support/skip.ts).
//
// `pnpm verify --skip memory` (a step's first word; several with commas) leaves a step out and shows it as skipped
// in the table, which is handy while iterating. The gate itself is the run with no step skipped. The last line names
// every skipped step, whatever skipped it.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { systemOf, type System } from '../packages/protocol/src/platform.ts'
import { resolveCargo } from './cargo.ts'
import { packOs } from './pack/src/os/index.ts'
import { NO_PLAN, skipsWithoutPlan } from './trace/src/presence.ts'
import { namePattern, TIER_A, type TierAProject } from './verify-tier-a.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bin = (name: string) => join(root, 'node_modules/.bin', name)

type Step = {
  name: string
  run: () => { code: number; note?: string }
  /** Why a system cannot run this step yet; it is shown as skipped there and the gate does not wait for it. */
  cannot?: Partial<Record<System, string>>
}
export type Result = { name: string; status: 'pass' | 'FAIL' | 'skip'; ms: number; note: string }

function exec(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): number {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
  if (r.error) {
    console.error(`${cmd}: ${r.error.message}`)
    return 1
  }
  return r.status ?? 1
}

const node = process.execPath

const tierA = (project: TierAProject, cannot?: Step['cannot']): Step => ({
  name: `${project} (Tier A)`,
  run: () => ({ code: exec(bin('vitest'), ['run', '--project', project, '--passWithNoTests', '--testNamePattern', namePattern(TIER_A[project])]) }),
  ...(cannot ? { cannot } : {}),
})

const system = systemOf(process.platform) // os-ok: the gate runs this system's own set

const steps: Step[] = [
  { name: 'codegen --check', run: () => ({ code: exec(node, ['tools/codegen/src/main.ts', '--check']) }) },
  {
    name: 'constants owners',
    run: () => (skipsWithoutPlan(root) ? { code: -1, note: NO_PLAN } : { code: exec(node, ['tools/trace/src/main.ts', '--check-owners']) }),
  },
  {
    name: 'private references',
    run: () => (skipsWithoutPlan(root) ? { code: -1, note: NO_PLAN } : { code: exec(node, ['tools/trace/src/main.ts', '--check-source']) }),
  },
  { name: 'lint', run: () => ({ code: exec(node, ['tools/lint/src/main.ts']) }) },
  {
    name: 'typecheck',
    run: () => {
      const tsc = exec(bin('tsc'), ['-p', 'tsconfig.json', '--noEmit'])
      // svelte-check lives in app/renderer: it needs TypeScript 6's compiler API (tsconfig.svelte.json says why)
      const svelte = exec(join(root, 'app/renderer/node_modules/.bin/svelte-check'), ['--tsconfig', './tsconfig.svelte.json', '--workspace', '.', '--fail-on-warnings'])
      return { code: tsc || svelte }
    },
  },
  { name: 'unit', run: () => ({ code: exec(bin('vitest'), ['run', '--project', 'unit']) }) },
  {
    name: 'rust',
    run: () => {
      const manifest = join(root, 'native/kea-helper/Cargo.toml')
      if (!existsSync(manifest)) return { code: -1, note: 'native/kea-helper has no Cargo.toml yet' }
      // Rust tests are part of Tier A: without cargo the gate is not green (brew install rustup).
      if (!resolveCargo()) return { code: 1, note: `cargo not found (${packOs.rust.installHint})` }
      return { code: exec(node, ['tools/cargo.ts', 'test', '--manifest-path', 'native/kea-helper/Cargo.toml']) }
    },
  },
  tierA('integration'),
  tierA('contract'),
  tierA('chaos'),
  tierA('memory'),
]

const firstWord = (name: string) => name.split(' ')[0]!
const fmt = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s` : `${(ms / 1000).toFixed(1)}s`)

/** The report's last line: the verdict, then every skipped step, so that a green run with gaps never reads as complete. */
export function summaryLine(results: Result[], ms: number): string {
  const count = (n: number) => `${n} step${n === 1 ? '' : 's'}`
  const failed = results.filter((r) => r.status === 'FAIL')
  const skipped = results.filter((r) => r.status === 'skip')
  const verdict = failed.length === 0 ? 'Tier A green' : `${count(failed.length)} failed (${failed.map((r) => r.name).join(', ')})`
  const slow = ms > 300_000 ? ' — over the 5 min target' : ''
  const gaps = skipped.length > 0 ? `; ${count(skipped.length)} skipped: ${skipped.map((r) => r.name).join(', ')}` : ''
  return `verify: ${verdict} in ${fmt(ms)}${slow}${gaps}`
}

function main(): never {
  const skipAt = process.argv.indexOf('--skip')
  const skipped = skipAt === -1 ? [] : (process.argv[skipAt + 1] ?? '').split(',').filter(Boolean)
  const unknownSkips = skipped.filter((w) => !steps.some((s) => firstWord(s.name) === w))
  if (skipAt !== -1 && (skipped.length === 0 || unknownSkips.length > 0)) {
    console.error(`pnpm verify --skip: ${skipped.length === 0 ? 'name a step' : `not a step: ${unknownSkips.join(', ')}`} (steps: ${steps.map((s) => firstWord(s.name)).join(', ')})`)
    process.exit(2)
  }

  const results: Result[] = []
  const started = performance.now()
  for (const s of steps) {
    console.log(`\n━━ verify: ${s.name} ━━`)
    const t0 = performance.now()
    const cannot = s.cannot?.[system]
    const { code, note } = skipped.includes(firstWord(s.name)) ? { code: -1, note: 'left out with --skip' } : cannot ? { code: -1, note: `not on ${system} yet: ${cannot}` } : s.run()
    const ms = performance.now() - t0
    const status = code === -1 ? 'skip' : code === 0 ? 'pass' : 'FAIL'
    if (status === 'skip') console.warn(`warning: skipped ${s.name}: ${note}`)
    results.push({ name: s.name, status, ms, note: note ?? (status === 'FAIL' ? `exit ${code}` : '') })
  }

  const total = performance.now() - started
  const w = Math.max(...results.map((r) => r.name.length))
  console.log(`\n${'step'.padEnd(w)}  result  time     notes`)
  console.log(`${'─'.repeat(w)}  ──────  ───────  ─────`)
  for (const r of results) console.log(`${r.name.padEnd(w)}  ${r.status.padEnd(6)}  ${fmt(r.ms).padStart(7)}  ${r.note}`)
  console.log(`\n${summaryLine(results, total)}`)
  process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0)
}

if (import.meta.main) main()
