<!--
Find in terminal: a bar of `--size-row` height docked top-right of the terminal it searches, not a floating card (each
terminal area draws it over its own terminal on screen).
Typing searches incrementally; ↵ / ⇧↵ go to the next / previous match; the toggles set case and regex; Esc closes
(the search addon is disposed with its highlights) and returns focus to the terminal. Reopening shows the
last query selected and searches it again (`openFindBar`, findBar.ts).
-->
<script lang="ts">
  import { chordLabel, L } from '@kea/protocol'
  import { resultsText, type FindToggles } from './find.ts'
  import { closeFind, findView } from './findBar.ts'
  import { terminalUi, uiState } from './ui.svelte.ts'

  let { ptyId }: { ptyId: string | null } = $props()

  let input: HTMLInputElement | undefined = $state()
  const f = $derived(uiState.find)
  const toggles: FindToggles = $derived({ caseSensitive: f.caseSensitive, regex: f.regex })

  // the field takes focus with its text selected when the bar opens, and again on ⌘F while it is open (primitives, so
  // typing, which replaces `find`, does not select again)
  const open = $derived(f.open && ptyId !== null && f.ptyId === ptyId)
  const focusSeq = $derived(f.focusSeq)
  $effect(() => {
    void focusSeq
    if (open) input?.select()
  })

  function run(query: string, t: FindToggles, dir: 'incremental' | 'next' | 'previous'): void {
    findView()?.find(query, t, dir)
  }

  function toggle(patch: Partial<FindToggles>): void {
    const t = { ...toggles, ...patch }
    terminalUi.find(patch)
    run(f.query, t, 'incremental')
    input?.focus()
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      run(f.query, toggles, e.shiftKey ? 'previous' : 'next')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeFind()
    }
  }

  const keepFocus = (e: MouseEvent) => e.preventDefault()
</script>

{#if open}
  <div class="find-bar" role="search" aria-label="Find in terminal">
    <input
      bind:this={input}
      class="find-input"
      aria-label="Find in terminal"
      placeholder="Find"
      spellcheck="false"
      maxlength={L.findQueryMaxChars}
      value={f.query}
      oninput={(e) => {
        // the store cuts the query to `L.findQueryMaxChars`; search what it keeps
        terminalUi.find({ query: e.currentTarget.value })
        run(uiState.find.query, toggles, 'incremental')
      }}
      onkeydown={onKeyDown}
    />
    <span class="find-count" aria-live="polite">{resultsText(f.results, f.query)}</span>
    <button class={f.caseSensitive ? 'find-toggle on' : 'find-toggle'} aria-pressed={f.caseSensitive} aria-label="Match case" data-tip="Match case" onmousedown={keepFocus} onclick={() => toggle({ caseSensitive: !f.caseSensitive })}>Aa</button>
    <button class={f.regex ? 'find-toggle on' : 'find-toggle'} aria-pressed={f.regex} aria-label="Regular expression" data-tip="Regular expression" onmousedown={keepFocus} onclick={() => toggle({ regex: !f.regex })}>.*</button>
    <button class="find-button" aria-label="Previous match" data-tip="Previous match" data-tip-key={chordLabel('shift+enter')} onmousedown={keepFocus} onclick={() => run(f.query, toggles, 'previous')}>↑</button>
    <button class="find-button" aria-label="Next match" data-tip="Next match" data-tip-key={chordLabel('enter')} onmousedown={keepFocus} onclick={() => run(f.query, toggles, 'next')}>↓</button>
    <button class="find-button" aria-label="Close find" data-tip="Close" data-tip-key="Esc" onmousedown={keepFocus} onclick={() => closeFind()}>×</button>
  </div>
{/if}
