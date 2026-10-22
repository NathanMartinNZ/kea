// The one place a URL leaves Kea for the system browser: the dev server's port chip and links in a terminal. The
// renderer opens a link with `window.open`; main denies the window and hands the URL here, after `externalUrl`
// (links.ts) has checked its scheme whatever the renderer decided.
//
// A build run with `--kea-perf` gets the recorder instead of the system: a browser would take the keyboard from
// whoever is at the machine, so no test and no perf run ever opens one. The harness reads what would have been opened
// through `__keaTest.opened()` (testHooks.ts).

import { BoundedQueue } from '@kea/kit'
import { L } from '@kea/protocol'
import { externalUrl } from './links.ts'

export interface ExternalOpener {
  /** Hand a URL that passed `externalUrl` to the system. */
  open(url: string): void
}

/** The stand-in for the system browser: it keeps what it was asked to open, newest last. */
export class RecordingOpener implements ExternalOpener {
  // bounded: the newest L.logMemoryEntries URLs (an in-memory log for tests)
  readonly log = new BoundedQueue<string>({ cap: L.logMemoryEntries, overflow: 'drop-oldest' })

  open(url: string): void {
    this.log.push(url)
  }
}

/**
 * A link the window asked to open: checked, then given to `opener`. Returns the URL that was opened, or null when it
 * must not be (nothing reaches the opener then).
 */
export function openLink(raw: string, opener: ExternalOpener): string | null {
  const url = externalUrl(raw)
  if (url === null) return null
  opener.open(url)
  return url
}
