// The renderer's RPC client to core: one RpcPeer per port; when core restarts, main sends a new port and the client
// moves to it, re-subscribing every store. Typed by `coreApi`, the whole renderer → core surface.

import { coreApi, fromDomPort, RpcPeer, type ArgsOf, type CoreApi, type ResultOf, type StoreView } from '@kea/protocol'
import { onRpcPort } from './bridge.ts'

type Peer = RpcPeer<Record<string, never>, CoreApi>
/** `changed`: the keys a delta touched; null for a snapshot (the first one, and after a core restart). */
type Sub = { store: string; cb: (data: ReadonlyMap<string, unknown>, changed: readonly string[] | null) => void; view: StoreView<unknown> | null }

let peer: Peer | null = null
const waiters: ((p: Peer) => void)[] = [] // bounded: calls made before the first port arrives
const subs = new Set<Sub>() // bounded: one per store the UI shows
const portFirst = new Set<() => void>() // bounded: one per installed module with something to say first (the visible set)

onRpcPort((port) => {
  peer?.dispose()
  const p: Peer = new RpcPeer(fromDomPort(port as never), { name: 'renderer→core' }, coreApi)
  peer = p
  // what core must know before any store is subscribed (the visible set: a session's stores exist only while it is shown)
  for (const f of portFirst) f()
  for (const s of subs) attach(p, s)
  for (const w of waiters.splice(0)) w(p)
})

function attach(p: Peer, s: Sub): void {
  s.view = p.subscribe(s.store, (v, changed) => s.cb(v.data, changed))
}

function ready(): Promise<Peer> {
  if (peer && !peer.isDisposed) return Promise.resolve(peer)
  return new Promise((resolve) => waiters.push(resolve))
}

export async function call<K extends keyof CoreApi & string>(method: K, args: ArgsOf<CoreApi, K>): Promise<ResultOf<CoreApi, K>> {
  return (await ready()).call(method, args)
}

/**
 * Send a call on the current port before this function returns, so that it reaches core ahead of whatever is sent
 * next (a subscription). Null when there is no port now: nothing is sent, and `onPortFirst` is the place to say it.
 */
export function callNow<K extends keyof CoreApi & string>(method: K, args: ArgsOf<CoreApi, K>): Promise<ResultOf<CoreApi, K>> | null {
  return peer && !peer.isDisposed ? peer.call(method, args) : null
}

/** `cb` on every new port (the first, and each one after a core restart), before the stores are subscribed on it. */
export function onPortFirst(cb: () => void): () => void {
  portFirst.add(cb)
  return () => portFirst.delete(cb)
}

/**
 * Store subscriptions live on the current port (the resource report's `storeSubscriptions`), and the window's
 * calls still waiting for core's answer (the test probe `rpcPending`: a test waits for a sheet's preview with it).
 */
export function rpcStats(): { subscriptions: number; pendingCalls: number } {
  const live = peer && !peer.isDisposed ? peer.stats : null
  return { subscriptions: live?.clientSubs ?? 0, pendingCalls: live?.pendingCalls ?? 0 }
}

/**
 * Follow a core store across core restarts. The callback gets the store's current copy and the keys that changed (null
 * after a snapshot). Returns an unsubscribe function.
 */
export function subscribe<V>(store: string, cb: (data: ReadonlyMap<string, V>, changed: readonly string[] | null) => void): () => void {
  const s: Sub = { store, cb: cb as Sub['cb'], view: null }
  subs.add(s)
  if (peer && !peer.isDisposed) attach(peer, s)
  return () => {
    subs.delete(s)
    s.view?.unsubscribe()
  }
}
