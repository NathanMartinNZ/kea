// Picks tools/pack's OS implementation once, at start, from `process.platform`.
import { systemOf } from '../../../../packages/protocol/src/platform.ts'
import { darwin } from './darwin.ts'
import type { PackOs } from './index.ts'
import { linux } from './linux.ts'

export const packOs: PackOs = systemOf(process.platform) === 'linux' ? linux : darwin
