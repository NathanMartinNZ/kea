// Command-line switches a packaged Kea refuses to start with: a debugger (Chromium remote debugging, the Node
// inspector) would let any same-user process drive Kea and so reach every session, and the perf harness's
// `--kea-perf*` probes expose test-only surfaces. The fuses already disable `--inspect*` (nodeCliInspect off); this
// check is the second layer and the only one for Chromium's switches. Dev builds accept everything. A perf-probe build
// (`pnpm kea:install --perf-probes`, built with `__KEA_PERF_PROBES__`; for test runs only, never installed for use)
// accepts `--kea-perf*` and nothing else on this list.
//
// Chromium on macOS reads a switch with one or two leading dashes, so both forms are matched; names are compared
// case-insensitively, and an entry after a `--` terminator is refused too (refusing more is always safe).

export interface SwitchPolicy {
  /** `app.isPackaged` */
  packaged: boolean
  /** The build-time `__KEA_PERF_PROBES__` constant (tools/build.ts `--perf-probes`). */
  perfProbes: boolean
}

const DEBUGGER_PREFIXES = ['remote-debugging-', 'inspect'] // remote-debugging-port/-pipe/-address…, inspect, inspect-brk, inspect-port…
const PERF_PREFIX = 'kea-perf' // kea-perf, kea-perf-busy=…

/** The entries of `argv` (argv[0], the executable, excluded) that make this build refuse to start; empty to start. */
export function refusedSwitches(argv: readonly string[], policy: SwitchPolicy): string[] {
  if (!policy.packaged) return []
  return argv.slice(1).filter((arg) => {
    const name = /^--?([^=-][^=]*)/.exec(arg)?.[1]?.toLowerCase()
    if (name === undefined) return false
    if (DEBUGGER_PREFIXES.some((p) => name.startsWith(p))) return true
    return name.startsWith(PERF_PREFIX) && !policy.perfProbes
  })
}
