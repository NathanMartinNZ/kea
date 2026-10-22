// The test runner's `expect` for support code shared by the Vitest suites (chaos, memory) and the Playwright suite
// (e2e): Vitest's inside Vitest, Playwright's otherwise. Shared code uses only the matchers both provide (`toBe`,
// `toEqual`, `toMatchObject`, ordering comparisons, `not`), with a message as the second argument of `expect`.

import type { expect as VitestExpect } from 'vitest'

export const expect: typeof VitestExpect = process.env.VITEST
  ? (await import('vitest')).expect
  : ((await import('@playwright/test')).expect as unknown as typeof VitestExpect)
