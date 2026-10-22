// The palette's window state: whether it is open and how it was opened (`⌘⇧P`: everything; `⌘P`: the files of the
// session on screen), the usage record its empty query and ranking read, and the sources it reads (the window's, unless
// a perf test gave it a synthetic set). One floating layer per window (`PaletteLayer.svelte`).

import { isCommandId } from '@kea/protocol'
import type { BaseMode } from './model.ts'
import type { Sources } from './data.ts'
import { windowSources } from './sources.ts'
import { Usage } from './usage.ts'

class PaletteState {
  /** Open, and how: `seq` moves on every opening, so one asked for again while open takes the keyboard back. */
  open = $state.raw<{ base: BaseMode; seq: number } | null>(null)
}

export const palette = new PaletteState()

let seq = 0

export function openPalette(base: BaseMode): void {
  palette.open = { base, seq: ++seq }
}

export function closePalette(): void {
  palette.open = null
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** How often the palette ran each command: the window's one record. */
export const usage = new Usage(storage(), isCommandId)

let sources: Sources = windowSources

/** The sources the palette reads. */
export function paletteSources(): Sources {
  return sources
}

/** A perf test's synthetic sources (P-UI-3), or null for the window's own again. */
export function setPaletteSources(s: Sources | null): void {
  sources = s ?? windowSources
}

/** What the open palette holds, for the resource report; written by the palette as it reads its sources. */
export const paletteHolds = { candidates: 0, rows: 0 }

/** Timing probes a perf run installs (P-UI-3); none otherwise. */
export const paletteTiming: { keystroke: ((ms: number) => void) | null } = { keystroke: null }
