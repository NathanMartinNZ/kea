<!--
The file tree: the flat rows of the plain model (model.ts, rows.ts), drawn only where they are on screen (window.ts;
every row is `--size-tree-row` high, so nothing is measured). A `tree` of `treeitem`s: the tree itself has the keyboard,
and `aria-activedescendant` names the row it is on.

  click            a file: shown in the viewer (`viewer.open`); a folder: opened or closed
  double-click     a file: opened in the editor (`openInEditor`)
  Enter · Space    as a click · a file is shown without the keyboard leaving the tree
  ↑ ↓ ← → Home End PageUp PageDown, typing a name     keys.ts
  ⌘↵               Open in Editor (the key scope `file panel`: commands.ts)
  F2 · ⌦ (Delete)  Rename… · Move to Trash: the table's `file panel` keys, which the router leaves to the tree
  the list keys    the OS layer's `listKeys`: macOS ⌘⌫ (Move to Trash); Linux Ctrl+X, C, V, Z (always kept from the page)
  right-click · ⇧F10    the `file ⌃` menu on a row; `files ⌃` (the folder's own) on the space under the rows, or with
                   no row selected
  drag             onto a folder row, a file row (its folder), the Files bar or the space under the rows (the
                   session's folder): moved there, copied with the system's copy modifier (drag.ts); onto a terminal:
                   the path is typed there (features/terminal/drop.ts). Files from other apps dropped on the tree are
                   copied into the folder under the pointer once the person says yes

The list ends with one empty row's height, so there is always space under the rows that stands for the session's
folder. The name field (New File…, New Folder…, Rename…) is drawn in the sizer at its row's place, never in the reused
rows. Rows are not keyed: as the list scrolls the same elements show other rows, so a scroll step touches only what
changed.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { L, protocolOs } from '@kea/protocol'
  import { Icon } from '@kea/ui'
  import { SIZE_PX } from '@kea/ui/tokens'
  import { chordOf, primaryDown, scopedBinding } from '../commands/keys.ts'
  import { commands } from '../commands/registry.ts'
  import { currentKeyScopes } from '../commands/scope.ts'
  import { openInEditor } from '../editor/open.ts'
  import { showToast } from '../sessions/state.svelte.ts'
  import { dragPayload } from '../terminal/drop.ts'
  import { LETTER_NAMES } from './changes.ts'
  import { dragOverFolder, dropOnFolder, edgeScroll, endDrag, leaveFolder, startRowDrag } from './drag.ts'
  import { folderOf, parentOf } from './edit.ts'
  import { isTypeKey, moreDir, toggleAction, treeKey, typeAhead, type PanelAction } from './keys.ts'
  import { filesModel } from './model.ts'
  import NameField from './NameField.svelte'
  import { pendingPath, type FlatRow } from './rows.ts'
  import { endEdit, panel } from './state.svelte.ts'
  import { pageRows, rowWindow, scrollToShow } from './window.ts'

  let { sessionId, activePath }: { sessionId: string; activePath: string | null } = $props()

  const ROW = SIZE_PX['tree-row']
  let scroller: HTMLDivElement | undefined = $state()
  /** The first row at the top of the viewport, and the viewport's height: all that scrolling changes. */
  let first = $state(0)
  let viewport = $state(0)

  const rows = $derived.by(() => {
    void panel.version
    return filesModel.rows
  })
  const selected = $derived.by(() => {
    void panel.version
    return filesModel.rowIndex(filesModel.ui.files.sel)
  })
  const win = $derived(rowWindow(first * ROW, viewport, ROW, rows.length, L.treeOverscanRows))
  const shown = $derived(rows.slice(win.start, win.end))

  /** The name field's row: the pending row of a new entry, or the row being renamed; -1 while it waits for its folder. */
  const edit = $derived(panel.edit?.sessionId === sessionId ? panel.edit : null)
  const editIndex = $derived.by(() => {
    void panel.version
    if (!edit) return -1
    return filesModel.rowIndex(edit.kind === 'new' ? pendingPath(edit.dir) : edit.path)
  })
  const editPath = $derived(edit?.kind === 'rename' ? edit.path : null)

  // the field follows its row; when the row goes (the folder or the file was removed meanwhile) the edit ends, said
  $effect(() => {
    void panel.version
    const e = edit
    const at = editIndex
    untrack(() => {
      if (!e) return
      if (at >= 0) return void showRowSoon(at)
      const anchor = e.kind === 'new' ? e.dir : e.path
      // still on its way: the folder is loading (a new entry's), or its own folder is
      if (anchor === '' || !filesModel.hasDir(parentOf(anchor)) || (e.kind === 'new' && filesModel.rowIndex(anchor) >= 0 && !filesModel.hasDir(anchor))) return
      endEdit()
      showToast({ message: e.kind === 'new' ? 'The folder is gone; nothing was made' : 'It is gone; nothing was renamed' })
    })
  })

  let shownFor = -1
  function showRowSoon(index: number): void {
    if (index === shownFor) return
    shownFor = index
    void tick().then(() => showRow(index))
  }
  $effect(() => {
    if (!edit) shownFor = -1
  })

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
    filesModel.scrolled('files', top)
  }

  // the session's own place comes back with its rows, before the frame is painted
  let placed: string | null = null
  $effect(() => {
    void panel.version
    if (!scroller || !filesModel.opened || placed === sessionId) return
    placed = sessionId
    const top = filesModel.ui.files.top
    untrack(() => {
      first = Math.floor(top / ROW)
      // once the rows have given the list its height
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

  // Reveal in File Tree (from the viewer): the row is selected by the model; bring it into view, take the keyboard
  let revealedSeen = untrack(() => filesModel.revealed)
  $effect(() => {
    void panel.version
    if (filesModel.revealed === revealedSeen) return
    revealedSeen = filesModel.revealed
    const focus = filesModel.revealFocus
    untrack(() => {
      void tick().then(() => {
        showRow(filesModel.rowIndex(filesModel.ui.files.sel))
        if (focus) scroller?.focus({ preventScroll: true })
      })
    })
  })

  function select(index: number): void {
    const row = rows[index]
    if (!row) return
    filesModel.select('files', row.path)
    showRow(index)
  }

  function open(row: FlatRow, focus: boolean): void {
    commands.run('viewer.open', { sessionId, path: row.path, mode: 'file', ...(focus ? {} : { focus: false }) })
  }

  function act(a: PanelAction): void {
    switch (a.do) {
      case 'select':
        select(a.index)
        break
      case 'expand':
        filesModel.expand(a.path)
        break
      case 'collapse':
        filesModel.collapse(a.path)
        break
      case 'showAll':
        filesModel.showAll(a.dir)
        break
      case 'open': {
        const row = rows[a.index]
        if (row) open(row, a.focus)
        break
      }
    }
  }

  const rowAt = (e: Event): { row: FlatRow; index: number; el: HTMLElement } | null => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-index]') : null
    const index = el ? Number(el.dataset.index) : -1
    const row = rows[index]
    return el && row ? { row, index, el } : null
  }

  function onClick(e: MouseEvent): void {
    const hit = rowAt(e)
    if (!hit || hit.row.kind === 'pending') return
    const { row, index } = hit
    if (row.kind === 'more') return void filesModel.showAll(moreDir(row.path))
    filesModel.select('files', row.path)
    if (row.kind === 'dir') {
      // the second click of a double-click is not a second toggle
      if (e.detail <= 1) act(toggleAction(row))
      return
    }
    showRow(index)
    if (e.detail <= 1) open(row, true)
  }

  function onDblClick(e: MouseEvent): void {
    const hit = rowAt(e)
    if (!hit || hit.row.kind === 'dir' || hit.row.kind === 'more' || hit.row.kind === 'pending') return
    void openInEditor({ target: 'session', id: sessionId, path: hit.row.path })
  }

  function menuFor(row: FlatRow, at: { x: number; y: number }): void {
    if (row.kind === 'more' || row.kind === 'pending') return
    filesModel.select('files', row.path)
    panel.menu = { kind: 'file', target: { sessionId, path: row.path, dir: row.kind === 'dir', from: 'tree' }, at }
  }

  /** The folder's own menu (`files ⌃`): the session's folder, from the space under the rows or with no row selected. */
  function rootMenu(at: { x: number; y: number }): void {
    panel.menu = { kind: 'files', target: { sessionId, path: '', dir: true, from: 'tree' }, at }
  }

  function onContextMenu(e: MouseEvent): void {
    // the name field's own menu is the text menu's
    if (e.target instanceof Element && e.target.closest('.ft-edit')) return
    e.preventDefault()
    const hit = rowAt(e)
    if (hit) menuFor(hit.row, { x: e.clientX, y: e.clientY })
    else rootMenu({ x: e.clientX, y: e.clientY })
  }

  /**
   * `⇧F10` or the menu key: the selected row's menu (brought into view first), else the folder's. The menu is placed
   * from the list's geometry: a row scrolled into view is drawn only at the next frame.
   */
  function keyMenu(): void {
    const row = rows[selected]
    const r = scroller?.getBoundingClientRect()
    if (!r || !scroller) return
    if (!row || row.kind === 'more' || row.kind === 'pending') return rootMenu({ x: r.left + ROW, y: r.top + ROW })
    showRow(selected)
    const bottom = r.top + (selected + 1) * ROW - scroller.scrollTop
    menuFor(row, { x: r.left + ROW, y: Math.min(bottom, r.bottom) })
  }

  // type-ahead: keys typed close together are one prefix (L.treeTypeaheadMs)
  let typed = ''
  let typedAt = 0

  function onKeyDown(e: KeyboardEvent): void {
    // the list's own keys only: the name field keeps its keys to itself
    if (e.target !== scroller || e.isComposing) return
    // the keys that cannot be bindings of the table (macOS ⌘⌫; Linux's plain Ctrl+X, C, V, Z, never Blink's here)
    const chord = chordOf(e)
    const own = chord !== null ? protocolOs.keys.listKeys[chord] : undefined
    if (own !== undefined) {
      e.preventDefault()
      commands.run(own)
      return
    }
    if (e.metaKey || e.ctrlKey) return // the window's shortcuts (⌘↵ is Open in Editor, through the key scope)
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault()
      keyMenu()
      return
    }
    // the table's `file panel` keys without the primary modifier (F2, ⌦ / Delete), which the router passes here
    const b = primaryDown(e) ? undefined : scopedBinding(e, currentKeyScopes())
    if (b) {
      e.preventDefault()
      commands.run(b.id, b.args)
      return
    }
    if (e.altKey) return
    const a = treeKey(rows, selected, e.key, pageRows(viewport, ROW))
    if (a) {
      e.preventDefault()
      typed = ''
      act(a)
      return
    }
    if (!isTypeKey(e)) return
    const now = performance.now()
    typed = now - typedAt <= L.treeTypeaheadMs ? typed + e.key : e.key
    typedAt = now
    const hit = typeAhead(filesModel.labels, selected, typed)
    if (hit >= 0) {
      e.preventDefault()
      select(hit)
    }
  }

  function onDragStart(e: DragEvent): void {
    const hit = rowAt(e)
    if (!hit || hit.row.kind === 'more' || hit.row.kind === 'pending' || !e.dataTransfer) return void e.preventDefault()
    // the row's path for Kea's terminals, and as text for other apps (never with a raw control character)
    for (const [type, data] of Object.entries(dragPayload(sessionId, hit.row.path))) e.dataTransfer.setData(type, data)
    // moved within the tree, copied with the modifier (or onto a terminal)
    e.dataTransfer.effectAllowed = 'copyMove'
    startRowDrag({ sessionId, path: hit.row.path, dir: hit.row.kind === 'dir' })
  }

  /** The folder the place under a drag stands for: a row's (`folderOf`), the session's under the rows; null: the field's place. */
  function dropDirAt(e: DragEvent): string | null {
    if (e.target instanceof Element && e.target.closest('.ft-edit')) return null
    const hit = rowAt(e)
    if (!hit) return ''
    return hit.row.kind === 'pending' ? null : folderOf(hit.row)
  }

  function onDragOver(e: DragEvent): void {
    if (scroller) edgeScroll(scroller, e.clientY)
    dragOverFolder(e, sessionId, dropDirAt(e))
  }

  // a drag ends with the session it began in
  $effect(() => {
    void sessionId
    return () => endDrag()
  })

  /** How a row is decorated; `version` makes the read follow the status. */
  const decoration = (row: FlatRow, _version: number) => filesModel.decoration(row)
</script>

<div
  bind:this={scroller}
  class="fp-list ft{panel.dropDir === '' ? ' drop-root' : ''}"
  role="tree"
  tabindex="0"
  aria-label="Files"
  aria-activedescendant={selected >= win.start && selected < win.end ? `ft-row-${selected}` : undefined}
  data-panel-focus
  data-rows={rows.length}
  onscroll={onScroll}
  onclick={onClick}
  ondblclick={onDblClick}
  oncontextmenu={onContextMenu}
  onkeydown={onKeyDown}
  ondragstart={onDragStart}
  ondragover={onDragOver}
  ondragleave={leaveFolder}
  ondrop={(e) => dropOnFolder(e, sessionId, dropDirAt(e))}
  {@attach measure}
>
  <!-- one empty row's height after the last row: the space that stands for the session's folder -->
  <div class="fp-sizer" role="none" style:height="{win.height + ROW}px">
    <div class="fp-rows" role="none" style:transform="translateY({win.offset}px)">
      {#each shown as row, i}
        {@const index = win.start + i}
        {@const deco = decoration(row, panel.version)}
        <div
          id="ft-row-{index}"
          class="fp-row ft-{row.kind}{deco ? ` git-${deco.cls}` : ''}{row.ignored ? ' ignored' : ''}{index === selected ? ' selected' : ''}{row.path === activePath ? ' active' : ''}{index === editIndex && editPath !== null ? ' editing' : ''}{row.kind === 'dir' && row.path === panel.dropDir ? ' drop-target' : ''}{panel.clip?.cut && panel.clip.sessionId === sessionId && row.path === panel.clip.path ? ' cut' : ''}"
          role="treeitem"
          aria-level={row.depth + 1}
          aria-expanded={row.kind === 'dir' ? row.expanded : undefined}
          aria-selected={index === selected}
          aria-hidden={row.kind === 'pending' || (index === editIndex && editPath !== null) ? 'true' : undefined}
          data-tip={row.kind === 'symlink' ? 'Symbolic link' : undefined}
          data-index={index}
          data-path={row.kind === 'pending' ? undefined : row.path}
          data-kind={row.kind}
          data-git={deco ? (deco.letter ?? 'dot') : undefined}
          draggable={row.kind === 'more' || row.kind === 'pending' ? undefined : 'true'}
        >
          <span class="ft-indent" style:width="calc({row.depth} * var(--space-3))"></span>
          {#if row.kind === 'dir'}
            <Icon name={row.expanded ? 'caretDown' : 'caretRight'} class="ft-chevron" />
          {:else if row.kind === 'symlink'}
            <Icon name="link" class="ft-chevron" />
          {:else}
            <span class="ft-chevron"></span>
          {/if}
          {#if row.kind === 'more'}
            <span class="ft-name">Show all ({row.total})</span>
          {:else if row.kind === 'pending'}
            <span class="ft-name"></span>
          {:else}
            <!-- one monochrome glyph, a folder's or a file's -->
            <Icon name={row.kind === 'dir' ? 'folder' : 'file'} class="ft-glyph" />
            <span class="ft-name">{row.label}</span>
          {/if}
          {#if deco?.letter}
            <span class="fp-letter" role="img" aria-label={LETTER_NAMES[deco.letter] ?? deco.letter} data-tip={LETTER_NAMES[deco.letter]}>{deco.letter}</span>
          {:else if deco}
            <span class="ft-dot" role="img" aria-label="contains changes"></span>
          {/if}
        </div>
      {/each}
    </div>
    {#if edit && editIndex >= 0}
      <div class="ft-edit-place" style:top="{editIndex * ROW}px">
        {#key edit}
          <NameField ask={edit} depth={rows[editIndex]?.depth ?? 0} />
        {/key}
      </div>
    {/if}
  </div>
</div>
