// What the file panel keeps per session besides the expanded folders: which list it showed, where each list was
// scrolled to and the row the keyboard was on. Core stores it as given (`files.saveUi`, bounded in size) and hands it
// back with `files.open`; it is read here field by field, so a state written by another version of Kea never breaks the
// panel. Pure.

export type PanelMode = 'files' | 'changes'

/** One list's place: where it is scrolled to and the row the keyboard is on (a path; null: none). */
export interface ListUi {
  top: number
  sel: string | null
}

/** What the panel keeps per session besides the expanded folders (`files.saveUi`; core stores it as given). */
export interface PanelUi {
  /** Files or Changes, as last shown for this session; null: never chosen, the window's current one stays. */
  mode: PanelMode | null
  /** Ignored files shown in this session; null: never chosen here, the `files.showIgnored` setting decides. */
  showIgnored: boolean | null
  /** The fsmonitor hint was closed for this session: it is offered once. */
  hintClosed: boolean
  files: ListUi
  changes: ListUi
}

export const NO_UI: PanelUi = { mode: null, showIgnored: null, hintClosed: false, files: { top: 0, sel: null }, changes: { top: 0, sel: null } }

function listUi(raw: unknown): ListUi {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return { top: typeof o.top === 'number' && Number.isFinite(o.top) && o.top > 0 ? Math.round(o.top) : 0, sel: typeof o.sel === 'string' && o.sel !== '' ? o.sel : null }
}

/** What core kept, read field by field: anything missing or wrong takes its default. */
export function parsePanelUi(raw: unknown): PanelUi {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return { mode: o.mode === 'files' || o.mode === 'changes' ? o.mode : null, showIgnored: typeof o.showIgnored === 'boolean' ? o.showIgnored : null, hintClosed: o.hintClosed === true, files: listUi(o.files), changes: listUi(o.changes) }
}
