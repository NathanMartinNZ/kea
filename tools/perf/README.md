# tools/perf

The performance harness behind `pnpm perf`. Every performance budget is a Vitest test in the `perf` project whose
name begins with the budget's ID (`P-TERM-1 · …`), and every budget's metric, limit and unit is in
`constants/budgets.toml`. `pnpm perf` runs the project, then prints a table of the results that run recorded: budget,
measured value, margin, and the previous value, flagged when a passing result is more than 15 % worse than the last
one.

## Running

```sh
pnpm perf                              # every budget except the two-hour GPU run
pnpm perf --only P-TERM-1,P-START-3    # selected budgets
pnpm perf --app                        # only the app-level tests (tests/perf/app-*)
pnpm perf --long                       # also P-GPU-2 (two hours) and the longer window-cycle run
pnpm perf --keys 200 --flood-mb 100    # keystrokes per echo budget (default 1000); output flood size in MiB (default 100)
pnpm perf --contention --busy 30:1000  # also keystroke echo while five other terminals replay recordings;
                                       # --busy optionally stalls ptyhost for 30 ms every 1000 ms
```

`pnpm exec vitest run --project perf` runs the same tests without the summary.

Budgets are judged on the reference machine: Apple silicon, on AC power, with nothing else heavy running. On macOS
`pnpm perf` exits non-zero when a budget is missed or a test fails. On Linux it runs and reports the same tests but
exits 0 whatever the results. During a run the machine is kept awake (`caffeinate -di` on macOS; `systemd-inhibit`
on Linux, where the session allows it).

Each result is stored in `tools/perf/last.json` (not committed) with the machine, OS, Electron version, commit and
whether the tree was dirty, power source and load average, so a result taken on a busy machine shows it. A partial run
keeps the other budgets' last results.

The multi-hour idle soaks do not run under `pnpm perf`, only under `pnpm test:long`.

## What is measured where

- `tests/perf/app-*.test.ts` drive the real app: a release build made on first use in `dist/test-app-<tag>`, launched
  with `--kea-perf` (its window never takes keyboard focus) on a temporary `KEA_HOME` and `HOME`. On Linux it draws on
  an Xvfb display of the harness's own.
- `tests/perf/ptyhost-*.test.ts` measure ptyhost and the terminal holder, in-process or in a probe process of their
  own (`ptyhost-probe.ts`).
- `tests/perf/core-*.test.ts` measure core's work in-process: git, the file service and hook delivery.
- The measurements themselves (keystroke echo, CPU and memory per process, frame timing, idle sessions) are written
  once, in `tests/perf/app-harness.ts` and `tests/perf/app-idle.ts`.

No real agent CLI runs here. Agent output comes from recorded sessions in `fixtures/cassettes/`, replayed by
`tools/fake-agent` or by `src/workloads/agent-loop.ts`.

## Files

| File | What |
|---|---|
| `src/main.ts` | `pnpm perf`: passes the options above to Vitest as environment variables, then prints the summary |
| `src/record.ts` | Reads and writes `last.json` and renders the summary table |
| `src/gpu-soak.ts` | Runs the GPU memory test (P-GPU-2) alone: `node tools/perf/src/gpu-soak.ts --duration 2h` writes a report to `test-results/perf/`, and `--summary <report.json>` prints a saved one again |
| `src/workloads/` | Programs the tests run in a terminal: `agent-loop.ts` (recordings in a loop, with optional truecolor animation, duty cycles and bursts), `thinking.ts` (Claude Code's thinking animation with keystroke echo), `winch.ts` (counts resize signals) |
| `src/launch.ts` | Launches a build for a test run with its own `KEA_HOME`, `HOME` and `PATH` (only the harness's fake agent CLIs can be found), finds the run's processes and cleans them up. Shared with the chaos and leak suites through `tests/support/` |
| `src/holders.ts`, `src/procs.ts` | Find and stop exactly the terminal holders a run started, reading processes with `kea-helper procs`. A pid is signalled only after checking it is still the same process |
| `src/stats.ts` | Nearest-rank quantiles, median, Theil–Sen slope, and the most events in any window of time |
| `src/survival.ts` | Checks that a terminal survives a quit, a SIGKILL of the whole app and an upgrade to a new build, and that each relaunch adopts it again. Uses a dev build by default; `--app <Kea.app> [--next-app <Kea.app>]` tests packaged macOS builds |
| `src/os/` | The harness's OS layer: where the app draws, keeping the machine awake, facts about the machine |
| `src/generated/budgets.ts` | Written by `pnpm codegen` from `constants/budgets.toml`. Do not edit |
