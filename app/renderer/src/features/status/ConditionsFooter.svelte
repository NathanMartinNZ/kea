<!--
The sidebar footer's account-condition lines: one line per condition while it lasts, in
`--type-secondary` and `--text-3`, led by a `--size-dot` `--warn` dot — `Claude Code · limited until 15:00`
(`limited since 14:02` without a reset time, `signed out — run claude auth login` with the agent's login command,
`billing problem`) — and, once a usage limit has reset, a quiet **Continue all**, which types `continue` into each
session it held: only on that click. Nothing else. Each line is a `status` named by its text; the button is
"Continue all". In a compact sidebar the text, cut short, has its full wording as a tooltip.
-->
<script lang="ts">
  import { conditionText } from '@kea/protocol'
  import { External } from '../../lib/reactive.svelte.ts'
  import { sidebarCompact } from '../../shell/layoutStore.svelte.ts'
  import { commands } from '../commands/registry.ts'
  import { agentName, agents, conditions } from './state.ts'

  const list = new External(conditions.subscribeList, () => conditions.values())
  const names = new External(agents.subscribeList, () => agents.listVersion)
  const lines = $derived.by(() => {
    void names.current
    return [...list.current].sort((a, b) => a.since - b.since).map((c) => ({ agent: c.agent, text: `${agentName(c.agent)} · ${conditionText(c, agents.get(c.agent)?.loginCommand)}`, reset: c.state === 'reset' }))
  })
  const keepFocus = (e: MouseEvent) => e.preventDefault()
</script>

{#each lines as l (l.agent)}
  <div class="condition-line" role="status" aria-label={l.text}>
    <span class="condition-dot" aria-hidden="true"></span>
    <span class="condition-text" data-tip={sidebarCompact() ? l.text : undefined}>{l.text}</span>
    {#if l.reset}
      <button class="quiet-button condition-action" onmousedown={keepFocus} onclick={() => commands.run('session.continueAll', { agent: l.agent })}>Continue all</button>
    {/if}
  </div>
{/each}
