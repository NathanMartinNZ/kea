// Core's rows of the resource report, registered on kit's process-global registry so the report main
// collects (the `report` message), the leak suite's hook and "Copy diagnostics" all read the same thing. Kit's own rows
// (`kit.children.*` from runProcess, `kit.timers`, `kit.scopes`, …) sit beside these.
//
//   core.connections    renderer connection scopes (one RPC peer per window)
//   core.visible        of those, the ones showing a session (the visible set)
//   core.control        the ptyhost control connection (1 while connected)
//   core.controlWaiters calls waiting for the control port while ptyhost is away (≤ L.coreControlWaitersMax)
//   core.subscriptions  store subscriptions served to renderers
//   core.pendingDeltas  of those, the ones holding a merged delta not yet sent
//   core.terminalRecords  terminal records: SQLite, and terminals.json for the `shells` pseudo-session
//   core.orphans        orphaned-holder entries (`terminals.orphans`)
//   core.terminalLaunches  PTYs being launched: record written, not yet listed by ptyhost (`Terminals`' `spawning`)
//   core.sessionsSeen   the sessions the Time Machine exclusions know of (`SessionsSeen`, ≤ sessions in the store)
//   core.tabTitles      shell tabs on screen followed for their foreground process, rate-limit timers armed,
//                       `STAT`s out
//   core.db             the SQLite connection: prepared statements, WAL bytes, status writes waiting for the tick
//   core.projects       project records (the `projects` store) and repositories holding the worktree mutex
//   core.settings       settings values held, the settings.json watcher, change listeners
//   core.keybindings    entries of keybindings.json in use, notices held, its watch
//   core.ghostty        the Ghostty config's watch while the theme follows it, its pending re-read, listeners
//   core.sessions      sessions in the store, creations in progress or failed, other per-session state, per-session
//                       call queues, background work in flight (pipelines, trash removal), orphaned worktrees listed
//   core.banners        app-level banners (at most one per kind)
//   core.status         live sessions' status state, recent-signal ring entries, per-session status timers, lifecycles
//                       followed, account conditions, notice listeners
//   core.statusReports  status report bundles present, by expected state (and in all)
//   core.notifications  the notification policy's live tags, the sessions in the burst window, the burst's sessions,
//                       its timers (the time-to-live and the startup summary)
//   core.agents         live agent sessions' signal state, launches waiting to turn live, status-file and transcript
//                       watches, interrupt and tier-3 timers, hook connections, envelope ids kept for the dedupe
//   core.viewer         files followed for windows (one each at most), their waiting calls and rate timers, reads in
//                       flight
//   core.servers        sessions with a dev-server entry, servers alive, `server:` stores registered, port-scan timers,
//                       scans in flight, start.sh folder watches, sessions watched for auto-start
//   core.editors        editors and terminal app in the detection cache, a detection under way, launches in flight;
//                       and the checks of printed paths: on disk, waiting, places whose check hung
//   core.watch          worktrees followed, common dirs, native streams, sessions attached and those marked stale,
//                       events pending and the most ever pending, files and directories riding a stream or watched
//                       singly, poll and restart timers, watches refused at the cap, worktrees released by the LRU;
//                       on Linux the entries the followed trees hold, worktrees released at their cap, and
//                       whether an inotify limit is held
//   core.files          sessions held, visible and with caches, directories and entries loaded, status entries,
//                       ignored paths known, line counts cached, status runs in flight and waiting, finder indexes,
//                       workers and paths, cache evictions, git-facts listeners, timers
//   core.disk           rows of the `disk` store, sessions waiting for a size walk, a walk under way, its thread, the
//                       schedule's timer, work in flight (walks, removals, trash deletions), retries noted. Levels,
//                       every one
//
// Not every row is a level. `core.watch.evictions`, `.refused`, `.unfollowed` and `.entriesReleased` and
// `core.files.evictions` count events since core started, and `core.watch.peakPendingEvents` is a high-water mark. The
// leak suite holds every other row to its baseline, so it names these one by one (tests/support/app-leak.ts
// `EVENT_ROWS` and `CAPPED`): a new row of either kind is added there.

import { combinedDisposable, markAsSingleton, registerSingletonGauge, type Disposable } from '@kea/kit'
import type { RpcPeer } from '@kea/protocol'

