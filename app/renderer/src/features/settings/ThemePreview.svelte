<!--
The Terminal section's live theme preview: a small static sample drawn with the colours of the theme in force, in the
terminal's font. It is not a terminal: no xterm, no canvas, a few spans. The colours are data (the bundled palettes from
`constants/tokens.json`, or the Ghostty config's), set as inline styles; the caption says where "Match Ghostty config"
got them (a missing file is Kea Dark, said here and nowhere else).
-->
<script lang="ts">
  import { GHOSTTY_THEME, type GhosttyConfig } from '@kea/protocol'
  import { ANSI_KEYS, terminalFontStack, type TerminalTheme } from '@kea/terminal'

  let p: { theme: TerminalTheme; themeId: string; fontFamily: string; fontSize: number; lineHeight: number; ghostty: GhosttyConfig | null } = $props()

  const NAMES = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const
  const caption = $derived.by(() => {
    if (p.themeId !== GHOSTTY_THEME) return null
    const g = p.ghostty
    if (!g || !g.found) return `No Ghostty config at ${g?.path || '~/.config/ghostty/config'}: showing Kea Dark.`
    const colours = [g.background, g.foreground, g.cursor, ...g.palette].filter((c) => c !== null).length
    const font = [g.fontFamily, g.fontSize === null ? null : `${g.fontSize} px`].filter((x) => x !== null).join(' ')
    return `From ${g.path}: ${colours} ${colours === 1 ? 'colour' : 'colours'}${font ? `, font ${font}` : ''}. Kea Dark fills in the rest.`
  })
</script>

<div class="settings-row column">
  <span class="settings-label" id="theme-preview-label">Preview</span>
  <div
    class="theme-preview"
    role="img"
    aria-labelledby="theme-preview-label"
    data-theme={p.themeId}
    data-background={p.theme.background}
    style:background={p.theme.background}
    style:color={p.theme.foreground}
    style:font-family={terminalFontStack(p.fontFamily)}
    style:font-size="{p.fontSize}px"
    style:line-height={p.lineHeight}
  >
    <div><span style:color={p.theme.green}>~/project</span> <span style:color={p.theme.blue}>main</span> $ git status</div>
    <div>
      {#each NAMES as n (n)}
        <span style:color={p.theme[n]}>{n}</span>{' '}
      {/each}
    </div>
    <div>
      {#each NAMES as n (n)}
        {@const bright = `bright${n[0]!.toUpperCase()}${n.slice(1)}` as (typeof ANSI_KEYS)[number]}
        <span style:color={p.theme[bright]}>{n}</span>{' '}
      {/each}
    </div>
    <div>
      <span style:background={p.theme.selectionBackground} style:color={p.theme.selectionForeground}>selected text</span>
      <span style:color={p.theme.brightBlack}># comment</span>
      <span class="theme-preview-cursor" style:background={p.theme.cursor} style:color={p.theme.cursorAccent}>&nbsp;</span>
    </div>
    <div class="theme-preview-swatches" aria-hidden="true">
      {#each ANSI_KEYS as k (k)}
        <span style:background={p.theme[k]}></span>
      {/each}
    </div>
  </div>
  {#if caption}
    <span class="settings-help" role="status">{caption}</span>
  {/if}
</div>
