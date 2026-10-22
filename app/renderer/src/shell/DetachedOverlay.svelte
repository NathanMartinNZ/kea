<!--
The detached overlay: over a detached session's dimmed last screen, one centred row — what ended (`end_reason`:
stopped, exited, crashed with its exit code, lost) · Resume ↵ · Restart ⌘↵. No modal: the terminal around it stays
readable and scrollable.

Keys: while the keyboard is in the session's terminal area (or nowhere), the pane is the "detached overlay" context: ⌘↵
is its scoped binding and the router runs Restart (`scope.ts`); ↵ is its own key, taken here before the ended terminal
sees it, and runs Resume, the default action. Both run the session commands, which act on the session shown.

Locatable as `status` "Session ended" with `button`s "Resume" and "Restart".
-->
<script lang="ts">
  import type { EndReason } from '@kea/protocol'
  import { shortcut } from '../features/commands/bindings.svelte.ts'
  import { commands } from '../features/commands/registry.ts'
  import { provideKeyScope } from '../features/commands/scope.ts'
  import { endedText } from './detached.ts'

  let { reason, exit }: { reason: EndReason | null; exit: { code: number | null; signal: number | null } | null } = $props()
  let el: HTMLDivElement | undefined = $state()
  const text = $derived(endedText(reason, exit))
  // the keys as this system writes them (`↵` / `⌘↵`; `Enter` / `Ctrl+Shift+Enter` on Linux), following keybindings.json
  const resumeKey = $derived(shortcut('session.resume'))
  const restartKey = $derived(shortcut('session.restart'))

  /** The keyboard is in this pane's terminal area (the overlay's parent), or nowhere. */
  function inScope(): boolean {
    const a = document.activeElement
    return !!el && (a === null || a === document.body || !!el.parentElement?.contains(a))
  }

  /** ↵ is the overlay's unless a control in the area has the keyboard (the find bar's field, a focused button). */
  function enterIsOurs(): boolean {
    const a = document.activeElement
    if (a instanceof HTMLInputElement || a instanceof HTMLButtonElement) return false
    if (a instanceof HTMLTextAreaElement && !a.classList.contains('xterm-helper-textarea')) return false
    return inScope()
  }

  $effect(() => {
    const withdraw = provideKeyScope(() => (inScope() ? 'detached overlay' : null))
    // ↵ is the overlay's own key: taken before the ended terminal's xterm, which would send it to no program
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !enterIsOurs()) return
      e.preventDefault()
      e.stopPropagation()
      commands.run('session.resume')
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      withdraw()
      window.removeEventListener('keydown', onKey, true)
    }
  })
</script>

<div class="detached-overlay" bind:this={el}>
  <div class="detached-row" role="status" aria-label="Session ended">
    <span>{text}</span>
    <span aria-hidden="true">·</span>
    <button class="button" aria-label="Resume" onclick={() => commands.run('session.resume')}>Resume{#if resumeKey}<kbd>{resumeKey}</kbd>{/if}</button>
    <span aria-hidden="true">·</span>
    <button class="button" aria-label="Restart" onclick={() => commands.run('session.restart')}>Restart{#if restartKey}<kbd>{restartKey}</kbd>{/if}</button>
  </div>
</div>
