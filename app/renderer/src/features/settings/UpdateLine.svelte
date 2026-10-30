<!--
The sidebar footer's update line, above the account conditions, in their style but led by a `--size-dot` dot in the
accent (an update is not a warning): "Kea 1.0.3 is out" (a click opens Settings › About; ✕ hides it for that version
until Kea next starts), "Kea 1.0.3 is ready — Restart to Update" and "Kea was updated — Restart Kea" (a click
restarts; no ✕), or, once per home where Kea checks by itself, the line saying it does (a click opens About; ✕ closes
it). That line counts as seen only while it is in view in a window in front, and the first automatic check waits for it.
Wider than compact the line wraps rather than being cut short, and its action is never split; compact, it is cut short
and its tooltip has the whole wording.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { Icon } from '@kea/ui'
  import { restartToUpdate, updateNoticeShown } from '../../lib/bridge.ts'
  import { External } from '../../lib/reactive.svelte.ts'
  import { sidebarCompact } from '../../shell/layoutStore.svelte.ts'
  import { commands } from '../commands/registry.ts'
  import { footerUpdate, updates } from './updates.ts'

  // one subscription: the store tells it of a new state, a dismissed version and the closed line alike
  const update = new External(updates.subscribe, () => updates.state)
  const line = $derived.by(() => footerUpdate(update.current, { dismissed: (v) => updates.dismissed(v), notice: updates.notice }))
  const keepFocus = (e: MouseEvent) => e.preventDefault()

  let el = $state<HTMLElement | null>(null)
  /** Reported once per window: main records it and stops saying the line is due. */
  let reported = false
  $effect(() => {
    const node = el
    if (!node || line?.kind !== 'notice') return
    return untrack(() => {
      const seen = new IntersectionObserver((entries) => {
        if (reported || document.visibilityState !== 'visible') return
        if (entries.some((e) => e.isIntersecting)) {
          reported = true
          updateNoticeShown()
        }
      })
      seen.observe(node)
      return () => seen.disconnect()
    })
  })

  function open(): void {
    if (!line) return
    if (line.click === 'restart') restartToUpdate()
    else commands.run('app.settings', { page: 'about' })
  }

  function close(): void {
    if (!line) return
    if (line.kind === 'notice') {
      updateNoticeShown()
      updates.closeNotice()
    } else if (line.version) updates.dismiss(line.version)
  }
</script>

{#if line}
  {@const lead = line.action ? line.text.slice(0, line.text.length - line.action.length) : line.text}
  <div class="condition-line update-line" class:compact={sidebarCompact()} role="status" aria-label={line.text} data-update-line={line.kind} bind:this={el}>
    <button class="quiet-button update-open condition-text" data-tip={sidebarCompact() ? line.text : undefined} onmousedown={keepFocus} onclick={open}
      >{lead}{#if line.action}<span class="update-action">{line.action}</span>{/if}</button
    >
    {#if line.close}
      <button class="quiet-button icon update-close" aria-label="Dismiss" data-tip="Dismiss" onmousedown={keepFocus} onclick={close}><Icon name="close" /></button>
    {/if}
  </div>
{/if}
