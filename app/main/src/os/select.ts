// Picks main's OS implementation once, at start, from `process.platform`.
import { systemOf } from '@kea/protocol'
import { darwin } from './darwin.ts'
import type { MainOs } from './index.ts'
import { linux } from './linux.ts'

export const mainOs: MainOs = systemOf(process.platform) === 'linux' ? linux : darwin
