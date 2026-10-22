<!-- One project setting (projectSettings.ts `Field`): a switch, a select, a text field or a list (one item per line). -->
<script lang="ts">
  import { untrack } from 'svelte'
  import { listValue, type Field } from './projectSettings.ts'

  let { field, value, onChange }: { field: Field; value: unknown; onChange(v: unknown): void } = $props()

  const shown = $derived(field.kind === 'list' ? ((value as string[] | undefined) ?? []).join('\n') : field.kind === 'toggle' ? !!value : ((value as string | undefined) ?? ''))
  let text = $state(untrack(() => shown))
  // the field follows the stored value whenever that changes
  const stored = $derived(JSON.stringify(value))
  $effect(() => {
    void stored
    text = untrack(() => shown)
  })

  function commit(): void {
    const v = field.kind === 'list' ? listValue(String(text)) : String(text).trim()
    if (JSON.stringify(v) !== JSON.stringify(field.kind === 'list' ? listValue(String(shown)) : String(shown))) onChange(v)
  }
</script>

{#if field.kind === 'toggle'}
  <label class="settings-row">
    <span class="settings-label">{field.label}</span>
    <input
      type="checkbox"
      role="switch"
      checked={!!value}
      onchange={(e) => {
        onChange(e.currentTarget.checked ? true : undefined)
        // the switch shows the stored value; it changes when core's store does
        e.currentTarget.checked = !!value
      }}
    />
    {#if field.help}
      <span class="settings-help">{field.help}</span>
    {/if}
  </label>
{:else if field.kind === 'select'}
  {@const options = field.options}
  {@const current = (value as string | undefined) ?? options[0]?.value}
  <label class="settings-row">
    <span class="settings-label">{field.label}</span>
    <select
      class="field"
      value={current}
      onchange={(e) => {
        onChange(e.currentTarget.value === options[0]?.value ? undefined : e.currentTarget.value)
        // the select shows the stored value; it changes when core's store does
        e.currentTarget.value = current ?? ''
      }}
    >
      {#each options as o (o.value)}
        <option value={o.value}>{o.label}</option>
      {/each}
    </select>
    {#if field.help}
      <span class="settings-help">{field.help}</span>
    {/if}
  </label>
{:else}
  <label class="settings-row">
    <span class="settings-label">{field.label}</span>
    {#if field.kind === 'list'}
      <textarea class="field mono" rows="3" value={String(text)} spellcheck="false" oninput={(e) => (text = e.currentTarget.value)} onblur={commit}></textarea>
    {:else}
      <input
        class="field mono"
        value={String(text)}
        spellcheck="false"
        oninput={(e) => (text = e.currentTarget.value)}
        onblur={commit}
        onkeydown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    {/if}
    {#if field.help}
      <span class="settings-help">{field.help}</span>
    {/if}
  </label>
{/if}
