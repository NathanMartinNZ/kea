<!--
The first-quit sheet: shown once, on the first `⌘Q` while terminals run and "On quit" says to stay in the menu bar. One
sentence, and Keep in Menu Bar (the default, the filled accent button) and Stop All and Quit (`--danger` text). Main
acts on the answer and remembers that the sheet was answered; Esc answers nothing and Kea keeps running as it was.
Locatable as `alertdialog` "Quit Kea".

On Linux the first choice is Stay in Tray, offered only while the desktop has a tray host (`background`);
without one the sheet says that quitting stops the terminals, and Stop All and Quit is the only answer.
-->
<script lang="ts">
  import { protocolOs } from '@kea/protocol'
  import { quitChoice } from '../../lib/bridge.ts'
  import SheetFrame from './SheetFrame.svelte'
  import { closeSheet } from './sheets.ts'

  /** `live`: how many terminals run (agents, servers, scripts, shells). */
  let { live, background }: { live: number; background: boolean } = $props()

  const tray = protocolOs.window.background === 'tray'
  const running = $derived(live === 1 ? '1 terminal is' : `${live} terminals are`)

  function choose(c: 'menuBar' | 'stopAll'): void {
    closeSheet()
    quitChoice(c)
  }
</script>

<SheetFrame title="Quit Kea" onCancel={closeSheet}>
  {#snippet buttons()}
    {#if !tray}
      <button class="primary-button" data-default="true" onclick={() => choose('menuBar')}>Keep in Menu Bar</button>
      <button class="button danger" onclick={() => choose('stopAll')}>Stop All and Quit</button>
    {:else if background}
      <button class="primary-button" data-default="true" onclick={() => choose('menuBar')}>Stay in Tray</button>
      <button class="button danger" onclick={() => choose('stopAll')}>Stop All and Quit</button>
    {:else}
      <button class="primary-button" data-default="true" onclick={() => choose('stopAll')}>Stop All and Quit</button>
    {/if}
  {/snippet}
  {#if !tray}
    <p>{running} running. Kea stays in the menu bar so you still get notified, or stops them all and quits.</p>
  {:else if background}
    <p>{running} running. Kea stays in the tray, with its terminals running, so you still get notified, or stops them all and quits.</p>
  {:else}
    <p>{running} running. This desktop has no tray to keep Kea in, so quitting stops every terminal, including servers.</p>
  {/if}
</SheetFrame>
