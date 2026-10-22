// Shared by the cross-process suites: temp KEA_HOMEs, tagged per Vitest invocation, and how a teardown finds its own
// run's holders by them.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Every temp KEA_HOME starts with this, so strays from tests can be told apart from real holders. */
export const TEST_HOME_PREFIX = 'kea-test-'

/**
 * The Vitest invocation the in-process suites' homes belong to (tests/support/holders.ts `shortKeaHome`): the
 * integration suite's global setup sets it, so its teardown finds this invocation's holders, and only those, by their
 * homes `kea-test-<tag>-*`. A process started outside such an invocation (the memory, chaos and perf suites' in-process
 * files) uses `adhoc`, which no teardown looks for.
 */
export const RUN_TAG_ENV = 'KEA_TEST_RUN'

/** `kea-test-<tag>-`: the start of every in-process home of this invocation (never `kea-test-app-`, app.ts). */
export function runHomePrefix(): string {
  return `${TEST_HOME_PREFIX}${process.env[RUN_TAG_ENV] ?? 'adhoc'}-`
}

/** A fresh, empty KEA_HOME for one test; `dispose` removes it. */
export async function tempKeaHome(): Promise<{ home: string; dispose(): Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), runHomePrefix()))
  return { home, dispose: () => rm(home, { recursive: true, force: true }) }
}

/**
 * Homes of the app-level suites (tests/support/app.ts): their holders belong to a running app, and each invocation's
 * global teardown (app-global.ts) removes its own, so no other suite may treat them as strays.
 */
export const APP_TEST_HOME_PREFIX = `${TEST_HOME_PREFIX}app-`

/**
 * The homes named on a command line that start with `prefix` (a holder names its state directory and, unless the
 * fallback run directory is used, its socket). Teardowns find their own run's holders this way and no one else's: a
 * teardown that killed every new `kea-test-` helper would also kill the holders of a memory, chaos or perf run going on
 * at the same time, and fail on any helper another run or the installed app started meanwhile.
 */
export function homesOf(args: string, prefix: string): string[] {
  const out: string[] = []
  const literal = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(/[^ ]*?/${literal}[^/ ]+)`, 'g')
  for (const m of args.matchAll(re)) out.push(m[1] as string)
  return out
}
