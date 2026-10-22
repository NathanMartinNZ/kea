// RPC over a Channel: request/response with cancellation, fire-and-forget notifications, and store subscriptions
// (snapshot + coalesced, latest-wins deltas). Either side can serve and call. A peer is one connection scope:
// disposing it drops every subscription, pending call and timer.
import type { z } from 'zod'
import type { Channel } from './channel.ts'
import { applyDelta, isEmptyDelta, mergeDelta, type Delta, type Snapshot, type StoreRegistry } from './store.ts'
import { L } from './generated/limits.ts'

export type MethodDef = { args: z.ZodType; result?: z.ZodType }
export type Api = Record<string, MethodDef>
export type ArgsOf<A extends Api, K extends keyof A> = z.input<A[K]['args']>
export type ResultOf<A extends Api, K extends keyof A> = A[K]['result'] extends z.ZodType ? z.output<NonNullable<A[K]['result']>> : void

export function defineApi<A extends Api>(api: A): A {
  return api
}

export type CallContext = { signal: AbortSignal; peer: RpcPeer }
export type Handlers<A extends Api> = {
  [K in keyof A]?: (args: z.output<A[K]['args']>, ctx: CallContext) => ResultOf<A, K> | Promise<ResultOf<A, K>>
}

/** `o[k]` only when `k` is an own key (never an inherited Object.prototype member). */
function own<T extends object>(o: T | undefined, k: unknown): T[keyof T] | undefined {
  return o && typeof k === 'string' && Object.hasOwn(o, k) ? o[k as keyof T] : undefined
}

export class RpcError extends Error {
  readonly code: 'unknown_method' | 'invalid_args' | 'handler_error' | 'cancelled' | 'closed' | 'timeout' | (string & {})
  constructor(code: RpcError['code'], message: string) {
    super(message)
    this.code = code
    this.name = 'RpcError'
  }
}

type Msg =
  | { k: 'req'; id: number; m: string; a: unknown }
  | { k: 'res'; id: number; ok: true; v: unknown }
  | { k: 'res'; id: number; ok: false; e: { code: string; message: string } }
  | { k: 'cancel'; id: number }
  | { k: 'note'; m: string; a: unknown }
  | { k: 'sub'; id: number; store: string }
  | { k: 'unsub'; id: number }
  | { k: 'snap'; id: number; rev: number; v: Snapshot<unknown> }
  | { k: 'delta'; id: number; rev: number; d: Delta<unknown> }
  | { k: 'ack'; id: number; rev: number }
  | { k: 'gone'; id: number }

export type StoreView<V> = {
  /** Current local copy (updated before the listener runs). */
  readonly data: ReadonlyMap<string, V>
  readonly ready: boolean
  unsubscribe(): void
}

type ServedSub = {
  store: string
  rev: number
  inflight: boolean
  pending: Delta<unknown>
  timer: ReturnType<typeof setTimeout> | null
  off: () => void
  lastFlush: number
}

type ClientSub = {
  store: string
  map: Map<string, unknown>
  ready: boolean
  cb: (view: StoreView<unknown>, changed: string[] | null) => void
  onGone?: () => void
  view: StoreView<unknown>
}

export type RpcPeerOptions<Local extends Api> = {
  name: string
  /** Methods this side serves, with their schemas (args are validated here — the receiving side). */
  api?: Local
  handlers?: Handlers<Local>
  /** Notification handlers (no response). */
  notes?: Record<string, (args: unknown, peer: RpcPeer) => void>
  stores?: StoreRegistry
  /** Validate results on the calling side too (dev builds and tests). */
  validateResults?: boolean
  onError?: (e: unknown) => void
}

