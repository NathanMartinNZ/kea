<!-- Worktrees under a Kea worktree root that no session owns, each to adopt or remove. -->
<script lang="ts">
  import { untrack } from 'svelte'
  import type { OrphanWorktree } from '@kea/protocol'
  import { call } from '../../lib/rpc.ts'
  import { failed, ui } from './state.svelte.ts'

  let { projectId }: { projectId: string } = $props()
  let list = $state.raw<OrphanWorktree[] | null>(null)

  function load(id: string, refresh: boolean): Promise<void> {
    return call('worktrees.orphans', { projectId: id, ...(refresh ? { refresh: true } : {}) })
      .then((r) => {
        list = r.orphans
      })
      .catch(() => {
        list = []
      })
  }

  $effect(() => {
    const id = projectId
    untrack(() => void load(id, false))
  })

  async function act(path: string, how: 'adopt' | 'remove'): Promise<void> {
    const id = projectId
    try {
      if (how === 'adopt') await call('worktrees.adopt', { projectId: id, path })
      else {
        const r = await call('worktrees.remove', { projectId: id, path })
        if (!r.removed && (r.dirty > 0 || r.statusFailed)) {
          // Never removed with work in it unless the user saw it; a status that fails counts as work (fails closed)
          const why = r.statusFailed ? 'git cannot list its changes' : `it has ${r.dirty} uncommitted ${r.dirty === 1 ? 'change' : 'changes'}`
          ui.toast = { message: `${path} was not removed: ${why}.`, action: { label: 'Remove anyway', run: () => void call('worktrees.remove', { projectId: id, path, force: true }).then(() => load(id, true)) } }
        }
      }
      await load(id, true)
    } catch (e) {
      failed(how === 'adopt' ? "Couldn't adopt the worktree" : "Couldn't remove the worktree", e)
    }
  }
</script>

{#if list && list.length > 0}
  <div class="settings-row column">
    <span class="settings-label">Orphaned worktrees</span>
    <ul class="sheet-rows" aria-label="Orphaned worktrees">
      {#each list as o (o.path)}
        <li class="sheet-row">
          <code class="sheet-row-title">{o.path}</code>
          {#if o.branch}
            <code class="sheet-row-meta">{o.branch}</code>
          {/if}
          <button class="button" onclick={() => void act(o.path, 'adopt')}>Adopt</button>
          <button class="button danger" onclick={() => void act(o.path, 'remove')}>Remove</button>
        </li>
      {/each}
    </ul>
  </div>
{/if}
