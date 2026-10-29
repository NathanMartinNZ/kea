<!--
Small layers over the terminal: "Jump to bottom", the multi-line paste confirmation (a sheet at the top of the main
pane whose default button is the safe one), the link target on hover, the "Copy link" menu for targets that are
never opened, and Linux's one-time copy hint (plain Ctrl+C over a selection interrupted; its action turns on
`terminal.ctrlCopyPaste`). The hint never takes the keyboard. Each terminal area draws the layers of its own terminal
on screen, and the paste sheet of any of its tabs.
-->
<script lang="ts">
  import { Icon, Menu, type MenuItem } from '@kea/ui'
  import { call } from '../../lib/rpc.ts'
  import { shortcut } from '../commands/bindings.svelte.ts'
  import { commands } from '../commands/registry.ts'
  import { failed } from '../sessions/state.svelte.ts'
  import { isScrolledUp, terminalUi, uiState } from './ui.svelte.ts'
  import { terminals } from './views.ts'

  let {
    ptyId,
    owns,
  }: {
    /** The area's terminal on screen. */
    ptyId: string | null
    /** Whether a terminal is one of the area's tabs. */
    owns: (id: string) => boolean
  } = $props()

  const mine = (id: string | null | undefined): boolean => ptyId !== null && id === ptyId

  const keepFocus = (e: MouseEvent) => e.preventDefault()
  const LINK_ITEMS: MenuItem[] = [{ id: 'copyLink', label: 'Copy link' }]

  function useCtrlCopy(): void {
    terminalUi.copyHint(null)
    call('settings.set', { key: 'terminal.ctrlCopyPaste', value: true }).catch((e: unknown) => failed("Couldn't change the setting", e))
  }

  let pasteCancel: HTMLButtonElement | undefined = $state()

  // the paste sheet opens with its safe button focused
  $effect(() => {
    if (uiState.paste && owns(uiState.paste.ptyId)) pasteCancel?.focus()
  })

  function settle(ok: boolean): void {
    const p = uiState.paste
    if (!p) return
    const text = terminalUi.settlePaste(ok)
    const v = terminals.get(p.ptyId)
    if (text !== null) v?.paste(text)
    v?.focus()
  }

  /** "Copy link", for the target the menu was opened on (the menu closes before its pick runs). */
  const copyLink = (id: string, target: string) => (): void => {
    void navigator.clipboard.writeText(target).catch((e: unknown) => console.warn('copy link failed', e))
    terminals.get(id)?.focus()
  }
</script>

{#if mine(uiState.copyHint)}
  <div class="copy-hint" role="status">
    <span>Ctrl+C sent an interrupt. Copy is {shortcut('terminal.copy') ?? 'Ctrl+Shift+C'}.</span>
    <button class="link-button" onmousedown={keepFocus} onclick={useCtrlCopy}>Use Ctrl+C to copy</button>
    <button class="quiet-button icon" aria-label="Dismiss" data-tip="Dismiss" onmousedown={keepFocus} onclick={() => terminalUi.copyHint(null)}><Icon name="close" /></button>
  </div>
{/if}
{#if isScrolledUp(ptyId)}
  <button class="jump-bottom" onmousedown={(e) => e.preventDefault()} onclick={() => commands.run('terminal.jumpToBottom')}>Jump to bottom</button>
{/if}
{#if uiState.paste && owns(uiState.paste.ptyId)}
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
{#if uiState.linkHover && mine(uiState.linkHover.ptyId)}
  {@const h = uiState.linkHover}
  <div class="link-tip" role="tooltip" style:left="{h.x}px" style:top="{h.y}px">{h.text}</div>
{/if}
{#if uiState.linkMenu && mine(uiState.linkMenu.ptyId)}
  {@const m = uiState.linkMenu}
  <!-- a menu like any other: one at a time, Esc, a press elsewhere or the window losing focus closes it -->
  <Menu label="Link menu" items={LINK_ITEMS} at={{ x: m.x, y: m.y }} onPick={copyLink(m.ptyId, m.target)} onClose={() => terminalUi.linkMenu(null)} />
{/if}
