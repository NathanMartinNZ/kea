<!--
The composer for a project, once the project's row has reached the window (a project just added arrives a frame
later). Mounted per project (`MainPane.svelte` keys it), so its draft and checks start fresh for each.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { External } from '../../lib/reactive.svelte.ts'
  import { projects } from '../sessions/state.svelte.ts'
  import ComposerBody from './ComposerBody.svelte'

  let { projectId, pickProject }: { projectId: string; pickProject: boolean } = $props()
  // the id is fixed for this mount
  const id = untrack(() => projectId)
  const project = new External(
    (cb) => projects.subscribeRow(id, cb),
    () => projects.get(id),
  )
</script>

{#if project.current}
  <ComposerBody project={project.current} {pickProject} />
{/if}
