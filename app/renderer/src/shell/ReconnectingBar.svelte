<!--
The thin "Reconnecting…" bar: laid over the tab strip while core has been away longer than L.reconnectingBarDelayMs, so
nothing moves and no terminal is resized. Its state is reconnecting.ts, fed by the bridge from the moment this module
loads (before any bar is mounted).
-->
<script module lang="ts">
  import { L } from '@kea/protocol'
  import { onCoreConnection } from '../lib/bridge.ts'
  import { ReconnectingState } from './reconnecting.ts'
  import './reconnecting.css'

  const reconnecting = new ReconnectingState(L.reconnectingBarDelayMs)
  onCoreConnection((up) => (up ? reconnecting.coreBack() : reconnecting.coreAway()))
</script>

<script lang="ts">
  import { External } from '../lib/reactive.svelte.ts'

  const shown = new External(reconnecting.subscribe, () => reconnecting.shown)
</script>

{#if shown.current}
  <div class="reconnecting-bar" role="status" aria-live="polite">Reconnecting…</div>
{/if}
