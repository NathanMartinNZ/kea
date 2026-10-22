<!--
Settings › Disk: what the worktrees cost on disk. The total, then every session with a worktree of its own, largest
first: size, rebuildable share, last activity, lifecycle and branch state, with Remove build folders · Archive · Delete…
for a row or for the rows selected; a Stale filter (not viewed for `L.diskStaleDays` days); and the sessions deleted
recently, each with Restore. Remove build folders acts at once here (the row shows what it is about) and deletes the
folders for good, not into the Trash; a folder that holds a git repository is kept, and the row says so afterwards.

What it costs: core's `disk` store is followed only while this page is mounted, and core measures what is missing when
it opens (`disk.measure`). The list is capped (`L.diskViewRowsMax`, the largest first), not windowed. A row's branch
state is asked of core only when the row comes on screen, one at a time. No timer runs here: ages are as of the last
change the page saw.

Keyboard: the list is a grid with one tab stop. ↑ ↓ Home End move between rows, ← → between a row's controls; Space
ticks a row, Enter presses its button. Everything else is in the Tab order. The keyboard is never left nowhere: an
action that cannot run now is `aria-disabled` and says why (it is not removed, and not disabled under the focus), and
when the row that holds the focus goes (deleted, restored, filtered away) the focus moves to the row in its place.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { DISK_STORE, L, type DiskBranch, type DiskUsage } from '@kea/protocol'
  import { External } from '../../lib/reactive.svelte.ts'
  import { call, subscribe } from '../../lib/rpc.ts'
  import { relativeTime } from '../sessions/model.ts'
  import { deletedAgo, plural } from '../sessions/sheets.ts'
  import { failed, projects, sessionRows, sessions } from '../sessions/state.svelte.ts'
  import { archiveSessions, deleteSessions, removeBuildFolders, restoreSession } from './actions.ts'
  import './disk.css'
  import { branchText, deletedRows, diskView, keptText, lifecycleText, rowActions, shareText, sizeText, totalText, type DeletedRow, type DiskRow } from './model.ts'
  import { diskHolds, diskUi, setBusy, setSelected, toggleSelected } from './state.svelte.ts'

  // core's `disk` store as this page reads it: plain rows by session id (≤ one per session, dropped with the page)
  let disk = $state.raw<ReadonlyMap<string, DiskUsage>>(new Map())
  let loaded = $state(false)
  let now = $state(Date.now())
  // bounded: one per row that has come on screen (≤ L.diskViewRowsMax), dropped with the page and by Refresh; a row's
  // branch state is asked of core when the row first comes on screen
  let branches = $state.raw<ReadonlyMap<string, DiskBranch | null>>(new Map())
  let deleted = $state.raw<{ rows: DeletedRow[]; more: number } | null>(null)
  // bounded: one line per row whose last Remove build folders kept something (≤ L.diskViewRowsMax), dropped with the
  // page and by Refresh (counted with `renderer.diskSelected`)
  let kept = $state.raw<ReadonlyMap<string, string>>(new Map())
  /** The row that holds the grid's tab stop. */
  let focusRow = $state<string | null>(null)
  let grid: HTMLDivElement | undefined = $state()
  let root: HTMLDivElement | undefined = $state()

  const sessionList = new External(sessions.subscribeAny, () => sessionRows())
  const projectName = new External(projects.subscribeAny, () => (id: string) => projects.get(id)?.name ?? '')
  /** Every project's row as it is now (`projects.values()` is a snapshot of the list's structure: a row's count can change under it). */
  const projectRows = () => projects.values().map((p) => projects.get(p.id) ?? p)
  /** Which projects have deleted sessions to restore: the list is read again when this changes. */
  const restorable = new External(projects.subscribeAny, () =>
    projectRows()
      .map((p) => `${p.id}:${p.restorable}`)
      .join(' '),
  )

  const view = $derived(diskView(sessionList.current, disk, now, diskUi.filter))
  const tabRow = $derived(view.rows.some((r) => r.id === focusRow) ? focusRow : (view.rows[0]?.id ?? null))
  const picked = $derived(view.rows.filter((r) => diskUi.selected.has(r.id)))
  const pickedCan = $derived({
    removeBuildFolders: picked.some((r) => rowActions(r).removeBuildFolders),
    archive: picked.some((r) => rowActions(r).archive),
    delete: picked.length > 0,
  })
  const working = $derived(diskUi.busy.size > 0)

  // ── what is asked of core, in plain variables ──────────────────────────────────────────────────────
  let live = false
  /** The one observer of the rows on screen. */
  let observer: IntersectionObserver | null = null
  // bounded: ⊆ the rows drawn (≤ L.diskViewRowsMax); a row leaves when it is scrolled away or removed
  const onScreen = new Set<string>()
  // bounded: ⊆ onScreen at the time each was added; emptied as the answers come
  const wanted: string[] = []
  let asking = false
  let listing = false
  let listAgain = false
  let listedFor = ''
  /** The control that had the keyboard last, and where it stood: put back when its row goes. */
  let lastEl: HTMLElement | null = null
  let lastAt: { rows: boolean; index: number } | null = null

  async function askBranches(): Promise<void> {
    if (asking) return
    asking = true
    try {
      while (live && wanted.length > 0) {
        const id = wanted.shift()!
        if (!onScreen.has(id) || branches.has(id)) continue
        let b: DiskBranch | null = null
        try {
          b = (await call('disk.branch', { id })).branch
        } catch {
          // the row says the state is not known: a failure with a place of its own
        }
        if (!live) return
        branches = new Map(branches).set(id, b)
        diskHolds.branches = branches.size
      }
    } finally {
      asking = false
    }
  }

  function want(id: string): void {
    if (branches.has(id) || wanted.includes(id)) return
    wanted.push(id)
    void askBranches()
  }

  /** A row's element tells the observer when it comes on screen and when it leaves (an attachment: it reads no state). */
  function onScreenRow(node: HTMLElement): () => void {
    const id = node.dataset['diskRow'] ?? ''
    observer ??= new IntersectionObserver((entries) => {
      for (const e of entries) {
        const rowId = (e.target as HTMLElement).dataset['diskRow']
        if (!rowId) continue
        if (e.isIntersecting) {
          onScreen.add(rowId)
          want(rowId)
        } else onScreen.delete(rowId)
      }
    })
    diskHolds.observers = 1
    observer.observe(node)
    return () => {
      observer?.unobserve(node)
      onScreen.delete(id)
    }
  }

  async function listDeleted(): Promise<void> {
    if (listing) {
      listAgain = true
      return
    }
    listing = true
    try {
      do {
        listAgain = false
        const lists: { projectId: string; sessions: Omit<DeletedRow, 'projectId'>[] }[] = []
        let failure: unknown = null
        for (const p of projectRows()) {
          if (p.restorable === 0) continue
          try {
            lists.push({ projectId: p.id, sessions: (await call('sessions.listDeleted', { projectId: p.id })).sessions })
          } catch (e) {
            failure ??= e
          }
          if (!live) return
        }
        deleted = deletedRows(lists)
        diskHolds.deleted = deleted.rows.length
        if (failure) failed("Couldn't list the deleted sessions", failure)
      } while (listAgain && live)
    } finally {
      listing = false
    }
  }

  function measure(all: boolean): void {
    call('disk.measure', all ? { all: true } : {}).catch((e: unknown) => failed("Couldn't measure the worktrees", e))
  }

  $effect(() => {
    live = true
    const off = subscribe<DiskUsage>(DISK_STORE, (data) => {
      if (!live) return
      disk = new Map(data)
      now = Date.now()
      loaded = true
      diskHolds.rows = data.size
    })
    // What was never measured, or longer ago than its interval, is measured now
    untrack(() => measure(false))
    return () => {
      live = false
      off()
      observer?.disconnect()
      observer = null
      onScreen.clear()
      wanted.length = 0
      diskHolds.rows = 0
      diskHolds.branches = 0
      diskHolds.deleted = 0
      diskHolds.observers = 0
      diskHolds.kept = 0
      // closed for good: nothing stays selected behind a closed sheet (an action's own sheet brings the view back).
      // Written only when something is selected: a development build's Svelte records where a state was written from
      // an effect once it has been written there five times, and each record keeps the closures of that moment alive,
      // this closing page and its sheet with them (L-MEM-23: two closed Settings sheets, 350 DOM nodes, kept from then on)
      if (!diskUi.away && diskUi.selected.size > 0) setSelected([])
    }
  })

  // Recently deleted follows the projects' own count of what is restorable (a delete or a restore changes it)
  $effect(() => {
    const key = restorable.current
    untrack(() => {
      if (key === listedFor && deleted !== null) return
      listedFor = key
      void listDeleted()
    })
  })

  // a row that left the list (deleted, or filtered away) is no longer selected: an action never reaches a row not shown
  $effect(() => {
    if (!loaded) return
    const shown = new Set(view.rows.map((r) => r.id))
    untrack(() => {
      if ([...diskUi.selected].some((id) => !shown.has(id))) setSelected([...diskUi.selected].filter((id) => shown.has(id)))
    })
  })

  function refresh(): void {
    now = Date.now()
    measure(true)
    branches = new Map()
    diskHolds.branches = 0
    kept = new Map()
    diskHolds.kept = 0
    for (const id of onScreen) want(id)
    listedFor = ''
    void listDeleted()
  }

  async function restore(id: string): Promise<void> {
    if (diskUi.busy.has(id)) return
    setBusy(id, true)
    const ok = await restoreSession(id)
    setBusy(id, false)
    if (!ok || !live) return
    // its worktree is back: measured with whatever else is missing
    measure(false)
    void listDeleted()
  }

  /** Remove, then each row says what its removal left in place (a folder that holds a git repository). */
  async function removeAndSay(ids: readonly string[]): Promise<void> {
    const done = await removeBuildFolders(ids)
    if (!live) return
    const next = new Map(kept)
    for (const id of ids) {
      const text = keptText(done.get(id)?.kept ?? [])
      if (text) next.set(id, text)
      else next.delete(id)
    }
    kept = next
    diskHolds.kept = next.size
  }

  type Action = 'removeBuildFolders' | 'archive' | 'delete'
  const run = { removeBuildFolders: removeAndSay, archive: archiveSessions, delete: deleteSessions }
  const WHY_NOT: Record<Action, string> = { removeBuildFolders: 'Nothing rebuildable was found', archive: 'Already archived', delete: '' }

  /** One row's action; nothing while the row is busy or the action does not apply (the control says so). */
  function act(r: DiskRow, what: Action): void {
    if (diskUi.busy.has(r.id) || !rowActions(r)[what]) return
    void run[what]([r.id])
  }

  /** The selection's action, on the rows it applies to. */
  function actOnPicked(what: Action): void {
    if (working || !pickedCan[what]) return
    void run[what](picked.filter((r) => rowActions(r)[what]).map((r) => r.id))
  }

  function noteFocus(e: FocusEvent): void {
    const el = e.target instanceof HTMLElement ? e.target : null
    const row = el?.closest<HTMLElement>('[data-disk-row]')
    const item = row ?? el?.closest<HTMLElement>('li[data-disk-deleted]')
    lastEl = el
    lastAt = item?.parentElement ? { rows: row !== null && row !== undefined, index: [...item.parentElement.children].indexOf(item) } : null
    if (row?.dataset['diskRow']) focusRow = row.dataset['diskRow']
  }

  function noteBlur(e: FocusEvent): void {
    // the keyboard went elsewhere in the window: there is nothing to put back
    if (e.relatedTarget instanceof Node && !root?.contains(e.relatedTarget)) {
      lastEl = null
      lastAt = null
    }
  }

  /** The pointer drives now: a click on a control gives it the focus itself, and a click beside them puts nothing back. */
  function notePointer(): void {
    lastEl = null
    lastAt = null
  }

  // The lists were drawn again and the keyboard is nowhere: the control that had it moved with its row (the list was
  // sorted again: the DOM moves the row, which drops the focus), or its row went (deleted, restored, filtered away).
  // The same control takes the keyboard back, or the row now in the other's place does, so that the arrows, Tab and Esc
  // go on working.
  $effect(() => {
    void view.rows
    void deleted
    untrack(() => {
      if (!root || !lastEl) return
      if (document.activeElement && document.activeElement !== document.body) return
      if (lastEl.isConnected) {
        lastEl.focus()
        return
      }
      const at = lastAt
      lastEl = null
      lastAt = null
      const items = at ? [...root.querySelectorAll<HTMLElement>(at.rows ? '[data-disk-row]' : 'li[data-disk-deleted]')] : []
      const next = items[Math.min(at?.index ?? 0, items.length - 1)]
      ;(next?.querySelector<HTMLElement>('input, button') ?? root.querySelector<HTMLElement>('button, input'))?.focus()
    })
  })

  /** ↑ ↓ Home End between rows, ← → between a row's controls (the grid's one tab stop moves with the focus). */
  function gridKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey || !grid) return
    const at = e.target instanceof HTMLElement ? e.target : null
    const rowEl = at?.closest<HTMLElement>('[data-disk-row]')
    if (!at || !rowEl) return
    const stops = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('input, button')]
    const col = stops(rowEl).indexOf(at)
    let to: HTMLElement | undefined
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') to = stops(rowEl)[col + (e.key === 'ArrowRight' ? 1 : -1)]
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      const rows = [...grid.querySelectorAll<HTMLElement>('[data-disk-row]')]
      const i = rows.indexOf(rowEl)
      const next = rows[e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : rows.length - 1]
      if (next && next !== rowEl) {
        const s = stops(next)
        to = s[Math.min(Math.max(col, 0), s.length - 1)]
      }
    } else return
    e.preventDefault()
    to?.focus()
  }
