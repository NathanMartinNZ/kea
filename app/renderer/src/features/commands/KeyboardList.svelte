<!--
KeyboardList: every command of the command table with its id and its key now, read-only. The body of Settings › Keyboard
and of the Keyboard Shortcuts sheet (`app.shortcuts`). It takes no props and fills the width it is given; its container
scrolls it.

Above the list: "Open keybindings.json", and what is wrong with the file when something is — where it does not parse
(the keys in use are then the last good ones), the entries that were left out and why, and the conflicts (two commands
on one key: the file's entry has it). The list follows the file live (`bindings.svelte.ts`). On Linux, with
`terminal.ctrlCopyPaste` on, Copy and Paste list Ctrl+C and Ctrl+V after their own keys.

Locatable as `region` "Keyboard shortcuts": `button` "Open keybindings.json"; `alert` for a file that does not parse;
`list` "Entries left out" and `list` "Conflicts"; one `list` per category, named by it, its rows carrying
`data-command` and showing that id (`.keyboard-id`), each key a `kbd`, and `data-changed` on a row whose key comes
from the file.
-->
<script lang="ts">
  import { CATEGORIES, conflictText } from '@kea/protocol'
  import { External } from '../../lib/reactive.svelte.ts'
  import { settings } from '../settings/store.ts'
  import { keybindingsFile, keyboardRows } from './bindings.svelte.ts'
  import { openKeybindingsFile } from './commands.ts'
  import { ctrlCopyPasteKeys, selectAllKeys } from './keys.ts'
  import './keyboard.css'

  // Linux's Ctrl+C and Ctrl+V in a terminal, while the setting is on
  const ctrlCopy = new External(settings.subscribe, () => settings.get<boolean>('terminal.ctrlCopyPaste'))
  // the keys the router gives commands beside their bindings: Linux's plain Ctrl+C and Ctrl+V when on, ⌘A's Select All
  const rows = $derived(keyboardRows((id) => [...ctrlCopyPasteKeys(id, ctrlCopy.current), ...selectAllKeys(id)]))
  const file = $derived(keybindingsFile())
  const groups = $derived(CATEGORIES.map((category) => ({ category, rows: rows.filter((r) => r.category === category) })))
  /** A notice's place in the file, as a person counts (the first entry is 1). */
  const place = (index: number): string => (index < 0 ? '' : `Entry ${index + 1}: `)
</script>

<section class="keyboard-list" aria-label="Keyboard shortcuts" data-testid="keyboard-list">
  <div class="keyboard-file">
    <p class="keyboard-note">Shortcuts are changed in keybindings.json: one entry per command, read again whenever the file is saved.</p>
    <button class="button" onclick={() => void openKeybindingsFile()}>Open keybindings.json</button>
  </div>
  {#if file.state?.error}
    <p class="keyboard-problem" role="alert">keybindings.json does not parse (line {file.state.error.line}, column {file.state.error.column}: {file.state.error.message}). The shortcuts in use are the last ones that did.</p>
  {/if}
  {#if file.state && file.state.notices.length > 0}
    <ul class="keyboard-issues" aria-label="Entries left out">
      {#each file.state.notices as n, i (i)}
        <li>{place(n.index)}{n.message}</li>
      {/each}
    </ul>
  {/if}
  {#if file.conflicts.length > 0}
    <ul class="keyboard-issues" aria-label="Conflicts">
      {#each file.conflicts as c, i (i)}
        <li>{conflictText(c)}</li>
      {/each}
    </ul>
  {/if}
  {#each groups as g (g.category)}
    <h3 class="keyboard-category" id="keyboard-{g.category}">{g.category}</h3>
    <ul class="keyboard-rows" aria-labelledby="keyboard-{g.category}">
      {#each g.rows as r (r.id)}
        <li class="keyboard-row" data-command={r.id} data-changed={r.changed ? '' : undefined}>
          <span class="keyboard-title">{r.title}</span>
          <!-- what an entry of keybindings.json names: nothing else in the window says a command's id -->
          <code class="keyboard-id">{r.id}</code>
          {#if r.scope && r.keys.length > 0}<span class="keyboard-scope">in the {r.scope}</span>{/if}
          {#if r.changed}<span class="keyboard-scope">from keybindings.json</span>{/if}
          <span class="keyboard-keys">
            {#each r.keys as k (k)}<kbd>{k}</kbd>{/each}
            {#if r.keys.length === 0 && r.gesture}<span class="keyboard-gesture">{r.gesture}</span>{/if}
            {#if r.keys.length === 0 && !r.gesture}<span class="keyboard-gesture" aria-label="no shortcut">—</span>{/if}
          </span>
        </li>
      {/each}
    </ul>
  {/each}
</section>
