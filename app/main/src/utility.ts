// The Electron side of a supervised child: a `utilityProcess` behind kit's `SupervisedChild`.
// Heartbeats are `ping`/`pong` on `parentPort` (`packages/protocol` process.ts); so are resource-report requests
// (`report`), each ended by its answer, its deadline or the child's exit. An answer whose report fails the
// checks ends its request at once and is logged.

import { utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron'
import { Emitter, type Disposable, type Logger, type SupervisedChild } from '@kea/kit'
import { isChildToMain, refusedReportId, type MainToChild, type MenuBarState, type NotificationOp, type ResourceReport } from '@kea/protocol'
import { Replies } from './resources.ts'

export class UtilityChild implements SupervisedChild {
  readonly name: string
  private readonly proc: UtilityProcess
  private readonly pongs = new Emitter<void>({ name: 'UtilityChild.pong' })
  private readonly exits = new Emitter<number | null>({ name: 'UtilityChild.exit' })
  private readonly readies = new Emitter<void>({ name: 'UtilityChild.ready' })
  private readonly testReplies = new Emitter<TestReply>({ name: 'UtilityChild.testReply' })
  private readonly reports = new Replies<ResourceReport>()
  private readonly menuBars = new Emitter<MenuBarState>({ name: 'UtilityChild.menuBar' })
  private readonly notices = new Emitter<NotificationOp>({ name: 'UtilityChild.notify' })
  private readonly visibles = new Emitter<{ connId: number; dirs: string[] }>({ name: 'UtilityChild.visible' })
  private readonly watchLimits = new Emitter<boolean>({ name: 'UtilityChild.watchLimit' })
  private readonly updateChecks = new Emitter<boolean>({ name: 'UtilityChild.updates' })
  private readonly stops = new Replies<true>()
  private n = 0
  private exited = false
  private everReady = false
  isReady = false

  /**
   * `env`: test hooks only (testHooks.ts); otherwise the child inherits main's environment. `v8Flags`: V8 flags for the
   * child, passed as `--js-flags=…`, the one form a utility process honours.
   */
  constructor(name: string, entry: string, args: string[], log: Logger, env?: Record<string, string>, v8Flags: readonly string[] = []) {
    this.name = name
    this.proc = utilityProcess.fork(entry, args, { serviceName: `Kea ${name}`, stdio: 'inherit', ...(env ? { env } : {}), ...(v8Flags.length ? { execArgv: [`--js-flags=${v8Flags.join(' ')}`] } : {}) })
    this.proc.on('message', (m: unknown) => {
      if (!isChildToMain(m)) {
        const refused = refusedReportId(m)
        if (refused !== null) {
          log.warn('resource report refused', { process: name, id: refused })
          this.reports.end(refused)
        } else if (isTestReply(m)) this.testReplies.fire(m)
        return
      }
      if (m.k === 'pong') this.pongs.fire()
      else if (m.k === 'ready') {
        this.isReady = true
        this.everReady = true
        this.readies.fire()
      } else if (m.k === 'locked') log.error('another Kea instance holds this KEA_HOME', { process: name, lock: m.path })
      else if (m.k === 'report') this.reports.answer(m.id, m.report)
      else if (m.k === 'menuBar') {
        const { k: _k, ...state } = m
        this.menuBars.fire(state)
      } else if (m.k === 'stoppedAll') this.stops.answer(m.id, true)
      else if (m.k === 'notify') {
        const { k: _k, ...op } = m
        this.notices.fire(op)
      } else if (m.k === 'visible') this.visibles.fire({ connId: m.connId, dirs: m.dirs })
      else if (m.k === 'watchLimit') this.watchLimits.fire(m.held)
      else if (m.k === 'updates') this.updateChecks.fire(m.check)
    })
    this.proc.on('exit', (code: number) => {
      if (this.exited) return
      this.exited = true
      this.isReady = false
      this.exits.fire(code)
      this.pongs.dispose()
      this.readies.dispose()
      this.testReplies.dispose()
      this.reports.dispose()
      this.menuBars.dispose()
      this.notices.dispose()
      this.visibles.dispose()
      this.watchLimits.dispose()
      this.updateChecks.dispose()
      this.stops.dispose()
    })
  }

  get pid(): number | undefined {
    return this.proc.pid
  }

  /** It said `ready` at some point (stays true after it exits: main's core-away notice). */
  get wasReady(): boolean {
    return this.everReady
  }

  /** SIGKILL, as the Supervisor expects (a hung child must not get to ignore it). */
  kill(): void {
    const pid = this.proc.pid
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL')
        return
      } catch {
        // already gone; fall through
      }
    }
    this.proc.kill()
  }

  ping(): void {
    this.post({ k: 'ping', n: ++this.n })
  }

  post(m: MainToChild, ports?: MessagePortMain[]): void {
    if (!this.exited) this.proc.postMessage(m, ports)
  }

  onPong(cb: () => void): Disposable {
    return this.pongs.event(cb)
  }
  onExit(cb: (code: number | null) => void): Disposable {
    return this.exits.event(cb)
  }
  onReady(cb: () => void): Disposable {
    return this.readies.event(cb)
  }

  /** The child's resource report, or null if it has not answered within `deadlineMs` or exits first. */
  report(deadlineMs: number): Promise<ResourceReport | null> {
    if (this.exited) return Promise.resolve(null)
    return this.reports.ask((id) => this.post({ k: 'report', id }), deadlineMs)
  }

  /** Core's menu-bar state, each time it changes. */
  onMenuBar(cb: (s: MenuBarState) => void): Disposable {
    return this.menuBars.event(cb)
  }

  /** Core's notifications to post or withdraw. */
  onNotify(cb: (op: NotificationOp) => void): Disposable {
    return this.notices.event(cb)
  }

  /**
   * Core: the working directories of the sessions a window shows, each time they change; for `kea-file://`
   * (keaFile.ts).
   */
  onVisible(cb: (v: { connId: number; dirs: string[] }) => void): Disposable {
    return this.visibles.event(cb)
  }

  /**
   * Core: its watcher holds an inotify limit, or no longer does, each time that changes; for the platform
   * report.
   */
  onWatchLimit(cb: (held: boolean) => void): Disposable {
    return this.watchLimits.event(cb)
  }

  /** Core: whether Kea may check for updates by itself (`updates.check`), at its start and on each change. */
  onUpdates(cb: (check: boolean) => void): Disposable {
    return this.updateChecks.event(cb)
  }

  /** Core: stop every session (Stop All and Quit); resolves on its answer, at `deadlineMs` or when it exits. */
  async stopAll(deadlineMs: number): Promise<void> {
    if (this.exited) return
    await this.stops.ask((id) => this.post({ k: 'stopAll', id }), deadlineMs)
  }

  /** Report requests waiting for this child's answer. */
  get pendingReports(): number {
    return this.reports.size
  }

  /** Test hooks only (testHooks.ts): a message for the child's tests/support/app-child-hooks.cjs, and its answers. */
  postTest(m: { k: 'kea-test'; id: number; op: string; arg?: string | undefined }): void {
    if (!this.exited) this.proc.postMessage(m)
  }
  onTestReply(cb: (m: TestReply) => void): Disposable {
    return this.testReplies.event(cb)
  }
}

/** An answer from tests/support/app-child-hooks.cjs. */
export type TestReply = { k: 'kea-test'; id: number; ok: boolean; value?: unknown; error?: unknown }

function isTestReply(m: unknown): m is TestReply {
  return typeof m === 'object' && m !== null && (m as { k?: unknown }).k === 'kea-test' && typeof (m as { id?: unknown }).id === 'number'
}
