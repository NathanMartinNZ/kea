<!-- Rename in place; ↵ keeps it, Esc leaves it as it was. Locatable as `textbox` "Session title". -->
<script lang="ts">
  import { untrack } from 'svelte'
  import { L, type SessionView } from '@kea/protocol'
  import { renameSession } from '../features/sessions/actions.ts'
  import { ui } from '../features/sessions/state.svelte.ts'

  let { s }: { s: SessionView } = $props()
  let title = $state(untrack(() => s.title))
  let input: HTMLInputElement | undefined = $state()
  // set by ↵ and Esc: the field is going, and a blur as it leaves the page changes nothing
  let settled = false

  $effect(() => {
    untrack(() => {
      input?.focus()
      input?.select()
    })
  })
</script>

<input
  bind:this={input}
  class="field session-title-field"
  aria-label="Session title"
  value={title}
  maxlength={L.titleMaxChars}
  spellcheck="false"
  oninput={(e) => (title = e.currentTarget.value)}
  onblur={() => {
    if (!settled) void renameSession(s.id, title)
  }}
  onkeydown={(e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      settled = true
      void renameSession(s.id, title)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      settled = true
      ui.renaming = null
    }
  }}
/>
