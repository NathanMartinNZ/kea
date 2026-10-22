<!-- Delete a session, saying what will be lost and what stays recoverable, in exact numbers (sheets.ts). -->
<script lang="ts">
  import { untrack } from 'svelte'
  import type { DeletePreview } from '@kea/protocol'
  import { call } from '../../lib/rpc.ts'
  import SheetFrame from './SheetFrame.svelte'
  import { closeSheet, deleteSummary, plural } from './sheets.ts'
  import { failed, sessions, showToast, ui } from './state.svelte.ts'

  let { sessionId }: { sessionId: string } = $props()
  // fixed for this mount (Sheets.svelte keys it), and still needed after the sheet closes
  const id = untrack(() => sessionId)
  const title = untrack(() => sessions.get(id)?.title ?? 'this session')
  let preview = $state.raw<DeletePreview | null>(null)
  let deleteBranch = $state(false)

  $effect(() => {
    let live = true
    call('sessions.deletePreview', { id })
      .then((p) => {
        if (!live) return
        preview = p
        deleteBranch = p.deleteBranchDefault
      })
      .catch((e: unknown) => {
        if (!live) return
        closeSheet()
        failed("Couldn't check what a delete would lose", e)
      })
    return () => {
      live = false
    }
  })

  const unmerged = $derived(!!preview && !preview.merged && preview.uniqueCommits > 0)
  const sum = $derived(preview ? deleteSummary(preview) : null)

  async function run(): Promise<void> {
    const force = deleteBranch && unmerged
    const branch = deleteBranch
    closeSheet()
    try {
      const r = await call('sessions.delete', { id, deleteBranch: branch, ...(force ? { forceBranch: true } : {}) })
      // A delete leaves no row to say its teardown failed, so a toast names the session; its log went with the
      // session's directory, so View log shows the one the delete returned
      const log = r.log
      if (r.teardownFailed) showToast({ message: `The teardown of ${title} failed.`, action: { label: 'View log', run: () => (ui.sheet = { kind: 'log', sessionId: id, title, ...(log ? { log } : {}) }) } })
    } catch (e) {
      failed("Couldn't delete the session", e)
    }
  }
</script>

<SheetFrame title="Delete session" onCancel={closeSheet}>
  {#snippet buttons()}
    <button class="button" data-default="true" onclick={closeSheet}>Cancel</button>
    <button class="button danger" disabled={!preview} onclick={() => void run()}>Delete</button>
  {/snippet}
  <p>Delete {title}?</p>
  {#if !preview || !sum}
    <p class="sheet-meta">Checking the worktree…</p>
  {:else}
    <p>{sum.lost}</p>
    {#if preview.branch && preview.isolation === 'worktree'}
      <label class="sheet-check"><input type="checkbox" checked={deleteBranch} onchange={(e) => (deleteBranch = e.currentTarget.checked)} />Delete the branch <code>{preview.branch}</code> too{deleteBranch && preview.ownCommits > 0 ? ` (${plural(preview.ownCommits, 'commit only it holds', 'commits only it holds')})` : ''}</label>
    {/if}
    {#if sum.keeps}
      <p class="sheet-meta">{sum.keeps}</p>
    {/if}
    {#if preview.oversize.length > 0}
      <p class="sheet-meta">Too large to keep, so not restorable: {preview.oversize.map((o) => o.path).join(', ')}.</p>
    {/if}
    {#if preview.nestedRepos.length > 0}
      <p class="sheet-meta">Repositories of their own inside the worktree are not kept, files and history: {preview.nestedRepos.join(', ')}.</p>
    {/if}
    {#if preview.teardown}
      <p class="sheet-meta">The project's teardown command runs first.</p>
    {/if}
  {/if}
</SheetFrame>
