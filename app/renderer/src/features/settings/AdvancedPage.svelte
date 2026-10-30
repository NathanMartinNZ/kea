<!--
Settings › Advanced: Reload shell environment · Running background processes (every holder core finds in
`<KEA_HOME>/run`, never the database's list: session, kind, pid, uptime → Terminate) · Orphaned holders (Adopt
as shell / Terminate) · Reset window layout · Open logs folder · Open reports folder · Copy diagnostics with its
"Include file paths" tick box, and in a development build the performance HUD's (`features/diagnostics`). The version
and build commit are on About (AboutPage). The list is read when the page opens and after each action; "Refresh" reads
it again (no timer runs behind the sheet).
-->

<script lang="ts">
  import { untrack } from 'svelte'
  import { TERMINAL_ORPHANS_STORE, type HolderRow, type OrphanInfo } from '@kea/protocol'
  import { openHomeItem } from '../../lib/bridge.ts'
  import { call, subscribe } from '../../lib/rpc.ts'
  import { DEFAULT_LAYOUT } from '../../shell/layout.ts'
  import { setLayout } from '../../shell/layoutStore.svelte.ts'
  import { SHELLS_CONTEXT } from '../../shell/terminalPane.ts'
  import { commands } from '../commands/registry.ts'
  import DiagnosticsRow from '../diagnostics/DiagnosticsRow.svelte'
  import { failed, sessions } from '../sessions/state.svelte.ts'
  import { kindText, uptimeText } from './model.ts'
  import { envReloadText, settingsUi } from './state.svelte.ts'

  let holders = $state.raw<HolderRow[] | null>(null)
  let orphans = $state.raw<OrphanInfo[]>([])
  let readAt = $state(Date.now())
  let busy = $state.raw<ReadonlySet<string>>(new Set())
  let layoutReset = $state(false)

  async function load(): Promise<void> {
    try {
      const r = await call('terminal.holders', {})
      holders = r.holders
      readAt = Date.now()
    } catch (e) {
      holders = []
      failed("Couldn't list the background processes", e)
    }
  }

  $effect(() => {
    let live = true
    untrack(() => void load())
    // the orphans follow core's reconciliation while the page is open
    const off = subscribe<OrphanInfo>(TERMINAL_ORPHANS_STORE, (data) => {
      if (live) orphans = [...data.values()]
    })
    return () => {
      live = false
      off()
    }
  })

  const sessionName = (id: string | null): string => (id === null ? 'Unknown' : id === SHELLS_CONTEXT ? 'Shell tabs' : (sessions.get(id)?.title ?? id))

  async function act(ptyId: string, what: 'terminate' | 'adopt'): Promise<void> {
    busy = new Set([...busy, ptyId])
    try {
      if (what === 'adopt') await call('terminal.adoptOrphan', { ptyId })
      else {
        const r = await call('terminal.terminateHolder', { ptyId })
        if (!r.ok) failed("Couldn't terminate the process", new Error('its holder could not be confirmed, so nothing was signalled'))
      }
    } catch (e) {
      failed(what === 'adopt' ? "Couldn't adopt the holder" : "Couldn't terminate the process", e)
    } finally {
      busy = new Set([...busy].filter((x) => x !== ptyId))
      await load()
    }
  }

  /** One reload at a time: the button stays pressable (it keeps the focus), a press while one runs does nothing. */
  function reloadEnv(): void {
    if (settingsUi.envReload.state !== 'running') commands.run('app.reloadShellEnv')
  }
</script>

<div class="settings-form settings-fill" role="group" aria-label="Advanced settings">
  <div class="settings-row">
    <span class="settings-label">Shell environment</span>
    <div class="gen-control">
      <!-- busy, it keeps its place and the keyboard (a `disabled` button drops the focus out of the sheet, and Esc with it) -->
      <button class="button" aria-disabled={settingsUi.envReload.state === 'running'} onclick={reloadEnv}>Reload shell environment</button>
    </div>
    <span class="settings-help" role="status" data-env-reload={settingsUi.envReload.state}>{envReloadText(settingsUi.envReload)}</span>
  </div>

  <div class="settings-row column">
    <div class="settings-list-head">
      <span class="settings-label" id="holders-label">Running background processes</span>
      <button class="link-button" onclick={() => void load()}>Refresh</button>
    </div>
    <span class="settings-help">Every terminal Kea keeps running, as found on disk: agents, dev servers, setup scripts and shells. Quitting Kea stops them; after a crash they are still here.</span>
    {#if holders === null}
      <span class="settings-help">Reading…</span>
    {:else if holders.length === 0}
      <span class="settings-help" data-holders="none">Nothing is running.</span>
    {:else}
      <ul class="sheet-rows settings-holders" aria-labelledby="holders-label">
        {#each holders as h (h.ptyId)}
          <li class="sheet-row" data-holder={h.ptyId}>
            <span class="sheet-row-title">{sessionName(h.sessionId)}</span>
            <span class="sheet-row-meta">{kindText(h.kind)}{h.exited ? ' · ended' : ''}{h.orphan ? ' · orphaned' : ''}</span>
            <code class="sheet-row-meta">pid {h.childPid ?? h.pid ?? '?'}</code>
            <span class="sheet-row-meta">{uptimeText(h.startedAt, readAt)}</span>
            <button class="button danger" disabled={busy.has(h.ptyId)} aria-label="Terminate {kindText(h.kind)} of {sessionName(h.sessionId)}, pid {h.childPid ?? h.pid ?? 'unknown'}" onclick={() => void act(h.ptyId, 'terminate')}>Terminate</button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if orphans.length > 0}
    <div class="settings-row column">
      <span class="settings-label" id="orphans-label">Orphaned holders</span>
      <span class="settings-help">Running terminals that no session accounts for.</span>
      <ul class="sheet-rows settings-holders" aria-labelledby="orphans-label">
        {#each orphans as o (o.ptyId)}
          <li class="sheet-row" data-orphan={o.ptyId}>
            <code class="sheet-row-title">{o.argv.join(' ') || o.ptyId}</code>
            <span class="sheet-row-meta">{sessionName(o.sessionId)} · {kindText(o.kind)}</span>
            <code class="sheet-row-meta">pid {o.holderPid ?? '?'}</code>
            {#if o.canAdopt}
              <button class="button" disabled={busy.has(o.ptyId)} onclick={() => void act(o.ptyId, 'adopt')}>Adopt as shell</button>
            {/if}
            <button class="button danger" disabled={busy.has(o.ptyId)} onclick={() => void act(o.ptyId, 'terminate')}>Terminate</button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <div class="settings-row">
    <span class="settings-label">Window</span>
    <div class="gen-control">
      <button
        class="button"
        onclick={() => {
          setLayout(() => DEFAULT_LAYOUT)
          layoutReset = true
        }}>Reset window layout</button
      >
    </div>
    {#if layoutReset}
      <span class="settings-help" role="status">The sidebar and the file panel are back at their first widths.</span>
    {/if}
  </div>

  <div class="settings-row">
    <span class="settings-label">Files</span>
    <div class="gen-control">
      <button class="button" onclick={() => openHomeItem('logs')}>Open logs folder</button>
      <button class="button" onclick={() => (commands.available('app.openReports') ? commands.run('app.openReports') : openHomeItem('reports'))}>Open reports folder</button>
    </div>
  </div>

  <DiagnosticsRow />
</div>
