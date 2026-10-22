// "Copy diagnostics" (`app.copyDiagnostics`: menu bar, palette, Settings › Advanced). The text is core's part
// (`diagnostics.collect`: versions, agent CLIs, sessions as counts, holders, banners, recent warnings and errors of
// every process's log) followed by the resource report: every process's rows and its footprint, as main collects them
// for the hourly line (`resourceReports`), or this window's own rows when main gives none.
//
// The rule (packages/protocol/src/diagnostics.ts): no terminal content, and no path outside `<KEA_HOME>` unless the
// person ticked "Include file paths". Core holds to it for its part; the resource report is names and numbers, and is
// passed through the same scrubber all the same, so the rule holds for the whole text whatever a row is named.
//
// The clipboard is written through the window's one seam (`copyText` of the sessions feature, `navigator.clipboard`),
// which the tests replace with a recorder: no test touches the person's clipboard.

import { reportLines, resourcesSection, scrubPaths } from '@kea/protocol'
import { resourceReports } from '../../lib/bridge.ts'
import { call } from '../../lib/rpc.ts'
import { rendererResources } from '../resources/report.ts'
import { copyText } from '../sessions/actions.ts'
import { failed, ui } from '../sessions/state.svelte.ts'
import { diagUi } from './state.svelte.ts'

/** The resource report's section of the text. */
export function resourcesText(collected: Awaited<ReturnType<typeof resourceReports>>, paths: boolean): string {
  const lines = resourcesSection(collected)
  if (!collected) lines.push('renderer:', ...reportLines(rendererResources()))
  const text = lines.join('\n')
  return paths ? text : scrubPaths(text, { home: [] })
}

/** The whole text: core's part, a blank line, the resource report. */
export async function diagnosticsText(paths: boolean): Promise<string> {
  const [core, collected] = await Promise.all([call('diagnostics.collect', paths ? { paths: true } : {}), resourceReports()])
  return `${core.text.replace(/\n+$/, '')}\n\n${resourcesText(collected, paths)}\n`
}

/** Collect and copy. `paths`: include file paths (default: what "Include file paths" says now). One copy at a time. */
export async function copyDiagnostics(paths: boolean = diagUi.paths): Promise<void> {
  if (diagUi.copy.state === 'copying') return
  diagUi.copy = { state: 'copying' }
  // Advanced has the status line: a failure has its place there; anywhere else it is a toast (success is never toasted)
  const inPlace = (): boolean => ui.sheet?.kind === 'settings' && ui.sheet.page === 'advanced'
  try {
    const text = await diagnosticsText(paths)
    if (!(await copyText(text))) throw new Error('the clipboard could not be written (the window must be in front)')
    diagUi.copy = { state: 'copied', at: Date.now(), paths, lines: text.trimEnd().split('\n').length }
  } catch (e) {
    diagUi.copy = { state: 'failed', message: e instanceof Error ? e.message : String(e) }
    if (!inPlace()) failed("Couldn't copy the diagnostics", e)
  }
}
