<!--
The sidebar: projects and their sessions as one tree, keyboard first.

  rows        project rows (SidebarProjectRow.svelte), session rows (SidebarSessionRow.svelte), and one "Archived (n)"
              section row per project
  keys        ↑ ↓ Home End move, → ← open and close, ↵ chooses, typing filters and Esc clears it, ⇧F10 or the
              context-menu key opens the row's menu, ⌥↑ ⌥↓ move a project, or a session within its project, past its
              neighbour (the keyboard's drag; sessions in `stable` order)
  updates     each row follows its own store row, the list only its layout
  roles       `tree` "Sessions"; `treeitem` named by the project name, the session title or "Archived (n)", with
              aria-selected on the session shown and aria-expanded on projects and Archived rows
-->
<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { Icon } from '@kea/ui'
  import { External } from '../../lib/reactive.svelte.ts'
  import { shortcut } from '../commands/bindings.svelte.ts'
  import { heldSessions } from '@kea/protocol'
  import { settings } from '../settings/store.ts'
  import { conditions } from '../status/state.ts'
  import { addProject, moveProjectPast, moveSessionPast, toggleProject } from './actions.ts'
  import { neighbour, orderProjects, sidebarRows, type SidebarRow } from './model.ts'
  import { activate, openRowMenu, toggleArchived } from './sidebar.ts'
  import SidebarProjectRow from './SidebarProjectRow.svelte'
  import SidebarSessionRow from './SidebarSessionRow.svelte'
  import { projects, selectSession, sessionOrder, sessions, ui } from './state.svelte.ts'

  const sessionsList = new External(sessions.subscribeList, () => sessions.listVersion)
  const projectsList = new External(projects.subscribeList, () => projects.listVersion)
  const conditionsList = new External(conditions.subscribeList, () => conditions.listVersion)
  const order = new External(settings.subscribe, sessionOrder)
  // the versions stand for the stores' contents (an account condition decides whether its sessions are in the
  // attention groups)
  const rows = $derived.by(() => {
    void sessionsList.current
    void projectsList.current
    void conditionsList.current
    return sidebarRows({ projects: projects.values(), sessions: sessions.values(), order: order.current, filter: ui.filter ?? '', archivedOpen: ui.archivedOpen, held: heldSessions(conditions.values()) })
  })
  const keys = $derived(rows.map((r) => r.key))
  let focusKey = $state<string | null>(null)
  const current = $derived(focusKey && keys.includes(focusKey) ? focusKey : (keys[0] ?? null))
  let tree: HTMLDivElement | undefined = $state()
  let filterEl: HTMLInputElement | undefined = $state()

  function rowElement(key: string): HTMLElement | null {
    return tree?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) ?? null
  }

  function focusRow(key: string | null): void {
    if (!key) return
    focusKey = key
    requestAnimationFrame(() => rowElement(key)?.focus())
  }

  // asked to focus the sidebar (a project added again)
  $effect(() => {
    const signal = ui.sidebarFocus
    if (signal === 0) return
    untrack(() => {
      const want = ui.focusRow
      focusRow(want && keys.includes(want) ? want : current)
    })
  })

  // a row moved with ⌥↑ / ⌥↓ keeps the keyboard once the list has its new order (the move is core's, a frame or more later)
  let refocus: { key: string; keys: readonly string[] } | null = null
  $effect(() => {
    const ks = keys
    untrack(() => {
      const r = refocus
      if (!r || ks === r.keys) return
      refocus = null
      void tick().then(() => focusRow(r.key))
    })
  })

  // The row that holds the keyboard went (archived, deleted, its group folded, filtered away): the keyboard goes to the
  // row now in its place, never to nothing (full keyboard reachability, A-3). `held` is that row and where
  // it was in the list; a row the keyboard left by itself is not held.
  let held: { key: string; index: number } | null = null
  let body: HTMLDivElement | undefined = $state()
  $effect(() => {
    const ks = keys
    untrack(() => {
      const h = held
      if (!h) return
      const at = ks.indexOf(h.key)
      if (at >= 0) {
        h.index = at
        return
      }
      held = null
      void tick().then(() => {
        // only while nothing else took the keyboard (a sheet, the terminal of the session now shown)
        const a = document.activeElement
        if (a !== null && a !== document.body) return
        const next = ks[Math.min(h.index, ks.length - 1)]
        if (next) focusRow(next)
        else body?.closest('aside')?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
      })
    })
  })

  function onRowFocus(e: FocusEvent): void {
    const key = (e.target as HTMLElement).dataset.key
    focusKey = key ?? current
    held = key ? { key, index: keys.indexOf(key) } : null
  }

  function onRowBlur(e: FocusEvent): void {
    const t = e.target as HTMLElement
    // still in the list and no longer focused: the keyboard left by itself (a row removed under it stays held)
    queueMicrotask(() => {
      if (t.isConnected && held?.key === t.dataset.key && document.activeElement !== t) held = null
    })
  }

  /** ⌥↑ / ⌥↓: the row past its visible neighbour (projects by their order, sessions within their project and group). */
  function reorder(row: SidebarRow | undefined, dir: 1 | -1): boolean {
    if (row?.kind === 'project') {
      const target = neighbour(
        orderProjects(projects.values()).map((p) => p.id),
        row.projectId,
        dir,
      )
      return !!target && moveProjectPast(row.projectId, target)
    }
    if (row?.kind !== 'session' || row.archived || order.current !== 'stable') return false
    const siblings = rows.flatMap((r) => (r.kind === 'session' && r.projectId === row.projectId && !r.archived ? [r.sessionId] : []))
    const target = neighbour(siblings, row.sessionId, dir)
    return !!target && moveSessionPast(row.sessionId, target)
  }

  // the filter field takes focus when it opens
  const filtering = $derived(ui.filter !== null)
  $effect(() => {
    if (filtering) untrack(() => document.activeElement !== filterEl && filterEl?.focus())
  })

  function onKeyDown(e: KeyboardEvent): void {
    const i = current ? keys.indexOf(current) : -1
    const row = rows[i]
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      if (row && reorder(row, e.key === 'ArrowUp' ? -1 : 1)) refocus = { key: row.key, keys }
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const move = (to: number) => {
      e.preventDefault()
      focusRow(keys[Math.max(0, Math.min(keys.length - 1, to))] ?? null)
    }
    switch (e.key) {
      case 'ArrowDown':
        return move(i + 1)
      case 'ArrowUp':
        return move(i - 1)
      case 'Home':
        return move(0)
      case 'End':
        return move(keys.length - 1)
      case 'ArrowRight':
        if (row?.kind === 'project' && row.collapsed) {
          e.preventDefault()
          toggleProject(row.projectId)
        } else if (row?.kind === 'archived' && !row.expanded) {
          e.preventDefault()
          toggleArchived(row.projectId)
        } else move(i + 1)
        return
      case 'ArrowLeft':
        if (row?.kind === 'project' && !row.collapsed) {
          e.preventDefault()
          toggleProject(row.projectId)
        } else if (row?.kind === 'archived' && row.expanded) {
          e.preventDefault()
          toggleArchived(row.projectId)
        } else if (row && row.kind !== 'project') move(keys.indexOf(`p:${row.projectId}`))
        return
      case 'Enter':
      case ' ':
        if (!row) return
        e.preventDefault()
        activate(row)
        return
      case 'Escape':
        if (ui.filter !== null) {
          e.preventDefault()
          ui.filter = null
        }
        return
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'F10' && !e.shiftKey) return
        if (!row || row.kind === 'archived') return
        e.preventDefault()
        openRowMenu(row, rowElement(row.key))
        return
    }
    // Typing filters
    if ([...e.key].length === 1 && e.key.trim() !== '') {
      e.preventDefault()
      ui.filter = (ui.filter ?? '') + e.key
    }
  }

  function onFilterKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      ui.filter = null
      focusRow(current)
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault()
      const first = rows.find((r) => r.kind === 'session')
      if (e.key === 'Enter' && first?.kind === 'session') selectSession(first.sessionId)
      else focusRow(first?.key ?? current)
    }
  }
