<!--
One generated settings row: the key's label, its control, its help, "Reset" while the value differs from the default,
and the schema's message when a value was refused (never written). Everything it shows comes from the row
(`SettingRow`): this component knows control kinds, not keys. A change applies at once (no Save button): a switch and a
select as they change, a text-like control when it is left or ↵ is pressed.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import type { SettingRow } from '@kea/protocol'
  import { isModified, parseText, refusal, rowId, shownText } from './model.ts'

  let p: {
    row: SettingRow
    value: unknown
    options: readonly { value: string; label: string }[]
    /** Write the value; rejects with core's refusal. */
    onSet(value: unknown): Promise<unknown>
    /** Back to the default (the key leaves the file). */
    onReset(): Promise<unknown>
  } = $props()

  const id = $derived(rowId(p.row))
  const modified = $derived(isModified(p.row, p.value))
  const shown = $derived(shownText(p.row, p.value))
  let text = $state(untrack(() => shown))
  let error = $state<string | null>(null)
  // the control follows the stored value whenever that changes (an edit of the file, a reset, another window)
  $effect(() => {
    text = shown
    untrack(() => (error = null))
  })
  const describedBy = $derived([p.row.help ? `${id}-help` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined)

  async function apply(change: () => Promise<unknown>): Promise<void> {
    try {
      await change()
      error = null
    } catch (e) {
      error = refusal(p.row, e)
    }
  }

  function commit(): void {
    if (text === shown) {
      error = null
      return
    }
    const r = parseText(p.row, text)
    if ('error' in r) error = r.error
    else if ('reset' in r) void apply(p.onReset)
    else void apply(() => p.onSet(r.value))
  }

  function reset(): void {
    void apply(p.onReset).then(() => (text = shown))
  }
</script>

<div class="settings-row gen-row" data-setting={p.row.fullKey}>
  <label class="settings-label" for={id}>{p.row.label}</label>
  <div class="gen-control">
    {#if p.row.control === 'toggle'}
      <input
        {id}
        type="checkbox"
        role="switch"
        checked={p.value === true}
        aria-describedby={describedBy}
        onchange={(e) => {
          const on = e.currentTarget.checked
          // the switch shows the stored value; it changes when core's store does
          e.currentTarget.checked = p.value === true
          void apply(() => p.onSet(on))
        }}
      />
    {:else if p.row.control === 'select'}
      {@const current = typeof p.value === 'string' ? p.value : ''}
      <select
        {id}
        class="field"
        value={current}
        aria-describedby={describedBy}
        aria-invalid={error ? 'true' : undefined}
        onchange={(e) => {
          const next = e.currentTarget.value
          e.currentTarget.value = current
          void apply(() => p.onSet(next))
        }}
      >
        {#each p.options as o (o.value)}
          <option value={o.value}>{o.label}</option>
        {/each}
        {#if !p.options.some((o) => o.value === current)}
          <!-- a value the list does not know (an adapter that is gone): shown as it is, never silently another -->
          <option value={current}>{current}</option>
        {/if}
      </select>
    {:else if p.row.control === 'list' || p.row.control === 'map'}
      <textarea
        {id}
        class="field mono"
        rows="3"
        spellcheck="false"
        value={text}
        placeholder={p.row.control === 'map' ? 'NAME=value' : ''}
        aria-describedby={describedBy}
        aria-invalid={error ? 'true' : undefined}
        oninput={(e) => (text = e.currentTarget.value)}
        onblur={commit}
      ></textarea>
    {:else if p.row.control === 'number'}
      <input
        {id}
        class="field gen-number"
        type="number"
        min={p.row.min}
        max={p.row.max}
        step={p.row.integer ? 1 : 'any'}
        value={text}
        aria-describedby={describedBy}
        aria-invalid={error ? 'true' : undefined}
        oninput={(e) => (text = e.currentTarget.value)}
        onblur={commit}
        onkeydown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    {:else if p.row.control === 'text' || p.row.control === 'path'}
      <input
        {id}
        class="field{p.row.control === 'path' ? ' mono' : ''}"
        spellcheck="false"
        maxlength={p.row.maxLength}
        value={text}
        aria-describedby={describedBy}
        aria-invalid={error ? 'true' : undefined}
        oninput={(e) => (text = e.currentTarget.value)}
        onblur={commit}
        onkeydown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    {/if}
    {#if modified}
      <button class="link-button gen-reset" aria-label="Reset {p.row.label} to its default" onclick={reset}>Reset</button>
    {/if}
  </div>
  {#if p.row.help}
    <span class="settings-help" id="{id}-help">{p.row.help}</span>
  {/if}
  {#if p.row.onNote && modified}
    <span class="settings-help gen-note" role="status">{p.row.onNote}</span>
  {/if}
  {#if error}
    <span class="settings-help gen-error" role="alert" id="{id}-error">{error}</span>
  {/if}
</div>
