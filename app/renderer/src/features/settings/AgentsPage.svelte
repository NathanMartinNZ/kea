<!--
Settings › Agents: a card per registered adapter (AgentCards.svelte). The rows come from core (`settings.describe`: an
adapter's own keys are in its package, which the window never loads); what core detected comes from the `agents` store,
and "Look again" detects afresh (a CLI installed or signed in while Settings is open).
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import type { SettingsDescription } from '@kea/protocol'
  import { External } from '../../lib/reactive.svelte.ts'
  import { call } from '../../lib/rpc.ts'
  import { agents, installAgents } from '../composer/agents.ts'
  import { copyText } from '../sessions/actions.ts'
  import { failed } from '../sessions/state.svelte.ts'
  import AgentCards from './AgentCards.svelte'
  import { agentCards } from './model.ts'
  import { describeSettings } from './state.svelte.ts'
  import { settings } from './store.ts'

  installAgents()
  const values = new External(settings.subscribe, () => settings.values)
  const infos = new External(agents.subscribeAny, () => agents.values().map((a) => agents.get(a.id) ?? a))
  let description = $state.raw<SettingsDescription | null>(null)
  let problem = $state<string | null>(null)
  let looking = $state(false)

  $effect(() => {
    let live = true
    untrack(() => {
      describeSettings().then(
        (d) => {
          if (live) description = d
        },
        (e: unknown) => {
          if (live) problem = e instanceof Error ? e.message : String(e)
        },
      )
    })
    return () => {
      live = false
    }
  })

  const cards = $derived(description ? agentCards(description, infos.current) : [])

  async function lookAgain(): Promise<void> {
    if (looking) return
    looking = true
    try {
      await call('agents.refresh', {})
    } catch (e) {
      failed("Couldn't look for the agents again", e)
    } finally {
      looking = false
    }
  }
</script>

<div class="settings-form" role="group" aria-label="Agents settings">
  {#if problem}
    <p class="settings-help settings-wide" role="alert">The agents' settings could not be read: {problem}</p>
  {:else if description}
    <AgentCards
      {cards}
      value={(key) => values.current.get(key)}
      onSet={(row, value) => call('settings.set', { key: row.fullKey, value })}
      onReset={(row) => call('settings.reset', { key: row.fullKey })}
      onCopy={(text) => void copyText(text)}
    />
    <div class="settings-actions">
      <!-- busy, it keeps its place and the keyboard (a `disabled` button drops the focus out of the sheet, and Esc with it) -->
      <button class="button" aria-disabled={looking} onclick={() => void lookAgain()}>Look again</button>
    </div>
  {/if}
</div>
