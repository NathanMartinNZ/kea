// The part of a list of fixed-height rows that is drawn (row render is O(visible), whatever the list holds). The tree
// and the Changes list are flat lists of rows of one height (`--size-tree-row`), so which rows are on screen is
// arithmetic on the scroll position: no measuring, nothing kept per row. Pure.

export interface RowWindow {
  /** The first row drawn. */
  start: number
  /** One past the last row drawn. */
  end: number
  /** Where the first drawn row sits, in pixels from the top of the list. */
  offset: number
  /** The whole list's height in pixels (what the scroller scrolls). */
  height: number
}

/** The rows to draw for a viewport `viewport` px tall scrolled to `scrollTop`, with `overscan` rows on either side. */
export function rowWindow(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan: number): RowWindow {
  const height = count * rowHeight
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, offset: 0, height: 0 }
  // a scroll position past the end (the list shrank) draws the last screenful, as the browser will clamp to
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, height - viewport)))
  const first = Math.floor(top / rowHeight)
  const last = Math.ceil((top + Math.max(0, viewport)) / rowHeight)
  const start = Math.max(0, first - overscan)
  const end = Math.min(count, Math.max(last, first + 1) + overscan)
  return { start, end, offset: start * rowHeight, height }
}

/** The scroll position that brings row `index` fully into view, moving as little as possible (unchanged when it is). */
export function scrollToShow(index: number, scrollTop: number, viewport: number, rowHeight: number): number {
  const top = index * rowHeight
  if (top < scrollTop) return top
  if (top + rowHeight > scrollTop + viewport) return Math.max(0, top + rowHeight - viewport)
  return scrollTop
}

/** How many whole rows a page key moves by (at least one). */
export function pageRows(viewport: number, rowHeight: number): number {
  return Math.max(1, Math.floor(viewport / rowHeight) - 1)
}