</script>

<div bind:this={root} class="settings-form settings-fill" role="group" aria-label="Disk settings" onfocusin={noteFocus} onfocusout={noteBlur} onpointerdown={notePointer}>
  <div class="settings-row column">
    <div class="settings-list-head">
      <span class="settings-label" id="disk-label">Worktrees</span>
      <button class="link-button" data-tip="Measure every worktree again" onclick={refresh}>Refresh</button>
    </div>
    <span class="disk-total" role="status" data-disk-total>{loaded ? totalText(view.total) : 'Reading…'}</span>
    <span class="settings-help">Sizes are upper bounds: files that share disk space (APFS clones, hard links such as pnpm's) are counted in full.</span>

    {#if loaded && view.total.sessions > 0}
      <div class="disk-bar">
        <div class="segments" role="group" aria-label="Show">
          <button class="segment{diskUi.filter === 'all' ? ' on' : ''}" aria-pressed={diskUi.filter === 'all'} onclick={() => (diskUi.filter = 'all')}>All ({view.total.sessions})</button>
          <button class="segment{diskUi.filter === 'stale' ? ' on' : ''}" aria-pressed={diskUi.filter === 'stale'} data-tip="Not viewed for {plural(L.diskStaleDays, 'day', 'days')}" onclick={() => (diskUi.filter = 'stale')}
            >Stale ({view.total.stale})</button
          >
        </div>
        <label class="sheet-check disk-all">
          <input
            type="checkbox"
            checked={picked.length > 0 && picked.length === view.rows.length}
            indeterminate={picked.length > 0 && picked.length < view.rows.length}
            disabled={view.rows.length === 0}
            onchange={(e) => setSelected(e.currentTarget.checked ? view.rows.map((r) => r.id) : [])}
          />{picked.length > 0 ? `${picked.length} selected` : 'Select all'}
        </label>
        <div class="disk-actions" role="group" aria-label="The selected sessions">
          <button class="button" aria-disabled={working || !pickedCan.removeBuildFolders} onclick={() => actOnPicked('removeBuildFolders')}>Remove build folders</button>
          <button class="button" aria-disabled={working || !pickedCan.archive} onclick={() => actOnPicked('archive')}>Archive</button>
          <button class="button danger" aria-disabled={working || !pickedCan.delete} onclick={() => actOnPicked('delete')}>Delete…</button>
        </div>
      </div>
      {#if diskUi.filter === 'stale'}
        <span class="settings-help">Sessions not viewed for {plural(L.diskStaleDays, 'day', 'days')}. Auto-clean never removes one with unmerged or uncommitted work, so those stay listed here until you deal with them.</span>
      {/if}

      {#if view.rows.length === 0}
        <span class="settings-help" data-disk-rows="none">{diskUi.filter === 'stale' ? 'Every session with a worktree was viewed in that time.' : 'No session has a worktree of its own.'}</span>
      {:else}
        <!-- svelte-ignore a11y_interactive_supports_focus (the grid's one tab stop is the control of its current row) -->
        <div bind:this={grid} class="disk-rows" role="grid" aria-labelledby="disk-label" aria-rowcount={view.rows.length} onkeydown={gridKey}>
          {#each view.rows as r (r.id)}
            {@const can = rowActions(r)}
            {@const busy = diskUi.busy.has(r.id)}
            {@const tab = r.id === tabRow ? 0 : -1}
            {@const share = shareText(r)}
            <div class="disk-row" role="row" data-disk-row={r.id} data-stale={r.stale ? 'true' : undefined} aria-busy={busy} {@attach onScreenRow}>
              <span class="disk-check" role="gridcell">
                <input type="checkbox" tabindex={tab} aria-label="Select {r.title}" checked={diskUi.selected.has(r.id)} onchange={(e) => toggleSelected(r.id, e.currentTarget.checked)} />
              </span>
              <span class="disk-title" role="rowheader">{r.title}</span>
              <span class="disk-size" role="gridcell" data-disk-size>{sizeText(r)}{share ? ` · ${share}` : ''}</span>
              <span class="disk-meta" role="gridcell"
                >{projectName.current(r.projectId)} · {lifecycleText(r.lifecycle)} · {relativeTime(r.lastActivityAt, now) === 'now' ? 'active now' : `active ${relativeTime(r.lastActivityAt, now)} ago`}{r.stale ? ' · stale' : ''} ·
                <span data-disk-branch>{branchText(branches.get(r.id))}</span>{#if kept.get(r.id)}
                  · <span data-disk-kept>{kept.get(r.id)}</span>{/if}</span
              >
              <span class="disk-row-actions" role="gridcell">
                <button class="link-button" tabindex={tab} aria-disabled={busy || !can.removeBuildFolders} data-tip={can.removeBuildFolders ? undefined : WHY_NOT.removeBuildFolders} aria-label="Remove build folders of {r.title}" onclick={() => act(r, 'removeBuildFolders')}
                  >Remove build folders</button
                >
                <button class="link-button" tabindex={tab} aria-disabled={busy || !can.archive} data-tip={can.archive ? undefined : WHY_NOT.archive} aria-label="Archive {r.title}" onclick={() => act(r, 'archive')}>Archive</button>
                <button class="link-button disk-danger" tabindex={tab} aria-disabled={busy} aria-label="Delete {r.title}…" onclick={() => act(r, 'delete')}>Delete…</button>
              </span>
            </div>
          {/each}
        </div>
        {#if view.more > 0}
          <span class="settings-help" data-disk-more>{plural(view.more, 'smaller worktree is', 'smaller worktrees are')} not listed: the list shows the {L.diskViewRowsMax} largest.</span>
        {/if}
      {/if}
    {/if}
  </div>

  <div class="settings-row column">
    <span class="settings-label" id="disk-deleted-label">Recently deleted</span>
    {#if deleted === null}
      <span class="settings-help">Reading…</span>
    {:else if deleted.rows.length === 0}
      <span class="settings-help" data-disk-deleted="none">No session was deleted recently.</span>
    {:else}
      <span class="settings-help">A deleted session keeps its uncommitted changes and commits until its retention ends (General).</span>
      <ul class="sheet-rows disk-deleted" aria-labelledby="disk-deleted-label">
        {#each deleted.rows as d (d.id)}
          <li class="sheet-row" data-disk-deleted={d.id}>
            <span class="sheet-row-title">{d.title}</span>
            <span class="sheet-row-meta">{projectName.current(d.projectId)}</span>
            {#if d.branch}
              <code class="sheet-row-meta">{d.branch}</code>
            {/if}
            <span class="sheet-row-meta">{deletedAgo(d.deletedAt, now)}</span>
            <span class="sheet-row-meta">{d.isolation === 'inplace' ? 'record only' : d.snapshotFiles ? plural(d.snapshotFiles, 'changed file', 'changed files') : 'branch tip'}</span>
            <button class="button" aria-disabled={diskUi.busy.has(d.id)} aria-label="Restore {d.title}" onclick={() => void restore(d.id)}>Restore</button>
          </li>
        {/each}
      </ul>
      {#if deleted.more > 0}
        <span class="settings-help">{plural(deleted.more, 'older one is', 'older ones are')} not listed: Restore Deleted Session… in a project's menu lists them all.</span>
      {/if}
    {/if}
  </div>
</div>
