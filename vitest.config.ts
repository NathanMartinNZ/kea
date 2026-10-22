import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

// Playwright 1.63 asserts when Chromium answers a call for a page it has already marked crashed
// (`CRSession._onMessage`, "Target crashed"), from its own event dispatch. The chaos suite crashes the renderer on
// purpose (C-KILL-1) and checks the crash and the recovery itself, so that one assertion is not a test error;
// anything else still is.
function playwrightCrashAssert(e: { message?: string; stack?: string }): boolean | void {
  if (e.message === 'Target crashed' && (e.stack ?? '').includes('_CRSession._onMessage')) return false
}

// The test projects. Unit tests sit next to their code; the rest live in tests/.
export default defineConfig({
  test: {
    projects: [
      {
        // Svelte compiles `.svelte` components and `.svelte.ts` rune modules here as in the renderer build, for
        // Node: runes become plain values and a component renders to HTML with `svelte/server` (a test that mounts one in
        // a DOM needs the browser conditions and a DOM environment instead)
        plugins: [svelte({ configFile: 'svelte.config.js' })],
        test: {
          name: 'unit',
          include: ['{app,packages,tools}/*/src/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          globalSetup: ['tests/integration/global-setup.ts'],
          setupFiles: ['tests/support/long-guard.ts'],
          fileParallelism: true,
        },
      },
      {
        // app-level suites (chaos, memory): app-global.ts builds the app they launch and checks nothing is left behind
        test: { name: 'chaos', include: ['tests/chaos/**/*.test.ts'], environment: 'node', testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false, globalSetup: ['tests/support/app-global.ts'], setupFiles: ['tests/support/long-guard.ts'], onUnhandledError: playwrightCrashAssert },
      },
      {
        // the leak suite's app compiles Svelte without its dev mode (tests/support/app.ts `testAppDist`)
        test: { name: 'memory', include: ['tests/memory/**/*.test.ts'], environment: 'node', testTimeout: 300_000, hookTimeout: 120_000, fileParallelism: false, globalSetup: ['tests/support/app-global.ts'], setupFiles: ['tests/support/long-guard.ts'], env: { KEA_TEST_APP_SVELTE: 'production' } },
      },
      {
        // performance budgets (constants/budgets.toml), in-process (ptyhost-*) and against the real app (app-*, a
        // release build made on first use by tests/perf/app-harness.ts); `pnpm perf` runs this project and prints the
        // summary of tools/perf/last.json
        test: { name: 'perf', include: ['tests/perf/**/*.test.ts'], environment: 'node', testTimeout: 300_000, hookTimeout: 120_000, fileParallelism: false, globalSetup: ['tests/perf/app-global.ts'], setupFiles: ['tests/support/long-guard.ts'] },
      },
      {
        test: { name: 'contract', include: ['tests/contract/static/**/*.test.ts', 'tests/contract/fixtures/**/*.test.ts'], environment: 'node', testTimeout: 30_000 },
      },
      {
        test: { name: 'contract-live', include: ['tests/contract/live/**/*.test.ts'], environment: 'node', testTimeout: 300_000, fileParallelism: false },
      },
    ],
  },
})
