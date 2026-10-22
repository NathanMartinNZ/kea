// Ptyhost in a worker thread, with its real exception guard (app/ptyhost/src/guard.ts), for the tests that make xterm
// throw: an exception escaping from a timer must reach ptyhost's own `uncaughtException` handler, not the test
// runner's. The worker runs a `ptyhostHarness` in a KEA_HOME the test owns; the test drives it with `PtyhostWorker`
// (request/response messages). If the worker dies, `dispose` adopts its holders from the test thread and ends them, so
// nothing is left behind either way. Also for tests where ptyhost needs an event loop of its own, as in the app:
// renderers (`attach`) and core (`control`) reach it over worker ports.

import v8 from 'node:v8'
import vm from 'node:vm'
import { isMainThread, MessageChannel, parentPort, Worker, workerData, type MessagePort } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { resources, type ResourceReport } from '@kea/kit'
import { fromNodePort, ptyhostApi, RpcPeer, type Channel } from '@kea/protocol'
import { installExceptionGuard } from '../../app/ptyhost/src/guard.ts'
import type { Pty } from '../../app/ptyhost/src/pty.ts'
import { endHoldersIn, ptyhostHarness, shortKeaHome, until, type Harness } from '../support/holders.ts'

export interface WorkerPtyState {
  running: boolean
  /** Bytes that reached ptyhost (the coalescer's flushed seq). */
  flushedSeq: number
  parsedSeq: number | null
  pendingWrites: number
  stats: Pty['stats']
  screen: string | null
}

type Op =
  | { op: 'spawn'; argv: string[]; ringBytes?: number; cols?: number; rows?: number }
  /** A renderer's stream port for one terminal, as main brokers it. */
  | { op: 'attach'; ptyId: string; port: MessagePort }
  /** Core's control port: ptyhost serves `ptyhostApi` on it, as in the app (main.ts). */
  | { op: 'control'; port: MessagePort }
  | { op: 'input'; ptyId: string; data: string }
  | { op: 'signal'; ptyId: string; signo: number }
  /** The PTY's current mirror stops parsing (its writes are swallowed) and a timer throws, as a stalled headless does. */
  | { op: 'stall'; ptyId: string }
  /** A timer throws with no mirror involved. */
  | { op: 'throw' }
  | { op: 'state'; ptyId: string }
  /** Forced GC twice, then the resource report and the worker's heap. */
  | { op: 'measure' }
  | { op: 'logs' }
  | { op: 'dispose' }

type Request = Op & { id: number }
type Response = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }

// ── worker side ────────────────────────────────────────────────────────────────────

async function serve(): Promise<void> {
  const port = parentPort!
  const { home } = workerData as { home: string }
  v8.setFlagsFromString('--expose-gc')
  const gc = vm.runInNewContext('gc') as () => void
  let h: Harness | null = null
  let control: RpcPeer | null = null
  let exiting = false
  const exit = (code: number) => {
    exiting = true
    port.postMessage({ exit: code })
    process.exit(code)
  }
  const pty = (id: string) => {
    const p = h!.manager.get(id)
    if (!p) throw new Error(`no PTY ${id}`)
    return p
  }
  const run = async (r: Op): Promise<unknown> => {
    switch (r.op) {
      case 'spawn':
        return (await h!.spawn({ argv: r.argv, ...(r.ringBytes ? { ringBytes: r.ringBytes } : {}), ...(r.cols ? { cols: r.cols } : {}), ...(r.rows ? { rows: r.rows } : {}) })).ptyId
      case 'attach':
        h!.manager.attachStream(r.ptyId, fromNodePort(r.port as never))
        return null
      case 'control': {
        control?.dispose()
        control = new RpcPeer(fromNodePort(r.port as never), { name: 'ptyhost', api: ptyhostApi, handlers: h!.manager.handlers() })
        return null
      }
      case 'input':
        pty(r.ptyId).input(r.data)
        return null
      case 'signal':
        pty(r.ptyId).signal(r.signo, 'child')
        return null
      case 'stall': {
        const m = pty(r.ptyId).currentMirror
        if (!m) throw new Error('stall: the mirror is parked')
        const t = m.terminal as unknown as { write(data: unknown, cb?: () => void): void }
        let thrown = false
        t.write = () => {
          if (thrown) return
          thrown = true
          setTimeout(() => {
            throw new Error('injected: headless parser stalled')
          }, 0)
        }
        return null
      }
      case 'throw':
        setTimeout(() => {
          throw new Error('injected: not a mirror')
        }, 0)
        return null
      case 'state': {
        const p = pty(r.ptyId)
        const m = p.currentMirror
        return { running: p.isRunning, flushedSeq: p.flushedSeq(), parsedSeq: m?.parsedSeq ?? null, pendingWrites: p.pendingWrites, stats: { ...p.stats }, screen: m?.screenText() ?? null } satisfies WorkerPtyState
      }
      case 'measure':
        gc()
        await new Promise((res) => setImmediate(res))
        gc()
        return { report: resources.report(), heapUsed: v8.getHeapStatistics().used_heap_size } // the report main logs
      case 'logs':
        return h!.log.entries.map((e) => ({ level: e.level, msg: e.msg, fields: e }))
      case 'dispose':
        control?.dispose()
        control = null
        await h!.dispose()
        h = null
        return null
    }
  }
  port.on('message', (r: Request) => {
    void run(r).then(
      (value) => port.postMessage({ id: r.id, ok: true, value } satisfies Response),
      (e: unknown) => port.postMessage({ id: r.id, ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) } satisfies Response),
    )
  })
  h = await ptyhostHarness({ home })
  installExceptionGuard(process, h.manager, h.log, (code) => {
    if (!exiting) exit(code)
  })
  port.postMessage({ ready: true })
}

