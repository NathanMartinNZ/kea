// The leak suite's seam (L-MEM-19): tests/support/app-child-hooks.cjs, preloaded only into a dev build run with
// `--kea-perf`, sets a function on Symbol.for('kea.test.status'); core hands it the status engine at start, so the
// hook's `status` op can drive a storm of status inputs inside core as the hook intake would. Nothing else sets it, so
// this is a no-op otherwise.

import type { StatusEngine } from './engine.ts'

const TEST_STATUS = Symbol.for('kea.test.status')

export function offerToTestHook(engine: StatusEngine): void {
  const f = (globalThis as Record<symbol, unknown>)[TEST_STATUS]
  if (typeof f === 'function') (f as (e: StatusEngine) => void)(engine)
}
