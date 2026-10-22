// Setup file for the integration, chaos, memory and perf projects (vitest.config.ts): a test that is not behind
// `KEA_LONG` and runs past LONG_GUARD_MS fails, so a new long test can't slip into the runs that stop for it.

import { afterEach, beforeEach } from 'vitest'
import { overLong } from './long.ts'

let started = 0

beforeEach(() => {
  started = performance.now()
})

afterEach((ctx) => {
  const why = overLong(ctx.task.name, performance.now() - started)
  if (why) throw new Error(why)
})
