<!--
A generated Settings section (General, Terminal, Notifications, Files): the schema's rows for `section`, each showing
its effective value from the window's settings store and written through core's one-key write (`settings.set` /
`settings.reset`), which applies it at once. The rows are core's (`settings.describe`: as this system offers
them); until core answers, the window's own (`settingRows([])`: every key but the adapters', less what
this system never has). `children` is what a section adds above its rows (Terminal's theme preview) and `after` below
them (Notifications' link to macOS).
-->
<script lang="ts" module>
  import { settingRows, type SettingRow, type SettingsSection } from '@kea/protocol'

  /** Every global key's row: the schema itself, read once; drawn until core describes this system's rows. */
  const ROWS: readonly SettingRow[] = settingRows([])
</script>

<script lang="ts">
  import { untrack, type Snippet } from 'svelte'
  import { External } from '../../lib/reactive.svelte.ts'
  import { call } from '../../lib/rpc.ts'
  import { agentList, agents, installAgents } from '../composer/agents.ts'
  import { sectionRows } from './model.ts'
  import Rows from './Rows.svelte'
  import { describedNow, describeSettings } from './state.svelte.ts'
  import { settings } from './store.ts'

  let p: { section: SettingsSection; children?: Snippet; after?: Snippet } = $props()

  installAgents()
  const values = new External(settings.subscribe, () => settings.values)
  const adapters = new External(agents.subscribeAny, () => agentList(agents.values().map((a) => agents.get(a.id) ?? a)))
  let offered = $state.raw<readonly SettingRow[]>(describedNow()?.rows ?? ROWS)
  $effect(() => {
    let live = true
    untrack(() => {
      describeSettings().then(
        (d) => {
          if (live) offered = d.rows
        },
        () => {}, // core did not answer: the window's own rows stay
      )
    })
    return () => {
      live = false
    }
  })
  const rows = $derived(sectionRows(offered, p.section))
</script>

<div class="settings-form" role="group" aria-label="{p.section} settings">
  {@render p.children?.()}
  <Rows
    {rows}
    value={(key) => values.current.get(key)}
    agents={adapters.current}
    onSet={(row, value) => call('settings.set', { key: row.fullKey, value })}
    onReset={(row) => call('settings.reset', { key: row.fullKey })}
  />
  {@render p.after?.()}
</div>
