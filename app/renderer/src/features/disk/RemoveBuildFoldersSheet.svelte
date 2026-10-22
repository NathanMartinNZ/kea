<!--
Remove Build Folders… run from the palette, the menu bar or a key. There, nothing on screen shows what would go, and the
removal cannot be undone (the folders are deleted, not moved to the Trash), so it asks first: the session, the folders
core would take now and their size as last measured, and any it would keep because it holds a git repository. The safe
button is the default; Esc cancels. From Settings › Disk the same removal acts at once.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import type { BuildFoldersFound } from '@kea/protocol'
  import { call } from '../../lib/rpc.ts'
  import SheetFrame from '../sessions/SheetFrame.svelte'
  import { closeSheet } from '../sessions/sheets.ts'
  import { failed, sessions, showToast, ui } from '../sessions/state.svelte.ts'
  import { removeBuildFolders } from './actions.ts'
  import { foldersText, keptText } from './model.ts'

  const sheet = $derived(ui.sheet?.kind === 'removeBuildFolders' ? ui.sheet : null)
  /** What core found for the session the sheet is about; null while it is asked. */
  let found = $state.raw<{ id: string; what: BuildFoldersFound } | null>(null)

  $effect(() => {
    const id = sheet?.sessionId
    if (!id) {
      found = null
      return
    }
    let live = true
    untrack(() => (found = null))
    call('disk.buildFolders', { id })
      .then((what) => {
        if (live) found = { id, what }
      })
      .catch((e: unknown) => {
        if (!live) return
        closeSheet()
        failed(`Couldn't remove the build folders of ${sessions.get(id)?.title ?? 'the session'}`, e)
      })
    return () => {
      live = false
    }
  })

  async function run(id: string, asked: BuildFoldersFound): Promise<void> {
    closeSheet()
    const done = (await removeBuildFolders([id])).get(id)
    // the removal looked again: a folder it kept that the question had not named is said (anything else was shown)
    if (done && done.kept.length > asked.kept.length) showToast({ message: keptText(done.kept, { names: true }) })
  }
</script>

{#if sheet}
  {@const id = sheet.sessionId}
  {@const what = found?.id === id ? found.what : null}
  <SheetFrame title="Remove build folders" onCancel={closeSheet}>
    {#snippet buttons()}
      <button class="button" data-default="true" onclick={closeSheet}>Cancel</button>
      <button class="button danger" disabled={!what || what.folders.length === 0} onclick={() => what && void run(id, what)}>Remove</button>
    {/snippet}
    <p>Remove the build folders of {sessions.get(id)?.title ?? 'this session'}?</p>
    {#if !what}
      <p class="sheet-meta">Checking the worktree…</p>
    {:else}
      <p data-build-folders>{foldersText(what)}</p>
      {#if what.kept.length > 0}
        <p class="sheet-meta" data-build-kept>{keptText(what.kept, { names: true })}</p>
      {/if}
      {#if what.folders.length > 0}
        <p class="sheet-meta">Setup re-creates them. This cannot be undone: the folders are deleted, not moved to the Trash.</p>
      {/if}
    {/if}
  </SheetFrame>
{/if}
