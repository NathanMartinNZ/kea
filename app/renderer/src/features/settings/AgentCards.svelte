<!--
The Agents section's cards: one per registered adapter, in registry order. A card says what core detected (the CLI's
path, its version and login state, or "Not installed" with the install command to copy), then draws that adapter's rows:
the keys every adapter has (`agents.<id>.*`), then its own extension keys. Nothing here names an agent or a key:
the cards are whatever the registry lists.
-->
<script lang="ts">
  import type { SettingRow } from '@kea/protocol'
  import { midPath } from '../files/changes.ts'
  import { agentSummary, type AgentCard } from './model.ts'
  import Rows from './Rows.svelte'

  let p: {
    cards: readonly AgentCard[]
    value(fullKey: string): unknown
    onSet(row: SettingRow, value: unknown): Promise<unknown>
    onReset(row: SettingRow): Promise<unknown>
    onCopy(text: string): void
  } = $props()
</script>

{#each p.cards as card (card.id)}
  {@const summary = agentSummary(card.info)}
  <section class="agent-card" aria-label={card.displayName} data-agent={card.id}>
    <h3 class="settings-heading">{card.displayName}</h3>
    <div class="settings-row" data-agent-state={summary.state}>
      <span class="settings-label">Command-line tool</span>
      <div class="agent-detected">
        {#if card.info?.path}
          <!-- a path is cut in its middle: the command's own name stays whole; the tooltip has it all -->
          {@const cut = midPath(card.info.path)}
          <code class="settings-value path-mid" data-tip={card.info.path}><span class="head">{cut.head}</span><span class="tail">{cut.tail}</span></code>
        {/if}
        {#each summary.lines as line (line)}
          <span>{line}</span>
        {/each}
        {#if summary.state === 'missing' && card.info?.installCommand}
          {@const install = card.info.installCommand}
          <span class="agent-command">
            <code class="settings-value">{install}</code>
            <button class="link-button" aria-label="Copy the install command for {card.displayName}" onclick={() => p.onCopy(install)}>Copy</button>
          </span>
        {/if}
        {#if summary.state === 'installed' && card.info?.loggedIn === false && card.info.loginCommand}
          {@const login = card.info.loginCommand}
          <span class="agent-command">
            <code class="settings-value">{login}</code>
            <button class="link-button" aria-label="Copy the sign-in command for {card.displayName}" onclick={() => p.onCopy(login)}>Copy</button>
          </span>
        {/if}
      </div>
    </div>
    <Rows rows={card.rows} value={p.value} agents={[]} onSet={p.onSet} onReset={p.onReset} />
  </section>
{/each}
