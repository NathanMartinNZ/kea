<!--
The main header's dev-server control, after the diff stat. One state at a time:

  nothing to run   hidden (the command says why); so is Run in a session that can run none (archived, its
                   worktree gone: core refuses it)
  stopped          `▶ Run`
  starting         spinner + `Starting` (a click stops it)
  running          green dot + `Stop`; to its left the URL chip `:5173 ↗` once a port listens: a click opens the
                   browser, a right-click offers Copy URL, and with several ports the chip opens a menu of them
  stopping         `Stopping…` (a click skips to SIGKILL)
  crashed          red dot + `Exited 1` (a click shows the Server tab) and `Restart`

Under it, one line when a port is held: who holds it, and "Stop it and run here" when that is another session's dev
server. It reads the window's copy of `server:<sessionId>` (state.svelte.ts): the session on screen's.
Locatable as the group "Dev server" with `data-server-state`.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { serverExitLabel, serverHintText } from '@kea/protocol'
  import { Icon, Menu, menuTrigger, StatusGlyph, type MenuItem } from '@kea/ui'
  import { copyUrl, dismissHint, openInBrowser, restartServer, runServer, showServerLog, stopServer, takeOverPort } from './actions.ts'
  import { controlShown, portLinks } from './model.ts'
  import { scanPorts, serverOf } from './state.svelte.ts'
  import './server.css'

  /** `canRun`: the session is one a server can be run in (model.ts `canRunIn`); the header, which follows its row, says. */
  let { sessionId: idProp, canRun = true }: { sessionId: string; canRun?: boolean } = $props()
  const sessionId = untrack(() => idProp)

  const v = $derived(serverOf(sessionId))
  const links = $derived(portLinks(v))
  const primary = $derived(links[0])

  /** The chip's menu: the listening ports (a click, with several), or Copy URL (a right-click). */
  let menu = $state.raw<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null)
  const COPY = 'copy'

  function openMenu(el: HTMLElement, items: MenuItem[]): void {
    const r = el.getBoundingClientRect()
    menu = { at: { x: r.right, y: r.bottom }, items }
    scanPorts(sessionId) // The port menu was opened
  }

  function chipClick(e: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    if (!primary) return
    if (links.length === 1) openInBrowser(primary.url)
    else openMenu(e.currentTarget, [...links.map((l) => ({ id: l.url, label: l.url })), { id: COPY, label: 'Copy URL' }])
  }

  function chipMenu(e: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    e.preventDefault()
    openMenu(e.currentTarget, [{ id: COPY, label: 'Copy URL' }])
  }

  function pick(id: string): void {
    if (id === COPY) {
      if (primary) copyUrl(primary.url)
    } else if (links.some((l) => l.url === id)) openInBrowser(id)
  }

  // a header control never takes the keyboard from the terminal
  const keepFocus = (e: MouseEvent) => e.preventDefault()
</script>

{#if controlShown(v, canRun)}
  <div class="server-control" role="group" aria-label="Dev server" data-server-state={v.state}>
    {#if primary}
      <button
        class="server-chip"
        aria-label={`Open ${primary.url} in the browser`}
        aria-haspopup={links.length > 1 ? 'menu' : undefined}
        aria-expanded={links.length > 1 ? menu !== null : undefined}
        data-menu-trigger="server-ports"
        data-command="server.openBrowser"
        data-tip={primary.url}
        data-url={primary.url}
        onmousedown={keepFocus}
        onclick={chipClick}
        oncontextmenu={chipMenu}>{primary.label} <span aria-hidden="true">↗</span></button
      >
    {/if}
    {#if v.state === 'stopped'}
      <button class="quiet-button" data-command="server.toggle" data-tip="Run Dev Server" onmousedown={keepFocus} onclick={() => void runServer(sessionId)}><span aria-hidden="true">▶</span> Run</button>
    {:else if v.state === 'starting'}
      <button class="quiet-button" data-command="server.toggle" data-tip="Stop Dev Server" onmousedown={keepFocus} onclick={() => void stopServer(sessionId)}><StatusGlyph kind="working" label="" /> Starting</button>
    {:else if v.state === 'running'}
      <button class="quiet-button" data-command="server.toggle" data-tip="Stop Dev Server" onmousedown={keepFocus} onclick={() => void stopServer(sessionId)}><span class="server-dot" aria-hidden="true"></span> Stop</button>
    {:else if v.state === 'stopping'}
      <button class="quiet-button" data-command="server.toggle" data-tip="Stop it now (SIGKILL)" onmousedown={keepFocus} onclick={() => void stopServer(sessionId)}>Stopping…</button>
    {:else}
      <button class="quiet-button" data-command="server.showLog" onmousedown={keepFocus} onclick={() => showServerLog(sessionId)}><span class="server-dot crashed" aria-hidden="true"></span> {serverExitLabel(v.exit)}</button>
      <button class="quiet-button" data-command="server.restart" onmousedown={keepFocus} onclick={() => void restartServer(sessionId)}>Restart</button>
    {/if}
    {#if v.hint}
      {@const hint = v.hint}
      <div class="server-hint" role="status">
        <span>{serverHintText(hint)}</span>
        {#if hint.holder.kind === 'session'}
          <button class="quiet-button" onmousedown={keepFocus} onclick={() => void takeOverPort(sessionId)}>Stop it and run here</button>
        {/if}
        <button class="quiet-button icon" aria-label="Dismiss" data-tip="Dismiss" onmousedown={keepFocus} onclick={() => dismissHint(sessionId)}><Icon name="close" /></button>
      </div>
    {/if}
  </div>
  {#if menu}
    <Menu label="Dev server ports" items={menu.items} at={menu.at} align="end" trigger={menuTrigger('server-ports')} onPick={pick} onClose={() => (menu = null)} />
  {/if}
{/if}
