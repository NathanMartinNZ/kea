<!--
The composer's inline note for an agent an account condition holds: `Claude Code is limited until 15:00. A new
session may fail until then.` — or signed out (`Claude Code is signed out — run claude auth login. …`, the command from
the adapter through the `agents` row), or a billing problem. Nothing when the agent has no condition. It blocks nothing:
Start stays available. The composer (features/composer) places it under its agent row: `<ConditionNote agent={id} />`.
Locatable as `note` named by its text.
-->
<script lang="ts">
  import { conditionText } from '@kea/protocol'
  import { External } from '../../lib/reactive.svelte.ts'
  import { agentName, agents, conditions } from './state.ts'

  let { agent }: { agent: string } = $props()
  // the conditions copy's list changes with any of its rows (its structure is the whole row), so the agent can change too
  const list = new External(conditions.subscribeList, () => conditions.listVersion)
  const names = new External(agents.subscribeList, () => agents.listVersion)
  const text = $derived.by(() => {
    void list.current
    void names.current
    const c = conditions.get(agent)
    if (!c) return null
    const name = agentName(c.agent)
    if (c.kind === 'auth') {
      const login = agents.get(c.agent)?.loginCommand
      return login ? `${name} is ${conditionText(c, login)}. A new session may fail until then.` : `${name} is signed out. A new session may fail until you sign in again.`
    }
    if (c.kind === 'billing') return `${name} has a billing problem. A new session may fail until it is fixed.`
    if (c.state === 'reset') return `${name}'s usage limit has reset.`
    return `${name} is ${conditionText(c)}. A new session may fail until then.`
  })
</script>

{#if text}
  <p class="condition-note" role="note" aria-label={text}><span class="condition-dot" aria-hidden="true"></span>{text}</p>
{/if}
