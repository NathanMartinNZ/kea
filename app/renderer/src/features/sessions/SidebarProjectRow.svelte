<!--
A project row of the sidebar: a click folds it, `+` on hover or focus starts a session in it, drag to reorder; a missing
project is dimmed with Locate… and Remove. A collapsed project shows how many of its sessions need you. It follows its
own store row and its sessions' group.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { Icon } from '@kea/ui'
  import { External } from '../../lib/reactive.svelte.ts'
  import { askRemoveProject, locateProject, moveProjectPast, toggleProject } from './actions.ts'
  import type { SidebarRow } from './model.ts'
  import { DRAG_PROJECT } from './sidebar.ts'
  import { openComposer, projects, sessions, ui } from './state.svelte.ts'

  let { row, tabbable }: { row: Extract<SidebarRow, { kind: 'project' }>; tabbable: boolean } = $props()
  // a row's key names its project (Sidebar.svelte keys rows by it)
  const id = untrack(() => row.projectId)
  const project = new External(
    (cb) => projects.subscribeRow(id, cb),
    () => projects.get(id),
  )
  /** Sessions needing you in the project (a collapsed project shows the count). */
  const needing = new External(
    (cb) => sessions.subscribeGroup(id, cb),
    () => sessions.inGroup(id).filter((s) => s.glyph === 'needsYou' && s.lifecycle !== 'deleted').length,
  )
  const p = $derived(project.current)
  const needsYou = $derived(needing.current)
  let over = $state(false)

  function onDrop(e: DragEvent): void {
    over = false
    const dragged = e.dataTransfer?.getData(DRAG_PROJECT)
    if (!dragged || dragged === id) return
    e.preventDefault()
    moveProjectPast(dragged, id)
  }

  const keepFocus = (e: MouseEvent) => e.preventDefault()
</script>

{#if p}
  <!-- svelte-ignore a11y_role_has_required_aria_props, a11y_click_events_have_key_events, a11y_role_supports_aria_props
    (a project row is not selectable, so it has no aria-selected; the tree's keydown handles its keys; Chromium exposes
    aria-description on any role) -->
  <div
    role="treeitem"
    aria-level={1}
    aria-expanded={!row.collapsed}
    aria-label={p.name}
    aria-description={p.missing ? 'Missing: locate it or remove it' : undefined}
    data-key={row.key}
    data-project-id={p.id}
    tabindex={tabbable ? 0 : -1}
    class="sb-row sb-project{p.missing ? ' missing' : ''}{over ? ' drop' : ''}"
    draggable="true"
    ondragstart={(e) => {
      e.dataTransfer?.setData(DRAG_PROJECT, id)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    }}
    ondragover={(e) => {
      if (!e.dataTransfer?.types.includes(DRAG_PROJECT)) return
      e.preventDefault()
      over = true
    }}
    ondragleave={() => (over = false)}
    ondrop={onDrop}
    onclick={() => toggleProject(id)}
    oncontextmenu={(e) => {
      e.preventDefault()
      ui.menu = { kind: 'project', id, at: { x: e.clientX, y: e.clientY } }
    }}
  >
    {#if row.collapsed}
      <Icon name="caretRight" class="sb-caret" />
    {/if}
    <span class="sb-name">{p.name}</span>
    {#if row.collapsed && needsYou > 0}
      <span class="sb-count" aria-label={`${needsYou} need you`}>{needsYou}</span>
    {/if}
    {#if p.missing}
      <span class="sb-actions always">
        <button
          class="sb-text-button"
          tabindex="-1"
          onmousedown={keepFocus}
          onclick={(e) => {
            e.stopPropagation()
            void locateProject(id)
          }}>Locate…</button
        >
        <button
          class="sb-text-button"
          tabindex="-1"
          onmousedown={keepFocus}
          onclick={(e) => {
            e.stopPropagation()
            askRemoveProject(id)
          }}>Remove</button
        >
      </span>
    {:else}
      <span class="sb-actions">
        <button
          class="sb-icon-button"
          tabindex="-1"
          aria-label={`New Session in ${p.name}`}
          data-command="session.new"
          onmousedown={keepFocus}
          onclick={(e) => {
            e.stopPropagation()
            openComposer(id)
          }}><Icon name="plus" /></button
        >
      </span>
    {/if}
  </div>
{/if}
