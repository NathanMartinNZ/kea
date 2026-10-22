// `pnpm test:long [ID…]`: the long tests, each behind `KEA_LONG=1` (tests/support/long.ts). Run them all before a
// release, or the one a change touches (`pnpm test:long L-TERM-3`). The two-hour GPU run (P-GPU-2) is not here:
// `pnpm perf --long` runs it, only when asked.
//
// The 12-hour idle soak (C-SOAK-2 with L-MEM-17) lives in the perf project, whose every test `pnpm perf --long` puts
// behind `KEA_LONG=1`: so it waits for `KEA_SOAK=1` as well, which only this file sets.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { harnessOs } from './perf/src/os/index.ts'
import { namePattern } from './verify-tier-a.ts'

/**
 * The long tests by Vitest project: every test declared with `it.runIf(LONG)`, except the perf runs above. Beside each,
 * what it measures: a change to one of these is a reason to run it.
 */
export const LONG_TESTS: Record<string, string[]> = {
  memory: [
    // L-TERM-3: GPU memory of WebGL terminals: the atlas guard, the webgl patch, xterm or addon versions, terminal view
    // creation, warmth and disposal, the renderer framework
    'L-TERM-3',
  ],
  // on the release bundle (tests/perf/app-nowindow.test.ts): the app with no window, held to P-MEM-5 and P-CPU-2
  perf: [
    // L-TERM-5 (50 + 50 cycles, about 10 min; a routine run does 15 + 15): what main keeps per window: the window's
    // creation and close, the menu-bar item and the Dock icon, connection records and menu states,
    // notification records; and what a closed window leaves in the GPU helper
    'L-TERM-5',
    // C-SOAK-2 and L-MEM-17 (12 h, one run for both; before a release): anything that runs or grows while Kea idles
    // with no window: a timer, poll or watcher in main, core or ptyhost (P-CPU-2), mirror parking and checkpoints, the
    // resource log and footprint sampler, the menu-bar item, the holders
    'C-SOAK-2',
    'L-MEM-17',
  ],
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const only = process.argv.slice(2)
const known = Object.values(LONG_TESTS).flat()
const unknown = only.filter((id) => !known.includes(id))
if (unknown.length > 0) {
  console.error(`pnpm test:long: not a long test: ${unknown.join(', ')} (long tests: ${known.join(', ')})`)
  process.exit(2)
}

for (const [project, ids] of Object.entries(LONG_TESTS)) {
  const run = only.length > 0 ? ids.filter((id) => only.includes(id)) : ids
  if (run.length === 0) continue
  console.log(`━━ test:long: ${project}: ${run.join(', ')} ━━`)
  // the machine (on macOS the display too) kept awake for the whole run, by an assertion held by a process, not a
  // setting (the harness's OS layer: `caffeinate -di`, `systemd-inhibit`): with the display off, Electron's main keeps
  // memory for each window made and closed, which L-TERM-5 would read as Kea's
  const awake = harnessOs.keepAwake.wrap([join(root, 'node_modules/.bin/vitest'), 'run', '--project', project, '--testNamePattern', namePattern(run)])
  if (awake.warning) console.warn(`test:long: ${awake.warning}`)
  const r = spawnSync(awake.file, awake.args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, KEA_LONG: '1', KEA_SOAK: '1' },
  })
  if (r.error) console.error(`vitest: ${r.error.message}`)
  if (r.status !== 0) process.exit(r.status ?? 1)
}
