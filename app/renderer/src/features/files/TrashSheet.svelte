<!--
Move to Trash: always asked first, in a sheet at the top of the main pane, as Discard Changes… is. It names the exact
path and says whether a folder goes with everything in it; Cancel is the default. Core moves the entry with the
system's trash tool, never deletes it, and refuses when the path is now the other kind (a file where the sheet named a
folder). Locatable as `alertdialog` "Move to Trash".
-->
<script lang="ts">
  import SheetFrame from '../sessions/SheetFrame.svelte'
  import { startName } from './edit.ts'
  import { trash } from './operations.ts'
  import { panel, type TrashAsk } from './state.svelte.ts'

  let { ask }: { ask: TrashAsk } = $props()
  let busy = $state(false)
  const name = $derived(startName(ask.path))

  const cancel = (): void => {
    panel.trash = null
  }

  async function confirm(): Promise<void> {
    if (busy) return
    busy = true
    try {
      await trash(ask.sessionId, ask.path, ask.dir, ask.fromList)
    } finally {
      panel.trash = null
    }
  }
</script>

<SheetFrame title="Move to Trash" onCancel={cancel}>
  {#snippet buttons()}
    <button class="button" data-default="true" onclick={cancel}>Cancel</button>
    <button class="button danger" disabled={busy} onclick={() => void confirm()}>Move to Trash</button>
  {/snippet}
  <p>{ask.dir ? `Move the folder “${name}” and everything in it to the Trash?` : `Move “${name}” to the Trash?`}</p>
  <p class="sheet-path">{ask.path}</p>
</SheetFrame>
