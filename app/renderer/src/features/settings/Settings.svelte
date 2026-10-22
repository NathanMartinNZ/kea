<!--
Settings (`⌘,`): a sheet over the main pane with the section list on the left (in pages.ts' order) and
the selected page on the right. Changes apply as they are made, so there is no Save button; "Open
settings.json" is at the bottom. Locatable as `role=dialog` named `Settings: <page>`; opened on a project
(`project.settings`) it is `Settings: Project settings · <name>`. The list is a vertical `tablist`: ↑ ↓ Home End move
between pages, Tab goes into the page; Esc closes and focus goes back where it was (SheetFrame).
-->
<script lang="ts">
  import { tick } from 'svelte'
  import './settings.css'
  import { openSettingsFile } from '../../lib/bridge.ts'
  import { External } from '../../lib/reactive.svelte.ts'
  import SheetFrame from '../sessions/SheetFrame.svelte'
  import { projects, ui } from '../sessions/state.svelte.ts'
  import { pageOf, SETTINGS_PAGES } from './pages.ts'
  import { closeSettings, FIRST_PAGE, showPage } from './state.svelte.ts'

  const sheet = $derived(ui.sheet?.kind === 'settings' ? ui.sheet : null)
  const page = $derived(pageOf(sheet?.page ?? FIRST_PAGE))
  const projectId = $derived(sheet?.projectId ?? null)
  const names = new External(projects.subscribeAny, () => (id: string | null) => (id === null ? undefined : projects.get(id)?.name))
  const projectName = $derived(page.id === 'projects' ? names.current(projectId) : undefined)
  const label = $derived(`Settings: ${projectName === undefined ? page.title : `Project settings · ${projectName}`}`)
  let nav: HTMLDivElement | undefined = $state()

  /** ↑ ↓ Home End in the list: the page follows the focus (a vertical tablist). */
  function navKey(e: KeyboardEvent): void {
    const i = SETTINGS_PAGES.findIndex((x) => x.id === page.id)
    const last = SETTINGS_PAGES.length - 1
    const to = e.key === 'ArrowDown' ? Math.min(i + 1, last) : e.key === 'ArrowUp' ? Math.max(i - 1, 0) : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1
    if (to < 0 || e.metaKey || e.ctrlKey || e.altKey) return
    e.preventDefault()
    const next = SETTINGS_PAGES[to]!
    if (next.id !== page.id) showPage(next.id)
    void tick().then(() => nav?.querySelector<HTMLElement>(`[data-page="${next.id}"]`)?.focus())
  }
</script>

{#if sheet}
  <SheetFrame title="Settings" {label} role="dialog" class="settings-sheet" onCancel={closeSettings}>
    {#snippet buttons()}
      <button class="link-button settings-file" onclick={openSettingsFile}>Open settings.json</button>
      <button class="button" onclick={closeSettings}>Done</button>
    {/snippet}
    <div class="settings-panes">
      <!-- svelte-ignore a11y_interactive_supports_focus (the selected tab is the list's one tab stop) -->
      <div bind:this={nav} class="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections" onkeydown={navKey}>
        {#each SETTINGS_PAGES as pg (pg.id)}
          {@const on = pg.id === page.id}
          <button
            class="settings-tab{on ? ' on' : ''}"
            role="tab"
            id="settings-tab-{pg.id}"
            data-page={pg.id}
            data-default={on ? 'true' : undefined}
            aria-selected={on}
            aria-controls="settings-panel"
            tabindex={on ? 0 : -1}
            onclick={() => showPage(pg.id)}>{pg.title}</button
          >
        {/each}
      </div>
      <div class="settings-panel" role="tabpanel" id="settings-panel" aria-labelledby="settings-tab-{page.id}" data-page={page.id}>
        {#key page.id}
          <page.component {...page.props} {projectId} />
        {/key}
      </div>
    </div>
  </SheetFrame>
{/if}