if (!isMainThread && (workerData as { ptyhostWorker?: boolean } | null)?.ptyhostWorker) void serve()

// ── test side ──────────────────────────────────────────────────────────────────────

const SELF = fileURLToPath(import.meta.url)

export class PtyhostWorker {
  readonly home: string
  private readonly worker: Worker
  private readonly ownHome: { home: string; dispose(): void }
  private next = 1
  private readonly waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>() // bounded: requests in flight from one test
  private exitCode: number | null = null
  private exitedP: Promise<number>

  private constructor() {
    this.ownHome = shortKeaHome()
    this.home = this.ownHome.home
    this.worker = new Worker(SELF, { workerData: { ptyhostWorker: true, home: this.home } })
    this.exitedP = new Promise((resolve) => {
      this.worker.on('exit', (code) => {
        this.exitCode = code
        for (const w of this.waiting.values()) w.reject(new Error(`ptyhost worker exited (${code})`))
        this.waiting.clear()
        resolve(code)
      })
    })
    this.worker.on('message', (m: Response | { ready: true } | { exit: number }) => {
      if (!('id' in m)) return
      const w = this.waiting.get(m.id)
      this.waiting.delete(m.id)
      if (m.ok) w?.resolve(m.value)
      else w?.reject(new Error(m.error))
    })
  }

  static async start(): Promise<PtyhostWorker> {
    const w = new PtyhostWorker()
    await new Promise<void>((resolve, reject) => {
      w.worker.on('message', (m: { ready?: boolean }) => m.ready && resolve())
      w.worker.once('error', reject)
      void w.exitedP.then((c) => reject(new Error(`ptyhost worker exited (${c}) before it was ready`)))
    })
    return w
  }

  /** The worker thread is gone (its guard exited it, or it crashed). */
  get exited(): number | null {
    return this.exitCode
  }
  get whenExited(): Promise<number> {
    return this.exitedP
  }

  private call<T>(op: Op, transfer: MessagePort[] = []): Promise<T> {
    if (this.exitCode !== null) return Promise.reject(new Error(`ptyhost worker exited (${this.exitCode})`))
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.worker.postMessage({ ...op, id }, transfer)
    })
  }

  async spawn(argv: string[], o: { ringBytes?: number; cols?: number; rows?: number } = {}): Promise<string> {
    return this.call<string>({ op: 'spawn', argv, ...o })
  }
  /** A stream port attached to `ptyId` in the worker; returns the renderer's end (for `TestRenderer`). */
  async attach(ptyId: string): Promise<Channel> {
    const { port1, port2 } = new MessageChannel()
    await this.call({ op: 'attach', ptyId, port: port2 }, [port2])
    return fromNodePort(port1 as never)
  }
  /** Core's end of a control port served by the worker's ptyhost (`ptyhostApi`). */
  async control(): Promise<RpcPeer<Record<string, never>, typeof ptyhostApi>> {
    const { port1, port2 } = new MessageChannel()
    await this.call({ op: 'control', port: port2 }, [port2])
    return new RpcPeer(fromNodePort(port1 as never), { name: 'core→ptyhost' }, ptyhostApi)
  }
  input(ptyId: string, data: string): Promise<void> {
    return this.call({ op: 'input', ptyId, data })
  }
  signal(ptyId: string, signo: number): Promise<void> {
    return this.call({ op: 'signal', ptyId, signo })
  }
  stall(ptyId: string): Promise<void> {
    return this.call({ op: 'stall', ptyId })
  }
  throwNow(): Promise<void> {
    return this.call({ op: 'throw' })
  }
  state(ptyId: string): Promise<WorkerPtyState> {
    return this.call({ op: 'state', ptyId })
  }
  measure(): Promise<{ report: ResourceReport; heapUsed: number }> {
    return this.call({ op: 'measure' })
  }
  logs(): Promise<{ level: string; msg: string; fields: Record<string, unknown> }[]> {
    return this.call({ op: 'logs' })
  }

  /** Wait until the PTY's mirror has parsed everything that reached ptyhost and `cond` holds. */
  async settled(ptyId: string, what: string, cond: (s: WorkerPtyState) => boolean = () => true, ms?: number): Promise<WorkerPtyState> {
    let last: WorkerPtyState | null = null
    await until(
      what,
      async () => {
        last = await this.state(ptyId)
        return last.parsedSeq === last.flushedSeq && last.pendingWrites === 0 && cond(last)
      },
      ms,
    )
    return last!
  }

  /**
   * End every holder and the worker, and remove the home. Whatever went wrong (a dead worker, a request that never
   * returned), every holder left in the home is adopted and ended from the test thread before the home goes.
   */
  async dispose(): Promise<void> {
    try {
      if (this.exitCode === null) {
        try {
          await this.call({ op: 'dispose' })
        } finally {
          await this.worker.terminate()
        }
      }
    } finally {
      try {
        await endHoldersIn(this.home)
      } finally {
        this.ownHome.dispose()
      }
    }
  }
}
