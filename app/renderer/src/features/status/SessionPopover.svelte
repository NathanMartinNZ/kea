<!--
The session popover, opened from the header's config summary: the launch config, then "Why this status?" — the
last journal entries in plain language with their time and source, the pending attention items, a note when only
terminal activity is known and another while a restored status waits for its agent — and the "Report wrong
status" link. The link opens a one-line picker in place ("It should be: working · needs me · finished · idle · ended",
an optional note) and says where the bundle went.

A floating layer: `--surface-4`, `--radius-lg`; Esc, a press outside, the window losing focus or the
focus leaving it close it, and focus goes back where it was. Locatable as `dialog` "Session details"; the entries as
`list` "Why this status?"; the picker as `radiogroup` "It should be", `textbox` "Note", `button` "Save report", and
`status` "Report saved".
-->
<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { EXPECTED_STATES, L, type AttentionItem, type ExpectedState, type WhyEntry } from '@kea/protocol'
  import { External } from '../../lib/reactive.svelte.ts'
  import { call } from '../../lib/rpc.ts'
  import { midPath } from '../files/changes.ts'
  import { shortcut } from '../commands/bindings.svelte.ts'
  import { copyText } from '../sessions/actions.ts'
  import { sessions } from '../sessions/state.svelte.ts'
  import { agentName, agents } from './state.ts'
  import { closePopover } from './ui.svelte.ts'

  let { sessionId, report }: { sessionId: string; report: boolean } = $props()
  const id = untrack(() => sessionId)
  const row = new External(
    (cb) => sessions.subscribeRow(id, cb),
    () => sessions.get(id),
  )
  const s = $derived(row.current)
  const agentRow = new External(agents.subscribeList, () => agents.get(s?.agent ?? ''))

  type Why = { entries: WhyEntry[]; attention: AttentionItem[]; estimated: boolean; unconfirmed: boolean }
  let why = $state.raw<Why | null>(null)
  let whyError = $state<string | null>(null)
  let picking = $state(untrack(() => report))
  let expected = $state<ExpectedState | null>(null)
  let note = $state('')
  let saving = $state(false)
  let saved = $state.raw<{ dir: string; ms: number } | null>(null)
  let saveError = $state<string | null>(null)
  let el: HTMLDivElement | undefined = $state()
  let pos = $state({ x: 0, y: 0 })
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const WORDS: Record<ExpectedState, string> = { working: 'working', needsMe: 'needs me', finished: 'finished', idle: 'idle', ended: 'ended' }

  const time = (at: number) => {
    const d = new Date(at)
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
  }

  // "Why this status?" again whenever the status it explains changes
  $effect(() => {
    void s?.phase
    void s?.lifecycle
    void s?.unread
    void s?.attention.length
    void s?.lastActivityAt
    untrack(() => {
      call('status.why', { id })
        .then((r) => {
          why = r
          whyError = null
        })
        .catch((e: unknown) => {
          whyError = e instanceof Error ? e.message : String(e)
        })
    })
  })

  // below the config summary it belongs to (a command opens it there too), kept inside the window
  $effect(() => {
    void el
    untrack(() => {
      if (!el) return
      const anchor = document.querySelector<HTMLElement>('[data-config-summary]')
      const a = anchor?.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      const x = Math.max(0, Math.min(a ? a.left : window.innerWidth - r.width, window.innerWidth - r.width))
      const y = Math.max(0, Math.min(a ? a.bottom : 0, window.innerHeight - r.height))
      pos = { x, y }
      void tick().then(() => (el?.querySelector<HTMLElement>(picking ? '[role=radio]' : '[data-autofocus]') ?? el)?.focus({ preventScroll: true }))
    })
  })

  $effect(() => () => {
    if (before?.isConnected) before.focus({ preventScroll: true })
  })

  // a press elsewhere, or the window losing focus, closes it
  $effect(() => {
    // the config summary toggles it itself
    const onDown = (e: PointerEvent) => {
      if (el && e.target instanceof Element && !el.contains(e.target) && !e.target.closest('[data-config-summary]')) closePopover()
    }
    const onBlur = () => closePopover()
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', onBlur)
    }
  })

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closePopover()
    }
  }

  function onFocusOut(e: FocusEvent): void {
    const to = e.relatedTarget
    if (el && to instanceof Node && !el.contains(to)) closePopover()
  }

  async function save(): Promise<void> {
    if (!expected || saving) return
    saving = true
    saveError = null
    try {
      saved = await call('status.report', { id, expected, ...(note.trim() ? { note: note.slice(0, L.reportNoteMaxChars) } : {}) })
      // the button it was on is gone: focus stays in the popover (Esc still closes it)
      await tick()
      el?.focus({ preventScroll: true })
    } catch (e) {
      saveError = e instanceof Error ? e.message : String(e)
    } finally {
      saving = false
    }
  }

  const config = $derived.by(() => {
    if (!s) return []
    const a = agentRow.current
    const rows: { label: string; value: string; copy?: boolean; path?: boolean }[] = [{ label: 'Agent', value: [agentName(s.agent), a?.version].filter(Boolean).join(' ') }]
    const model = s.model ?? s.launch.model
    const effort = s.effort ?? s.launch.effort
    if (model) rows.push({ label: 'Model', value: [model, effort].filter(Boolean).join(' · ') })
    const mode = s.permissionMode ?? s.launch.permissionMode
    if (mode) rows.push({ label: 'Permissions', value: mode })
    if (s.baseBranch) rows.push({ label: 'Base', value: s.baseCommit ? `${s.baseBranch} @ ${s.baseCommit.slice(0, 7)}` : s.baseBranch })
    rows.push({ label: 'Folder', value: s.cwd, copy: true, path: true })
    if (s.agentSessionId) rows.push({ label: 'Agent session', value: s.agentSessionId, copy: true })
    return rows
  })
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Esc closes the dialog; its controls take the keys) -->
<div bind:this={el} class="kea-popover session-popover" role="dialog" aria-label="Session details" tabindex="-1" style:left="{pos.x}px" style:top="{pos.y}px" onkeydown={onKeyDown} onfocusout={onFocusOut}>
  {#if s}
    <dl class="popover-config">
      {#each config as r (r.label)}
        <dt>{r.label}</dt>
        <dd>
          {#if r.path}
            <!-- a path is cut in its middle: the folder it ends in stays whole -->
            {@const cut = midPath(r.value)}
            <span class="popover-value mono path-mid" data-tip={r.value}><span class="head">{cut.head}</span><span class="tail">{cut.tail}</span></span>
          {:else}
            <span class="popover-value" class:mono={r.copy}>{r.value}</span>
          {/if}
          {#if r.copy}
            <button class="quiet-button popover-copy" aria-label={`Copy ${r.label.toLowerCase()}`} onclick={() => void copyText(r.value)}>Copy</button>
          {/if}
        </dd>
      {/each}
    </dl>
  {/if}
  <section class="popover-why">
    <h2 class="popover-heading">Why this status?</h2>
    {#if why?.unconfirmed}
      <p class="popover-note" role="note">Restored after a restart; waiting for the agent to confirm it.</p>
    {/if}
    {#if why?.estimated}
      <p class="popover-note" role="note">Status is estimated from terminal activity.</p>
    {/if}
    {#if whyError}
      <p class="popover-note">Couldn't read the status history: {whyError}</p>
    {:else if why && why.entries.length === 0}
      <p class="popover-note">Nothing recorded yet.</p>
    {:else if why}
      <ol class="popover-entries" aria-label="Why this status?">
        {#each why.entries as e, i (i)}
          <li><span class="popover-time">{time(e.at)}</span> {e.text}</li>
        {/each}
      </ol>
    {/if}
    {#if why && why.attention.length > 0}
      <ul class="popover-attention" aria-label="Waiting on you">
        {#each why.attention as a (a.key)}
          <li><span class="popover-kind">{a.kind}</span> {a.summary}</li>
        {/each}
      </ul>
    {/if}
  </section>
  <div class="popover-report">
    {#if !picking}
      <button class="quiet-button" data-autofocus onclick={() => (picking = true)}>Report wrong status… {#if shortcut('session.reportStatus')}<kbd>{shortcut('session.reportStatus')}</kbd>{/if}</button>
    {:else if saved}
      <p class="popover-saved" role="status" aria-label="Report saved">Report saved <span class="popover-value mono path-mid"><span class="head">{midPath(saved.dir).head}</span><span class="tail">{midPath(saved.dir).tail}</span></span></p>
    {:else}
      <div class="popover-picker" role="radiogroup" aria-label="It should be">
        <span class="popover-label">It should be:</span>
        {#each EXPECTED_STATES as x (x)}
          <button class="segment" class:on={expected === x} role="radio" aria-checked={expected === x} onclick={() => (expected = x)}>{WORDS[x]}</button>
        {/each}
      </div>
      <textarea class="field popover-notefield" aria-label="Note" placeholder="Note (optional)" maxlength={L.reportNoteMaxChars} rows="2" bind:value={note}></textarea>
      <div class="popover-actions">
        {#if saveError}
          <span class="popover-note">{saveError}</span>
        {/if}
        <!-- while it saves it keeps its place and the keyboard (a `disabled` button drops the focus out of the popover, and Esc with it); `save` lets one through at a time -->
        <button class="button" disabled={!expected} aria-disabled={saving} onclick={() => void save()}>Save report</button>
      </div>
    {/if}
  </div>
</div>
