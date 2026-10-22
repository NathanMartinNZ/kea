// `pnpm gallery` (tools/gallery/src/main.ts) runs Playwright with this: the screenshot gallery. One worker; each set
// launches Kea through the e2e fixtures (tests/e2e/fixtures.ts: unfocused, a temporary KEA_HOME, the fake agent). The
// global setup is the app-level suites' (tests/support/app-global.ts): it builds the app into dist/test-app-<tag> and,
// after the run, fails if anything a set started is still alive. Never part of `pnpm verify`: the sets are
// `*.gallery.ts`, which no other runner and not the trace report reads.
export default {
  testDir: './src',
  testMatch: '**/*.gallery.ts',
  globalSetup: '../../tests/support/app-global.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 300_000,
  reporter: [['list']],
  outputDir: '../../dist/gallery-results',
}
