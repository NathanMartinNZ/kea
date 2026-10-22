<!--
Settings › Projects: pick a project, then every `ProjectSettings` field and its orphaned worktrees: the sessions
feature's own form (`ProjectSettingsForm`), not a second one. `project.settings` opens the sheet here with its project
picked. A project whose root has a `.worktreeinclude` is told that the file replaces its "Files to copy".
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { External } from '../../lib/reactive.svelte.ts'
  import { shortcut } from '../commands/bindings.svelte.ts'
  import { call } from '../../lib/rpc.ts'
  import ProjectSettingsForm from '../sessions/ProjectSettingsForm.svelte'
  import { contextProjectId, projects } from '../sessions/state.svelte.ts'
  import { showPage } from './state.svelte.ts'

  let p: { projectId: string | null } = $props()

  const list = new External(projects.subscribeList, () => [...projects.values()].sort((a, b) => a.sortOrder - b.sortOrder))
  /** The project picked: the one asked for while it exists, else the window's own, else the first. */
  const picked = $derived.by(() => {
    const all = list.current
    const want = p.projectId ?? untrack(contextProjectId)
    return all.find((x) => x.id === want)?.id ?? all[0]?.id ?? null
  })

  let includeFile = $state(false)
  $effect(() => {
    const id = picked
    let live = true
    includeFile = false
    if (id === null) return
    untrack(() => {
      call('worktrees.includeFile', { projectId: id }).then(
        (r) => {
          if (live) includeFile = r.exists
        },
        () => undefined,
      )
    })
    return () => {
      live = false
    }
  })
</script>

<div class="settings-projects">
  {#if picked === null}
    <p class="settings-help settings-wide">No project yet. Add one with {shortcut('project.add') ?? 'Add Project…'}.</p>
  {:else}
    <label class="settings-row">
      <span class="settings-label">Project</span>
      <select class="field" value={picked} onchange={(e) => showPage('projects', e.currentTarget.value)}>
        {#each list.current as x (x.id)}
          <option value={x.id}>{x.name}</option>
        {/each}
      </select>
    </label>
    {#key picked}
      <ProjectSettingsForm projectId={picked} />
    {/key}
    {#if includeFile}
      <p class="settings-help settings-wide" role="status" data-worktreeinclude="present">This project has a .worktreeinclude file: it decides which files are copied into new worktrees, and “Files to copy” is not used.</p>
    {/if}
  {/if}
</div>
