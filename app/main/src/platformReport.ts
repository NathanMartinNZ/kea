// The platform report as main keeps it. The OS layer's `report` makes the lines (os/darwin.ts, os/linux.ts);
// this keeps the last report and hands it to core, which shows it: Settings › About asks core for it
// (`diagnostics.platform`), and Copy Diagnostics and status reports include it, scrubbed.
//
// When it is assembled: as each core becomes ready (the start, and a core that restarted, which knows nothing yet), and
// when a window's renderer starts, since its sandbox is read from it. It is assembled again when a capability it
// reports changes: the desktop's services (the tray host, the notification service), Chromium's GPU (WebGL2 or not) and
// core's watcher holding an inotify limit or letting it go. A report is sent to core only when it differs from what
// that core was last sent. Assembling reads a few files and no child, so it is done at once, never queued.

import type { Logger } from '@kea/kit'
import type { PlatformReport } from '@kea/protocol'

/** What made main assemble the report: logged with it when it changed. */
export type PlatformReportWhy = 'coreReady' | 'window' | 'services' | 'gpu' | 'watchLimit' | 'test'

export interface PlatformReportsOptions {
  /** The report now (the OS layer's `report`); null where the system has none. */
  build(): PlatformReport | null
  /** Hand the report to core; false when no core is ready to take it. */
  send(report: PlatformReport): boolean
  log: Logger
}

export class PlatformReports {
  private readonly o: PlatformReportsOptions
  /** The report assembled last: one, replaced by the next. */
  private last: PlatformReport | null = null
  private lastText: string | null = null
  /** The report as the core now running was last sent it; null: this core has none yet. */
  private sentText: string | null = null

  constructor(o: PlatformReportsOptions) {
    this.o = o
  }

  get latest(): PlatformReport | null {
    return this.last
  }

  /** A core became ready: it has no report yet, so it gets this one whatever it was sent before. */
  coreReady(): PlatformReport | null {
    this.sentText = null
    return this.assemble('coreReady')
  }

  /** Assemble the report again: kept, logged when it changed (the ids of the lines with a fix, never their text), and sent to core when that core has not had it. */
  assemble(why: PlatformReportWhy): PlatformReport | null {
    let r: PlatformReport | null
    try {
      r = this.o.build()
    } catch (e) {
      this.o.log.warn('platform report not assembled', { why, error: String(e) })
      return this.last
    }
    if (!r) return null
    const text = JSON.stringify(r)
    if (text !== this.lastText) this.o.log.info('platform report', { why, system: r.system, lines: r.lines.length, fixes: r.lines.filter((l) => l.fix !== null).map((l) => l.id) })
    this.last = r
    this.lastText = text
    if (text !== this.sentText && this.o.send(r)) this.sentText = text
    return r
  }
}
