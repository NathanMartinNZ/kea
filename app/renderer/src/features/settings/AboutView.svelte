<!--
Settings › About: Kea's version, the commit and the day it was built, then the platform report: the
system, then each line in `PLATFORM_LINES`' order. A line that is not the full answer leads with the banner strip's
warning dot and has its one-sentence fix under it in `--text-3`. Drawn from data only; AboutPage.svelte reads the report
when the page opens. `report`: undefined while it is read, null when core has none (main has not sent it yet) or could
not be asked (`error`).
-->
<script lang="ts">
  import type { PlatformReport } from '@kea/protocol'
  import { textParts, type BuildFacts } from './about.ts'

  let p: { build: BuildFacts; report: PlatformReport | null | undefined; error?: string | null } = $props()
</script>

<div class="settings-form settings-fill" role="group" aria-label="About Kea">
  <div class="settings-row">
    <span class="settings-label">Version</span>
    <code class="settings-value" data-version>Kea {p.build.version}</code>
  </div>
  <div class="settings-row">
    <span class="settings-label">Commit</span>
    <code class="settings-value" data-commit>{p.build.commit ?? 'not known: built outside a git checkout'}</code>
  </div>
  <div class="settings-row">
    <span class="settings-label">Built</span>
    <code class="settings-value" data-build-date>{p.build.date ?? 'not known'}</code>
  </div>

  <h3 class="settings-heading" id="platform-heading">This system</h3>
  {#if p.report === undefined}
    <span class="settings-help" data-platform="reading">Reading…</span>
  {:else if p.error}
    <span class="settings-help" role="status" data-platform="failed">Couldn’t read the platform report: {p.error}</span>
  {:else if p.report === null}
    <span class="settings-help" data-platform="none">Not known yet: Kea is still starting. Open About again in a moment.</span>
  {:else}
    <div class="about-lines" role="list" aria-labelledby="platform-heading" data-platform={p.report.system}>
      <div class="settings-row about-line" role="listitem" data-platform-line="system">
        <span class="settings-label">System</span>
        <span class="about-value">{p.report.version} · {p.report.arch}</span>
      </div>
      {#each p.report.lines as l (l.id)}
        <div class="settings-row about-line" role="listitem" data-platform-line={l.id} data-fix={l.fix === null ? 'none' : 'shown'}>
          <span class="settings-label">{l.label}</span>
          <span class="about-value">
            {#if l.fix !== null}<span class="about-dot" aria-hidden="true"></span>{/if}
            <span class="about-text">{l.value}</span>
          </span>
          {#if l.fix !== null}
            <span class="settings-help about-fix" data-platform-fix
              >{#each textParts(l.fix) as part, i (i)}{#if part.code}<code>{part.text}</code>{:else}{part.text}{/if}{/each}</span
            >
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
