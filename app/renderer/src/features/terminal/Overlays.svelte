<!--
Small layers over the terminal: "Jump to bottom", the link target on hover, the "Copy link" menu for targets that are
never opened, and Linux's one-time copy hint (plain Ctrl+C over a selection interrupted; its action turns on
`terminal.ctrlCopyPaste`). The hint never takes the keyboard. Each terminal area draws the layers of its own terminal
on screen.
-->
<script lang="ts">
  import { Icon, Menu, type MenuItem } from '@kea/ui'
  import { call } from '../../lib/rpc.ts'
  import { shortcut } from '../commands/bindings.svelte.ts'
  import { commands } from '../commands/registry.ts'
  import { failed } from '../sessions/state.svelte.ts'
  import { isScrolledUp, terminalUi, uiState } from './ui.svelte.ts'
  import { terminals } from './views.ts'

  // the area's terminal on screen
  let { ptyId }: { ptyId: string | null } = $props()

  const mine = (id: string | null | undefined): boolean => ptyId !== null && id === ptyId

  const keepFocus = (e: MouseEvent) => e.preventDefault()
  const LINK_ITEMS: MenuItem[] = [{ id: 'copyLink', label: 'Copy link' }]

  function useCtrlCopy(): void {
    terminalUi.copyHint(null)
    call('settings.set', { key: 'terminal.ctrlCopyPaste', value: true }).catch((e: unknown) => failed("Couldn't change the setting", e))
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
{#if uiState.linkHover && mine(uiState.linkHover.ptyId)}
  {@const h = uiState.linkHover}
  <div class="link-tip" role="tooltip" style:left="{h.x}px" style:top="{h.y}px">{h.text}</div>
{/if}
{#if uiState.linkMenu && mine(uiState.linkMenu.ptyId)}
  {@const m = uiState.linkMenu}
  <!-- a menu like any other: one at a time, Esc, a press elsewhere or the window losing focus closes it -->
  <Menu label="Link menu" items={LINK_ITEMS} at={{ x: m.x, y: m.y }} onPick={copyLink(m.ptyId, m.target)} onClose={() => terminalUi.linkMenu(null)} />
{/if}
