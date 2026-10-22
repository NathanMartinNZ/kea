<!-- A status glyph (glyphs.ts). `label` overrides the default accessible label (e.g. "permission"). -->
<script lang="ts">
  import { GLYPH_LABELS, type GlyphKind } from './glyphs.ts'

  let { kind, label }: { kind: GlyphKind; label?: string } = $props()
</script>

<svg class={`kea-glyph kea-glyph-${kind}`} viewBox="0 0 12 12" role="img" aria-label={label ?? GLYPH_LABELS[kind]} focusable="false" data-glyph={kind}>
  {#if kind === 'working'}
    <!-- a three-quarter arc: from 12 o'clock clockwise to 9 o'clock -->
    <path class="kea-glyph-arc" d="M6 1.75 A4.25 4.25 0 1 1 1.75 6" />
  {:else if kind === 'needsYou' || kind === 'unread'}
    <circle cx="6" cy="6" r="4" class="kea-glyph-fill" />
  {:else if kind === 'idle'}
    <circle cx="6" cy="6" r="4" />
  {:else if kind === 'detached'}
    <circle cx="6" cy="6" r="3" class="kea-glyph-dashed" />
  {:else if kind === 'failed' || kind === 'limited'}
    <circle cx="6" cy="6" r="4.25" />
    <path d="M3 9 L9 3" />
  {/if}
</svg>
