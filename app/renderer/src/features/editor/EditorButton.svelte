<!--
The main header's open-in-editor split button, before the overflow.

  primary   the default editor's name (`Code`): opens the session's folder in it (`session.openInEditor`, `⌘⇧O`).
            Always the default editor; pressed for a moment after any open is asked for.
  caret     the commands the command table marks `editor ▾`, in its order: Reveal Worktree in Finder, Copy Worktree
            Path, one "Open in <editor>" per other detected editor (only installed ones), Open in Terminal App.
            Opening it looks for editors again.
  missing   the default editor is not installed: one button, `Open in…`, that opens the menu; the menu's last item
            offers to change the default.

It also shows the two menus other parts of the window ask for (state.svelte.ts): this menu, when something was to be
opened and there is no editor to open it with, and "Choose editor" for a request that failed.
Locatable as the group "Open in editor".
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { EDITOR_BUTTON_LABEL, type EditorOpenRequest } from '@kea/protocol'
  import { Icon, Menu, type MenuItem } from '@kea/ui'
  import { call } from '../../lib/rpc.ts'
  import { commands } from '../commands/registry.ts'
  import { menuItems } from '../sessions/sheets.ts'
  import { failed } from '../sessions/state.svelte.ts'
  import { openInEditor } from './open.ts'
  import { buttonMounted, editorState, refreshEditors } from './state.svelte.ts'
  import './editor.css'

  let { sessionId: idProp }: { sessionId: string } = $props()
  const sessionId = untrack(() => idProp)

  const OPEN_IN = 'view.openIn'
  const CHANGE_DEFAULT = 'editor.changeDefault'

  type MenuOpen = { kind: 'commands' } | { kind: 'default' } | { kind: 'choose'; req: EditorOpenRequest }
  const LABEL: Record<MenuOpen['kind'], string> = { commands: 'Open in', default: 'Default editor', choose: 'Choose editor' }

  const list = $derived(editorState.list)
  const def = $derived(list.default)
  let group: HTMLDivElement | undefined = $state()
  let menu = $state.raw<(MenuOpen & { at: { x: number; y: number } }) | null>(null)

  $effect(() => buttonMounted())

  /** Menus hang from the button's right edge (the header's right end). */
  function anchor(): { x: number; y: number } {
    const r = group?.getBoundingClientRect()
    return r ? { x: r.right, y: r.bottom } : { x: window.innerWidth, y: 0 }
  }

  function openMenu(): void {
    menu = { kind: 'commands', at: anchor() }
    void refreshEditors(true) // Detection runs when the menu opens
  }

  // asked for from elsewhere, after this button was mounted
  let menuSeen = untrack(() => editorState.menuWanted)
  $effect(() => {
    const n = editorState.menuWanted
    untrack(() => {
      if (n === menuSeen) return
      menuSeen = n
      openMenu()
    })
  })
  let chooseSeen = untrack(() => editorState.choose?.seq ?? 0)
  $effect(() => {
    const c = editorState.choose
    untrack(() => {
      if (!c || c.seq === chooseSeen) return
      chooseSeen = c.seq
      menu = { kind: 'choose', req: c.req, at: anchor() }
    })
  })

  const items = $derived.by((): MenuItem[] => {
    const m = menu
    if (!m) return []
    if (m.kind === 'choose') return list.editors.map((e) => ({ id: e.id, label: `Open in ${e.name}` }))
    if (m.kind === 'default') return list.editors.map((e) => ({ id: e.id, label: e.name }))
    const out: MenuItem[] = []
    for (const it of menuItems('editor ▾', { id: sessionId })) {
      if (it.id !== OPEN_IN) {
        out.push(it)
        continue
      }
      // One item per installed editor other than the primary button's
      for (const e of list.editors) if (e.id !== def) out.push({ ...it, id: `${OPEN_IN}:${e.id}`, label: `Open in ${e.name}` })
      if (list.editors.length === 0) out.push({ id: OPEN_IN, label: 'No editor found', disabled: true, reason: 'Install VS Code, Cursor, Windsurf or Zed' })
    }
    // The hint that offers to change the default
    if (def === null && list.editors.length > 0) out.push({ id: CHANGE_DEFAULT, label: 'Change Default Editor…' })
    return out
  })

  async function setDefault(id: string): Promise<void> {
    try {
      await call('settings.set', { key: 'general.defaultEditor', value: id })
    } catch (e) {
      failed("Couldn't change the default editor", e)
    }
  }

  /** The pick runs with the menu it was made in (the menu closes, and clears `menu`, before the pick runs). */
  const picker = (m: MenuOpen) => (id: string) => {
    if (m.kind === 'choose') void openInEditor({ ...m.req, editor: id })
    else if (m.kind === 'default') void setDefault(id)
    else if (id === CHANGE_DEFAULT) menu = { kind: 'default', at: anchor() }
    else if (id.startsWith(`${OPEN_IN}:`)) commands.run(OPEN_IN, { id: sessionId, editor: id.slice(OPEN_IN.length + 1) })
    else commands.run(id, { id: sessionId })
  }

  const hint = $derived(def !== null ? '' : list.editors.length === 0 ? 'No editor was found on this Mac' : `${list.configured.name} is not installed`)
  const defName = $derived(list.editors.find((e) => e.id === def)?.name ?? '')
  // a header control never takes the keyboard from the terminal
  const keepFocus = (e: MouseEvent) => e.preventDefault()
</script>

<div bind:this={group} class="editor-split" role="group" aria-label="Open in editor" data-editor={def ?? ''}>
  {#if def}
    <button class={editorState.pressed ? 'quiet-button pressed' : 'quiet-button'} data-command="session.openInEditor" data-tip={`Open in ${defName}`} onmousedown={keepFocus} onclick={() => commands.run('session.openInEditor', { id: sessionId })}
      >{#if def === 'vscode' || def === 'vscode-insiders'}<Icon name="vscode" />{/if}{EDITOR_BUTTON_LABEL[def]}</button
    >
    <button class="quiet-button caret" aria-label="Open in…" aria-haspopup="menu" aria-expanded={menu !== null} data-command="view.openIn" onmousedown={keepFocus} onclick={openMenu}><Icon name="caretDown" /></button>
  {:else}
    <button class={editorState.pressed ? 'quiet-button pressed' : 'quiet-button'} aria-haspopup="menu" aria-expanded={menu !== null} data-command="view.openIn" data-tip={hint || undefined} onmousedown={keepFocus} onclick={openMenu}>Open in…</button>
  {/if}
</div>
{#if menu}
  {#key menu.kind}
    <Menu label={LABEL[menu.kind]} {items} at={menu.at} align="end" onPick={picker(menu)} onClose={() => (menu = null)} />
  {/key}
{/if}
