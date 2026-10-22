<!--
A session's terminals in the main column: its tab strip over its terminal area. One context shows at a time: a session's
PTYs (agent, the setup script while `SessionView.setup` names it, server, shells; a teardown script is never a tab), or
the plain shell tabs of the `shells` pseudo-session, whose first shell opens only when `terminal.restored` reports none
survived and core's first `sessions` snapshot lists no session. In both, a new shell (`⌘T`: `terminal.openShell` for the
shells, `sessions.openShell` in a session) becomes active once the terminals store lists it, as does an agent that
starts while the pane shows (after setup), and a shell that exits closes its tab. A person closing a shell tab that has
a running foreground process is asked first (`terminal.foreground`, then the sheet).

The tab a session showed last comes back with it. The window remembers it while it lives (`lastActive`); the session
remembers it too (`savedTab.ts`: saved with its panel state), so a window that has not shown the session before (closed
and reopened, back from the menu bar, reloaded, Kea started again) starts it on that tab when it still exists, else on
its Agent terminal, never on whichever tab is last. Nothing waits for core's answer: such a pane starts on its Agent
terminal and moves to the remembered tab when the answer comes, unless a tab was chosen meanwhile.

Keys and the menu bar go through the command registry; this component contributes what the terminal commands act on (the
tabs and the active one). Tabs never take keyboard focus from the terminal.

An ended tab (its program exited or its holder was lost) shows its last screen dimmed: its view renders it from the
checkpoint and is freed once hidden (never pinned or kept warm). `overlay` is laid over the terminal area with the
active tab's kind and whether it ended (SessionPane: the detached overlay).

