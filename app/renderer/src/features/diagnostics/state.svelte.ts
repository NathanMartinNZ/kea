// The diagnostics feature's state: how the last "Copy diagnostics" went and whether file paths are to be included
// (Settings › Advanced shows both; the menu bar and the palette run the same copy), and whether the dev-only
// performance HUD is shown. Small values only.

export type CopyState = { state: 'idle' } | { state: 'copying' } | { state: 'copied'; at: number; paths: boolean; lines: number } | { state: 'failed'; message: string }

class DiagnosticsUi {
  /** "Include file paths": off until ticked, and off again in a new window. */
  paths = $state(false)
  copy = $state.raw<CopyState>({ state: 'idle' })
  /** The performance HUD is shown (a development build only: dev.ts). */
  hud = $state(false)
}

export const diagUi = new DiagnosticsUi()

/** What the last copy did, in words (the Advanced row's status line). */
export function copyStatus(c: CopyState, paths: boolean): string {
  if (c.state === 'copying') return 'Collecting…'
  if (c.state === 'failed') return `Not copied: ${c.message}`
  if (c.state === 'copied') return `Copied ${c.lines} lines${c.paths ? ', file paths included' : ', with no file path outside Kea’s own folder'}.`
  return paths
    ? 'Versions, the agent CLIs found, sessions as counts, background processes, recent warnings and errors, and the resource report. Never terminal content. File paths are included as they are.'
    : 'Versions, the agent CLIs found, sessions as counts, background processes, recent warnings and errors, and the resource report. Never terminal content, and no file path outside Kea’s own folder.'
}

/** What the HUD runs while it is shown, for the resource report: its animation-frame loop and its interval; 0 while hidden. */
export const hudHolds = { timers: 0 }
