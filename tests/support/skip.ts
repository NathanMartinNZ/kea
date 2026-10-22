// A test that needs what this system lacks skips by its name, with the reason: on Linux, a test that needs a macOS tool
// or a macOS-only behaviour is skipped and says why. One helper, so every such skip reads the same in a run's output:
// `not on linux: <the capability's reason>`.
import type { TestContext } from 'vitest'
import { isAvailable, type NotAvailable } from '../../packages/protocol/src/platform.ts'
import { harnessOs } from '../../tools/perf/src/os/index.ts'

/** The capability, or (where this system lacks it) the running test skipped with its reason. */
export function needOrSkip<T extends object>(ctx: Pick<TestContext, 'skip'>, capability: T | NotAvailable): T {
  if (isAvailable(capability)) return capability
  ctx.skip(skipNote(capability.reason))
  throw new Error('unreachable: ctx.skip ends the test')
}

/** Skip the running test where `reason` is non-null (a behaviour this system does not have). */
export function skipWhere(ctx: Pick<TestContext, 'skip'>, reason: string | null): void {
  if (reason !== null) ctx.skip(skipNote(reason))
}

/** The note a skip shows. */
export function skipNote(reason: string): string {
  return `not on ${harnessOs.system}: ${reason}`
}
