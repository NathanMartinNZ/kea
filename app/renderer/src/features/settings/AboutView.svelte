<!--
Settings › About: Kea's version, the commit and the day it was built, then Updates (what the last check found, its
one action, "Release notes" where a version is named, when Kea last checked, why the macOS updater is not used, and
the switch for checking by itself where Kea checks by itself), then the platform report: the
system, then each line in `PLATFORM_LINES`' order. A line that is not the full answer leads with the banner strip's
warning dot and has its one-sentence fix under it in `--text-3`. Drawn from data only; AboutPage.svelte reads the report
when the page opens. `report`: undefined while it is read, null when core has none (main has not sent it yet) or could
not be asked (`error`).
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { PlatformReport } from '@kea/protocol'
  import { textParts, type BuildFacts } from './about.ts'
  import type { AboutUpdate, UpdateAction } from './updates.ts'

  let p: {
    build: BuildFacts
    report: PlatformReport | null | undefined
    error?: string | null
    /** The Updates block; left out, the page has none. */
    updates?: { about: AboutUpdate; last: string | null; why: string | null; notesUrl: string | null } | null
    onUpdateAction?(a: UpdateAction): void
    onNotes?(url: string): void
    /** The switch for checking by itself, where Kea checks by itself. */
    autoRow?: Snippet
  } = $props()

  const ACTION_LABELS: Record<Exclude<UpdateAction, null>, string> = { check: 'Check Now', retry: 'Try Again', restartUpdate: 'Restart to Update', restartKea: 'Restart Kea', copy: 'Copy Command' }
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

  {#if p.updates}
    {@const u = p.updates}
    <h3 class="settings-heading" id="updates-heading">Updates</h3>
    <div class="settings-row column about-updates" role="group" aria-labelledby="updates-heading" data-updates={u.about.action ?? 'none'}>
      <span class="about-value" role="status" data-update-text
        ><span class="about-text">{#each textParts(u.about.line) as part, i (i)}{#if part.code}<code>{part.text}</code>{:else}{part.text}{/if}{/each}</span></span
      >
      {#if u.why}<span class="settings-help" data-update-why>{u.why}</span>{/if}
      <div class="settings-actions">
        {#if u.about.action}
          {@const action = u.about.action}
          <button class="button" data-update-action={action} onclick={() => p.onUpdateAction?.(action)}>{ACTION_LABELS[action]}</button>
        {/if}
        {#if u.notesUrl}
          {@const url = u.notesUrl}
          <button class="quiet-button" data-update-notes onclick={() => p.onNotes?.(url)}>Release notes</button>
        {/if}
      </div>
      {#if u.last}<span class="settings-help" data-update-last>{u.last}</span>{/if}
    </div>
    {@render p.autoRow?.()}
  {/if}

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
