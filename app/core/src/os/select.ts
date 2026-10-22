// Picks core's OS implementation once, at start, from `process.platform`.
import { systemOf } from '@kea/protocol'
import { darwin } from './darwin.ts'
import type { CoreOs } from './index.ts'
import { linux } from './linux.ts'

export const coreOs: CoreOs = systemOf(process.platform) === 'linux' ? linux : darwin
