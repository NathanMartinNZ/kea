<!--
The Changes view: what this session changed in the active scope. A header — the scope switch `Branch` · `Uncommitted`,
the totals, the branch line (with `REBASING 2/5` / `MERGING` and a detached HEAD's short id) and the `changes ⋯` menu —
over a flat list in `changesOrder` (conflicts first, then by path), drawn only where it is on screen like the tree
(window.ts).

  click · Enter     the file's diff in the viewer (`viewer.open` as a diff); Space shows it and keeps the keyboard here
  double-click      Open in Editor at the first changed line (`openChangeInEditor`), as `⌘↵` does via the key scope
  ↑ ↓ Home End PageUp PageDown, typing a name
  right-click · ⇧F10    the `file ⌃` menu for the row

States: nothing changed → "No changes yet."; more changes than Kea tracks → that, and a manual Refresh; git did not
answer → the last status that worked, said so.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { DIFF_SCOPES, L, type DiffScope, type GitEntry } from '@kea/protocol'
  import { MoreIcon } from '@kea/ui'
  import { SIZE_PX } from '@kea/ui/tokens'
  import { commands } from '../commands/registry.ts'
  import { branchLine, branchText, changeRow, LETTER_NAMES, midPath, totalsText } from './changes.ts'
  import { openChangeInEditor } from './commands.ts'
  import { isTypeKey, listKey, typeAhead } from './keys.ts'
  import { filesModel } from './model.ts'
  import { panel } from './state.svelte.ts'
  import { pageRows, rowWindow, scrollToShow } from './window.ts'

  let { sessionId, activePath }: { sessionId: string; activePath: string | null } = $props()

  const ROW = SIZE_PX['tree-row']
  const SCOPE_LABEL: Record<DiffScope, string> = { branch: 'Branch', uncommitted: 'Uncommitted' }
  let scroller: HTMLDivElement | undefined = $state()
  let first = $state(0)
  let viewport = $state(0)

  const head = $derived.by(() => {
    void panel.version
    return filesModel.gitHead
  })
  const entries = $derived.by(() => {
    void panel.version
    return filesModel.changes
  })
  const selected = $derived.by(() => {
    void panel.version
    return filesModel.changeIndex(filesModel.ui.changes.sel)
  })
  const gitState = $derived(head?.state ?? (head ? 'ok' : 'loading'))
  const totals = $derived(totalsText(head))
  const branch = $derived(branchLine(head))
  const win = $derived(rowWindow(first * ROW, viewport, ROW, entries.length, L.treeOverscanRows))
  const shown = $derived(entries.slice(win.start, win.end).map(changeRow))

  const measure: Attachment<HTMLDivElement> = (el) => {
    const ro = new ResizeObserver(() => {
      viewport = el.clientHeight
    })
    ro.observe(el)
    viewport = el.clientHeight
    return () => ro.disconnect()
  }

  function onScroll(): void {
    if (!scroller) return
    const top = scroller.scrollTop
    const at = Math.floor(top / ROW)
    if (at !== first) first = at
    filesModel.scrolled('changes', top)
  }

  // the session's own place comes back with its list
  let placed: string | null = null
  $effect(() => {
    void panel.version
    if (!scroller || !filesModel.opened || entries.length === 0 || placed === sessionId) return
    placed = sessionId
    const top = filesModel.ui.changes.top
    untrack(() => {
      first = Math.floor(top / ROW)
      void tick().then(() => {
        if (scroller) scroller.scrollTop = top
      })
    })
  })

  function showRow(index: number): void {
    if (!scroller || index < 0) return
    const top = scrollToShow(index, scroller.scrollTop, scroller.clientHeight, ROW)
    if (top !== scroller.scrollTop) scroller.scrollTop = top
  }

  function select(index: number): void {
    const e = entries[index]
    if (!e) return
    filesModel.select('changes', e.path)
    showRow(index)
  }

  function open(e: GitEntry, focus: boolean): void {
    commands.run('viewer.open', { sessionId, path: e.path, mode: 'diff', ...(focus ? {} : { focus: false }) })
  }

  const rowAt = (e: Event): { entry: GitEntry; index: number; el: HTMLElement } | null => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-index]') : null
    const index = el ? Number(el.dataset.index) : -1
    const entry = entries[index]
    return el && entry ? { entry, index, el } : null
  }

  function onClick(e: MouseEvent): void {
    const hit = rowAt(e)
    if (!hit) return
    select(hit.index)
    if (e.detail <= 1) open(hit.entry, true)
  }

  function onDblClick(e: MouseEvent): void {
    const hit = rowAt(e)
    if (hit && hit.entry.code !== 'D') openChangeInEditor(sessionId, hit.entry.path)
  }

  function menuFor(entry: GitEntry, at: { x: number; y: number }): void {
    filesModel.select('changes', entry.path)
    panel.menu = { kind: 'file', target: { sessionId, path: entry.path, dir: false }, at }
  }

  function onContextMenu(e: MouseEvent): void {
    const hit = rowAt(e)
    if (!hit) return
    e.preventDefault()
    menuFor(hit.entry, { x: e.clientX, y: e.clientY })
  }

  let typed = ''
  let typedAt = 0

  function onKeyDown(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey) return
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      const entry = entries[selected]
      const el = scroller?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      if (!entry || !el) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      menuFor(entry, { x: r.left + r.height, y: r.bottom })
      return
    }
    if (e.altKey) return
    const a = listKey(entries.length, selected, e.key, pageRows(viewport, ROW))
    if (a) {
      e.preventDefault()
      typed = ''
      if (a.do === 'select') select(a.index)
      else if (a.do === 'open' && entries[a.index]) open(entries[a.index] as GitEntry, a.focus)
      return
    }
    if (!isTypeKey(e)) return
    const now = performance.now()
    typed = now - typedAt <= L.treeTypeaheadMs ? typed + e.key : e.key
    typedAt = now
    // by file name, as the row shows it
    const hit = typeAhead(entries.map((x) => x.path.slice(x.path.lastIndexOf('/') + 1)), selected, typed)
    if (hit >= 0) {
      e.preventDefault()
      select(hit)
    }
  }

  function openMenu(e: MouseEvent): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    panel.menu = { kind: 'changes', target: { sessionId, path: '', dir: true }, at: { x: r.right, y: r.bottom } }
  }

  const keepFocus = (e: MouseEvent) => e.preventDefault()
