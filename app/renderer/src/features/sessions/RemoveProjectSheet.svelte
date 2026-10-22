<!--
Remove a project. Core says what removing it would do (`projects.removePreview`): sessions that keep it (a worktree on
disk, a creation in progress or failed) are named, and nothing can remove it until the user deletes, discards or cleans
them; running sessions without a worktree stop only on "Stop and Remove"; deleted sessions stop being restorable. The
folder is never touched.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import type { ProjectRemoval } from '@kea/protocol'
  import { call } from '../../lib/rpc.ts'
  import { removeProject } from './actions.ts'
  import SheetFrame from './SheetFrame.svelte'
  import { closeSheet, plural, REMOVE_BLOCKER } from './sheets.ts'
  import { failed, projects } from './state.svelte.ts'

  let { projectId, removal }: { projectId: string; removal: ProjectRemoval | null } = $props()
  const id = untrack(() => projectId)
  const name = $derived(projects.get(id)?.name ?? 'this project')
  // core's answer to a remove that was refused replaces the preview (sessions may have changed meanwhile)
  let fetched = $state.raw<ProjectRemoval | null>(null)
  const preview = $derived(removal ?? fetched)

  $effect(() => {
    if (untrack(() => removal)) return
    let live = true
    call('projects.removePreview', { id })
      .then((p) => {
        if (live) fetched = p
      })
      .catch((e: unknown) => {
        if (!live) return
        closeSheet()
        failed("Couldn't check the project's sessions", e)
      })
    return () => {
      live = false
    }
  })

  const blocked = $derived(!!preview && preview.blocking.length > 0)
  const stop = $derived(!!preview && preview.running.length > 0)
</script>

<SheetFrame title="Remove project" onCancel={closeSheet}>
  {#snippet buttons()}
    <!-- one default button throughout, so the focus the sheet gave it stays when the preview arrives (Esc keeps working) -->
    <button class="button" data-default="true" onclick={closeSheet}>{blocked ? 'OK' : 'Cancel'}</button>
    {#if !blocked}
      <button class="button danger" disabled={!preview} onclick={() => void removeProject(id, stop)}>{stop ? 'Stop and Remove' : 'Remove'}</button>
    {/if}
  {/snippet}
  {#if !preview}
    <p class="sheet-meta">Checking the project's sessions…</p>
  {:else if blocked}
    <p>{name} can't be removed while {preview.blocking.length === 1 ? 'this session keeps' : 'these sessions keep'} work in it:</p>
    <ul class="sheet-list" aria-label="Sessions that keep the project">
      {#each preview.blocking as b (b.sessionId)}
        <li>{b.title}: {REMOVE_BLOCKER[b.reason]}</li>
      {/each}
    </ul>
    <p class="sheet-meta">Delete them first (Delete… says what each would lose), or Discard a failed creation. An archived session keeps its worktree until auto-clean removes it.</p>
  {:else}
    <p>Remove {name} from Kea? The folder is not touched.</p>
    {#if stop}
      <p>{plural(preview.running.length, 'session is', 'sessions are')} running and will stop:</p>
      <ul class="sheet-list" aria-label="Running sessions">
        {#each preview.running as r (r.sessionId)}
          <li>{r.title}</li>
        {/each}
      </ul>
    {/if}
    {#if preview.restorable > 0}
      <p class="sheet-meta">{plural(preview.restorable, 'deleted session', 'deleted sessions')} can no longer be restored.</p>
    {/if}
  {/if}
</SheetFrame>
