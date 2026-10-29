<!--
The terminal menu: Copy, Paste, Select All, Find, Clear Terminal and Scrollback, from the command table's
`terminal ⌃` surface, opened by a right-click in a terminal or the keyboard's Menu key (`contextMenu.ts`, view.ts).
Copy stays listed while nothing is selected, disabled with its reason. A pick gives the keyboard to the terminal the
menu was opened on, then runs the command there, so Copy and Paste act on it even when the composer had the keyboard.
Mounted once by the window. Locatable as `role=menu` "Terminal menu".
-->
<script lang="ts">
  import { systemTitle } from '@kea/protocol'
  import { Menu } from '@kea/ui'
  import { shortcut } from '../commands/bindings.svelte.ts'
  import { selectAllKeys } from '../commands/keys.ts'
  import { surfaceItems } from '../commands/menuItems.ts'
  import { commands } from '../commands/registry.ts'
  import { terminalUi, uiState } from './ui.svelte.ts'
  import { terminals } from './views.ts'

  const open = $derived.by(() => {
    const m = uiState.menu
    if (!m) return null
    const args = { ptyId: m.ptyId }
    const items = surfaceItems('terminal ⌃', args, { inMenus: (id, a) => commands.inMenus(id, a), reason: (id, a) => commands.reason(id, a), title: (c) => systemTitle(c), key: (id) => shortcut(id) ?? selectAllKeys(id)[0] })
    return items.length === 0 ? null : { at: m.at, args, items }
  })

  /** The pick runs on the terminal the menu was opened on (the menu closes before its pick runs). */
  const pickOn = (args: { ptyId: string }) => (id: string) => {
    terminals.get(args.ptyId)?.focus()
    commands.run(id, args)
  }
</script>

{#if open}
  <Menu label="Terminal menu" items={open.items} at={open.at} onPick={pickOn(open.args)} onClose={() => terminalUi.openMenu(null)} />
{/if}
