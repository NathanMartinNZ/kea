<!--
The sheets attached to the top of the main pane: the confirmations to remove a project, archive a session and delete
one; restoring a deleted session, a session's log, and the first-quit sheet. The safe button is the default and has
focus; the destructive one is `--danger` text, not filled; Esc cancels. Settings, with a project's settings as its
Projects page, is its own sheet (features/settings/Settings.svelte).
-->
<script lang="ts">
  import { archiveSession } from './actions.ts'
  import DeleteSheet from './DeleteSheet.svelte'
  import LogSheet from './LogSheet.svelte'
  import QuitSheet from './QuitSheet.svelte'
  import RemoveProjectSheet from './RemoveProjectSheet.svelte'
  import RestoreSheet from './RestoreSheet.svelte'
  import SheetFrame from './SheetFrame.svelte'
  import { archiveReason, closeSheet } from './sheets.ts'
  import { sessions, ui } from './state.svelte.ts'
</script>

{#if ui.sheet?.kind === 'removeProject'}
  {#key ui.sheet}
    <RemoveProjectSheet projectId={ui.sheet.projectId} removal={ui.sheet.removal} />
  {/key}
{:else if ui.sheet?.kind === 'archive'}
  {@const sheet = ui.sheet}
  {@const title = sessions.get(sheet.sessionId)?.title ?? 'this session'}
  {@const sessionId = sheet.sessionId}
  <SheetFrame title="Archive session" onCancel={closeSheet}>
    {#snippet buttons()}
      <button class="button" data-default="true" onclick={closeSheet}>Cancel</button>
      <button class="button danger" onclick={() => void archiveSession(sessionId, true)}>Archive</button>
    {/snippet}
    <p>Archive {title}? Everything running in it stops; the worktree and branch are kept.</p>
    <ul class="sheet-list">
      {#each sheet.reasons as r, i (i)}
        <li>{archiveReason(r)}</li>
      {/each}
    </ul>
  </SheetFrame>
{:else if ui.sheet?.kind === 'delete'}
  {#key ui.sheet.sessionId}
    <DeleteSheet sessionId={ui.sheet.sessionId} />
  {/key}
{:else if ui.sheet?.kind === 'restoreDeleted'}
  <RestoreSheet projectId={ui.sheet.projectId} />
{:else if ui.sheet?.kind === 'quit'}
  <QuitSheet live={ui.sheet.live} background={ui.sheet.background} />
{:else if ui.sheet?.kind === 'log'}
  {#key ui.sheet.sessionId}
    <LogSheet sessionId={ui.sheet.sessionId} title={ui.sheet.title} given={ui.sheet.log} />
  {/key}
{/if}
