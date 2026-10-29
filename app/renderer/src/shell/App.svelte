<!--
The window: three columns — sidebar, file panel, main — under one continuous header row (`--size-header`) that is the
window's drag region except its controls. The leftmost visible header holds macOS's traffic lights, or the window's
menu button on Linux. Column widths come from layout.ts; the dividers between them are 1 px lines with a
`--size-divider-hit` hit area: drag to resize, double-click to reset, arrows to step when focused (Divider.svelte).

Landmarks (for people and for tests): `complementary` "Sidebar", `region` "File panel", `main` "Session"; each divider
is a `separator` "Resize sidebar" / "Resize file panel" with its width as its value.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { protocolOs } from '@kea/protocol'
  import { Icon, Tooltip } from '@kea/ui'
  import { pathForFile } from '../lib/bridge.ts'
  import { External } from '../lib/reactive.svelte.ts'
  import { commandTip, named } from '../features/commands/bindings.svelte.ts'
  import { registerAppCommands } from '../features/commands/commands.ts'
  import { commands } from '../features/commands/registry.ts'
  import { drafts } from '../features/composer/drafts.ts'
  import { registerDiagnosticsCommands } from '../features/diagnostics/commands.ts'
  import HudHost from '../features/diagnostics/HudHost.svelte'
  import { registerDiskCommands } from '../features/disk/commands.ts'
  import { registerEditorCommands } from '../features/editor/commands.ts'
  import { registerFilesCommands } from '../features/files/commands.ts'
  import FilePanel from '../features/files/FilePanel.svelte'
  import FilesLayers from '../features/files/FilesLayers.svelte'
  import { panelIsGit } from '../features/files/state.svelte.ts'
  import { registerPaletteCommands } from '../features/palette/commands.ts'
  import PaletteLayer from '../features/palette/PaletteLayer.svelte'
  import { registerServerCommands } from '../features/server/commands.ts'
  import { registerSettingsCommands } from '../features/settings/commands.ts'
  import { addProjectAt } from '../features/sessions/actions.ts'
  import { registerSessionCommands } from '../features/sessions/commands.ts'
  import Menus from '../features/sessions/Menus.svelte'
  import TerminalMenu from '../features/terminal/TerminalMenu.svelte'
  import Sidebar from '../features/sessions/Sidebar.svelte'
  import { lastSessionId, mru, pendingSessionId, projects, sessions, terminalsList, ui } from '../features/sessions/state.svelte.ts'
  import ToastHost from '../features/sessions/ToastHost.svelte'
  import { registerStatusCommands } from '../features/status/commands.ts'
  import ConditionsFooter from '../features/status/ConditionsFooter.svelte'
  import SessionPopover from '../features/status/SessionPopover.svelte'
  import { statusUi } from '../features/status/ui.svelte.ts'
  import { viewingState } from '../features/status/viewing.svelte.ts'
  import { registerViewerCommands } from '../features/viewer/commands.ts'
  import Banners from './Banners.svelte'
  import Divider from './Divider.svelte'
  import { fileTabsState, fileTabStrip } from './fileTabs.svelte.ts'
  import { drawn, setPanelMode, type PanelMode } from './layout.ts'
  import { layoutState, registerLayoutCommands, setLayout, setPanelElement } from './layoutStore.svelte.ts'
  import MainHeader from './MainHeader.svelte'
  import TextMenu from './TextMenu.svelte'
  import WindowMenu from './WindowMenu.svelte'
  import WindowMenuButton from './WindowMenuButton.svelte'
  import MainPane from './MainPane.svelte'
  import { forgetWhatGoes } from './forget.ts'
  import { askSavedTab } from './savedTab.ts'
  import { escapeToMain, leaveHiddenColumns, registerRegionCommands } from './regions.ts'

  const d = $derived(drawn(layoutState.layout, layoutState.width))
  /** Linux: the window's menu button, in the leftmost visible header, beside the overlay's controls. */
  const menuButton = protocolOs.window.menuButton
  const menuIn = $derived(!menuButton ? null : d.sidebar > 0 ? 'sidebar' : d.tree > 0 ? 'panel' : 'main')
  const cls = $derived(['window', layoutState.resizing ? 'resizing' : '', d.sidebar === 0 ? 'no-sidebar' : '', d.tree === 0 ? 'no-tree' : '', menuButton ? 'menu-button' : ''].filter(Boolean).join(' '))
  /** The file panel follows the session on screen; the composer and the shells have no files. */
  const panelSession = $derived(ui.pane.kind === 'session' ? ui.pane.id : null)
  /** A session whose folder is not a git repository has no Changes (no tab, and the panel shows Files). */
  const hasChanges = $derived(panelSession === null || panelIsGit())
  const mode = $derived(hasChanges ? layoutState.layout.panelMode : 'files')
  /** The file or diff tab the main area shows for that session: the panel marks its row. */
  const activeFile = $derived(fileTabsState.shown !== null && fileTabsState.shown.sessionId === panelSession ? fileTabsState.shown : null)
  /** `Changes n`: the panel reports the count of the session it shows. */
  let changes = $state<number | null>(null)
  /** The sidebar header's `+`: New Session in the project in context; absent until a project exists. */
  const anyProject = new External(projects.subscribeList, () => projects.size > 0)

  $effect(() =>
    untrack(() => {
      // one registration per feature; the tab strip registers its own with the pane (TerminalPane.svelte)
      const ds = [registerLayoutCommands(), registerSessionCommands(), registerStatusCommands(), registerRegionCommands(), registerFilesCommands(), registerViewerCommands(fileTabStrip), registerServerCommands(), registerEditorCommands(), registerSettingsCommands(), registerAppCommands(), registerPaletteCommands(), registerDiskCommands(), registerDiagnosticsCommands()]
      // what the window remembers per session, project or PTY goes with it
      const unwire = forgetWhatGoes(
        { projects, sessions, terminals: terminalsList },
        { drafts, mru, pending: pendingSessionId, archivedOpen: () => ui.archivedOpen, setArchivedOpen: (next) => (ui.archivedOpen = next) },
      )
      // The session this window is about to show again is asked now which tab it remembers, so its pane starts on that
      // tab (the pane mounts a frame after core's first snapshot; a session that is gone answers nothing)
      const back = lastSessionId()
      if (back !== null) void askSavedTab(back)
      return () => {
        for (const x of ds) x.dispose()
        unwire()
      }
    }),
  )

  // A column hidden while the keyboard is in it gives the keyboard to the main pane (regions.ts)
  $effect(() => {
    const hidden = [...(d.sidebar === 0 ? (['sidebar'] as const) : []), ...(d.tree === 0 ? (['files'] as const) : [])]
    untrack(() => leaveHiddenColumns(hidden))
  })

  /** The file panel is the focus target of ⌘⇧E / ⌘⇧G (layoutStore.svelte.ts). */
  const panelElement: Attachment<HTMLElement> = (el) => {
    setPanelElement(el)
    return () => setPanelElement(null)
  }

  // ── a folder dropped on the window adds it as a project ──────────

  function isFileDrag(e: DragEvent): boolean {
    return !!e.dataTransfer?.types.includes('Files')
  }

  function onFolderDragOver(e: DragEvent): void {
    if (!isFileDrag(e) || e.defaultPrevented) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }

  function onFolderDrop(e: DragEvent): void {
    // the composer's prompt takes dropped files as paths; everywhere else a folder becomes a project
    if (!isFileDrag(e) || e.defaultPrevented) return
    e.preventDefault()
    const file = e.dataTransfer?.files[0]
    const path = file ? pathForFile(file) : ''
    if (path) void addProjectAt(path)
  }

  const keepFocus = (e: MouseEvent) => e.preventDefault()
