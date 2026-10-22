<!-- display-only rename, 1…L.projectNameMaxChars characters; ↵ or leaving the field keeps it. -->
<script lang="ts">
  import { untrack } from 'svelte'
  import { L, type Project } from '@kea/protocol'
  import { call } from '../../lib/rpc.ts'
  import { failed } from './state.svelte.ts'

  let { project }: { project: Project } = $props()
  let name = $state(untrack(() => project.name))

  async function commit(): Promise<void> {
    const n = name.trim()
    if (!n || n === project.name) {
      name = project.name
      return
    }
    try {
      await call('projects.rename', { id: project.id, name: n })
    } catch (e) {
      name = project.name
      failed("Couldn't rename the project", e)
    }
  }
</script>

<label class="settings-row">
  <span class="settings-label">Name</span>
  <input
    class="field"
    value={name}
    maxlength={L.projectNameMaxChars}
    spellcheck="false"
    oninput={(e) => (name = e.currentTarget.value)}
    onblur={() => void commit()}
    onkeydown={(e) => {
      if (e.key === 'Enter') void commit()
    }}
  />
</label>
