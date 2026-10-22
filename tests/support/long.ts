// Long tests: a test designed to run 5 minutes or more runs only when asked, with `KEA_LONG=1` (`pnpm test:long`,
// `pnpm perf --long`): before a release, or when a change touches what it measures.
// Declare one with `it.runIf(LONG)(…)` and list it in tools/test-long.ts. Running its file or project without the
// switch reports it skipped. long-guard.ts fails any other test that runs past LONG_GUARD_MS.

export const LONG = process.env.KEA_LONG === '1'

/** A test not behind LONG that runs longer than this fails: twice the 5 minutes that make a test long, so a busy machine is not enough. */
export const LONG_GUARD_MS = 10 * 60_000

/**
 * Long tests a run asks for by their length, without KEA_LONG: the variable sets how long the one test runs (the GPU
 * memory run, `node tools/perf/src/gpu-soak.ts --duration …`; the idle soaks, tools/test-long.ts or by hand). A run that set
 * it asked for that length, so the guard lets that test, and only that one, run past LONG_GUARD_MS.
 */
export const LONG_BY_LENGTH: Readonly<Record<string, string>> = {
  'P-GPU-2': 'KEA_GPU_SOAK_DURATION_MS',
  'C-SOAK-2': 'KEA_IDLE_SOAK_MS',
  'L-MEM-17': 'KEA_IDLE_SOAK_MS',
}

/** Why long-guard.ts fails the test `name` that ran `ms`, or null when it may run that long. */
export function overLong(name: string, ms: number, o: { long?: boolean; env?: NodeJS.ProcessEnv } = {}): string | null {
  if ((o.long ?? LONG) || ms <= LONG_GUARD_MS) return null
  const asked = LONG_BY_LENGTH[name.split(' · ')[0] ?? '']
  if (asked !== undefined && (o.env ?? process.env)[asked] !== undefined) return null
  return (
    `"${name}" ran ${(ms / 60_000).toFixed(1)} min. A test that runs 5 minutes or more is a long test: declare it ` +
    `with it.runIf(LONG) from tests/support/long.ts and list it in tools/test-long.ts, or make it faster.`
  )
}
