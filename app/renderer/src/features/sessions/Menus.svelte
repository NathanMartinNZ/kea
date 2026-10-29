<!--
The context menus generated from the command table, and the header's overflow menu: the one the window's
`ui.menu` asks for. Locatable as `role=menu` "Session menu", "Project menu" or "Session actions".
-->
<script lang="ts">
  import { Menu } from '@kea/ui'
  import { commands } from '../commands/registry.ts'
  import { MENU_LABEL, MENU_SURFACE, menuItems } from './sheets.ts'
  import { ui } from './state.svelte.ts'

  const open = $derived.by(() => {
    const req = ui.menu
    if (!req) return null
    const args = req.kind === 'project' ? { projectId: req.id } : { id: req.id }
    const items = menuItems(MENU_SURFACE[req.kind], args)
    return items.length === 0 ? null : { req, args, items }
  })

  /** The pick runs with the row the menu was opened for (the request is cleared when the menu closes). */
  const runWith = (args: unknown) => (id: string) => {
    commands.run(id, args)
  }
  const close = () => {
    ui.menu = null
  }
</script>

{#if open}
  <!-- the header's ⋯ sits at the window's right edge: its menu opens leftwards from it -->
  <Menu label={MENU_LABEL[open.req.kind]} items={open.items} at={open.req.at} align={open.req.kind === 'header' ? 'end' : 'start'} trigger={open.req.trigger} onClose={close} onPick={runWith(open.args)} />
{/if}
