<!--
The main header's diff stat (the first control on the right, `+182 −40` in mono): the lines this session added and
removed in the active scope (it follows the scope, as the decorations do); `2 files` where no line was counted (only
renames or binary files changed). A click shows the file panel's Changes. Nothing is drawn while the session has no
changes, or its folder is not a repository.
-->
<script lang="ts">
  import { commands } from '../commands/registry.ts'
  import { diffStat } from './changes.ts'
  import './files.css'
  import { filesModel } from './model.ts'
  import { panel } from './state.svelte.ts'

  // the session whose header this is
  let { sessionId }: { sessionId: string } = $props()

  const stat = $derived.by(() => {
    void panel.version
    return filesModel.sessionId === sessionId && filesModel.isGit ? diffStat(filesModel.gitHead) : null
  })

  // the click takes the keyboard out of the panel first, so Show Changes shows it (it hides only a panel it is pressed in)
  const showChanges = (): void => void commands.run('files.showChanges')
</script>

{#if stat}
  <button class="quiet-button diff-stat" aria-label={stat.label} data-command="files.showChanges" onclick={showChanges}>
    {#if stat.added !== null && stat.removed !== null}
      <span class="add">{stat.added}</span>
      <span class="del">{stat.removed}</span>
    {:else}
      <!-- only renames or binary files: the count of files, never `+0 −0` -->
      <span class="files">{stat.files}</span>
    {/if}
  </button>
{/if}
