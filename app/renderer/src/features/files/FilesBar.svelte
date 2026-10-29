<!--
The Files bar, above the tree (Files only): the session's folder by name, and New File, New Folder and Collapse All. It
stands for the session's folder: a right-click opens the folder's menu (`files ⌃`), and a row dragged onto it goes
there. For the keyboard it is a toolbar before the list: `Tab` reaches it, `←` / `→` move between its buttons, `⇧F10`
or the menu key opens `files ⌃`. Its buttons act in the folder of the row selected in the tree, as the palette does.
Locatable as `toolbar` "Files".
-->
<script lang="ts">
  import { Icon } from '@kea/ui'
  import { named } from '../commands/bindings.svelte.ts'
  import { commands } from '../commands/registry.ts'
  import { sessions } from '../sessions/state.svelte.ts'
  import { dragOverFolder, dropOnFolder, leaveFolder } from './drag.ts'
  import { panel } from './state.svelte.ts'

  let { sessionId }: { sessionId: string } = $props()

  const BUTTONS = [
    { id: 'files.newFile', icon: 'filePlus', tip: 'New File' },
    { id: 'files.newFolder', icon: 'folderPlus', tip: 'New Folder' },
    { id: 'files.collapseAll', icon: 'collapseAll', tip: 'Collapse All' },
  ] as const

  const folder = $derived.by(() => {
    const cwd = (sessions.get(sessionId)?.cwd ?? '').replace(/\/+$/, '')
    return cwd.slice(cwd.lastIndexOf('/') + 1)
  })
  /** The button `Tab` lands on (roving: one stop for the toolbar). */
  let current = $state(0)
  let bar: HTMLDivElement | undefined = $state()

  function menuAt(at: { x: number; y: number }): void {
    panel.menu = { kind: 'files', target: { sessionId, path: '', dir: true, from: 'tree' }, at }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault()
      const r = (e.target instanceof HTMLElement ? e.target : bar)?.getBoundingClientRect()
      if (r) menuAt({ x: r.left, y: r.bottom })
      return
    }
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'Home' ? -BUTTONS.length : e.key === 'End' ? BUTTONS.length : 0
    if (step === 0) return
    e.preventDefault()
    current = Math.max(0, Math.min(BUTTONS.length - 1, current + step))
    bar?.querySelectorAll<HTMLButtonElement>('button')[current]?.focus()
  }

  function onContextMenu(e: MouseEvent): void {
    e.preventDefault()
    menuAt({ x: e.clientX, y: e.clientY })
  }
</script>

<div
  bind:this={bar}
  class="fp-bar{panel.dropDir === '' ? ' drop-target' : ''}"
  role="toolbar"
  aria-label="Files"
  tabindex="-1"
  onkeydown={onKeyDown}
  oncontextmenu={onContextMenu}
  ondragover={(e) => dragOverFolder(e, sessionId, '')}
  ondragleave={(e) => leaveFolder(e)}
  ondrop={(e) => dropOnFolder(e, sessionId, '')}
>
  <span class="fp-bar-name" data-tip={folder}>{folder}</span>
  {#each BUTTONS as b, i (b.id)}
    <button class="quiet-button icon" tabindex={i === current ? 0 : -1} aria-label={named(b.id, b.tip)} data-command={b.id} disabled={panel.busy} onfocus={() => (current = i)} onclick={() => commands.run(b.id)}><Icon name={b.icon} /></button>
  {/each}
</div>
