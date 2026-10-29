// The sidebar's status glyphs: SVG shapes, never emoji, each with its own shape so status is never colour-only, and an
// accessible label. Twelve units square (`--size-glyph`); colours come from tokens in ui.css, and in the sidebar's
// session rows from the session's own colour (`tone`) for the states that say nothing urgent. The working arc turns
// once per `--motion-spinner` and stands still under reduced motion. Drawn by `StatusGlyph.svelte`.

import { L, SESSION_GLYPHS, type SessionGlyph } from '@kea/protocol'

/** Every glyph kind (`SESSION_GLYPHS`): core derives a session's (`SessionView.glyph`, `sessionGlyph`). */
export const GLYPH_KINDS = SESSION_GLYPHS
export type GlyphKind = SessionGlyph

/** The glyphs a session's colour tones (ui.css `--glyph-tone`); needs-you, failed and limited keep their own colours. */
export const TONED_GLYPHS: readonly GlyphKind[] = ['working', 'unread', 'idle', 'detached']

/** A session's colour as the `--glyph-tone` value: `var(--session-<n>)`, wrapping past the palette; none without one. */
export function glyphTone(tone: number | undefined): string | undefined {
  if (tone === undefined || !Number.isInteger(tone) || tone < 0) return undefined
  return `var(--session-${(tone % L.sessionColors) + 1})`
}

/** What each glyph says to assistive technology when the row gives no more specific label. */
export const GLYPH_LABELS: Readonly<Record<GlyphKind, string>> = {
  working: 'Working',
  needsYou: 'Needs you',
  unread: 'Finished, unread',
  idle: 'Idle',
  detached: 'Detached',
  failed: 'Failed',
  limited: 'Waiting on an account condition',
}
