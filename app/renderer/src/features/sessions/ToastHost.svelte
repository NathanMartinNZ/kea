<!-- The one toast: failures with no natural place, bottom-right, one action. Locatable as `alert`. -->
<script lang="ts">
  import { ui } from './state.svelte.ts'

  const close = () => {
    ui.toast = null
  }
</script>

{#if ui.toast}
  {@const t = ui.toast}
  <div class="toast" role="alert">
    <span class="toast-text">{t.message}</span>
    {#if t.action}
      {@const action = t.action}
      <button
        class="button"
        onclick={() => {
          // read before closing: `action` follows the toast, which the close clears
          const a = action
          close()
          a.run()
        }}>{action.label}</button
      >
    {:else}
      <button class="button" onclick={close}>Dismiss</button>
    {/if}
  </div>
{/if}