</script>

<div class="ch-head">
  <div class="ch-top">
    <div class="ch-scope" role="group" aria-label="Compare with">
      {#each DIFF_SCOPES as s (s)}
        <button aria-pressed={head?.scope === s} onmousedown={keepFocus} onclick={() => filesModel.setScope(s)}>{SCOPE_LABEL[s]}</button>
      {/each}
    </div>
    {#if head?.manual || gitState === 'tooMany'}
      <button class="quiet-button" data-command="files.refresh" onmousedown={keepFocus} onclick={() => filesModel.refresh()}>Refresh</button>
    {/if}
    <button class="quiet-button icon" aria-label="Changes actions" aria-haspopup="menu" data-tip="Changes actions" onmousedown={keepFocus} onclick={openMenu}><MoreIcon /></button>
  </div>
  {#if totals && gitState !== 'tooMany'}
    <div class="ch-totals" aria-label="Totals">
      <span>{totals.files}</span>
      {#if totals.added !== null || totals.removed !== null}
        <span class="numstat"><span class="add">{totals.added ?? ''}</span> <span class="del">{totals.removed ?? ''}</span></span>
      {/if}
    </div>
  {/if}
  {#if branch}
    <div class="ch-branch" aria-label="Branch" data-tip={branchText(branch)}>
      {#if branch.operation}<span class="op">{branch.operation}</span>{/if}
      <span class="name">{branch.name}</span>
      {#if branch.base}<span>← {branch.base}</span>{/if}
      {#if branch.ahead}<span data-tip="Commits since the base">{branch.ahead}</span>{/if}
      {#if branch.behind}<span data-tip="Commits on the base since this branch started">{branch.behind}</span>{/if}
    </div>
  {/if}
</div>
{#if gitState === 'tooMany'}
  <p class="fp-note top" role="status">Too many changes to track. The list is not kept up to date: use Refresh.</p>
{:else if gitState === 'unavailable'}
  <p class="fp-note top" role="status">Git did not answer. This is the last status that worked.</p>
{:else if head?.truncated}
  <p class="fp-note top" role="status">The list is incomplete: git’s output passed its size limit.</p>
{/if}
{#if entries.length === 0 && gitState === 'ok'}
  <p class="fp-note top">No changes yet.</p>
{/if}
<div
  bind:this={scroller}
  class="fp-list ch"
  role="listbox"
  tabindex="0"
  aria-label="Changes"
  aria-activedescendant={selected >= win.start && selected < win.end ? `ch-row-${selected}` : undefined}
  data-panel-focus
  data-rows={entries.length}
  onscroll={onScroll}
  onclick={onClick}
  ondblclick={onDblClick}
  oncontextmenu={onContextMenu}
  onkeydown={onKeyDown}
  {@attach measure}
>
  <div class="fp-sizer" role="none" style:height="{win.height}px">
    <div class="fp-rows" role="none" style:transform="translateY({win.offset}px)">
      {#each shown as row, i}
        {@const index = win.start + i}
        <div
          id="ch-row-{index}"
          class="fp-row ch-row git-{row.cls}{index === selected ? ' selected' : ''}{row.path === activePath ? ' active' : ''}"
          role="option"
          aria-selected={index === selected}
          data-index={index}
          data-path={row.path}
          data-git={row.letter}
        >
          <span class="fp-letter" role="img" aria-label={LETTER_NAMES[row.letter] ?? row.letter} data-tip={LETTER_NAMES[row.letter]}>{row.letter}</span>
          <span class="ch-name{row.struck ? ' struck' : ''}">{row.name}</span>
          <span class="ch-dir path-mid" data-tip={row.dir || undefined}>{#if row.dir}{@const dir = midPath(row.dir)}<span class="head">{dir.head}</span><span class="tail">{dir.tail}</span>{/if}</span>
          {#if row.added !== null || row.removed !== null}
            <span class="numstat"><span class="add">{row.added ?? ''}</span> <span class="del">{row.removed ?? ''}</span></span>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>
