<!--
Small layers over the terminal: "Jump to bottom", the multi-line paste confirmation (a sheet at the top of the main
pane whose default button is the safe one), the link target on hover and the "Copy link" menu for targets that are
never opened.
-->
<script lang="ts">
  import { commands } from '../commands/registry.ts'
  import { terminalUi, uiState } from './ui.svelte.ts'
  import { terminals } from './views.ts'

  let pasteCancel: HTMLButtonElement | undefined = $state()
  let linkItem: HTMLButtonElement | undefined = $state()

  // the paste sheet opens with its safe button focused
  $effect(() => {
    if (uiState.paste) pasteCancel?.focus()
  })

  function settle(ok: boolean): void {
    const p = uiState.paste
    if (!p) return
    const text = terminalUi.settlePaste(ok)
    const v = terminals.get(p.ptyId)
    if (text !== null) v?.paste(text)
    v?.focus()
  }

  // "Copy link" takes focus; Esc, a press elsewhere or leaving the window closes it
  $effect(() => {
    const m = uiState.linkMenu
    const item = linkItem
    if (!m) return
    item?.focus()
    const close = () => terminalUi.linkMenu(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    const onDown = (e: MouseEvent) => !(e.target instanceof Node && item?.parentElement?.contains(e.target)) && close()
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', close)
    }
  })

  function copyLink(target: string): void {
    void navigator.clipboard.writeText(target).catch((e: unknown) => console.warn('copy link failed', e))
    terminalUi.linkMenu(null)
    terminals.shown()?.focus()
  }
</script>

{#if uiState.scrolledUp}
  <button class="jump-bottom" onmousedown={(e) => e.preventDefault()} onclick={() => commands.run('terminal.jumpToBottom')}>Jump to bottom</button>
{/if}
{#if uiState.paste}
  {@const p = uiState.paste}
  <!-- svelte-ignore a11y_interactive_supports_focus (focus moves to the default control inside; the sheet itself is not a tab stop) -->
  <div
    class="sheet"
    role="alertdialog"
    aria-label="Paste into the shell"
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        settle(false)
      }
    }}
  >
    <span class="sheet-text">Paste {p.lines} {p.lines === 1 ? 'line' : 'lines'} into the shell?</span>
    <button bind:this={pasteCancel} class="button" onclick={() => settle(false)}>Cancel</button>
    <button class="button" onclick={() => settle(true)}>Paste</button>
  </div>
{/if}
{#if uiState.linkHover}
  {@const h = uiState.linkHover}
  <div class="link-tip" role="tooltip" style:left="{h.x}px" style:top="{h.y}px">{h.text}</div>
{/if}
{#if uiState.linkMenu}
  {@const m = uiState.linkMenu}
  <div class="menu" role="menu" style:left="{m.x}px" style:top="{m.y}px">
    <button bind:this={linkItem} role="menuitem" class="menu-item" onclick={() => copyLink(m.target)}>Copy link</button>
  </div>
{/if}
