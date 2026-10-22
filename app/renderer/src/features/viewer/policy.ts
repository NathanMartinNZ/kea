// The large-file policy: what the file view does with a file of a given size. Core decides the first cut (a
// file over L.viewerMaxBytes is not loaded: `viewer.read` answers `large`); everything else is decided here from the
// loaded text's size, its line count and its longest line. Pure (U-FV-2).

import { L } from '@kea/protocol/limits'

export interface TextStats {
  /** The file's size on disk. */
  bytes: number
  lines: number
  /** The longest line, in characters. */
  longestLine: number
}

export interface ViewPolicy {
  /**
   * `full`: the whole file is tokenised. `budget`: tokenising gets L.viewerHighlightBudgetMs and then stops with a
   * notice. `none`: plain text.
   */
  highlight: 'full' | 'budget' | 'none'
  /** The tokenising time a request may use; null: no limit (and nothing to spend when `highlight` is `none`). */
  budgetMs: number | null
  folding: boolean
  /** Word wrap may be switched on. */
  wrap: boolean
  /** The Markdown preview may render it. */
  preview: boolean
  /** Plain-text mode (the notice says so). */
  plain: boolean
}

export function viewPolicy(s: TextStats): ViewPolicy {
  // very large: plain text, no highlighting, folding or wrap
  if (s.bytes > L.viewerPlainBytes || s.lines > L.viewerPlainLines) return { highlight: 'none', budgetMs: null, folding: false, wrap: false, preview: false, plain: true }
  // any very long line: wrap is unavailable
  const wrap = s.longestLine <= L.viewerWrapLineMax
  // small: full features
  if (s.bytes <= L.viewerFullBytes) return { highlight: 'full', budgetMs: null, folding: true, wrap, preview: true, plain: false }
  // in between: highlighting runs with a budget, then stops
  return { highlight: 'budget', budgetMs: L.viewerHighlightBudgetMs, folding: true, wrap, preview: false, plain: false }
}

/** Counted from the lines the editor will show. */
export function textStats(bytes: number, lines: readonly string[]): TextStats {
  let longestLine = 0
  for (const l of lines) if (l.length > longestLine) longestLine = l.length
  return { bytes, lines: lines.length, longestLine }
}