</script>

<div bind:this={body} class="sidebar-body">
  {#if ui.filter !== null}
    <input
      bind:this={filterEl}
      class="sidebar-filter"
      role="searchbox"
      aria-label="Filter sessions"
      placeholder="Filter sessions"
      value={ui.filter}
      spellcheck="false"
      oninput={(e) => (ui.filter = e.currentTarget.value)}
      onkeydown={onFilterKeyDown}
    />
  {/if}
  {#if rows.length === 0 && ui.filter === null}
    <!-- no projects yet -->
    <div class="sidebar-empty">
      <p>Add a project to get started.</p>
      <button class="button" onclick={() => void addProject()}>Add project… {#if shortcut('project.add')}<kbd>{shortcut('project.add')}</kbd>{/if}</button>
    </div>
  {:else if rows.length === 0}
    <p class="sidebar-note">No sessions match.</p>
  {:else}
    <!-- svelte-ignore a11y_interactive_supports_focus (focus is roving: one row has tabindex 0) -->
    <div
      bind:this={tree}
      class="sidebar-tree"
      role="tree"
      aria-label="Sessions"
      onkeydown={onKeyDown}
      onfocusin={onRowFocus}
      onfocusout={onRowBlur}
    >
      {#each rows as r (r.key)}
        {#if r.kind === 'project'}
          <SidebarProjectRow row={r} tabbable={r.key === current} />
        {:else if r.kind === 'session'}
          <SidebarSessionRow row={r} tabbable={r.key === current} />
        {:else}
          <!-- svelte-ignore a11y_role_has_required_aria_props, a11y_click_events_have_key_events (the archived row is not
            selectable; the tree's keydown handles its keys) -->
          <div
            role="treeitem"
            aria-level={2}
            aria-expanded={r.expanded}
            aria-label={`Archived (${r.count})`}
            data-key={r.key}
            tabindex={r.key === current ? 0 : -1}
            class="sb-row sb-archived"
            onclick={() => toggleArchived(r.projectId)}
          >
            <Icon name={r.expanded ? 'caretDown' : 'caretRight'} class="sb-caret" />
            <span class="sb-section">Archived ({r.count})</span>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>
