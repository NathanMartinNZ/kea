<!--
A session row of the sidebar: status glyph, title and one trailing meta, by priority (a label, "teardown failed",
"missing", the dev server dot, else the time since its last activity); hover shows Archive in the meta's place, or Retry
teardown and View log after a failed teardown; a failed creation shows Retry and Discard. A compact sidebar draws the
glyph and title only, and the tooltip says the rest (the session pane has the same buttons). Drag to reorder within its
project. It follows its own store row.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { Icon, StatusGlyph } from '@kea/ui'
  import { External } from '../../lib/reactive.svelte.ts'
  import { commands } from '../commands/registry.ts'
  import { terminals } from '../terminal/views.ts'
  import { moveSessionPast, sessionCall } from './actions.ts'
  import { clockTime, subscribeClock } from './clock.ts'
  import { sidebarCompact } from '../../shell/layoutStore.svelte.ts'
  import { relativeTime, rowLabel, rowTitle, type SidebarRow } from './model.ts'
  import { DRAG_SESSION, statusLabel } from './sidebar.ts'
  import { activeSessionId, selectSession, sessions, ui } from './state.svelte.ts'

  let { row, tabbable }: { row: Extract<SidebarRow, { kind: 'session' }>; tabbable: boolean } = $props()
  // a row's key names its session (Sidebar.svelte keys rows by it)
  const id = untrack(() => row.sessionId)
  const session = new External(
    (cb) => sessions.subscribeRow(id, cb),
    () => sessions.get(id),
  )
  const clock = new External(subscribeClock, clockTime)
  const s = $derived(session.current)
  const selected = $derived(ui.pane.kind === 'session' && ui.pane.id === id)
  let over = $state(false)

  // every mounted session row follows the clock: one listener each (clock.ts)
  $effect(() => {
    void clock.current
  })

  function onDrop(e: DragEvent): void {
    over = false
    const dragged = e.dataTransfer?.getData(DRAG_SESSION)
    const from = dragged ? sessions.get(dragged) : undefined
    const here = sessions.get(id)
    if (!from || !here || from.id === id || from.projectId !== here.projectId) return
    e.preventDefault()
    moveSessionPast(from.id, id)
  }

  function onClick(e: MouseEvent): void {
    const same = activeSessionId() === id
    selectSession(id)
    if (e.detail === 0) return
    // a click hands the keyboard to the session's terminal (the one shown, or the one about to show); a click on a
    // project row keeps focus in the tree. Rows are draggable, so their mousedown is not cancelled.
    if (same) terminals.shown()?.focus()
    else (document.activeElement as HTMLElement | null)?.blur()
  }

  const keepFocus = (e: MouseEvent) => e.preventDefault()
</script>

{#if s}
  {@const loud = selected || s.glyph === 'needsYou'}
  {@const label = statusLabel(s)}
  {@const trailing = rowLabel(s)}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_role_supports_aria_props (the tree's keydown handles its
    keys; Chromium exposes aria-description on any role) -->
  <div
    role="treeitem"
    aria-level={2}
    aria-selected={selected}
    aria-label={s.title}
    aria-description={label}
    data-key={row.key}
    data-session-id={s.id}
    data-status={s.glyph}
    data-lifecycle={s.lifecycle}
    tabindex={tabbable ? 0 : -1}
    data-tip={rowTitle(s, sidebarCompact() ? clock.current : undefined)}
    class="sb-row sb-session{selected ? ' selected' : ''}{loud ? ' loud' : ''}{over ? ' drop' : ''}"
    draggable={!row.archived}
    ondragstart={(e) => {
      e.dataTransfer?.setData(DRAG_SESSION, id)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    }}
    ondragover={(e) => {
      if (!e.dataTransfer?.types.includes(DRAG_SESSION) || row.archived) return
      e.preventDefault()
      over = true
    }}
    ondragleave={() => (over = false)}
    ondrop={onDrop}
    onclick={onClick}
    oncontextmenu={(e) => {
      e.preventDefault()
      ui.menu = { kind: 'session', id, at: { x: e.clientX, y: e.clientY } }
    }}
  >
    <!-- the session's colour, in the main list only: an archived row keeps the glyph's own -->
    <StatusGlyph kind={s.glyph} {label} tone={row.archived ? undefined : s.color} />
    <span class="sb-title">{s.title}</span>
    {#if s.lifecycle === 'create_failed'}
      <span class="sb-actions always">
        <button
          class="sb-text-button"
          tabindex="-1"
          onmousedown={keepFocus}
          onclick={(e) => {
            e.stopPropagation()
            void sessionCall('sessions.retry', id, 'retry the creation')
          }}>Retry</button
        >
        <button
          class="sb-text-button"
          tabindex="-1"
          onmousedown={keepFocus}
          onclick={(e) => {
            e.stopPropagation()
            void sessionCall('sessions.discard', id, 'discard the session')
          }}>Discard</button
        >
      </span>
    {:else}
      {@const canArchive = s.lifecycle === 'live' || s.lifecycle === 'detached'}
      <span class={s.teardownFailed ? 'sb-meta-slot swap-on-hover' : canArchive ? 'sb-meta-slot hide-on-hover' : 'sb-meta-slot'}>
        {#if trailing}
          <span class="sb-meta sb-label">{trailing}</span>
        {:else if s.teardownFailed}
          <span class="sb-meta">teardown failed</span>
        {:else if s.worktreeMissing}
          <span class="sb-meta">missing</span>
        {:else if s.serverRunning}
          <span class="sb-meta sb-dot" aria-label="Dev server running" role="img"></span>
        {:else}
          <span class="sb-meta sb-time">{relativeTime(s.lastActivityAt, clock.current)}</span>
        {/if}
      </span>
      {#if s.teardownFailed}
        <!-- An archived session whose teardown failed (the session pane's strip has the same, focusable) -->
        <span class="sb-actions">
          <button
            class="sb-text-button"
            tabindex="-1"
            onmousedown={keepFocus}
            onclick={(e) => {
              e.stopPropagation()
              void sessionCall('sessions.retryTeardown', id, 'run the teardown again')
            }}>Retry teardown</button
          >
          <button
            class="sb-text-button"
            tabindex="-1"
            onmousedown={keepFocus}
            onclick={(e) => {
              e.stopPropagation()
              ui.sheet = { kind: 'log', sessionId: id, title: s.title }
            }}>View log</button
          >
        </span>
      {:else if canArchive}
        <span class="sb-actions over">
          <button
            class="sb-icon-button"
            tabindex="-1"
            aria-label={`Archive ${s.title}`}
            data-command="session.archive"
            data-tip="Archive"
            onmousedown={keepFocus}
            onclick={(e) => {
              e.stopPropagation()
              commands.run('session.archive', { id })
            }}><Icon name="archive" /></button
          >
        </span>
      {/if}
    {/if}
  </div>
{/if}
