<!-- The project's sessions deleted recently, each with Restore. -->
<script lang="ts">
  import { call } from '../../lib/rpc.ts'
  import SheetFrame from './SheetFrame.svelte'
  import { closeSheet, deletedAgo, plural } from './sheets.ts'
  import { failed, projects, selectSession } from './state.svelte.ts'

  type Deleted = { id: string; title: string; branch: string | null; isolation: 'worktree' | 'inplace'; deletedAt: number; snapshotFiles: number }

  let { projectId }: { projectId: string } = $props()
  let list = $state.raw<Deleted[] | null>(null)
  const now = Date.now()

  $effect(() => {
    const id = projectId
    let live = true
    call('sessions.listDeleted', { projectId: id })
      .then((r) => {
        if (live) list = r.sessions
      })
      .catch((e: unknown) => {
        if (!live) return
        closeSheet()
        failed("Couldn't list the deleted sessions", e)
      })
    return () => {
      live = false
    }
  })

  async function restore(id: string): Promise<void> {
    closeSheet()
    try {
      await call('sessions.restore', { id })
      // the restored row may reach the window after this reply
      selectSession(id, { arriving: true })
    } catch (e) {
      failed("Couldn't restore the session", e)
    }
  }
</script>

<SheetFrame title="Restore deleted session" wide onCancel={closeSheet}>
  {#snippet buttons()}
    <button class="button" data-default="true" onclick={closeSheet}>Close</button>
  {/snippet}
  {#if list === null}
    <p class="sheet-meta">Loading…</p>
  {:else if list.length === 0}
    <p class="sheet-meta">No session of {projects.get(projectId)?.name ?? 'this project'} was deleted recently.</p>
  {:else}
    <ul class="sheet-rows" aria-label="Deleted sessions">
      {#each list as d (d.id)}
        <li class="sheet-row">
          <span class="sheet-row-title">{d.title}</span>
          {#if d.branch}
            <code class="sheet-row-meta">{d.branch}</code>
          {/if}
          <span class="sheet-row-meta">{deletedAgo(d.deletedAt, now)}</span>
          <span class="sheet-row-meta">{d.isolation === 'inplace' ? 'record only' : d.snapshotFiles ? plural(d.snapshotFiles, 'changed file', 'changed files') : 'branch tip'}</span>
          <button class="button" onclick={() => void restore(d.id)}>Restore</button>
        </li>
      {/each}
    </ul>
  {/if}
</SheetFrame>