Status: the pane tells the viewing report which tab it shows (a session counts as viewed, `isBeingViewed`, only while
its Agent tab is the one shown), takes a request to show its Agent tab (a notification's click, a menu-bar pick), and
the Agent tab shows a dot while its session needs you and another tab is the visible one.

File and diff tabs: a session's strip also holds the tabs `viewer.open` opened (the model is `tabs.ts`, the window's
copy `fileTabs.svelte.ts`). While one is active the viewer is mounted over the terminal area
(`features/viewer/Viewer.svelte`) and the area shows no terminal: the session's terminals stay alive underneath as its
other tabs do (pinned, the Agent terminal warm), so a flip back is a warm switch. The strip's own commands are
registered here: `viewer.open`, `viewer.pinTab`, and Close / Next / Previous Tab over every kind of tab.
-->
<script lang="ts">
  import { tick, untrack, type Snippet } from 'svelte'
  import { zOpenRequest, type OpenRequest } from '@kea/protocol'
  import { Icon } from '@kea/ui'
  import { disposeAll } from '@kea/terminal'
  import { call } from '../lib/rpc.ts'
  import { failed, sessions, sessionsListedAtStart } from '../features/sessions/state.svelte.ts'
  import { clearShownTab, reportShownTab, takeAgentTab, viewingState } from '../features/status/viewing.svelte.ts'
  import { External, watch } from '../lib/reactive.svelte.ts'
  import { named, shortcut } from '../features/commands/bindings.svelte.ts'
  import { commands } from '../features/commands/registry.ts'
  import { provideKeyScope } from '../features/commands/scope.ts'
  import { panelSelection } from '../features/files/selection.svelte.ts'
  import SheetFrame from '../features/sessions/SheetFrame.svelte'
  import { terminalsList } from '../features/sessions/state.svelte.ts'
  import { registerTerminalCommands } from '../features/terminal/commands.ts'
  import { openFind } from '../features/terminal/findBar.ts'
  import { estimateGrid } from '../features/terminal/grid.ts'
  import { prefs } from '../features/terminal/prefs.ts'
  import type { ActivateOptions } from '../features/terminal/registry.ts'
  import TerminalArea from '../features/terminal/TerminalArea.svelte'
  import { uiState } from '../features/terminal/ui.svelte.ts'
  import { terminalName } from '../features/terminal/screenReader.ts'
  import { activeView, setTabKinds, setTerminalNames, terminals } from '../features/terminal/views.ts'
  import type { TabViewState } from '../features/viewer/tab.ts'
  import Viewer from '../features/viewer/Viewer.svelte'
  import { fileTabsOf, reportShownFile, setFileTabs } from './fileTabs.svelte.ts'
  import ReconnectingBar from './ReconnectingBar.svelte'
  import { askSavedTab, saveTab } from './savedTab.ts'
  import { closeFileTab, fileTabTitle, homeTab, isFileTabId, openFileTab, pickActiveTab, pinFileTab, rememberTab, sameTabMemory, saveFileTabView, startTab, stripOrder, viewFileTab, type TabKind, type TabMemory } from './tabs.ts'
  import { byKind, closeQuestion, firstShell, KIND_ORDER, lastActive, opensFirstShell, savedTab, SHELLS_CONTEXT, tabTitle } from './terminalPane.ts'

  let {
    context,
    canOpenShell,
    whyNoShell = 'No shell can be opened here',
    scriptTab = null,
    booted,
    overlay,
  }: {
    context: string
    canOpenShell: boolean
    /** Why `⌘T` is unavailable (the menu and the palette say it). */
    whyNoShell?: string
    /** The one script PTY shown as a tab: the session's setup run. */
    scriptTab?: string | null
    booted?: () => void
    /** Laid over the terminal area: the active tab's kind (null with no tab) and whether its terminal has ended. */
    overlay?: Snippet<[{ kind: TabKind | null; ended: boolean }]>
  } = $props()

  const listVersion = new External(terminalsList.subscribeList, () => terminalsList.listVersion)
  const list = $derived.by(() => {
    void listVersion.current
    return terminalsList.values().filter((t) => t.sessionId === context && (context === SHELLS_CONTEXT ? t.kind === 'shell' : t.kind !== 'script' || t.ptyId === scriptTab))
  })
  // the tabs as the pane opens, so its first switch already knows them (an empty first switch would let warm terminals go)
  let order = $state.raw<string[]>(untrack(() => [...list].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]).map((t) => t.ptyId)))
  let active = $state<string | null>(untrack(() => lastActive.get(context) ?? null))
  // what the session remembers of its tabs, as far as the window knows it (null: nothing, or not known yet)
  let remembered: TabMemory | null = untrack(() => savedTab.get(context) ?? null)
  /**
   * The pane is where it began by itself and the session has not said yet what it remembers: its answer may still move
   * the pane, and until then neither the window nor the session takes the tab on screen for the one to remember.
   */
  let starting = untrack(() => context !== SHELLS_CONTEXT && active === null && !savedTab.has(context))
  let restored = $state(untrack(() => context !== SHELLS_CONTEXT))
  let opening = false
  // a shell just opened: it becomes active once the terminals list shows it (the list can arrive before or after the reply)
  let wanted: string | null = null
  /** The kind of the tab last on screen; it outlives the tab (a re-run replaces the Server tab). */
  let shownKind: TabKind | null = null
  let area: HTMLDivElement | undefined = $state()
  let pane: HTMLDivElement | undefined = $state()
  /** The viewer's mount, while a file or diff tab is the active one. */
  let mount: HTMLDivElement | undefined = $state()

  // keep tab order stable: existing tabs keep their place, new ones append (an agent's tab leads)
  $effect(() => {
    const l = list
    untrack(() => {
      const ids = [...l].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]).map((t) => t.ptyId)
      const prev = order
      const kept = prev.filter((id) => ids.includes(id))
      // a shell that has exited is closing (below): it never comes back as a tab while core still lists it
      const added = ids.filter((id) => !prev.includes(id) && !(byKind(l, id) === 'shell' && l.find((t) => t.ptyId === id)?.state !== 'running'))
      const next = [...kept, ...added].sort((a, b) => KIND_ORDER[byKind(l, a)] - KIND_ORDER[byKind(l, b)])
      // an agent that starts while the pane shows (after its setup, Skip or Start agent anyway) is what to watch
      const agent = prev.length > 0 ? added.find((id) => byKind(l, id) === 'agent') : undefined
      if (agent && !wanted) wanted = agent
      // a new run's Server tab takes the place of the one it replaces, on screen too (the old one goes just after)
      const server = added.find((id) => byKind(l, id) === 'server')
      if (server && !wanted && shownKind === 'server' && active !== null && (byKind(l, active) === 'server' || !ids.includes(active))) wanted = server
      if (!(next.length === prev.length && next.every((x, i) => x === prev[i]))) order = next
      setTabKinds(l.map((t) => [t.ptyId, t.kind]))
    })
  })

  const byId = $derived(new Map(list.map((t) => [t.ptyId, t])))
  // the session's file and diff tabs; the shells have none
  const files = $derived(fileTabsOf(context))
  /** The active tab when it is a file or diff tab. */
  const fileTab = $derived(isFileTabId(active) ? (files.tabs.find((t) => t.id === active) ?? null) : null)
  /** Its id, as a value: the tab object is a new one every time the viewer saves its view (`saveView`). */
  const fileTabId = $derived(fileTab?.id ?? null)
  /** The active tab when it is a terminal: what the terminal area shows (nothing under a file tab). */
  const terminal = $derived(isFileTabId(active) ? null : active)
  /** The terminal tab shown last: where Focus Terminal goes back to from a file tab. A plain value, read on demand. */
  let lastTerminal: string | null = null
  $effect(() => {
    if (terminal !== null) lastTerminal = terminal
  })
  /** The active tab's kind, and whether its terminal ended (dimmed). */
  const activeTab = $derived.by((): { kind: TabKind | null; ended: boolean } => {
    if (fileTab) return { kind: fileTab.mode, ended: false }
    const t = terminal ? byId.get(terminal) : undefined
    return { kind: t?.kind ?? null, ended: !!t && t.state !== 'running' }
  })
  // the same array while the ids are the same: a PTY's title or state changing (any session's, OSC titles unthrottled)
  // must not re-run the area's switch, the commands' availability or the exited-shell check
  let lastTabs: string[] = []
  const tabs = $derived.by(() => {
    const next = order.filter((id) => byId.has(id))
    if (next.length === lastTabs.length && next.every((x, i) => x === lastTabs[i])) return lastTabs
    lastTabs = next
    return next
  })

  // the same array while the ids are the same, as `tabs` above
  let lastFileIds: string[] = []
  const fileIds = $derived.by(() => {
    const next = files.tabs.map((t) => t.id)
    if (next.length === lastFileIds.length && next.every((x, i) => x === lastFileIds[i])) return lastFileIds
    lastFileIds = next
    return next
  })
  const kindOf = (id: string) => byId.get(id)?.kind
  /** Where a file tab that closes leaves the pane: the Agent terminal. */
  const home = () => homeTab(tabs, kindOf)
  /**
   * Where a pane that has shown no tab yet begins: the tab its session remembers while that tab exists, else its Agent
   * terminal. The plain shells have neither: they begin on the tab they showed last, else on the last one.
   */
  const start = () => (context === SHELLS_CONTEXT ? null : startTab(tabs, kindOf, remembered, home()))

  $effect(() => {
    const t = tabs
    const f = fileIds
    const a = active
    untrack(() => {
      const asked = wanted
      const next = pickActiveTab(t, f, { active: a, wanted: asked }, home(), start())
      wanted = next.wanted
      if (next.active !== a) active = next.active
      // a tab that was asked for (a shell just opened, an agent just started) is a choice, as a click is
      if (asked !== null && next.wanted === null) chosen()
    })
  })

  /**
   * The tab on screen is the one to come back to: the window remembers it, and the session does once it is known what
   * the session holds, so that only a change is saved.
   */
  function keep(): void {
    const a = active
    if (starting || a === null || (!isFileTabId(a) && !byId.has(a))) return
    lastActive.set(context, a)
    if (context === SHELLS_CONTEXT) return
    const known = savedTab.get(context)
    if (known === undefined) return
    const m = rememberTab(a, kindOf)
    if (!sameTabMemory(m, known)) saveTab(context, m)
  }

  /** A tab was chosen, by the person or by what they started: what the session remembers no longer moves the pane. */
  function chosen(): void {
    if (!starting) return
    starting = false
    keep()
  }

  $effect(() => {
    void active
    untrack(keep)
  })

  // A session this window has not asked yet says what it remembers, once. The pane has begun on its Agent terminal
  // meanwhile; it moves to the remembered tab only while that is still where it is by itself
  $effect(() => {
    const c = untrack(() => context)
    if (c === SHELLS_CONTEXT || untrack(() => savedTab.has(c))) return
    let here = true
    void askSavedTab(c).then((known) => {
      if (!here || !known) return
      if (starting) {
        remembered = savedTab.get(c) ?? null
        starting = false
        const tab = startTab(tabs, kindOf, remembered, home())
        if (tab !== null && tab !== active && wanted === null && !isFileTabId(active)) active = tab
      }
      keep()
    })
    return () => {
      here = false
    }
  })
  $effect(() => {
    if (activeTab.kind) shownKind = activeTab.kind
  })

  // the tab on screen says whether this session's Agent tab is being viewed
  $effect(() => {
    const k = activeTab.kind
    untrack(() => reportShownTab(context, k))
  })
  $effect(() => {
    const c = untrack(() => context)
    return () => clearShownTab(c)
  })
  // a notification's click or a menu-bar pick shows this session's Agent tab (once its tab is listed)
  $effect(() => {
    const w = viewingState.agentTab
    const t = tabs
    untrack(() => {
      if (w?.sessionId !== context) return
      const tab = t.find((x) => byId.get(x)?.kind === w.kind)
      if (tab && takeAgentTab(context)) select(tab)
    })
  })
  // the Agent tab's dot while the session needs you and another tab is shown
  const sessionRow = new External(
    (cb) => sessions.subscribeRow(context, cb),
    () => sessions.get(context),
  )
  const needsYou = $derived(sessionRow.current?.lifecycle === 'live' && sessionRow.current.phase === 'blocked')

  // each terminal's accessible name says its session and its tab; it follows a rename and a tab's title
  $effect(() => {
    const title = context === SHELLS_CONTEXT ? null : (sessionRow.current?.title ?? null)
    const names = list.map((t) => [t.ptyId, terminalName(title, tabTitle(t))] as const)
    untrack(() => setTerminalNames(names))
  })

  /**
   * The instance policy for this pane's switches: in a session, its other tabs stay alive (pinned, no WebGL) and its
   * Agent terminal stands for it among the warm ones; the warm ones are other sessions' Agent terminals. In the
   * `shells` pseudo-session the most recently viewed other tabs are warm.
   */
  function switchOptions(next: string | null, open: readonly string[]): ActivateOptions {
    const exists = (id: string) => terminalsList.get(id) !== undefined
    // an ended terminal's last screen is freed when hidden: never kept warm or pinned
    const running = (id: string) => terminalsList.get(id)?.state === 'running'
    const warmable = (id: string) => {
      const t = terminalsList.get(id)
      return t !== undefined && t.state === 'running' && (t.kind === 'agent' || t.sessionId === SHELLS_CONTEXT)
    }
    if (context === SHELLS_CONTEXT) return { exists, warmable }
    return { exists, warmable, pinned: open.filter((id) => id !== next && running(id)), representative: open.find((id) => terminalsList.get(id)?.kind === 'agent' && running(id)) ?? null }
  }

  function select(id: string): void {
    wanted = null
    if (isFileTabId(id)) setFileTabs(context, viewFileTab(fileTabsOf(context), id))
    active = id
    chosen()
  }

  async function openShell(): Promise<void> {
    if (opening || !canOpenShell) return
    opening = true
    try {
      // spawn at the pane's grid (the active terminal's; under a file tab, that of a terminal kept alive beneath it;
      // else measured)
      const kept = terminal === null ? tabs.map((id) => terminals.get(id)).find((v) => v !== undefined) : undefined
      const grid = activeView()?.grid() ?? kept?.grid() ?? estimateGrid(area ?? null, prefs.appearance())
      const { ptyId } = context === SHELLS_CONTEXT ? await call('terminal.openShell', grid) : await call('sessions.openShell', { id: context, grid })
      // the list may have it already (core's store update can come before its reply, as from a restarted core's first
      // reconciliation, C-RACE-7): pick now, since `tabs` keeps its array while the ids stay the same and the effect
      // above would not run again; otherwise that effect picks it once the list shows it
      const next = pickActiveTab(tabs, fileIds, { active, wanted: ptyId }, home(), start())
      wanted = next.wanted
      if (next.active !== active) active = next.active
      chosen()
    } catch (e) {
      failed("Couldn't open a shell", e)
    } finally {
      opening = false
    }
  }

  async function closeTab(ptyId: string): Promise<void> {
    terminals.close(ptyId)
    order = order.filter((id) => id !== ptyId)
    await call('terminal.close', { ptyId })
  }

  /** The shell tab whose close is waiting for an answer, with the program running in it. */
  let closing = $state.raw<{ ptyId: string; text: string } | null>(null)

  /**
   * A person closing a shell tab that has a running foreground process is asked first, and also when it could not be
   * learned whether it has one; a shell known to be idle, and a tab whose shell has ended, just close.
   * (A shell that exits closes its own tab, below, without asking.)
   */
  async function askClose(ptyId: string): Promise<void> {
    const t = byId.get(ptyId)
    if (t?.kind === 'shell' && t.state === 'running') {
      // asked also when core did not answer or does not know: a program that may be running is never ended unasked
      const q = closeQuestion(await call('terminal.foreground', { ptyId }).catch(() => null))
      if (q) {
        if (tabs.includes(ptyId)) closing = { ptyId, text: q.text }
        return
      }
    }
    await closeTab(ptyId)
  }

  /**
   * A click on a closable tab's close button: the button is part of the tab, not a control of its own (a tab never
   * takes the keyboard, and `⌘W` is the keyboard's way), so the tab's own click tells which was meant.
   */
  const onCloseButton = (e: MouseEvent): boolean => e.target instanceof Element && e.target.closest('.tab-close') !== null

  function confirmClose(ptyId: string): void {
    closing = null
    void closeTab(ptyId)
    // the sheet had the keyboard, and the terminal it came from is gone: the tab that takes over gets it
    void tick().then(() => activeView()?.focus())
  }

  // ── file and diff tabs ──

  /** The keyboard goes to the viewer once it is mounted. */
  function focusViewer(): void {
    void tick().then(() => mount?.focus())
  }

  /** `viewer.open`'s request for this pane's session; with no argument, the file panel's selected file. */
  function openRequest(args: unknown): OpenRequest | null {
    if (args === undefined) {
      const sel = panelSelection.current
      return sel?.sessionId === context ? { sessionId: context, path: sel.path, mode: sel.mode } : null
    }
    const r = zOpenRequest.safeParse(args)
    return r.success && r.data.sessionId === context ? r.data : null
  }

  function openFile(req: OpenRequest): void {
    const r = openFileTab(fileTabsOf(context), req)
    setFileTabs(context, r.tabs)
    wanted = null
    active = r.id
    chosen()
    if (req.focus !== false) focusViewer()
  }

  function pinFile(id: string): void {
    setFileTabs(context, pinFileTab(fileTabsOf(context), id))
  }

  /** Close a file tab; the active one hands the pane back to the Agent terminal (the pick below does it). */
  function closeFile(id: string): void {
    setFileTabs(context, closeFileTab(fileTabsOf(context), id))
  }

  function saveView(id: string, view: TabViewState): void {
    setFileTabs(context, saveFileTabView(fileTabsOf(context), id, view))
  }

  /** Keys the viewer left alone: Esc closes the tab, ↵ pins a preview. */
  function onViewerKey(e: KeyboardEvent): void {
    const t = fileTab
    if (!t || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    if (e.key === 'Escape') {
      e.preventDefault()
      closeFile(t.id)
    } else if (e.key === 'Enter' && !t.pinned) {
      e.preventDefault()
      pinFile(t.id)
    }
  }

  // a file tab that becomes the active one takes the keyboard when the main pane had it (or nothing did: the terminal
  // that had it is hidden now); a preview opened without moving focus (`Space` in the tree) leaves it where it is
  $effect(() => {
    const id = fileTabId
    untrack(() => {
      if (id === null) return
      void tick().then(() => {
        const a = document.activeElement
        if (a === null || a === document.body || pane?.contains(a)) mount?.focus()
      })
    })
  })

  // what the window knows of the tab on screen: the file panel marks its row, and the tab is the most recently viewed
  $effect(() => {
    const t = fileTab
    untrack(() => reportShownFile(context, t ? { path: t.path, mode: t.mode } : null))
  })
  $effect(() => {
    const c = untrack(() => context)
    return () => reportShownFile(c, null)
  })

  // the viewer's bindings apply while the keyboard is in the viewer (a diff tab is also a viewer tab)
  $effect(() => provideKeyScope(() => (fileTab && mount?.contains(document.activeElement) ? [fileTab.mode === 'diff' ? 'diff tab' : 'file tab', 'viewer tab'] : null)))

  // the strip's own Viewer commands: a session's pane opens files, the shells do not
  $effect(() => {
    if (untrack(() => context) === SHELLS_CONTEXT) return
    const ds = untrack(() => [
      commands.register('viewer.open', {
        run: (args) => {
          const req = openRequest(args)
          if (req) openFile(req)
        },
        when: (args) => openRequest(args) !== null,
        unavailableReason: (args) => (args === undefined ? 'Select a file in the file panel' : 'That file is not in the session on screen'),
      }),
      commands.register('viewer.pinTab', {
        run: () => {
          if (fileTab) pinFile(fileTab.id)
        },
        when: () => !!fileTab && !fileTab.pinned,
        unavailableReason: () => (fileTab ? 'This tab is pinned' : 'No file tab is showing'),
      }),
    ])
    const off = watch(
      () => panelSelection.current,
      () => commands.changed(),
    )
    return () => {
      off()
      disposeAll(ds)
    }
  })

  // a shell that exits closes its tab, as in a terminal app (an agent's or setup's tab stays, showing its last screen);
  // once: closing takes it out of the tabs, and the list changing again before core drops the PTY (any PTY's title or
  // state) does not bring it back (above), so core is asked once
  $effect(() => {
    const l = list
    untrack(() => {
      for (const t of l) if (t.kind === 'shell' && t.state !== 'running' && order.includes(t.ptyId)) void closeTab(t.ptyId)
    })
  })

  // first launch: one shell, decided only once core has listed the PTYs that survived the last run and sent its first
  // sessions snapshot: only when no shell survived, no session has a terminal and no session is listed
  // (`opensFirstShell`; a listed session comes back in the pane instead, a frame later). A pane that has gone meanwhile
  // opens nothing
  $effect(() => {
    if (restored) return
    let live = true
    untrack(() => {
      void Promise.all([call('terminal.restored', {}), sessionsListedAtStart]).then(([came, anyListed]) => {
        if (!live) {
          firstShell.decision = 'gone'
          return
        }
        restored = true
        booted?.()
        const open = opensFirstShell(came, anyListed)
        firstShell.decision = open ? 'opened' : 'none'
        if (open) void openShell()
      })
    })
    return () => {
      live = false
    }
  })

  // The visible terminal is rebuilt first. Sent once the terminal area has switched (the new view mounted and its
  // stream asked for), so a parked terminal's stream is served its checkpoint at once instead of waiting for the
  // rebuild this starts; this component's effects run before the area's in a flush
  $effect(() => {
    const a = terminal
    let current = true
    void tick().then(() => {
      if (current) void call('terminal.setVisible', { ptyIds: a ? [a] : [] })
    })
    return () => {
      current = false
    }
  })

  // the terminal commands act on the latest tabs
  $effect(() => {
    void canOpenShell
    void whyNoShell
    const d = untrack(() =>
      registerTerminalCommands({
        // Next / Previous Tab step through every kind of tab
        tabs: () => stripOrder(tabs, files),
        active: () => active,
        terminal: () => terminal,
        lastTerminal: () => (lastTerminal !== null && tabs.includes(lastTerminal) ? lastTerminal : (tabs[0] ?? null)),
        openShell: () => void openShell(),
        canOpenShell: () => canOpenShell,
        whyNoShell: () => whyNoShell,
        // the Agent tab is not closable; a shell and a file tab are
        canClose: (id) => isFileTabId(id) || byId.get(id)?.kind === 'shell',
        closeTab: (id) => (isFileTabId(id) ? closeFile(id) : void askClose(id)),
        select,
        openFind,
      }),
    )
    return () => d.dispose()
  })

  $effect(() => {
    void tabs
    void files
    void active
    untrack(() => commands.changed())
  })

  const keepFocus = (e: MouseEvent) => e.preventDefault()
</script>

<!-- a closable tab's close button: drawn when the tab is the active one or under the pointer; hidden from assistive
     technology, which closes a tab with ⌘W like the keyboard (the tab's name stays its title) -->
{#snippet closeButton()}
  <span class="tab-close" aria-hidden="true" data-tip="Close Tab" data-command="terminal.closeTab"><Icon name="close" /></span>
{/snippet}

<div bind:this={pane} class="terminal-pane">
  <div class="tabstrip">
    <div class="tabs" role="tablist" aria-label="Terminals">
      {#each tabs as id (id)}
        {@const t = byId.get(id)!}
        <!-- a tab never takes keyboard focus from the terminal, also when it is already the active one -->
        <!-- svelte-ignore a11y_role_supports_aria_props (Chromium exposes aria-description on any role) -->
        <button
          role="tab"
          data-pty={id}
          data-kind={t.kind}
          aria-selected={id === active}
          aria-description={t.kind === 'agent' && id !== active && needsYou ? 'Needs you' : undefined}
          class={['tab', t.kind === 'shell' ? 'closable' : '', id === active ? 'active' : ''].filter(Boolean).join(' ')}
          onmousedown={keepFocus}
          onclick={(e) => {
            if (t.kind === 'shell' && onCloseButton(e)) return void askClose(id)
            select(id)
            terminals.get(id)?.focus()
          }}
          onauxclick={(e) => {
            if (e.button === 1 && t.kind === 'shell') void askClose(id)
          }}
          >{#if t.kind === 'shell'}<span class="tab-title">{tabTitle(t)}</span>{@render closeButton()}{:else}{tabTitle(t)}{/if}{#if t.kind === 'agent' && id !== active && needsYou}<span class="tab-dot" aria-hidden="true"></span>{/if}</button
        >
      {/each}
      {#if canOpenShell}
        <button class="tab add" aria-label={named('terminal.newShell')} data-command="terminal.newShell" onmousedown={keepFocus} onclick={() => void openShell()}>+</button>
      {/if}
    </div>
    {#if files.tabs.length > 0}
      <!-- file and diff tabs: after the terminals; the preview tab's title is italic until it is pinned -->
      <div class="tabs file-tabs" role="tablist" aria-label="Open files">
        {#each files.tabs as t (t.id)}
          <!-- svelte-ignore a11y_role_supports_aria_props (Chromium exposes aria-description on any role) -->
          <button
            role="tab"
            data-tab={t.id}
            data-kind={t.mode}
            data-path={t.path}
            data-pinned={t.pinned}
            aria-selected={t.id === active}
            class={['tab', 'file', 'closable', t.id === active ? 'active' : '', t.pinned ? '' : 'preview'].filter(Boolean).join(' ')}
            aria-description={t.path}
            data-tip={t.path}
            onmousedown={keepFocus}
            onclick={(e) => {
              if (onCloseButton(e)) return closeFile(t.id)
              select(t.id)
              focusViewer()
            }}
            ondblclick={() => pinFile(t.id)}
            onauxclick={(e) => {
              if (e.button === 1) closeFile(t.id)
            }}><span class="tab-title">{fileTabTitle(t.path)}</span>{@render closeButton()}</button
          >
        {/each}
      </div>
    {/if}
    {#if uiState.copied}
      <span class="tab-note" role="status">Copied by terminal</span>
    {/if}
  </div>
  <div bind:this={area} class={activeTab.ended ? 'terminal-frame ended' : 'terminal-frame'}>
    <TerminalArea {tabs} active={terminal} sessionId={context === SHELLS_CONTEXT ? null : context} options={switchOptions} />
    {@render overlay?.(activeTab)}
    {#if restored && tabs.length === 0 && canOpenShell}
      <div class="empty">
        <span>No shell is open.</span>
        <button class="button" onclick={() => void openShell()}>New Shell Tab {#if shortcut('terminal.newShell')}<kbd>{shortcut('terminal.newShell')}</kbd>{/if}</button>
      </div>
    {/if}
    {#if fileTab}
      {@const tab = fileTab}
      <!-- the viewer's mount: over the terminal area, which shows no terminal meanwhile -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions (the keys the viewer inside leaves alone: Esc closes the tab, ↵ pins a preview) -->
      <div bind:this={mount} class="viewer-mount" role="tabpanel" aria-label={tab.path} tabindex="-1" data-path={tab.path} data-mode={tab.mode} onkeydown={onViewerKey}>
        <Viewer sessionId={context} {tab} onview={(view) => saveView(tab.id, view)} />
      </div>
    {/if}
  </div>
  <ReconnectingBar />
  {#if closing && tabs.includes(closing.ptyId)}
    {@const c = closing}
    <!-- Closing a shell tab with a running foreground process asks first (the safe button is the default) -->
    <SheetFrame title="Close tab" onCancel={() => (closing = null)}>
      {#snippet buttons()}
        <button class="button" data-default="true" onclick={() => (closing = null)}>Cancel</button>
        <button class="button danger" onclick={() => confirmClose(c.ptyId)}>Close Tab</button>
      {/snippet}
      <p>{c.text}</p>
    </SheetFrame>
  {/if}
</div>
