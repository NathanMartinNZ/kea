// The sidebar's status glyphs: SVG shapes, never emoji, each with its own shape so status is never colour-only, and an
// accessible label. Twelve units square (`--size-glyph`); colours come from tokens in ui.css. The working arc turns
// once per `--motion-spinner` and stands still under reduced motion. Drawn by `StatusGlyph.svelte`.

import { SESSION_GLYPHS, type SessionGlyph } from '@kea/protocol'

/** Every glyph kind (`SESSION_GLYPHS`): core derives a session's (`SessionView.glyph`, `sessionGlyph`). */
export const GLYPH_KINDS = SESSION_GLYPHS
export type GlyphKind = SessionGlyph

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
