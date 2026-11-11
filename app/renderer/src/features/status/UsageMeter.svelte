<!--
The usage meter: the usage limits of a session's agent, `5h 25% · 7d 67%`, at the right end of the agent pane's status
row (in one column, of the tab strip while the Agent tab is shown). It shows the latest reading of the session's agent
from the `status.usage` copy; nothing while that agent has none (the setting off, another agent, no reply yet). A
window as full as the warning ratio is drawn in the warning colour, as full as the danger ratio in the danger colour.
It takes the room its row leaves and lays its parts on one line in order: a part with no room wraps out of sight, so
the weekly part gives way first, then the whole meter, and the words on the row's left never move. It does nothing on
a click. Locatable as the image named `Usage: …`; its tooltip, on each part, spells the windows out with their resets
and when they were seen, and is its accessible description too (the window's tooltip is hidden from assistive
technology).
-->
<script lang="ts">
  import { External } from '../../lib/reactive.svelte.ts'
  import { usage } from './state.ts'
  import { latestReading, usageView } from './usage.ts'

  /** The session's agent (`SessionView.agent`); null shows nothing. */
  let { agent }: { agent: string | null } = $props()

  const list = new External(usage.subscribeList, () => usage.listVersion)
  const view = $derived.by(() => {
    void list.current
    return usageView(latestReading(usage.values(), agent), Date.now())
  })
</script>

{#if view}
  <!-- svelte-ignore a11y_role_supports_aria_props (Chromium exposes aria-description on any role) -->
  <span class="usage-meter" role="img" aria-label={view.label} aria-description={view.tip}>
    <!-- an empty first item: a first part with no room wraps out of sight too, rather than being cut -->
    <span class="usage-fit"></span>
    {#each view.parts as p, i (p.id)}
      <span class="usage-part" data-window={p.id} data-tip={view.tip}
        >{#if i > 0}<span>{' · '}</span>{/if}<span class="usage-value" data-level={p.level}>{p.text}</span></span
      >
    {/each}
  </span>
{/if}