export class RpcPeer<Local extends Api = Api, Remote extends Api = Api> {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; def?: MethodDef; off?: () => void }>() // bounded: one per in-flight call
  private readonly serving = new Map<number, AbortController>() // bounded: one per in-flight request from the peer
  private readonly served = new Map<number, ServedSub>() // bounded: one per subscription of this connection
  private readonly clientSubs = new Map<number, ClientSub>() // bounded: one per store this side subscribes to
  private readonly offs: (() => void)[] = []
  private disposed = false
  private readonly ch: Channel
  private readonly opts: RpcPeerOptions<Local>
  private readonly remoteApi: Remote | undefined

  constructor(ch: Channel, opts: RpcPeerOptions<Local>, remoteApi?: Remote) {
    this.ch = ch
    this.opts = opts
    this.remoteApi = remoteApi
    this.offs.push(ch.onMessage((m) => this.onMessage(m as Msg)))
    this.offs.push(ch.onClose(() => this.dispose()))
    if (opts.stores) {
      this.offs.push(
        opts.stores.onRemoved((name) => {
          for (const [id, s] of this.served) {
            if (s.store === name) {
              this.dropServed(id)
              this.ch.send({ k: 'gone', id } satisfies Msg)
            }
          }
        }),
      )
    }
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Counts for the resource report and leak tests (L-MEM-5). `pendingDeltas`: served subscriptions holding a
   * merged delta not yet sent (at most one each).
   */
  get stats(): { pendingCalls: number; servingCalls: number; servedSubs: number; clientSubs: number; pendingDeltas: number } {
    let pendingDeltas = 0
    for (const s of this.served.values()) if (!isEmptyDelta(s.pending)) pendingDeltas++
    return { pendingCalls: this.pending.size, servingCalls: this.serving.size, servedSubs: this.served.size, clientSubs: this.clientSubs.size, pendingDeltas }
  }

  call<K extends keyof Remote & string>(method: K, args: ArgsOf<Remote, K>, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ResultOf<Remote, K>> {
    if (this.disposed) return Promise.reject(new RpcError('closed', `${this.opts.name}: connection closed`))
    const id = this.nextId++
    const def = this.remoteApi?.[method]
    return new Promise<ResultOf<Remote, K>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup: (() => void)[] = []
      const entry = {
        resolve: (v: unknown) => {
          for (const c of cleanup) c()
          resolve(v as ResultOf<Remote, K>)
        },
        reject: (e: unknown) => {
          for (const c of cleanup) c()
          reject(e)
        },
        def,
      }
      this.pending.set(id, entry)
      if (o.signal) {
        if (o.signal.aborted) {
          this.pending.delete(id)
          reject(new RpcError('cancelled', `${method} cancelled`))
          return
        }
        const onAbort = () => {
          if (!this.pending.delete(id)) return
          this.ch.send({ k: 'cancel', id } satisfies Msg)
          entry.reject(new RpcError('cancelled', `${method} cancelled`))
        }
        o.signal.addEventListener('abort', onAbort, { once: true })
        cleanup.push(() => o.signal!.removeEventListener('abort', onAbort))
      }
      if (o.timeoutMs) {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return
          this.ch.send({ k: 'cancel', id } satisfies Msg)
          entry.reject(new RpcError('timeout', `${method} timed out after ${o.timeoutMs} ms`))
        }, o.timeoutMs)
        cleanup.push(() => clearTimeout(timer))
      }
      this.ch.send({ k: 'req', id, m: method, a: args } satisfies Msg)
    })
  }

  notify(method: string, args: unknown): void {
    if (!this.disposed) this.ch.send({ k: 'note', m: method, a: args } satisfies Msg)
  }

  /** Subscribe to a store served by the other side. The callback runs after each snapshot/delta is applied. */
  subscribe<V>(store: string, cb: (view: StoreView<V>, changed: string[] | null) => void, onGone?: () => void): StoreView<V> {
    const id = this.nextId++
    const sub: ClientSub = {
      store,
      map: new Map(), // bounded: a copy of the producer's store, which carries the cap
      ready: false,
      cb: cb as ClientSub['cb'],
      ...(onGone ? { onGone } : {}),
      view: undefined as unknown as StoreView<unknown>,
    }
    sub.view = {
      get data() {
        return sub.map
      },
      get ready() {
        return sub.ready
      },
      unsubscribe: () => {
        if (!this.clientSubs.delete(id)) return
        this.ch.send({ k: 'unsub', id } satisfies Msg)
      },
    }
    this.clientSubs.set(id, sub)
    this.ch.send({ k: 'sub', id, store } satisfies Msg)
    return sub.view as StoreView<V>
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.offs.splice(0)) off()
    for (const [, p] of this.pending) p.reject(new RpcError('closed', `${this.opts.name}: connection closed`))
    this.pending.clear()
    for (const [, ac] of this.serving) ac.abort()
    this.serving.clear()
    for (const id of [...this.served.keys()]) this.dropServed(id)
    this.clientSubs.clear()
    this.ch.close()
  }

  private onMessage(m: Msg): void {
    if (this.disposed || typeof m !== 'object' || m === null) return
    try {
      switch (m.k) {
        case 'req':
          void this.serve(m.id, m.m, m.a)
          break
        case 'res': {
          const p = this.pending.get(m.id)
          if (!p) return
          this.pending.delete(m.id)
          if (m.ok) {
            if (this.opts.validateResults && p.def?.result) {
              const r = p.def.result.safeParse(m.v)
              if (!r.success) {
                p.reject(new RpcError('invalid_result', r.error.message))
                return
              }
            }
            p.resolve(m.v)
          } else {
            p.reject(new RpcError(m.e.code, m.e.message))
          }
          break
        }
        case 'cancel':
          this.serving.get(m.id)?.abort()
          this.serving.delete(m.id)
          break
        case 'note': {
          const h = own(this.opts.notes, m.m)
          if (h) h(m.a, this as unknown as RpcPeer)
          break
        }
        case 'sub':
          this.serveSub(m.id, m.store)
          break
        case 'unsub':
          this.dropServed(m.id)
          break
        case 'ack': {
          const s = this.served.get(m.id)
          if (!s || m.rev !== s.rev) return
          s.inflight = false
          if (!isEmptyDelta(s.pending)) this.scheduleFlush(m.id, s)
          break
        }
        case 'snap': {
          const s = this.clientSubs.get(m.id)
          if (!s) return
          s.map.clear()
          for (const [k, v] of Object.entries(m.v)) s.map.set(k, v)
          s.ready = true
          this.ch.send({ k: 'ack', id: m.id, rev: m.rev } satisfies Msg)
          s.cb(s.view, null)
          break
        }
        case 'delta': {
          const s = this.clientSubs.get(m.id)
          if (!s) return
          const changed = applyDelta(s.map, m.d)
          this.ch.send({ k: 'ack', id: m.id, rev: m.rev } satisfies Msg)
          s.cb(s.view, changed)
          break
        }
        case 'gone': {
          const s = this.clientSubs.get(m.id)
          if (!s) return
          this.clientSubs.delete(m.id)
          s.onGone?.()
          break
        }
      }
    } catch (e) {
      this.opts.onError?.(e)
    }
  }

  private async serve(id: number, method: string, args: unknown): Promise<void> {
    // own keys only: a method named `constructor` or `__proto__` is unknown, not Object.prototype's (C-FUZZ-5)
    const def = own(this.opts.api, method)
    const handler = own(this.opts.handlers, method)
    if (!def || !handler) {
      this.ch.send({ k: 'res', id, ok: false, e: { code: 'unknown_method', message: `${this.opts.name}: unknown method ${method}` } } satisfies Msg)
      return
    }
    const parsed = def.args.safeParse(args)
    if (!parsed.success) {
      this.ch.send({ k: 'res', id, ok: false, e: { code: 'invalid_args', message: `${method}: ${parsed.error.message}` } } satisfies Msg)
      return
    }
    const ac = new AbortController()
    this.serving.set(id, ac)
    try {
      const v = await (handler as (a: unknown, c: CallContext) => unknown)(parsed.data, { signal: ac.signal, peer: this as unknown as RpcPeer })
      if (ac.signal.aborted || this.disposed) return
      this.ch.send({ k: 'res', id, ok: true, v: v ?? null } satisfies Msg)
    } catch (e) {
      if (ac.signal.aborted || this.disposed) return
      const code = e instanceof RpcError ? e.code : 'handler_error'
      this.ch.send({ k: 'res', id, ok: false, e: { code, message: e instanceof Error ? e.message : String(e) } } satisfies Msg)
    } finally {
      this.serving.delete(id)
    }
  }

  private serveSub(id: number, name: string): void {
    const store = this.opts.stores?.get(name)
    if (!store) {
      this.ch.send({ k: 'gone', id } satisfies Msg)
      return
    }
    const s: ServedSub = { store: name, rev: 1, inflight: true, pending: {}, timer: null, off: () => {}, lastFlush: performance.now() }
    s.off = store.onDelta((d) => {
      s.pending = mergeDelta(s.pending, d)
      if (!s.inflight) this.scheduleFlush(id, s)
    })
    this.served.set(id, s)
    this.ch.send({ k: 'snap', id, rev: s.rev, v: store.snapshot() } satisfies Msg)
  }

  // At most one delta message per store per tick, and none while the previous one is unacknowledged.
  private scheduleFlush(id: number, s: ServedSub): void {
    if (s.timer || s.inflight) return
    const wait = Math.max(0, L.storeTickMs - (performance.now() - s.lastFlush))
    s.timer = setTimeout(() => {
      s.timer = null
      if (!this.served.has(id) || s.inflight || isEmptyDelta(s.pending)) return
      s.rev++
      s.inflight = true
      s.lastFlush = performance.now()
      const d = s.pending
      s.pending = {}
      this.ch.send({ k: 'delta', id, rev: s.rev, d } satisfies Msg)
    }, wait)
  }

  private dropServed(id: number): void {
    const s = this.served.get(id)
    if (!s) return
    s.off()
    if (s.timer) clearTimeout(s.timer)
    this.served.delete(id)
  }
}
