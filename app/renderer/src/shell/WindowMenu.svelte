<!--
Linux's application menu, drawn by the window under the header's menu button: File, Edit, View, Session, Go, Window,
Help, each a submenu that drills down (`@kea/ui` Menu). Main sends its items when the button or `Alt` alone asks
(`onWindowMenu`), from the menu bar's own template, and runs a pick by its id; a command's item shows the key in use.
Edit › Select All with the keyboard in a terminal selects the terminal's text, as its key does. Mounted once by the
window where `protocolOs.window.menuButton` is set. Locatable as `role=menu` "Application menu".
-->
<script lang="ts">
  import { isCommandId, SELECT_ALL_COMMAND, type WindowMenuNode } from '@kea/protocol'
  import { Menu, type MenuItem } from '@kea/ui'
  import { onWindowMenu, pickWindowMenu } from '../lib/bridge.ts'
  import { shortcut } from '../features/commands/bindings.svelte.ts'
  import { commands } from '../features/commands/registry.ts'
  import { focusedView } from '../features/terminal/views.ts'
  import { windowMenuUi } from './windowMenuState.svelte.ts'

  $effect(() => onWindowMenu((m) => windowMenuUi.arrived(m, focusedView() !== undefined)))

  const item = (n: WindowMenuNode): MenuItem => {
    // a command's key in use; an Edit role's as main shows it (Select All's Ctrl+A, the field's own)
    const key = (isCommandId(n.id) ? shortcut(n.id) : undefined) ?? n.shortcut
    return {
      id: n.id,
      label: n.label,
      ...(n.separator ? { separator: true } : {}),
      ...(n.submenu ? { submenu: n.submenu.map(item) } : {}),
      ...(!n.enabled && !n.separator ? { disabled: true } : {}),
      ...(key && !n.submenu ? { shortcut: key } : {}),
    }
  }
  const open = $derived(windowMenuUi.open)
  const items = $derived(open ? open.items.map(item) : [])

  /** A pick, for the opening it came from (the menu closes before its pick runs). */
  const pickIn = (inTerminal: boolean) => (id: string) => {
    if (id === SELECT_ALL_COMMAND && inTerminal && commands.available(SELECT_ALL_COMMAND)) commands.run(SELECT_ALL_COMMAND)
    else pickWindowMenu(id)
  }
</script>

{#if open}
  <Menu label="Application menu" {items} at={open.at} trigger="[data-window-menu]" onPick={pickIn(open.inTerminal)} onClose={() => (windowMenuUi.open = null)} />
{/if}
