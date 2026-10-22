<!--
"View log": the session's log — its creation steps, git's output, setup and teardown — as core keeps it
(`sessions.creationLog`, the newest L.creationLogMaxBytes), also for a session just deleted. A sheet over the main pane,
read-only, scrolled to its end; Esc or Close goes. Locatable as `role=dialog` "Session log".
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { call } from '../../lib/rpc.ts'
  import SheetFrame from './SheetFrame.svelte'
  import { closeSheet } from './sheets.ts'
  import { failed } from './state.svelte.ts'

  let { sessionId, title, given }: { sessionId: string; title: string; given?: { text: string; truncated: boolean } | undefined } = $props()
  // fixed for this mount (Sheets.svelte keys it)
  const id = untrack(() => sessionId)
  // a session just deleted: the log its delete returned; otherwise core's
  let log = $state.raw<{ text: string; truncated: boolean } | null>(untrack(() => given ?? null))
  let pre: HTMLPreElement | undefined = $state()

  $effect(() => {
    if (untrack(() => given)) return
    let live = true
    call('sessions.creationLog', { id })
      .then((r) => {
        if (live) log = r
      })
      .catch((e: unknown) => {
        if (!live) return
        closeSheet()
        failed("Couldn't read the session's log", e)
      })
    return () => {
      live = false
    }
  })

  // the newest lines are the ones that explain a failure
  $effect(() => {
    if (log && pre) pre.scrollTop = pre.scrollHeight
  })
</script>

<SheetFrame title="Session log" role="dialog" wide onCancel={closeSheet}>
  {#snippet buttons()}
    <button class="button" data-default="true" onclick={closeSheet}>Close</button>
  {/snippet}
  <p class="sheet-meta">{title}{log?.truncated ? ' · its newest part' : ''}</p>
  {#if log === null}
    <p class="sheet-meta">Loading…</p>
  {:else if log.text === ''}
    <p class="sheet-meta">The log is empty.</p>
  {:else}
    <pre bind:this={pre} class="creation-log sheet-log" tabindex="-1">{log.text}</pre>
  {/if}
</SheetFrame>