</script>

{#snippet modeButton(m: PanelMode, label: string)}
  <button class="segment{mode === m ? ' on' : ''}" aria-pressed={mode === m} data-command={m === 'files' ? 'files.showFiles' : 'files.showChanges'} data-panel-focus={mode === m ? '' : undefined} onclick={() => setLayout((l) => setPanelMode(l, m))}>{label}</button>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions (a folder dropped anywhere in the window adds a project; ⌘O is
  the keyboard path; Esc here only moves focus back to the main pane) -->
<div class={cls} style:grid-template-columns="{d.sidebar}px {d.tree}px minmax(0, 1fr)" ondragover={onFolderDragOver} ondrop={onFolderDrop} onkeydown={escapeToMain}>
  <aside class="column sidebar-column" aria-label="Sidebar" hidden={d.sidebar === 0}>
    <div class="column-header sidebar-header">
      {#if menuIn === 'sidebar'}
        <div class="header-cluster"><WindowMenuButton /></div>
      {/if}
      <span class="header-spacer"></span>
      {#if anyProject.current}
        <div class="header-cluster">
          <button class="quiet-button icon" aria-label={named('session.new')} data-command="session.new" onmousedown={keepFocus} onclick={() => commands.run('session.new')}><Icon name="plus" /></button>
        </div>
      {/if}
    </div>
    <Sidebar />
    <div class="sidebar-footer">
      <!-- one line per account condition while it lasts, above the gear -->
      <ConditionsFooter />
      <!-- the gear opens Settings (`app.settings`, ⌘,) -->
      <button class="quiet-button icon" aria-label={named('app.settings')} data-command="app.settings" onmousedown={keepFocus} onclick={() => commands.run('app.settings')}><Icon name="gear" /></button>
    </div>
  </aside>
  <!-- the file panel: the column, its header toggle and its focus are the window's; its body is `FilePanel` -->
  <section class="column file-panel" aria-label="File panel" hidden={d.tree === 0} {@attach panelElement}>
    <div class="column-header panel-header">
      <div class="header-cluster">
        {#if menuIn === 'panel'}
          <WindowMenuButton />
        {/if}
        <div class="segments" role="group" aria-label="File panel mode">
          {@render modeButton('files', 'Files')}
          {#if hasChanges}
            {@render modeButton('changes', changes === null ? 'Changes' : `Changes ${changes}`)}
          {/if}
        </div>
      </div>
      <span class="header-spacer"></span>
      <!-- the finder: the panel header's search icon -->
      <div class="header-cluster">
        <button class="quiet-button icon" aria-label={named('files.goToFile', 'Go to File')} data-command="files.goToFile" data-tip="Go to File" disabled={panelSession === null} onmousedown={keepFocus} onclick={() => commands.run('files.goToFile')}><Icon name="search" /></button>
      </div>
    </div>
    <!-- the panel's body is the files feature's: the tree, or the Changes list -->
    <div class="panel-body">
      <FilePanel sessionId={panelSession} {mode} {activeFile} onchanges={(n) => (changes = n)} onmode={(m) => setLayout((l) => setPanelMode(l, m))} />
    </div>
  </section>
  <section class="column main-column" role="main" aria-label="Session">
    <MainHeader menuButton={menuIn === 'main'} />
    <Banners />
    <MainPane />
  </section>
  {#if d.sidebar > 0}
    <Divider column="sidebar" x={d.sidebar} label="Resize sidebar" splitDrawn={viewingState.agentPane !== null} />
  {/if}
  {#if d.tree > 0}
    <Divider column="tree" x={d.sidebar + d.tree} label="Resize file panel" splitDrawn={viewingState.agentPane !== null} />
  {/if}
  <Menus />
  <TerminalMenu />
  <TextMenu />
  {#if menuButton}
    <WindowMenu />
  {/if}
  <!-- the file panel's menus -->
  <FilesLayers />
  <!-- the command palette (⌘⇧P; ⌘P in file mode, which is the finder) -->
  <PaletteLayer />
  {#if statusUi.popover}
    {#key statusUi.popover.seq}
      <SessionPopover sessionId={statusUi.popover.sessionId} report={statusUi.popover.report} />
    {/key}
  {/if}
  <ToastHost />
  <HudHost />
  <!-- the window's one tooltip: a control names its command with `data-command`, its text with `data-tip` -->
  <Tooltip resolve={commandTip} />
</div>
