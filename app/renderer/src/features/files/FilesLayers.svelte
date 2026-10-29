<!--
The file panel's floating layers, mounted once by the window: the menus generated from the command table —
`file ⌃` for a row of the tree or the Changes list, `files ⌃` for the session's folder (the Files bar, the space under
the tree's rows), `changes ⋯` for the Changes header. A pick runs the command with the row the menu was opened for.
Locatable as `role=menu` "File menu" / "Folder menu" / "Changes actions". The finder (`⌘P`) is the palette's file mode
(features/palette).
-->
<script lang="ts">
  import { Menu } from '@kea/ui'
  import { commands } from '../commands/registry.ts'
  import { menuItems } from '../sessions/sheets.ts'
  import { panel, type FileMenu, type FileTarget } from './state.svelte.ts'

  const SURFACE = { file: 'file ⌃', files: 'files ⌃', changes: 'changes ⋯' } as const satisfies Record<FileMenu['kind'], string>
  const LABEL: Record<FileMenu['kind'], string> = { file: 'File menu', files: 'Folder menu', changes: 'Changes actions' }

  const menu = $derived.by(() => {
    const req = panel.menu
    if (!req) return null
    const items = menuItems(SURFACE[req.kind], req.target)
    return items.length === 0 ? null : { req, items }
  })

  /** The pick runs with the row the menu was opened for (the request is cleared when the menu closes). */
  const runWith = (target: FileTarget) => (id: string) => {
    commands.run(id, target)
  }
  const close = () => {
    panel.menu = null
  }
</script>

{#if menu}
  <Menu label={LABEL[menu.req.kind]} items={menu.items} at={menu.req.at} align={menu.req.kind === 'changes' ? 'end' : 'start'} trigger={menu.req.trigger} onClose={close} onPick={runWith(menu.req.target)} />
{/if}
