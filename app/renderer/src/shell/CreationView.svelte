<!-- The session's creation as it happens: the step running and its log. -->
<script lang="ts">
  import { CREATION_STEPS } from '@kea/protocol'
  import CreationLog from './CreationLog.svelte'

  type Step = (typeof CREATION_STEPS)[number]

  const STEP_LABEL: Record<Step, string> = {
    git: 'Finding git',
    base: 'Resolving the base',
    add: 'Adding the worktree',
    copy: 'Copying files',
    submodules: 'Submodules',
    setup: 'Setup',
    launch: 'Starting',
  }

  let { id, step, logBytes = 0, notices = [] }: { id: string; step: string | null; logBytes?: number; notices?: readonly string[] } = $props()
  const at = $derived(step ? CREATION_STEPS.indexOf(step as Step) : -1)
</script>

<div class="pane-scroll" role="status" aria-label="Creating the session">
  <ol class="creation-steps">
    {#each CREATION_STEPS as st, i (st)}
      <li class={i < at ? 'done' : i === at ? 'current' : undefined}>{STEP_LABEL[st]}</li>
    {/each}
  </ol>
  {#each notices as n (n)}
    <p class="sheet-meta">{n}</p>
  {/each}
  <CreationLog {id} {logBytes} />
</div>
