// The e2e suite: the real app driven through Playwright's Electron support, one worker. Each test launches Kea with its
// own temp KEA_HOME and `--kea-perf` (tests/support/app.ts), whose window is non-focusable and opens without taking
// keyboard focus, so typing elsewhere during a run never reaches a test terminal. The global setup
// (tests/support/app-global.ts) builds the app into dist/test-app-<tag> and, after the run, fails if anything a test
// started is still alive. Files are `*.spec.ts`, so `pnpm test:trace` finds their IDs.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  globalSetup: '../support/app-global.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [['list']],
  outputDir: '../../dist/e2e-results',
})
