<!--
The Keyboard Shortcuts sheet (`app.shortcuts`): the keyboard list in a sheet at the top of the main pane.
Esc or Done closes it and the keyboard goes back where it was. Locatable as `role=dialog` "Keyboard shortcuts".
-->
<script lang="ts">
  import SheetFrame from '../sessions/SheetFrame.svelte'
  import { ui } from '../sessions/state.svelte.ts'
  import KeyboardList from './KeyboardList.svelte'

  const close = (): void => {
    ui.sheet = null
  }
</script>

{#if ui.sheet?.kind === 'shortcuts'}
  <SheetFrame title="Keyboard shortcuts" role="dialog" wide onCancel={close}>
    {#snippet buttons()}
      <button class="button" data-default="true" onclick={close}>Done</button>
    {/snippet}
    <KeyboardList />
  </SheetFrame>
{/if}
