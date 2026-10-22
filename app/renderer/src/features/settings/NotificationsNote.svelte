<!-- Shown only while macOS denies Kea's notifications; the link asks main to open macOS's own pane. -->
<script lang="ts">
  let p: { denied: boolean; onOpen(): void } = $props()
</script>

{#if p.denied}
  <p class="settings-help settings-wide" role="status" data-notifications="denied">
    macOS is not showing Kea’s notifications. Allow them in
    <button class="link-button" onclick={p.onOpen}>Notification Settings…</button>
    The Dock badge works either way.
  </p>
{/if}
