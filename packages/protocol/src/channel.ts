// One transport shape over the three MessagePort flavours Kea uses: DOM ports (renderer), Electron's
// MessagePortMain (main, core, ptyhost) and node:worker_threads ports (tests). Structural types only —
// this package imports neither electron nor node builtins.

export interface Channel {
  send(msg: unknown, transfer?: unknown[]): void
  /** Returns an unsubscribe function (never rely on listener identity across a bridge). */
  onMessage(cb: (msg: unknown, ports: readonly unknown[]) => void): () => void
  onClose(cb: () => void): () => void
  close(): void
}

type DomPortLike = {
  postMessage(msg: unknown, transfer?: unknown[]): void
  addEventListener(type: 'message', cb: (e: { data: unknown; ports?: readonly unknown[] }) => void): void
  removeEventListener(type: 'message', cb: (e: { data: unknown; ports?: readonly unknown[] }) => void): void
  start?(): void
  close(): void
}

type EmitterPortLike = {
  postMessage(msg: unknown, transfer?: unknown[]): void
  on(event: string, cb: (...a: never[]) => void): unknown
  off?(event: string, cb: (...a: never[]) => void): unknown
  removeListener?(event: string, cb: (...a: never[]) => void): unknown
  start?(): void
  close(): void
}

function makeChannel(
  post: (msg: unknown, transfer?: unknown[]) => void,
  subscribe: (cb: (msg: unknown, ports: readonly unknown[]) => void) => () => void,
  subscribeClose: (cb: () => void) => () => void,
  close: () => void,
): Channel {
  let closed = false
  const closeCbs = new Set<() => void>() // bounded: one per owner of this port (its RpcPeer or stream); cleared on close
  const fireClose = () => {
    if (closed) return
    closed = true
    for (const cb of [...closeCbs]) cb()
    closeCbs.clear()
  }
  const offNative = subscribeClose(fireClose)
  return {
    send(msg, transfer) {
      if (!closed) post(msg, transfer)
    },
    onMessage: subscribe,
    onClose(cb) {
      if (closed) {
        cb()
        return () => {}
      }
      closeCbs.add(cb)
      return () => closeCbs.delete(cb)
    },
    close() {
      if (closed) return
      offNative()
      try {
        close()
      } finally {
        fireClose()
      }
    },
  }
}

/** Renderer side: a DOM MessagePort. */
export function fromDomPort(port: DomPortLike): Channel {
  const ch = makeChannel(
    (m, t) => port.postMessage(m, t ?? []),
    (cb) => {
      const h = (e: { data: unknown; ports?: readonly unknown[] }) => cb(e.data, e.ports ?? [])
      port.addEventListener('message', h)
      return () => port.removeEventListener('message', h)
    },
    () => () => {},
    () => port.close(),
  )
  port.start?.()
  return ch
}

/** Electron MessagePortMain (main, utility processes): message events carry `{ data, ports }`. */
export function fromElectronPort(port: EmitterPortLike): Channel {
  const off = (ev: string, h: (...a: never[]) => void) => (port.off ?? port.removeListener)?.call(port, ev, h)
  const ch = makeChannel(
    // MessagePortMain rejects an `undefined` transfer list ("transferables must be an array of MessagePorts")
    (m, t) => (t ? port.postMessage(m, t) : port.postMessage(m)),
    (cb) => {
      const h = ((e: { data: unknown; ports?: readonly unknown[] }) => cb(e.data, e.ports ?? [])) as (...a: never[]) => void
      port.on('message', h)
      return () => off('message', h)
    },
    (cb) => {
      const h = (() => cb()) as (...a: never[]) => void
      port.on('close', h)
      return () => off('close', h)
    },
    () => port.close(),
  )
  port.start?.()
  return ch
}

/** node:worker_threads MessagePort (tests): message events carry the data itself. */
export function fromNodePort(port: EmitterPortLike): Channel {
  const off = (ev: string, h: (...a: never[]) => void) => (port.off ?? port.removeListener)?.call(port, ev, h)
  const ch = makeChannel(
    (m, t) => port.postMessage(m, t),
    (cb) => {
      const h = ((d: unknown) => cb(d, [])) as (...a: never[]) => void
      port.on('message', h)
      return () => off('message', h)
    },
    (cb) => {
      const h = (() => cb()) as (...a: never[]) => void
      port.on('close', h)
      return () => off('close', h)
    },
    () => port.close(),
  )
  port.start?.()
  return ch
}

/**
 * An in-memory pair for unit tests: messages are structured-cloned and delivered asynchronously. Like a real port,
 * messages sent before `close()` are still delivered; the close follows them.
 */
export function channelPair(): [Channel, Channel] {
  // bounded: test-only pair; listeners and close callbacks are cleared on close
  type End = { listeners: Set<(m: unknown, p: readonly unknown[]) => void>; closeCbs: Set<() => void>; closed: boolean; closing: boolean; peer?: End }
  const a: End = { listeners: new Set(), closeCbs: new Set(), closed: false, closing: false }
  const b: End = { listeners: new Set(), closeCbs: new Set(), closed: false, closing: false }
  a.peer = b
  b.peer = a
  const make = (self: End): Channel => ({
    send(msg) {
      if (self.closing || self.closed || self.peer!.closed) return
      const copy = structuredClone(msg)
      queueMicrotask(() => {
        if (self.peer!.closed) return
        for (const l of [...self.peer!.listeners]) l(copy, [])
      })
    },
    onMessage(cb) {
      self.listeners.add(cb)
      return () => self.listeners.delete(cb)
    },
    onClose(cb) {
      if (self.closed) {
        cb()
        return () => {}
      }
      self.closeCbs.add(cb)
      return () => self.closeCbs.delete(cb)
    },
    close() {
      if (self.closing || self.closed) return
      self.closing = true
      // after the deliveries already queued by send()
      queueMicrotask(() => {
        for (const end of [self, self.peer!]) {
          if (end.closed) continue
          end.closed = true
          for (const cb of [...end.closeCbs]) cb()
          end.closeCbs.clear()
          end.listeners.clear()
        }
      })
    },
  })
  return [make(a), make(b)]
}
