<!--
The agent pane of the split: the session's Agent terminal beside the work pane, under a status row as tall as the
work pane's tab strip, so both panes' terminals start on the same line. The row shows the session's status glyph and
words (a live region: "Needs you" is announced here, since a session whose agent pane is drawn counts as viewed and no
notification comes), "Setting up" while the setup script runs before the agent, and at its right end the usage meter of
the session's agent, whose place "Copied by terminal" takes while the agent's clipboard write is shown. A click on it
gives the agent the keyboard. The detached overlay is drawn over the agent's last screen here only. A drag of files
from another app or of a file panel row over the pane where nothing takes it (no terminal yet while setup runs, the
overlay) is refused, so a folder dropped there never becomes a project. It registers no commands: the terminal pane
hosts it and activates both panes at once.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import { StatusGlyph } from '@kea/ui'
  import type { SessionGlyph } from '@kea/protocol'
  import UsageMeter from '../features/status/UsageMeter.svelte'
  import { takesDrop } from '../features/terminal/drop.ts'
  import TerminalArea from '../features/terminal/TerminalArea.svelte'

  let {
    sessionId,
    sessionAgent,
    agentTabs,
    status,
    settingUp,
    copied,
    ended,
    active,
    activate,
    claims,
    seize,
    focusAgent,
    onfocus,
    overlay,
  }: {
    sessionId: string
    /** The session's agent (`SessionView.agent`), whose usage limits the meter shows; null for none. */
    sessionAgent: string | null
    /** The Agent terminal, as the one tab of this pane (none before the agent starts). */
    agentTabs: readonly string[]
    status: { glyph: SessionGlyph; words: string } | null
    /** The setup script runs before the agent: the pane has no terminal yet. */
    settingUp: boolean
    copied: boolean
    /** The agent's terminal has ended: its last screen is dimmed. */
    ended: boolean
    /** The pane has the keyboard, or last had it: the focus line. */
    active: boolean
    activate: () => void
    claims: () => boolean
    seize: (id: string) => boolean
    focusAgent: () => void
    onfocus: () => void
    /** Laid over the agent's terminal (the detached overlay). */
    overlay?: Snippet
  } = $props()

  const agent = $derived(agentTabs[0] ?? null)
  const keepFocus = (e: MouseEvent) => e.preventDefault()

  /** A drag the terminal would take, where nothing in the pane took it: refused, so the window never adds it as a project. */
  function refuseDrop(e: DragEvent): void {
    if (e.defaultPrevented || !e.dataTransfer || !takesDrop(e.dataTransfer.types)) return
    e.preventDefault()
    if (e.type === 'dragover') e.dataTransfer.dropEffect = 'none'
  }
</script>

<section class={['agent-pane', active ? 'active' : ''].filter(Boolean).join(' ')} aria-label="Agent" data-kind="agent" data-pty={agent ?? undefined} onfocusin={onfocus}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (a pointer shortcut to the
       agent's keyboard; Focus Agent is the keyboard's way) -->
  <div class="status-row" onmousedown={keepFocus} onclick={focusAgent}>
    <span class="status-text" role="status">
      {#if settingUp}
        <span>Setting up</span>
      {:else if status}
        <StatusGlyph kind={status.glyph} label={status.words} />
        <span>{status.words}</span>
      {/if}
    </span>
    {#if copied}
      <span class="tab-note" role="status">Copied by terminal</span>
    {:else}
      <UsageMeter agent={sessionAgent} />
    {/if}
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions (only refuses drops; the terminal inside takes them) -->
  <div class={ended ? 'terminal-frame ended' : 'terminal-frame'} ondragover={refuseDrop} ondrop={refuseDrop}>
    {#if agent !== null}
      <TerminalArea tabs={agentTabs} active={agent} {sessionId} pane="agent" {activate} {claims} {seize} />
    {/if}
    {@render overlay?.()}
  </div>
</section>
