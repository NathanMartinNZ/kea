<!--
The creation log, read again whenever it grows (its byte count is in the session row). One read at a time: growth while
a read is in flight makes one more read after it, of the latest log, not one per change. The text (git's output, up to
L.creationLogMaxBytes) goes into the DOM only, never into rune state.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { call } from '../lib/rpc.ts'

  let { id, logBytes }: { id: string; logBytes: number } = $props()
  let shown = $state(false)
  let pre: HTMLPreElement | null = null
  // the last text read, until the element that shows it exists (plain, not rune state)
  let latest = ''
  let reading = false
  let again = false
  let live = true

  const holder: Attachment<HTMLPreElement> = (el) => {
    pre = el
    el.textContent = latest
    return () => {
      if (pre === el) pre = null
    }
  }

  function read(sessionId: string): void {
    if (reading) {
      again = true
      return
    }
    reading = true
    call('sessions.creationLog', { id: sessionId })
      .then((r) => {
        if (!live || sessionId !== id) return
        latest = r.text
        if (pre) pre.textContent = r.text
        shown = r.text.length > 0
      })
      .catch(() => undefined)
      .finally(() => {
        reading = false
        if (!again || !live) return
        again = false
        read(id)
      })
  }

  $effect(() => {
    const sessionId = id
    if (logBytes === 0) return
    untrack(() => read(sessionId))
  })

  $effect(() => () => {
    live = false
    latest = ''
  })
</script>

{#if shown}
  <pre class="creation-log" {@attach holder}></pre>
{/if}
