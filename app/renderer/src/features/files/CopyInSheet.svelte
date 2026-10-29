<!--
A drop from another app onto the file panel, measured before anything is written: the sheet says what will be copied
where ("Copy 3 items (12 MB) into src?"), and Cancel holds the keyboard, since a folder meant to be added as a project
is easy to drop on the panel by mistake. Core then copies (never moves); a taken name gets "copy". Locatable as
`alertdialog` "Copy into the session".
-->
<script lang="ts">
  import { sizeText } from '@kea/protocol'
  import SheetFrame from '../sessions/SheetFrame.svelte'
  import { sessions } from '../sessions/state.svelte.ts'
  import { startName } from './edit.ts'
  import { copyIn } from './operations.ts'
  import { panel, type CopyInAsk } from './state.svelte.ts'

  let { ask }: { ask: CopyInAsk } = $props()
  let busy = $state(false)

  const what = $derived(ask.sources.length === 1 ? `“${startName(ask.sources[0] ?? '')}”` : `${ask.sources.length} items`)
  const into = $derived.by(() => {
    const top = (sessions.get(ask.sessionId)?.cwd ?? '').replace(/\/+$/, '')
    return ask.toDir === '' ? top.slice(top.lastIndexOf('/') + 1) || 'the session’s folder' : ask.toDir
  })
  const size = $derived(ask.entries > ask.sources.length ? `${ask.entries} files and folders, ${sizeText(ask.bytes)}` : sizeText(ask.bytes))

  const cancel = (): void => {
    panel.copyIn = null
  }

  async function confirm(): Promise<void> {
    if (busy) return
    busy = true
    try {
      await copyIn(ask.sessionId, ask.sources, ask.toDir)
    } finally {
      panel.copyIn = null
    }
  }
</script>

<SheetFrame title="Copy into the session" onCancel={cancel}>
  {#snippet buttons()}
    <button class="button" data-default="true" onclick={cancel}>Cancel</button>
    <button class="button" disabled={busy} onclick={() => void confirm()}>Copy</button>
  {/snippet}
  <p>Copy {what} ({size}) into {into}?</p>
  <p>The originals stay where they are.</p>
</SheetFrame>
