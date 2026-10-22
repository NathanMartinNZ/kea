// Scroll marks: where a terminal was scrolled up to when its view was released (the window keeps only a few views),
// so the PTY's next view opens there. Kept apart from the views (`views.ts`) so the window's pruning
// (`shell/forget.ts`) and its cycle test (U-SB-5) need no xterm.

import type { ScrollMark } from './view.ts'

// bounded: one per open PTY whose view was released while scrolled up; taken by its next view, dropped with the PTY
const marks = new Map<string, ScrollMark>()

/** A view is released: its mark, or none when it was at the bottom. */
export function rememberScroll(ptyId: string, mark: ScrollMark | null): void {
  if (mark) marks.set(ptyId, mark)
  else marks.delete(ptyId)
}

/** The PTY's next view takes its mark (once). */
export function recallScroll(ptyId: string): ScrollMark | null {
  const m = marks.get(ptyId) ?? null
  marks.delete(ptyId)
  return m
}

/** The scroll marks go with their PTYs (`exists`: still in the terminals store). */
export function forgetScrollMarks(exists: (ptyId: string) => boolean): void {
  for (const id of [...marks.keys()]) if (!exists(id)) marks.delete(id)
}

/** Marks kept (the resource report's `scrollMarks`). */
export function scrollMarkCount(): number {
  return marks.size
}
