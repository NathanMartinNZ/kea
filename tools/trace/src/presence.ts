// Whether the private specification (.plan/) is in this checkout. It is gitignored, so a public clone has none: the
// steps and tests that read it skip there, with NO_PLAN as the reason, and KEA_REQUIRE_PLAN=1 makes its absence a
// failure instead. The two package tests that read the plan (packages/protocol, packages/ui) repeat this check inline,
// because the boundaries lint keeps a package's files from importing anything outside the package.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Why a step or test that reads the plan did not run. */
export const NO_PLAN = '.plan/ (the private specification) is not in this checkout'

/** Whether `root` holds the plan. */
export const hasPlan = (root: string): boolean => existsSync(join(root, '.plan'))

/** Whether a missing plan is a failure rather than a reason to skip (`KEA_REQUIRE_PLAN=1`). */
export const planRequired = (env: NodeJS.ProcessEnv = process.env): boolean => env.KEA_REQUIRE_PLAN === '1'

/** True when what reads the plan skips: `root` has no plan and none is required. */
export const skipsWithoutPlan = (root: string, env: NodeJS.ProcessEnv = process.env): boolean => !hasPlan(root) && !planRequired(env)
