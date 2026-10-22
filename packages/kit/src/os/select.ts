// Picks the kit's OS implementation once, at start, from `process.platform`.
import { systemOf } from '@kea/protocol/platform'
import { darwin } from './darwin.ts'
import type { KitOs } from './index.ts'
import { linux } from './linux.ts'

export const kitOs: KitOs = systemOf(process.platform) === 'linux' ? linux : darwin
