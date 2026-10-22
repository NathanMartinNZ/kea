<!--
Discard Changes…: the tree's one mutating action is always confirmed, in a sheet at the top of the main pane. It says
what will happen to the file — put back as the comparison base has it, or moved to the Trash — and the safe button is
the default. Core does only what the sheet said: every request carries what is to be done to the file, the scope the
sentence was written in and the commit it compared against (`discardRequests`), and when any of the three no longer
holds at the click the file is left alone and the refusal is shown.
-->
<script lang="ts">
  import { call } from '../../lib/rpc.ts'
  import SheetFrame from '../sessions/SheetFrame.svelte'
  import { showToast } from '../sessions/state.svelte.ts'
  import { discardRequests, refusalMessage } from './changes.ts'
  import { panel, type DiscardAsk } from './state.svelte.ts'

  let { ask }: { ask: DiscardAsk } = $props()
  let busy = $state(false)

  const cancel = (): void => {
    panel.discard = null
  }

  async function discard(): Promise<void> {
    if (busy) return
    busy = true
    try {
      for (const req of discardRequests(ask.sessionId, ask.plan)) {
        const r = await call('files.discard', req)
        if (r.ok) continue
        showToast({ message: refusalMessage(r.refused, r.detail) })
        break
      }
    } catch (e) {
      showToast({ message: `Couldn't discard the changes: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      panel.discard = null
    }
  }
</script>

<SheetFrame title="Discard changes" onCancel={cancel}>
  {#snippet buttons()}
    <button class="button" data-default="true" onclick={cancel}>Cancel</button>
    <button class="button danger" disabled={busy} onclick={() => void discard()}>{ask.plan.button}</button>
  {/snippet}
  <p>{ask.plan.text}</p>
  <p class="sheet-path">{ask.entry.path}</p>
</SheetFrame>
