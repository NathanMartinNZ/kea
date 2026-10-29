<!--
The file tree's name field: New File…, New Folder… (in the pending row's place) and Rename… (over the row). Drawn by
the tree inside its sizer at the row's place, never in the reused rows. Its keys are its own: nothing it gets reaches
the tree (type-ahead, the panel's keys), and `Esc` is not the window's. When it commits or cancels is `edit.ts`'s
`fieldAction`: `↵` commits; a press outside it or the keyboard moving elsewhere in the window commits a valid name and
cancels any other; `Esc`, another session and the panel leaving Files cancel; a menu or a sheet over it, and the window
losing the keyboard, change nothing. A name core refuses as invalid or taken is said under the field, which stays for
another try; any other refusal closes it with a toast. Locatable as a `textbox` named for what it does ("New file in
src", "Rename a.ts").
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { checkName } from '@kea/protocol'
  import { Icon } from '@kea/ui'
  import { sessions } from '../sessions/state.svelte.ts'
  import { fieldAction, parentOf, refusedInline, startName, stem, type FieldEvent } from './edit.ts'
  import { create, focusList, refused, rename } from './operations.ts'
  import { endEdit, type EditAsk } from './state.svelte.ts'

  // the tree draws one field per ask (`{#key}`): what the ask says holds for the field's life
  let { ask, depth }: { ask: EditAsk; depth: number } = $props()

  const renaming = $derived(ask.kind === 'rename')
  const dir = $derived(ask.kind === 'new' ? ask.dir : parentOf(ask.path))
  const isDir = $derived(ask.kind === 'new' ? ask.entry === 'dir' : ask.dir)
  const first = $derived(startName(ask.kind === 'rename' ? ask.path : null))
  const label = $derived.by(() => {
    if (ask.kind === 'rename') return `Rename ${first}`
    const top = (sessions.get(ask.sessionId)?.cwd ?? '').replace(/\/+$/, '')
    const where = dir === '' ? top.slice(top.lastIndexOf('/') + 1) || 'the session’s folder' : dir.slice(dir.lastIndexOf('/') + 1)
    return `New ${ask.entry === 'file' ? 'file' : 'folder'} in ${where}`
  })
  const msgId = `ft-edit-msg-${Math.random().toString(36).slice(2)}`

  let name = $state(untrack(() => first))
  let message = $state<string | null>(null)
  /** The last name core refused as invalid or taken: not sent again as it is. */
  let refusedName: string | null = null
  let sending = false
  let root: HTMLDivElement | undefined = $state()
  let input: HTMLInputElement | undefined = $state()

  $effect(() => {
    untrack(() => {
      input?.focus({ preventScroll: true })
      const [a, b] = stem(first, isDir)
      input?.setSelectionRange(a, b)
    })
  })

  /** Inside the field or its message, or in a menu or a sheet over it (those never commit nor cancel it). */
  const placeOf = (t: EventTarget | null): { inside: boolean; layer: boolean } => {
    const el = t instanceof Element ? t : null
    return { inside: !!el && !!root?.contains(el), layer: !!el?.closest('[role=menu], [role=alertdialog], [role=dialog]') }
  }

  function act(e: FieldEvent): void {
    const a = fieldAction(e, name, { nested: !renaming, dir, refused: refusedName })
    if (a === 'commit') void commit()
    else if (a === 'cancel') cancel(e.kind === 'escape')
  }

  function cancel(refocus: boolean): void {
    const had = !!root?.contains(document.activeElement)
    endEdit()
    if (refocus && had) focusList()
  }

  async function commit(): Promise<void> {
    if (sending) return
    const checked = checkName(name, { nested: !renaming, dir })
    if (!checked.ok) {
      message = checked.reason
      return
    }
    if (renaming && name === first) return cancel(true)
    if (name === refusedName) return
    sending = true
    // the keyboard goes back to the list when the field had it (↵), not after a click into a terminal
    const began = !!root?.contains(document.activeElement)
    const r = ask.kind === 'rename' ? await rename(ask.sessionId, ask.path, name, began) : await create(ask.sessionId, ask.dir, name, ask.entry, began)
    sending = false
    if (r === null) return endEdit()
    if (r.ok) return endEdit()
    const inline = refusedInline(r)
    if (inline !== null && root?.isConnected) {
      refusedName = name
      message = inline
      return
    }
    endEdit()
    refused(ask.kind === 'rename' ? "Couldn't rename" : ask.entry === 'file' ? "Couldn't make the file" : "Couldn't make the folder", r)
  }

  // a press anywhere outside it (one document listener while the field is open)
  $effect(() => {
    const onDown = (e: PointerEvent): void => act({ kind: 'press', ...placeOf(e.target) })
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  })

  function onKeyDown(e: KeyboardEvent): void {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      act({ kind: 'escape' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      act({ kind: 'enter', composing: e.isComposing })
    }
  }

  function onFocusOut(e: FocusEvent): void {
    // the window lost the keyboard: nothing; the keyboard moved to another element of it: as a press there
    if (!document.hasFocus()) return act({ kind: 'blur' })
    if (e.relatedTarget === null) return
    act({ kind: 'focus', ...placeOf(e.relatedTarget) })
  }

  const stop = (e: Event): void => e.stopPropagation()
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events (the field's own events are kept
  from the tree; the input is the control) -->
<div bind:this={root} class="fp-row ft-edit" style:padding-left="calc({depth} * var(--space-3) + var(--space-1))" onclick={stop} ondragstart={stop} oncut={stop} oncopy={stop} onpaste={stop} onkeydown={stop}>
  <span class="ft-chevron"></span>
  <Icon name={isDir ? 'folder' : 'file'} class="ft-glyph" />
  <input
    bind:this={input}
    class="ft-edit-input"
    type="text"
    aria-label={label}
    aria-invalid={message !== null}
    aria-describedby={message !== null ? msgId : undefined}
    spellcheck="false"
    autocomplete="off"
    value={name}
    oninput={(e) => {
      name = e.currentTarget.value
      message = null
    }}
    onkeydown={onKeyDown}
    onfocusout={onFocusOut}
  />
  {#if message !== null}
    <div id={msgId} class="ft-edit-msg" role="alert">{message}</div>
  {/if}
</div>
