// Picks the test harnesses' OS implementation once, at start, from `process.platform`.
import { systemOf } from '../../../../packages/protocol/src/platform.ts'
import { darwin } from './darwin.ts'
import type { HarnessOs } from './index.ts'
import { linux } from './linux.ts'

export const harnessOs: HarnessOs = systemOf(process.platform) === 'linux' ? linux : darwin
