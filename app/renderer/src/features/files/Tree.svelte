<!--
The file tree: the flat rows of the plain model (model.ts, rows.ts), drawn only where they are on screen (window.ts;
every row is `--size-tree-row` high, so nothing is measured). A `tree` of `treeitem`s: the tree itself has the keyboard,
and `aria-activedescendant` names the row it is on.

  click            a file: shown in the viewer (`viewer.open`); a folder: opened or closed
  double-click     a file: opened in the editor (`openInEditor`)
  Enter · Space    as a click · a file is shown without the keyboard leaving the tree
  ↑ ↓ ← → Home End PageUp PageDown, typing a name     keys.ts
  ⌘↵               Open in Editor (the key scope `file panel`: commands.ts)
  right-click · ⇧F10    the `file ⌃` menu
  drag             onto a terminal: the path is typed there (features/terminal/drop.ts)

Rows are not keyed: as the list scrolls the same elements show other rows, so a scroll step touches only what changed.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { L } from '@kea/protocol'
  import { Icon } from '@kea/ui'
  import { SIZE_PX } from '@kea/ui/tokens'
  import { commands } from '../commands/registry.ts'
  import { openInEditor } from '../editor/open.ts'
  import { dragPayload } from '../terminal/drop.ts'
  import { LETTER_NAMES } from './changes.ts'
  import { isTypeKey, moreDir, toggleAction, treeKey, typeAhead, type PanelAction } from './keys.ts'
  import { filesModel } from './model.ts'
  import type { FlatRow } from './rows.ts'
  import { panel } from './state.svelte.ts'
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
    untrack(() => {
      void tick().then(() => {
        showRow(filesModel.rowIndex(filesModel.ui.files.sel))
        scroller?.focus({ preventScroll: true })
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
    if (!hit) return
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
    if (!hit || hit.row.kind === 'dir' || hit.row.kind === 'more') return
    void openInEditor({ target: 'session', id: sessionId, path: hit.row.path })
  }

  function menuFor(row: FlatRow, at: { x: number; y: number }): void {
    if (row.kind === 'more') return
    filesModel.select('files', row.path)
    panel.menu = { kind: 'file', target: { sessionId, path: row.path, dir: row.kind === 'dir' }, at }
  }

  function onContextMenu(e: MouseEvent): void {
    const hit = rowAt(e)
    if (!hit) return
    e.preventDefault()
    menuFor(hit.row, { x: e.clientX, y: e.clientY })
  }

  // type-ahead: keys typed close together are one prefix (L.treeTypeaheadMs)
  let typed = ''
  let typedAt = 0

  function onKeyDown(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey) return // the window's shortcuts (⌘↵ is Open in Editor, through the key scope)
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      const row = rows[selected]
      const el = scroller?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      if (!row || !el) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      menuFor(row, { x: r.left + r.height, y: r.bottom })
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
    if (!hit || hit.row.kind === 'more' || !e.dataTransfer) return void e.preventDefault()
    // the row's path for Kea's terminals, and as text for other apps (never with a raw control character)
    for (const [type, data] of Object.entries(dragPayload(sessionId, hit.row.path))) e.dataTransfer.setData(type, data)
    e.dataTransfer.effectAllowed = 'copy'
  }

  /** How a row is decorated; `version` makes the read follow the status. */
  const decoration = (row: FlatRow, _version: number) => filesModel.decoration(row)
</script>

<div
  bind:this={scroller}
  class="fp-list ft"
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
  {@attach measure}
>
  <div class="fp-sizer" role="none" style:height="{win.height}px">
    <div class="fp-rows" role="none" style:transform="translateY({win.offset}px)">
      {#each shown as row, i}
        {@const index = win.start + i}
        {@const deco = decoration(row, panel.version)}
        <div
          id="ft-row-{index}"
          class="fp-row ft-{row.kind}{deco ? ` git-${deco.cls}` : ''}{row.ignored ? ' ignored' : ''}{index === selected ? ' selected' : ''}{row.path === activePath ? ' active' : ''}"
          role="treeitem"
          aria-level={row.depth + 1}
          aria-expanded={row.kind === 'dir' ? row.expanded : undefined}
          aria-selected={index === selected}
          data-tip={row.kind === 'symlink' ? 'Symbolic link' : undefined}
          data-index={index}
          data-path={row.path}
          data-kind={row.kind}
          data-git={deco ? (deco.letter ?? 'dot') : undefined}
          draggable={row.kind === 'more' ? undefined : 'true'}
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
  </div>
</div>
