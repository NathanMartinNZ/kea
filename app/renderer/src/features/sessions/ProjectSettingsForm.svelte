<!--
One project's settings, following its row: the project's name and every `ProjectSettings` field (projectSettings.ts),
each applied as soon as it changes (no Save button): `projects.rename` for the name, `projects.updateSettings` for the
rest (`set` a value, `unset` an emptied one). Learned values are shown, not edited (`serverPorts`); the composer keeps
`lastLaunch` itself. Orphaned worktrees can be adopted or removed here. It is the body of Settings › Projects
(features/settings/ProjectsPage.svelte), which picks the project and closes with the sheet; a `group` named "Project
settings", every field a labelled control.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import type { ProjectSettings } from '@kea/protocol'
  import { call } from '../../lib/rpc.ts'
  import { External } from '../../lib/reactive.svelte.ts'
  import { midPath } from '../files/changes.ts'
  import FieldRow from './FieldRow.svelte'
  import NameRow from './NameRow.svelte'
  import Orphans from './Orphans.svelte'
  import { fieldChange, PROJECT_FIELDS } from './projectSettings.ts'
  import { failed, projects } from './state.svelte.ts'

  let { projectId }: { projectId: string } = $props()
  // fixed for this mount (the page keys it)
  const id = untrack(() => projectId)
  const row = new External(
    (cb) => projects.subscribeRow(id, cb),
    () => projects.get(id),
  )
  const p = $derived(row.current)

  // git's fsmonitor is not offered for a folder on a network volume (core knows the volumes)
  let fsmonitorOffered = $state(true)
  $effect(() => {
    untrack(() => {
      call('files.fsmonitorOffered', { projectId: id }).then(
        (r) => {
          fsmonitorOffered = r.offered
        },
        () => undefined,
      )
    })
  })
  const fields = $derived(fsmonitorOffered ? PROJECT_FIELDS : PROJECT_FIELDS.filter((f) => f.key !== 'useFsmonitor'))

  async function update(key: keyof ProjectSettings, value: unknown): Promise<void> {
    try {
      await call('projects.updateSettings', { id, ...fieldChange(key, value) })
    } catch (e) {
      failed("Couldn't change the project setting", e)
    }
  }
</script>

{#if p}
  <div class="settings-form" role="group" aria-label="Project settings">
    <h3 class="settings-heading">Project settings · {p.name}</h3>
    <NameRow project={p} />
    <div class="settings-row">
      <span class="settings-label">Folder</span>
      <!-- a path is cut in its middle: the folder's own name stays whole; the tooltip has it all -->
      <code class="settings-value path-mid" data-tip={p.rootPath}><span class="head">{midPath(p.rootPath).head}</span><span class="tail">{midPath(p.rootPath).tail}</span></code>
    </div>
    {#each fields as f (f.key)}
      <FieldRow field={f} value={p.settings[f.key]} onChange={(v) => void update(f.key, v)} />
    {/each}
    {#if p.settings.serverPorts?.length}
      <div class="settings-row">
        <span class="settings-label">Dev server ports seen</span>
        <code class="settings-value">{p.settings.serverPorts.join(', ')}</code>
      </div>
    {/if}
    {#if p.isGit}
      <Orphans projectId={p.id} />
    {/if}
  </div>
{/if}
