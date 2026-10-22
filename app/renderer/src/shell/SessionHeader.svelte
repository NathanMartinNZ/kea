<!--
The main header on a session: left, the session title (double-click renames), the branch chip (mono, ⎇; a click copies
it and says "Copied" for L.branchCopiedMs) and the config summary in `--text-3`, whose click opens the session popover
(the launch config and "Why this status?"); right, the overflow `⋯` with the commands marked `header ⋯`, after the
header's three slots in this order: the diff stat (`features/files/DiffStat.svelte`), the dev-server control
(`features/server/ServerControl.svelte`) and the open-in-editor split button (`features/editor/EditorButton.svelte`);
each is its feature's own component and renders nothing when it has nothing to show. Mounted per session
(MainHeader.svelte keys it), following that session's row.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { L } from '@kea/protocol'
  import { MoreIcon } from '@kea/ui'
  import { External } from '../lib/reactive.svelte.ts'
  import EditorButton from '../features/editor/EditorButton.svelte'
  import DiffStat from '../features/files/DiffStat.svelte'
  import { canRunIn } from '../features/server/model.ts'
  import ServerControl from '../features/server/ServerControl.svelte'
  import { copyText } from '../features/sessions/actions.ts'
  import { menuItems } from '../features/sessions/sheets.ts'
  import { sessions, ui } from '../features/sessions/state.svelte.ts'
  import { closePopover, openPopover, statusUi } from '../features/status/ui.svelte.ts'
  import RenameField from './RenameField.svelte'

  let { id: idProp }: { id: string } = $props()
  const id = untrack(() => idProp)
  const row = new External(
    (cb) => sessions.subscribeRow(id, cb),
    () => sessions.get(id),
  )
  const s = $derived(row.current)
  const renaming = $derived(ui.renaming === id)
  let copied = $state(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  $effect(() => () => {
    if (timer) clearTimeout(timer)
  })
  const summary = $derived(s ? [s.agent, s.model ?? s.launch.model, s.effort ?? s.launch.effort].filter(Boolean).join(' · ') : '')

  function copyBranch(branch: string): void {
    void copyText(branch).then((ok) => {
      if (!ok) return
      copied = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => (copied = false), L.branchCopiedMs)
    })
  }

  function openActions(e: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    if (menuItems('header ⋯', { id }).length === 0) return
    const r = e.currentTarget.getBoundingClientRect()
    ui.menu = { kind: 'header', id, at: { x: r.right, y: r.bottom } }
  }

  const keepFocus = (e: MouseEvent) => e.preventDefault()
</script>

{#if s}
  <div class="header-left">
    {#if renaming}
      <RenameField {s} />
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions (double-click is a shortcut; the header menu's Rename is the keyboard path) -->
      <h1 class="session-title" data-tip="Double-click to rename" ondblclick={() => (ui.renaming = id)}>{s.title}</h1>
    {/if}
    {#if s.branch}
      {@const branch = s.branch}
      <button class="branch-chip" aria-label={`Branch ${branch}: copy`} data-command="session.copyBranch" data-tip="Copy branch name" onmousedown={keepFocus} onclick={() => copyBranch(branch)}><span aria-hidden="true">⎇</span> {branch}</button>
    {/if}
    {#if copied}
      <span class="header-note" role="status">Copied</span>
    {/if}
    {#if summary}
      <button
        class="config-summary"
        data-config-summary
        aria-haspopup="dialog"
        aria-expanded={statusUi.popover?.sessionId === id}
        data-command="session.showLaunchConfig"
        data-tip="Launch config and why this status"
        onmousedown={keepFocus}
        onclick={() => (statusUi.popover?.sessionId === id ? closePopover() : openPopover(id))}>{summary}</button
      >
    {/if}
  </div>
  <div class="header-right">
    <DiffStat sessionId={id} />
    <ServerControl sessionId={id} canRun={canRunIn(s)} />
    <EditorButton sessionId={id} />
    <button class="quiet-button icon" aria-label="Session actions" aria-haspopup="menu" data-tip="More" onmousedown={keepFocus} onclick={openActions}><MoreIcon /></button>
  </div>
{/if}
