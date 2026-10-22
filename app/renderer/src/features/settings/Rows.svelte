<!--
The rows of a generated section or of an agent's card: one `Row` per `SettingRow`, in the order given.
Nothing is laid out by hand: what it draws is the list it is given, which comes from the schema (U-SET-6).
-->
<script lang="ts">
  import type { SettingRow } from '@kea/protocol'
  import { optionsOf } from './model.ts'
  import Row from './Row.svelte'

  let p: {
    rows: readonly SettingRow[]
    /** A key's effective value. */
    value(fullKey: string): unknown
    /** The registered adapters (a select that names one). */
    agents: readonly { id: string; displayName: string }[]
    onSet(row: SettingRow, value: unknown): Promise<unknown>
    onReset(row: SettingRow): Promise<unknown>
  } = $props()
</script>

{#each p.rows as row (row.fullKey)}
  <Row {row} value={p.value(row.fullKey)} options={optionsOf(row, p.agents)} onSet={(v) => p.onSet(row, v)} onReset={() => p.onReset(row)} />
{/each}
