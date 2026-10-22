<!--
The banner strip: app-level conditions that need the person, at the top of the main column. The settings file's error
comes from `settings.status` (the parse error with its line and column, or the values that fell back to their
defaults); everything else from core's `banners` store (`BANNER_KINDS`: git missing, holders not detached, the helper
missing, the disk full, and on Linux holders running without a systemd scope, inotify's limits and too few port blocks;
bannerStore.ts). Each goes when its source clears it; there is no close button.
Locatable as `region` "Banners", each banner a `status` with its message.
-->
<script lang="ts">
  import { openSettingsFile } from '../lib/bridge.ts'
  import { External } from '../lib/reactive.svelte.ts'
  import { settings } from '../features/settings/store.ts'
  import { banners } from './bannerStore.ts'
  import { bannerLines } from './banners.ts'

  const status = new External(settings.subscribe, () => settings.status)
  const version = new External(banners.subscribeList, () => banners.listVersion)
  const lines = $derived.by(() => {
    void version.current
    return bannerLines(status.current, banners.values())
  })
</script>

{#if lines.length > 0}
  <div class="banners" role="region" aria-label="Banners">
    {#each lines as b (b.key)}
      <div class="banner" role="status" data-banner={b.key}>
        <span class="banner-dot {b.severity}" aria-label={b.severity === 'error' ? 'Error' : 'Warning'} role="img"></span>
        <span class="banner-text">{b.message}</span>
        {#if b.fix}
          <span class="banner-fix">{b.fix}</span>
        {/if}
        {#if b.opensSettings}
          <button class="button" onclick={openSettingsFile}>Open settings.json</button>
        {/if}
      </div>
    {/each}
  </div>
{/if}
