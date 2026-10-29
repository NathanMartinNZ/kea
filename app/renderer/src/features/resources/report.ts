// The renderer's resource report: the terminal rows (views.ts) plus the command handlers and the menu-state report and
// the store subscriptions on the RPC port. Main asks for it through the preload (`kea:resources`) for the hourly
// resources.ndjson line; the leak suite reads the same function through `__keaPerf.resources()`. The renderer has no
// kit registry: its rows are read here when the report is taken (rows.ts: dotted under `renderer.`, NaN for the rows of
// a gauge that throws).
//
//   renderer.terminals, .webglContexts, .atlasBytes, .atlasPages, .streamPorts, .searchAddons, .scrollMarks   views.ts (terminalResources)
//   renderer.commandHandlers     handlers registered in the command registry (≤ one per command of the table)
//   renderer.menuStateEntries    entries in the last menu state sent to main
//   renderer.keyChords           chords the key router matches (≤ the table's keys plus one per command)
//   renderer.keyOverrides, .keyNotices   entries of keybindings.json in use, and entries left out with their reason
//                                (each ≤ `keybindingsMaxEntries`)
//   renderer.paletteOpen, .paletteCandidates, .paletteRows   the palette: open (0 or 1), the candidates its index
//                                holds and the rows it lists (0 while closed; rows ≤ `paletteResults`)
//   renderer.paletteUsage        commands with a usage count (≤ one per command of the table)
//   renderer.tooltips            tooltip elements in the document (0 or 1)
//   renderer.menus               floating menus in the document (0 or 1: one is open at a time)
//   renderer.storeSubscriptions  core stores this window follows on its RPC port
//   renderer.storeRows           rows in its copies of them (`projects`, `sessions`, `terminals`, `banners`,
//                                `status.conditions`, `agents`: the frame-coalesced stores)
//   renderer.storeListeners      components listening to those copies
//   renderer.mru                 sessions in the ⌃Tab order
//   renderer.drafts              composer drafts, one per project
//   renderer.tabMemory           sessions whose last active tab the window remembers
//   renderer.fileTabs            file and diff tabs the window holds, over all sessions
//   renderer.folderPicks         folder pickers waiting for main's answer
//   renderer.serverStores        `server:<sessionId>` stores followed: the session on screen's, at most one
//   renderer.linkChecks          checked file references of terminal lines the window remembers
//   renderer.fileStores, .fileTreeDirs, .fileTreeRows, .fileGitEntries, .fileExpanded, .fileRowsDrawn,
//   .filePanelTimers, .fileLayers   the file panel: what it holds of the session on screen (features/files/resources.ts)
//   renderer.viewerEditors, .viewerMerges, .viewerDocBytes, .viewerCachedDocs, .viewerCachedBytes, .highlightWorkers,
//   .highlightPending, .highlightGrammars, .viewerFollows, .viewerReads   the file viewer (features/viewer/resources.ts)
//   renderer.diskRows, .diskBranches, .diskDeleted, .diskSelected, .diskObservers   Settings › Disk while it is open: rows
//                                of core's `disk` store held, branch states held, deleted sessions listed, rows selected
//                                or busy, its one observer of the rows on screen (0 while closed; features/disk)
//   renderer.diagnosticsAsks     questions to main for every process's report not answered yet (Copy diagnostics, the HUD)
//   renderer.hudTimers           the dev-only performance HUD's frame loop and interval: 2 while shown, 0 while hidden

import type { ResourceReport } from '@kea/protocol'
import { folderPicksPending, setResourceReporter } from '../../lib/bridge.ts'
import { rpcStats } from '../../lib/rpc.ts'
import { bindingsResources } from '../commands/bindings.svelte.ts'
import { menuStateEntries } from '../commands/install.ts'
import { bindingChords } from '../commands/keys.ts'
import { commands } from '../commands/registry.ts'
import { palette, paletteHolds, usage } from '../palette/state.svelte.ts'
import { drafts } from '../composer/drafts.ts'
import { DIAGNOSTICS_ROWS, diagnosticsResources } from '../diagnostics/resources.ts'
import { DISK_ROWS, diskResources } from '../disk/state.svelte.ts'
import { FILES_ROWS, filesResources } from '../files/resources.ts'
import { serverStores } from '../server/state.svelte.ts'
import { sessionsResources } from '../sessions/state.svelte.ts'
import { statusResources } from '../status/state.ts'
import { linkChecks } from '../terminal/fileLinks.ts'
import { VIEWER_ROWS, viewerResources } from '../viewer/resources.ts'
import { terminalResources } from '../terminal/views.ts'
import { bannerStore } from '../../shell/bannerStore.ts'
import { fileTabMemory } from '../../shell/fileTabs.svelte.ts'
import { tabMemory } from '../../shell/terminalPane.ts'
import { readGauges, type Gauge } from './rows.ts'

const GAUGES: readonly Gauge[] = [
  { rows: ['terminals', 'webglContexts', 'atlasBytes', 'atlasPages', 'streamPorts', 'searchAddons', 'scrollMarks'], read: terminalResources },
  { rows: ['commandHandlers'], read: () => ({ commandHandlers: commands.size }) },
  { rows: ['menuStateEntries'], read: () => ({ menuStateEntries: menuStateEntries() }) },
  { rows: ['keyChords', 'keyOverrides', 'keyNotices'], read: () => ({ keyChords: bindingChords(), ...bindingsResources() }) },
  { rows: ['paletteOpen', 'paletteCandidates', 'paletteRows', 'paletteUsage'], read: () => ({ paletteOpen: palette.open ? 1 : 0, paletteCandidates: paletteHolds.candidates, paletteRows: paletteHolds.rows, paletteUsage: usage.size }) },
  { rows: ['tooltips'], read: () => ({ tooltips: document.querySelectorAll('.kea-tooltip').length }) },
  { rows: ['menus'], read: () => ({ menus: document.querySelectorAll('.kea-menu').length }) },
  { rows: ['storeSubscriptions'], read: () => ({ storeSubscriptions: rpcStats().subscriptions }) },
  {
    rows: ['storeRows', 'storeListeners', 'mru'],
    read: () => {
      const s = sessionsResources()
      const b = bannerStore()
      const st = statusResources()
      return { storeRows: s.projects + s.sessions + s.terminals + b.rows + st.rows, storeListeners: s.listeners + b.listeners + st.listeners, mru: s.mru }
    },
  },
  { rows: ['drafts'], read: () => ({ drafts: drafts.size }) },
  { rows: ['tabMemory'], read: () => ({ tabMemory: tabMemory() }) },
  { rows: ['fileTabs'], read: () => ({ fileTabs: fileTabMemory() }) },
  { rows: ['folderPicks'], read: () => ({ folderPicks: folderPicksPending() }) },
  { rows: ['serverStores'], read: () => ({ serverStores: serverStores() }) },
  { rows: ['linkChecks'], read: () => ({ linkChecks: linkChecks() }) },
  { rows: VIEWER_ROWS, read: viewerResources },
  { rows: FILES_ROWS, read: filesResources },
  { rows: DISK_ROWS, read: diskResources },
  { rows: DIAGNOSTICS_ROWS, read: diagnosticsResources },
]

export function rendererResources(): ResourceReport {
  return readGauges(GAUGES, (rows, e) => console.warn('resource gauge failed', rows.join(', '), e))
}

/** Answer main's requests with this report. */
export function installResourceReport(): void {
  setResourceReporter(rendererResources)
}
