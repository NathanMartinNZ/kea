// The diagnostics feature's rows of the renderer's resource report: the questions to main for every process's report
// that are not answered yet, and what the dev-only HUD runs while it is shown.

import { resourceReportAsks } from '../../lib/bridge.ts'
import { hudHolds } from './state.svelte.ts'

export const DIAGNOSTICS_ROWS = ['diagnosticsAsks', 'hudTimers'] as const

export function diagnosticsResources(): Record<(typeof DIAGNOSTICS_ROWS)[number], number> {
  return { diagnosticsAsks: resourceReportAsks(), hudTimers: hudHolds.timers }
}
