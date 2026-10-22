import { describe, expect, it } from 'vitest'
import type { Channel } from '@kea/protocol'
import { closeStream, holdStream, streamPorts } from './streams.ts'

/** A stream port's channel that knows whether it was closed. */
function port(): Channel & { closed: boolean } {
  const ch = {
    closed: false,
    send() {},
    onMessage: () => () => {},
    onClose: () => () => {},
    close() {
      ch.closed = true
    },
  }
  return ch
}

/** What a terminal view does with its stream (view.ts `attach` / `dispose`), reduced to the port. */
class View {
  ch: Channel | null = null
  /** The stream opened: the view holds the port. */
  attached(p: Channel): void {
    closeStream(this.ch)
    this.ch = holdStream(p)
  }
  /** Re-attach started (a ptyhost restart): the old port is closed before the new one arrives. */
  reattaching(): void {
    closeStream(this.ch)
    this.ch = null
  }
  dispose(): void {
    closeStream(this.ch)
    this.ch = null
  }
}

describe('stream ports', () => {
  it('U-TERM-32 · the renderer’s stream-port count is the ports its views hold open, not the number of views: a view with no stream, one re-attaching and a disposed one hold none', () => {
    const ports = [port(), port(), port()]
    const a = new View()
    const b = new View()
    const c = new View() // its stream never opened (ptyhost was not running): it shows what it has, with no port
    a.attached(ports[0]!)
    b.attached(ports[1]!)
    expect(streamPorts()).toBe(2)
    // ptyhost restarted: a's port is closed at once, its new one comes later
    a.reattaching()
    expect(streamPorts()).toBe(1)
    a.attached(ports[2]!)
    expect(streamPorts()).toBe(2)
    expect(ports[0]!.closed).toBe(true)
    // disposing closes the view's port, once
    b.dispose()
    b.dispose()
    expect(ports[1]!.closed).toBe(true)
    expect(streamPorts()).toBe(1)
    a.dispose()
    c.dispose()
    expect(streamPorts()).toBe(0)
  })
})
