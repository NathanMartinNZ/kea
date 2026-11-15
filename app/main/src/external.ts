// The one place a URL leaves Kea for the system browser: a terminal's links, the dev server's chip and About's release
// notes. The window asks with `kea:openLink` and main answers `kea:linkOpened` (`handLink`, through
// browserHandoffs.ts), after `checkLink` (links.ts) has checked the address whatever the window decided. A `window.open`
// is denied after its URL is handed over the same way, with no answer.
//
// A build run with `--kea-perf` gets the recorder instead of the system: a browser would take the keyboard from
// whoever is at the machine, so no test and no perf run ever opens one. The harness reads what would have been opened
// through `__keaTest.opened()` (testHooks.ts).

import { BoundedQueue } from '@kea/kit'
import { L } from '@kea/protocol'
import { checkLink, externalUrl, type LinkRefusal } from './links.ts'

export interface ExternalOpener {
  /** Hand a URL that passed `checkLink` to the system; rejects when the system refused it. */
  open(url: string): Promise<void>
}

/** The stand-in for the system browser: it keeps what it was asked to open, newest last. */
export class RecordingOpener implements ExternalOpener {
  // bounded: the newest L.logMemoryEntries URLs (an in-memory log for tests)
  readonly log = new BoundedQueue<string>({ cap: L.logMemoryEntries, overflow: 'drop-oldest' })

  open(url: string): Promise<void> {
    this.log.push(url)
    return Promise.resolve()
  }
}

/** Why a link was not handed over, in words. */
export const LINK_REFUSALS: Readonly<Record<LinkRefusal, string>> = {
  long: 'The link is too long to open',
  scheme: 'Kea opens only web and mail links',
  malformed: 'The link is not a valid address',
}
/** Words for a link the system refused without saying why. */
export const LINK_NOT_OPENED = 'The link could not be opened'

/**
 * A link the window asked to open (`kea:openLink`): checked, then given to `opener`. Why not in words, or null once it
 * is handed over. `called` is told just before the opener is, whose call cannot be taken back.
 */
export async function handLink(raw: unknown, opener: ExternalOpener, called: () => void): Promise<string | null> {
  const r = checkLink(raw)
  if ('why' in r) return LINK_REFUSALS[r.why]
  called()
  try {
    await opener.open(r.url)
    return null
  } catch {
    return LINK_NOT_OPENED
  }
}

/**
 * A `window.open` the window made: checked, then given to `opener`. Returns the URL that was opened, or null when it
 * must not be (nothing reaches the opener then).
 */
export function openLink(raw: string, opener: ExternalOpener): string | null {
  const url = externalUrl(raw)
  if (url === null) return null
  opener.open(url).catch(() => undefined)
  return url
}