export interface CoreGaugeSources {
  /** The window connections (one RPC peer per window). */
  connections: ReadonlyMap<number, Pick<RpcPeer, 'stats'>>
  terminals: { readonly resourceCounts: { control: number; waiters: number; records: number; orphans: number; titles?: number; titleTimers?: number; titleAsks?: number; launching?: number } }
  /** The sessions the Time Machine exclusions know of (platform/backupExclusions.ts); none without a writer. */
  sessionsSeen?: { readonly size: number } | null
  db?: { readonly stats: { statements: number; walBytes: number } }
  statusBatch?: { readonly pending: number }
  projects?: { readonly resourceCounts: { projects: number; repoLocks: number } }
  settings?: { readonly resourceCounts: { values: number; watchers: number; listeners: number } }
  keybindings?: { readonly resourceCounts: { entries: number; notices: number; watchers: number } }
  ghostty?: { readonly resourceCounts: { watchers: number; timers: number; listeners: number } }
  sessions?: { readonly resourceCounts: { sessions: number; creations: number; perSession: number; queues: number; pending: number; orphans: number } }
  banners?: { readonly store: { readonly size: number } }
  status?: { readonly resourceCounts: Record<string, number>; readonly reports: { counts(): Record<string, number> } }
  notifications?: { readonly resourceCounts: Record<string, number> }
  agents?: { readonly resourceCounts: Record<string, number> }
  /** The visible set (platform/visible.ts). */
  visible?: { readonly size: number }
  /** The viewer service (viewer/service.ts). */
  viewer?: { readonly resourceCounts: Record<string, number> }
  /** The dev servers (server/servers.ts). */
  servers?: { readonly resourceCounts: Record<string, number> }
  /** The editor launcher (editor/editors.ts). */
  editors?: { readonly resourceCounts: Record<string, number> }
  /** The watch service, when it is the real one (platform/watch/watcher.ts). */
  watch?: { readonly resourceCounts: Record<string, number> } | undefined
  /** Files and git (files/service.ts). */
  files?: { readonly resourceCounts: Record<string, number> }
  /** Worktree sizes and build folders (worktrees/disk.ts). */
  disk?: { readonly resourceCounts: Record<string, number> }
}

export function registerCoreGauges(src: CoreGaugeSources): Disposable {
  const sum = (k: 'servedSubs' | 'pendingDeltas') => {
    let n = 0
    for (const c of src.connections.values()) n += c.stats[k]
    return n
  }
  return markAsSingleton(
    combinedDisposable(
      registerSingletonGauge('core.connections', () => src.connections.size),
      registerSingletonGauge('core.control', () => src.terminals.resourceCounts.control),
      registerSingletonGauge('core.controlWaiters', () => src.terminals.resourceCounts.waiters),
      registerSingletonGauge('core.subscriptions', () => sum('servedSubs')),
      registerSingletonGauge('core.pendingDeltas', () => sum('pendingDeltas')),
      registerSingletonGauge('core.terminalRecords', () => src.terminals.resourceCounts.records),
      registerSingletonGauge('core.orphans', () => src.terminals.resourceCounts.orphans),
      registerSingletonGauge('core.terminalLaunches', () => src.terminals.resourceCounts.launching ?? 0),
      ...(src.sessionsSeen ? [registerSingletonGauge('core.sessionsSeen', () => src.sessionsSeen!.size)] : []),
      registerSingletonGauge('core.tabTitles', () => {
        const c = src.terminals.resourceCounts
        return { tabs: c.titles ?? 0, timers: c.titleTimers ?? 0, asks: c.titleAsks ?? 0 }
      }),
      ...(src.db ? [registerSingletonGauge('core.db', () => ({ statements: src.db!.stats.statements, walBytes: src.db!.stats.walBytes, pendingWrites: src.statusBatch?.pending ?? 0 }))] : []),
      ...(src.projects ? [registerSingletonGauge('core.projects', () => ({ ...src.projects!.resourceCounts }))] : []),
      ...(src.settings ? [registerSingletonGauge('core.settings', () => ({ ...src.settings!.resourceCounts }))] : []),
      ...(src.keybindings ? [registerSingletonGauge('core.keybindings', () => ({ ...src.keybindings!.resourceCounts }))] : []),
      ...(src.ghostty ? [registerSingletonGauge('core.ghostty', () => ({ ...src.ghostty!.resourceCounts }))] : []),
      ...(src.sessions ? [registerSingletonGauge('core.sessions', () => ({ ...src.sessions!.resourceCounts }))] : []),
      ...(src.banners ? [registerSingletonGauge('core.banners', () => src.banners!.store.size)] : []),
      ...(src.status ? [registerSingletonGauge('core.status', () => ({ ...src.status!.resourceCounts })), registerSingletonGauge('core.statusReports', () => ({ ...src.status!.reports.counts() }))] : []),
      ...(src.notifications ? [registerSingletonGauge('core.notifications', () => ({ ...src.notifications!.resourceCounts }))] : []),
      ...(src.agents ? [registerSingletonGauge('core.agents', () => ({ ...src.agents!.resourceCounts }))] : []),
      ...(src.visible ? [registerSingletonGauge('core.visible', () => src.visible!.size)] : []),
      ...(src.viewer ? [registerSingletonGauge('core.viewer', () => ({ ...src.viewer!.resourceCounts }))] : []),
      ...(src.servers ? [registerSingletonGauge('core.servers', () => ({ ...src.servers!.resourceCounts }))] : []),
      ...(src.editors ? [registerSingletonGauge('core.editors', () => ({ ...src.editors!.resourceCounts }))] : []),
      ...(src.watch ? [registerSingletonGauge('core.watch', () => ({ ...src.watch!.resourceCounts }))] : []),
      ...(src.files ? [registerSingletonGauge('core.files', () => ({ ...src.files!.resourceCounts }))] : []),
      ...(src.disk ? [registerSingletonGauge('core.disk', () => ({ ...src.disk!.resourceCounts }))] : []),
    ),
  )
}
