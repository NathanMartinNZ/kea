<!--
The file panel's body: the file tree in Files mode, the Changes view in Changes mode, for the session on screen. The
column, its header toggle and its focus are the window's (`panel.ts` is the contract); the data is the plain model's
(model.ts), which follows the session on screen once per window (state.svelte.ts).

What it tells the window: the count for `Changes n` (`onchanges`), the session's own mode when it differs from the
header's (`onmode`), and the file row the keyboard is on (`panelSelection`, for `viewer.open` and Open in Editor
run with no row). What the window tells it: the tab on screen (`activeFile`), whose row is marked.

Notes above the list: "live updates unavailable" (poll mode, or a session on screen beyond the worktrees core follows
live), a missing folder, and the one-time hint to use git's fsmonitor when a status was slow.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { Icon } from '@kea/ui'
  import { call } from '../../lib/rpc.ts'
  import { failed, sessions } from '../sessions/state.svelte.ts'
  import Changes from './Changes.svelte'
  import './files.css'
  import { filesModel } from './model.ts'
  import type { FilePanelProps } from './panel.ts'
  import { panelSelection } from './selection.svelte.ts'
  import { panel, panelIsGit } from './state.svelte.ts'
  import Tree from './Tree.svelte'

  let { sessionId, mode, activeFile, onchanges, onmode }: FilePanelProps = $props()

  /** The session the model holds rows for: the views are drawn only for it (never one session's rows under another's id). */
  const held = $derived.by(() => {
    void panel.version
    return filesModel.sessionId
  })
  const git = $derived(panelIsGit())
  /** A folder that is not a repository has no Changes. */
  const shown = $derived(git ? mode : 'files')
  const treeHead = $derived.by(() => {
    void panel.version
    return filesModel.treeHead
  })
  const slow = $derived.by(() => {
    void panel.version
    return filesModel.gitHead?.slow === true && !filesModel.ui.hintClosed
  })
  const activePath = $derived(activeFile?.path ?? null)

  $effect(() => {
    panel.mode = shown
  })

  // `Changes n`
  $effect(() => {
    void panel.version
    const n = sessionId !== null && held === sessionId && git ? filesModel.changeCount : null
    untrack(() => onchanges(n))
  })

  // the mode this session was last looked at in comes back with it, once; from then on the header's choice is
  // kept for it
  let applied: string | null = null
  $effect(() => {
    void panel.version
    if (sessionId === null || held !== sessionId || !filesModel.opened || applied === sessionId) return
    applied = sessionId
    const want = filesModel.ui.mode
    untrack(() => {
      if (want !== null && want !== mode) onmode?.(want)
    })
  })
  $effect(() => {
    const m = mode
    untrack(() => {
      if (sessionId !== null && applied === sessionId) filesModel.setMode(m)
    })
  })

  // the tab on screen: its row is marked, it leads the finder's list, and Reveal in File Tree with no row means it
  $effect(() => {
    const a = activeFile
    const id = sessionId
    untrack(() => {
      panel.activeFile = a && id !== null ? { sessionId: id, path: a.path } : null
      if (a && id !== null && filesModel.sessionId === id) filesModel.noteOpened(a.path)
    })
  })

  // the file row the keyboard is on (for `viewer.open`): null for a folder, for no row, and while no session is shown
  $effect(() => {
    void panel.version
    let next: { sessionId: string; path: string; mode: 'file' | 'diff' } | null = null
    if (sessionId !== null && held === sessionId) {
      if (shown === 'files') {
        const sel = filesModel.ui.files.sel
        const row = filesModel.rows[filesModel.rowIndex(sel)]
        if (row && row.path === sel && row.kind !== 'dir' && row.kind !== 'more') next = { sessionId, path: row.path, mode: 'file' }
      } else {
        const sel = filesModel.ui.changes.sel
        if (sel !== null && filesModel.changeIndex(sel) >= 0) next = { sessionId, path: sel, mode: 'diff' }
      }
    }
    untrack(() => {
      const cur = panelSelection.current
      if (cur?.sessionId === next?.sessionId && cur?.path === next?.path && cur?.mode === next?.mode) return
      panelSelection.current = next
    })
  })
  $effect(() => () => {
    panelSelection.current = null
    panel.activeFile = null
  })

  async function useFsmonitor(): Promise<void> {
    const projectId = sessionId !== null ? sessions.get(sessionId)?.projectId : undefined
    if (!projectId) return
    try {
      await call('projects.updateSettings', { id: projectId, set: { useFsmonitor: true } })
    } catch (e) {
      failed("Couldn't turn on git fsmonitor", e)
    }
  }

  const keepFocus = (e: MouseEvent) => e.preventDefault()
</script>

{#if sessionId === null}
  <p class="fp-note top">Open a session to see its files.</p>
{:else if held === sessionId}
  <div class="fp" data-session={sessionId} data-mode={shown}>
    {#if treeHead?.missing}
      <p class="fp-note top" role="status">The session’s folder is missing.</p>
    {:else if treeHead?.live === false}
      <p class="fp-note top" role="status">Live updates unavailable.</p>
    {/if}
    {#if slow}
      <div class="fp-hint" role="status">
        <span>Git status is slow in this repository.</span>
        <button class="quiet-button" onmousedown={keepFocus} onclick={() => void useFsmonitor()}>Use git fsmonitor</button>
        <button class="quiet-button icon" aria-label="Dismiss" data-tip="Dismiss" onmousedown={keepFocus} onclick={() => filesModel.closeHint()}><Icon name="close" /></button>
      </div>
    {/if}
    {#if shown === 'files'}
      <Tree {sessionId} {activePath} />
    {:else}
      <Changes {sessionId} {activePath} />
    {/if}
  </div>
{/if}
