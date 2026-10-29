<!--
The main pane on a session: its terminals, its creation or what keeps it from running, each as a status strip over the
tab strip:

  creating    the steps and the creation log; once setup runs, its `Setup` tab instead, with Skip
  setup       failed: Retry, and Start agent anyway while the agent waits for it
  missing     Worktree missing: Recreate from branch · Delete session
  teardown    Teardown failed: Retry teardown · View log
  archived    Archived: Unarchive; nothing runs, the last screens stay readable

A detached session's Agent tab shows its last screen dimmed with the detached overlay over it: what ended · Resume ↵ ·
Restart ⌘↵; so does a detached session with no Agent tab left. Where the agent is beside the work pane (the split), the
agent pane draws the overlay, once, and the work pane never does. An agent started or restarted from here is sized to
the pane it will show in (`agentGrid.ts`).

Mounted per session (MainPane.svelte keys it), following that session's row.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import type { SessionView } from '@kea/protocol'
  import { call } from '../lib/rpc.ts'
  import { External } from '../lib/reactive.svelte.ts'
  import { sessionCall } from '../features/sessions/actions.ts'
  import CreationFailed from '../features/sessions/CreationFailed.svelte'
  import { failed, sessions, terminalsList, ui } from '../features/sessions/state.svelte.ts'
  import { agentGrid } from './agentGrid.ts'
  import CreationLog from './CreationLog.svelte'
  import CreationView from './CreationView.svelte'
  import DetachedOverlay from './DetachedOverlay.svelte'
  import TerminalPane from './TerminalPane.svelte'

  let { id: idProp }: { id: string } = $props()
  const id = untrack(() => idProp)
  const row = new External(
    (cb) => sessions.subscribeRow(id, cb),
    () => sessions.get(id),
  )
  const s = $derived(row.current)
  const listVersion = new External(terminalsList.subscribeList, () => terminalsList.listVersion)
  /** How the session's agent PTY ended (its exit code says what crashed); null while none is recorded. */
  const agentExit = $derived.by(() => {
    void listVersion.current
    const t = terminalsList.values().find((x) => x.sessionId === id && x.kind === 'agent')
    return t ? { code: t.exitCode, signal: t.exitSignal } : null
  })

  /** ⌘T: a session that runs, or can run, in its own directory. */
  function shellAllowed(v: SessionView): boolean {
    return (v.lifecycle === 'live' || v.lifecycle === 'detached') && !v.worktreeMissing
  }

  function whyNoShell(v: SessionView): string {
    if (v.lifecycle === 'archived') return 'Unarchive the session first'
    if (v.worktreeMissing) return 'The worktree is missing'
    return 'The session is not running yet'
  }

  /** The setup strip's Skip, Retry and Start agent anyway; each sends the agent's grid (its pane's in the split). */
  async function setupAction(action: 'skip' | 'retry' | 'startAnyway'): Promise<void> {
    const grid = agentGrid()
    try {
      await call('sessions.setup', { id, action, ...(grid ? { grid } : {}) })
    } catch (e) {
      failed(action === 'retry' ? "Couldn't run the setup again" : "Couldn't start the agent", e)
    }
  }

  const viewLog = () => {
    ui.sheet = { kind: 'log', sessionId: id, title: s?.title ?? '' }
  }
</script>

{#if !s || (s.lifecycle === 'creating' && !s.setup?.ptyId)}
  <CreationView {id} step={s ? (s.creation?.step ?? null) : null} logBytes={s?.creation?.logBytes ?? 0} notices={s?.creation?.notices ?? []} />
{:else if s.lifecycle === 'create_failed'}
  <div class="pane-scroll">
    <CreationFailed {id} error={s.creation?.error ?? null} />
    <CreationLog {id} logBytes={s.creation?.logBytes ?? 0} />
  </div>
{:else}
  {@const setup = s.setup}
  {@const waiting = s.lifecycle === 'creating'}
  <div class="session-pane">
    {#if setup && waiting && setup.state === 'running'}
      <div class="pane-strip" role="status">
        <span>Setup is running; the agent starts when it finishes.</span>
        <button class="button" onclick={() => void setupAction('skip')}>Skip</button>
      </div>
    {:else if setup?.state === 'failed'}
      <div class="pane-strip" role="status">
        <span>Setup failed{setup.exitCode !== null ? ` (exit ${setup.exitCode})` : ''}.</span>
        <button class="button" onclick={() => void setupAction('retry')}>Retry</button>
        {#if waiting}
          <button class="button" onclick={() => void setupAction('startAnyway')}>Start agent anyway</button>
        {/if}
        <button class="button" onclick={viewLog}>View log</button>
        {#if waiting}
          <!-- The creation is not done; Discard runs the teardown, then rolls it back -->
          <button class="button danger" onclick={() => void sessionCall('sessions.discard', id, 'discard the session')}>Discard</button>
        {/if}
      </div>
    {/if}
    {#if s.worktreeMissing}
      <div class="pane-strip" role="status">
        <span>Worktree missing.</span>
        <button class="button" onclick={() => void sessionCall('sessions.recreateWorktree', id, 'recreate the worktree')}>Recreate from branch</button>
        <button class="button danger" onclick={() => (ui.sheet = { kind: 'delete', sessionId: id })}>Delete session</button>
      </div>
    {/if}
    {#if s.teardownFailed}
      <div class="pane-strip" role="status">
        <span>Teardown failed.</span>
        <button class="button" onclick={() => void sessionCall('sessions.retryTeardown', id, 'run the teardown again')}>Retry teardown</button>
        <button class="button" onclick={viewLog}>View log</button>
      </div>
    {/if}
    {#if s.lifecycle === 'archived'}
      <div class="pane-strip" role="status">
        <span>Archived. Its worktree and branch are kept.</span>
        <button class="button" onclick={() => void sessionCall('sessions.unarchive', id, 'unarchive the session')}>Unarchive</button>
      </div>
    {/if}
    <TerminalPane context={id} canOpenShell={shellAllowed(s)} whyNoShell={whyNoShell(s)} scriptTab={setup?.ptyId ?? null}>
      {#snippet overlay(tab)}
        {#if s.lifecycle === 'detached' && !s.worktreeMissing && (tab.kind === 'agent' || tab.kind === null)}
          <DetachedOverlay reason={s.endReason} exit={agentExit} />
        {/if}
      {/snippet}
    </TerminalPane>
  </div>
{/if}
