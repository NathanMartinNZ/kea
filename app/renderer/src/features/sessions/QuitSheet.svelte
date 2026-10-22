<!--
The first-quit sheet: shown once, on the first `⌘Q` while sessions run and "On quit" says to stay in the menu bar. One
sentence, and Keep in Menu Bar (the default, the filled accent button), Quit Completely and Stop All and Quit
(`--danger` text). Main acts on the answer and remembers that the sheet was answered; Esc answers nothing and Kea keeps
running as it was. Locatable as `alertdialog` "Quit Kea".

On Linux the first choice is Keep Running in Background, offered only while the desktop has a tray host (`background`);
without one the sheet says that the sessions keep running in their terminals but notifications stop until Kea is opened
again, and Quit Completely is the default.
-->
<script lang="ts">
  import { protocolOs } from '@kea/protocol'
  import { quitChoice } from '../../lib/bridge.ts'
  import SheetFrame from './SheetFrame.svelte'
  import { closeSheet } from './sheets.ts'

  let { live, background }: { live: number; background: boolean } = $props()

  const tray = protocolOs.window.background === 'tray'
  const keeps = $derived(live === 1 ? '1 session keeps' : `${live} sessions keep`)

  function choose(c: 'menuBar' | 'quit' | 'stopAll'): void {
    closeSheet()
    quitChoice(c)
  }
</script>

<SheetFrame title="Quit Kea" onCancel={closeSheet}>
  {#snippet buttons()}
    {#if !tray}
      <button class="primary-button" data-default="true" onclick={() => choose('menuBar')}>Keep in Menu Bar</button>
      <button class="button" onclick={() => choose('quit')}>Quit Completely</button>
    {:else if background}
      <button class="primary-button" data-default="true" onclick={() => choose('menuBar')}>Keep Running in Background</button>
      <button class="button" onclick={() => choose('quit')}>Quit Completely</button>
    {:else}
      <button class="primary-button" data-default="true" onclick={() => choose('quit')}>Quit Completely</button>
    {/if}
    <button class="button danger" onclick={() => choose('stopAll')}>Stop All and Quit</button>
  {/snippet}
  {#if !tray}
    <p>{keeps} running. Kea stays in the menu bar so you still get notified.</p>
  {:else if background}
    <p>{keeps} running. Kea keeps running in the background, with its icon in the tray, so you still get notified.</p>
  {:else}
    <p>{keeps} running in {live === 1 ? 'its terminal' : 'their terminals'}. This desktop has no tray to keep Kea in, so notifications stop until you open Kea again.</p>
  {/if}
</SheetFrame>
