<!--
Settings › Notifications: the schema's rows, and, when macOS is not showing Kea's notifications (main saw one
fail since the last that showed), a line saying so with a link to macOS's notification settings. Main opens the pane;
the window only asks. Linux keeps no permission for an app's notifications, so there is no line and no link.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { protocolOs } from '@kea/protocol'
  import { notificationsDenied, openNotificationSettings } from '../../lib/bridge.ts'
  import NotificationsNote from './NotificationsNote.svelte'
  import SectionPage from './SectionPage.svelte'

  let denied = $state(false)
  $effect(() => {
    if (!protocolOs.window.notificationSettings) return
    let live = true
    untrack(() => {
      void notificationsDenied().then((d) => {
        if (live) denied = d
      })
    })
    return () => {
      live = false
    }
  })
</script>

<SectionPage section="Notifications">
  {#snippet after()}
    <NotificationsNote {denied} onOpen={openNotificationSettings} />
  {/snippet}
</SectionPage>
