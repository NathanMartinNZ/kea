<!-- Settings › Terminal: the schema's Terminal rows under a live preview of the theme in force. -->
<script lang="ts">
  import { GHOSTTY_THEME } from '@kea/protocol'
  import { External } from '../../lib/reactive.svelte.ts'
  import { prefs } from '../terminal/prefs.ts'
  import SectionPage from './SectionPage.svelte'
  import { settings } from './store.ts'
  import ThemePreview from './ThemePreview.svelte'

  // the preferences the terminals themselves read (the settings and, for "Match Ghostty config", the file's font)
  const shown = new External(
    (cb) => {
      const offs = [prefs.subscribe(cb), settings.subscribe(cb)]
      return () => {
        for (const off of offs) off()
      }
    },
    () => ({ p: prefs.get(), theme: settings.theme, ghostty: settings.ghostty }),
  )
  const s = $derived(shown.current)
  const ghosttyFont = $derived(s.p.theme === GHOSTTY_THEME && s.ghostty?.found && (s.ghostty.fontFamily !== null || s.ghostty.fontSize !== null))
</script>

<SectionPage section="Terminal">
  <ThemePreview theme={s.theme} themeId={s.p.theme} fontFamily={s.p.fontFamily} fontSize={s.p.fontSize} lineHeight={s.p.lineHeight} ghostty={s.ghostty} />
  {#snippet after()}
    {#if ghosttyFont}
      <p class="settings-help settings-wide" role="status">While the theme matches the Ghostty config, the font and the font size it states are used instead of the two settings above.</p>
    {/if}
  {/snippet}
</SectionPage>
