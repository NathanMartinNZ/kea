<!-- The main pane's view of a session whose creation failed: the error, Retry and Discard. -->
<script lang="ts">
  import { sessionCall } from './actions.ts'

  let { id, error }: { id: string; error: string | null } = $props()
</script>

<div class="pane-note" role="status">
  <p>{error ?? 'Creating the session failed.'}</p>
  <div class="pane-buttons">
    <button class="button" onclick={() => void sessionCall('sessions.retry', id, 'retry the creation')}>Retry</button>
    <button class="button danger" onclick={() => void sessionCall('sessions.discard', id, 'discard the session')}>Discard</button>
  </div>
</div>
