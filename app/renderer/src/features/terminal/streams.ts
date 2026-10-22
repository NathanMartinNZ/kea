// The window's terminal stream ports. A view holds one from the moment its stream opens until it closes it: on
// re-attach (a new snapshot, a ptyhost restart) and on dispose. The resource report counts the ports held here
// (`renderer.streamPorts`), not the views, so a view that forgets to close its port, or one left without a stream,
// shows in the leak and report tests (L-MEM-13, L-MEM-20).

import type { Channel } from '@kea/protocol'

const held = new Set<Channel>() // bounded: one per attached terminal view

/** A view now holds this stream port. */
export function holdStream(ch: Channel): Channel {
  held.add(ch)
  return ch
}

/** Close a view's stream port (the renderer's end), held or not. */
export function closeStream(ch: Channel | null): void {
  if (!ch) return
  held.delete(ch)
  ch.close()
}

/** The stream ports this window holds open. */
export function streamPorts(): number {
  return held.size
}
