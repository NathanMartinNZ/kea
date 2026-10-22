// Picks ptyhost's OS implementation once, at start, from `process.platform`.
import { systemOf } from '@kea/protocol'
import { darwin } from './darwin.ts'
import type { PtyhostOs } from './index.ts'
import { linux } from './linux.ts'

export const ptyhostOs: PtyhostOs = systemOf(process.platform) === 'linux' ? linux : darwin
