<!-- The main column's header: the session's (SessionHeader.svelte), else empty. A drag region except its controls.
`menuButton`: it is the leftmost visible header on Linux, so it holds the window's menu button. -->
<script lang="ts">
  import { ui } from '../features/sessions/state.svelte.ts'
  import SessionHeader from './SessionHeader.svelte'
  import WindowMenuButton from './WindowMenuButton.svelte'

  let { menuButton = false }: { menuButton?: boolean } = $props()
  const sessionId = $derived(ui.pane.kind === 'session' ? ui.pane.id : null)
</script>

<div class="column-header main-header">
  {#if menuButton}
    <WindowMenuButton />
  {/if}
  {#if sessionId}
    {#key sessionId}
      <SessionHeader id={sessionId} />
    {/key}
  {/if}
</div>
