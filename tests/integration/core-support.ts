// Core under plain Node, wired to a real ptyhost (tests/support/holders.ts harness) the way main wires them: one
// control channel, ptyhostApi served by the PtyManager, its notes forwarded to core. Every control call core makes is
// recorded, so a test can prove which holders core touched. Used by tests/integration/core-* and tests/chaos/core-*.

import fs from 'node:fs'
import path from 'node:path'
import { createMemoryLogger, type MemoryLogger } from '@kea/kit'
import { channelPair, ptyhostApi, RpcPeer, type CallContext, type PtyhostNote, type StreamToRenderer } from '@kea/protocol'
import { createCore, type Core, type CoreOptions } from '@kea/core/src/core.ts'
import { procsProbe } from '@kea/core/src/terminal/procs.ts'
import { FileRecords, type TerminalRecords } from '@kea/core/src/terminal/records.ts'
import type { ReconcilePlan } from '@kea/core/src/terminal/reconcile.ts'
import type { Env } from '@kea/core/src/terminal/shellEnv.ts'
import { Terminals, type TerminalsOptions } from '@kea/core/src/terminal/terminals.ts'
import { assertNoRealAgentOnPath } from '../support/agent-guard.ts'
import { until, type Harness } from '../support/holders.ts'

export interface CoreUnderTest {
  readonly t: Terminals
  readonly records: TerminalRecords
  readonly log: MemoryLogger
  /** Every reconciliation's plan, in order. */
  readonly plans: ReconcilePlan[]
  /** Every control call core made to ptyhost. */
  readonly calls: { m: string; a: Record<string, unknown> }[]
  /** Resolves with the plan of the `n`th reconciliation (1-based). */
  reconciled(n?: number): Promise<ReconcilePlan>
  /** Calls core made that named `ptyId`. */
  touched(ptyId: string): string[]
  /** Call one of core's renderer-facing handlers. */
  call<T = unknown>(method: string, args: object): Promise<T>
  /**
   * Ptyhost restarted under the running core (`h.restart()` first): core is handed a new control port to the
   * harness's current ptyhost, as main hands it one, and reconciles again.
   */
  reconnect(): void
  /** Core goes away (crash, quit or restart); ptyhost and the holders stay. */
  dispose(): void
}

export function startCore(h: Harness, o: { env?: Env; records?: TerminalRecords; opts?: Partial<TerminalsOptions> } = {}): CoreUnderTest {
  const calls: CoreUnderTest['calls'] = []
  let peer!: RpcPeer
  /** A control port to the harness's current ptyhost: core's end. */
  const connect = () => {
    const [coreSide, ptyhostSide] = channelPair()
    const served = h.manager.handlers() as Record<string, (a: unknown, ctx: CallContext) => unknown>
    const spied = Object.fromEntries(
      Object.entries(served).map(([m, fn]) => [
        m,
        (a: Record<string, unknown>, ctx: CallContext) => {
          calls.push({ m, a })
          return fn(a, ctx)
        },
      ]),
    )
    peer = new RpcPeer(ptyhostSide, { name: 'ptyhost', api: ptyhostApi, handlers: spied as never })
    return coreSide
  }
  const coreSide = connect()
  // the harness's ptyhost reports notes into `h.notes`; forward them over the control port as ptyhost's main does
  const push = h.notes.push
  h.notes.push = (...ns: PtyhostNote[]) => {
    for (const n of ns) if (!peer.isDisposed) peer.notify(n.m, n.a)
    return push.apply(h.notes, ns)
  }
  const log = createMemoryLogger({ process: 'core' })
  const records = o.records ?? FileRecords.open(h.home, log)
  const plans: ReconcilePlan[] = []
  const t = new Terminals({
    version: 'test',
    log,
    env: async () => o.env ?? {},
    home: h.home,
    records,
    // holder liveness from the harness's own helper, as core asks the one Kea ships
    probe: procsProbe(h.helper),
    onReconciled: (p) => plans.push(p),
    ...o.opts,
  })
  t.setControl(coreSide)
  const handlers = t.handlers() as Record<string, (a: object, ctx: never) => Promise<unknown>>
  return {
    t,
    records,
    log,
    plans,
    calls,
    async reconciled(n = 1) {
      await until(`reconciliation #${n}`, () => plans.length >= n)
      return plans[n - 1]!
    },
    touched: (ptyId) => calls.filter((c) => c.a.ptyId === ptyId || (c.a.ptyIds as string[] | undefined)?.includes(ptyId)).map((c) => c.m),
    call: <T>(method: string, args: object) => handlers[method]!(args, { signal: new AbortController().signal } as never) as Promise<T>,
    reconnect() {
      peer.dispose() // the old ptyhost's end of the port went with it
      t.setControl(connect())
    },
    dispose() {
      t.dispose()
      peer.dispose()
      h.notes.push = push
    },
  }
}

/** A renderer-side stream on one PTY, straight from ptyhost (core is never on this path): its output as text. */
export function readStream(h: Harness, ptyId: string): { text(): string; close(): void } {
  const [mine, theirs] = channelPair()
  let text = ''
  mine.onMessage((m) => {
    const s = m as StreamToRenderer
    if (s.k === 'data') {
      text += new TextDecoder().decode(s.b)
      mine.send({ k: 'credit', n: s.b.byteLength })
    } else if (s.k === 'snapshot') {
      text += s.data
      mine.send({ k: 'credit', n: s.data.length })
    }
  })
  h.manager.attachStream(ptyId, theirs)
  return { text: () => text, close: () => mine.close() }
}

/** Every ptyId with a state file in `home` that names its own directory and ptyId (for cleanup of what core spawned). */
export function ownPtyIds(home: string): string[] {
  const out: string[] = []
  const sessions = path.join(home, 'sessions')
  for (const s of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
    for (const f of fs.readdirSync(path.join(sessions, s))) {
      const m = /^([a-z0-9]{10})\.json$/.exec(f)
      if (!m) continue
      try {
        const j = JSON.parse(fs.readFileSync(path.join(sessions, s, f), 'utf8')) as { ptyId?: string; sessionId?: string; socket?: string }
        if (j.ptyId === m[1] && j.sessionId === s && j.socket?.startsWith(home)) out.push(m[1] as string)
      } catch {
        // not a state file
      }
    }
  }
  return out
}

/**
 * The whole of core (core.ts: database, settings, projects, terminals) as main.ts assembles it, on the harness's home,
 * wired to the harness's ptyhost like `startCore`. `dispose` is a clean shutdown; `crash` skips it, so the database's
 * open marker stays set as a killed core leaves it (SQLite's own close still checkpoints the WAL).
 */
export interface FullCoreUnderTest {
  readonly core: Core
  /** The environment source core was given: the test's, checked each time it is asked (`checkedShellEnv`). */
  readonly shellEnv: CoreOptions['shellEnv']
  readonly log: MemoryLogger
  /** Every control call core made to ptyhost. */
  readonly calls: { m: string; a: Record<string, unknown> }[]
  call<T = unknown>(method: string, args: object): Promise<T>
  /** Resolves with the plan of the `n`th reconciliation (1-based). */
  reconciled(n?: number): Promise<ReconcilePlan>
  dispose(): void
  crash(): void
}

/** Runs in place of ptyhost's handler for each control call core makes: `run` is the real one (to delay a reply, say). */
export type ControlWrap = (m: string, a: Record<string, unknown>, run: () => unknown) => unknown

/**
 * `source`, with every environment it hands out checked first (`assertNoRealAgentOnPath`): one whose PATH would find a
 * real agent CLI is never given to core (the call rejects, and detection, which keeps the environment it had, finds
 * nothing).
 */
export function checkedShellEnv(source: CoreOptions['shellEnv']): CoreOptions['shellEnv'] {
  return {
    get: async () => {
      const env = await source.get()
      assertNoRealAgentOnPath(env.PATH)
      return env
    },
    // what a reload read is handed out by the next `get`, checked there
    ...(source.reload ? { reload: () => source.reload!() } : {}),
  }
}

export function startFullCore(h: Harness, o: { env?: Env; opts?: Partial<CoreOptions>; wrap?: ControlWrap } = {}): FullCoreUnderTest {
  // detection runs the first agent command on the PATH core gets, which must never be a real CLI. `env` is checked
  // before anything starts; a source of its own in `opts.shellEnv` is checked each time core asks it (below)
  assertNoRealAgentOnPath(o.env?.PATH)
  const [coreSide, ptyhostSide] = channelPair()
  const calls: FullCoreUnderTest['calls'] = []
  const served = h.manager.handlers() as Record<string, (a: unknown, ctx: CallContext) => unknown>
  const spied = Object.fromEntries(
    Object.entries(served).map(([m, fn]) => [
      m,
      (a: Record<string, unknown>, ctx: CallContext) => {
        calls.push({ m, a })
        return o.wrap ? o.wrap(m, a, () => fn(a, ctx)) : fn(a, ctx)
      },
    ]),
  )
  const peer = new RpcPeer(ptyhostSide, { name: 'ptyhost', api: ptyhostApi, handlers: spied as never })
  const push = h.notes.push
  h.notes.push = (...ns: PtyhostNote[]) => {
    for (const n of ns) if (!peer.isDisposed) peer.notify(n.m, n.a)
    return push.apply(h.notes, ns)
  }
  const log = createMemoryLogger({ process: 'core' })
  const env = o.env ?? {}
  const plans: ReconcilePlan[] = []
  // after `o.opts`, so that no option of a test's replaces the checked source
  const shellEnv = checkedShellEnv(o.opts?.shellEnv ?? { get: async () => env })
  const core = createCore({ home: h.home, version: 'test', log, gitBinary: 'git', watchSettings: false, probe: procsProbe(h.helper), onReconciled: (p) => plans.push(p), ...o.opts, shellEnv })
  core.terminals.setControl(coreSide)
  const handlers = core.handlers() as Record<string, (a: object, ctx: never) => Promise<unknown>>
  let gone = false
  const detach = () => {
    peer.dispose()
    h.notes.push = push
  }
  return {
    core,
    shellEnv,
    log,
    calls,
    call: <T>(method: string, args: object) => handlers[method]!(args, { signal: new AbortController().signal } as never) as Promise<T>,
    async reconciled(n = 1) {
      await until(`reconciliation #${n}`, () => plans.length >= n)
      return plans[n - 1]!
    },
    dispose() {
      if (gone) return
      gone = true
      core.dispose()
      detach()
    },
    crash() {
      if (gone) return
      gone = true
      core.disk.dispose() // its timer and its walk's thread are this process's, not the killed core's
      core.servers.dispose()
      core.files.dispose()
      core.status.dispose()
      core.statusBatch.dispose()
      core.sessions.dispose()
      core.terminals.dispose()
      core.projects.dispose()
      core.settings.dispose()
      core.banners.dispose()
      core.db.abandon()
      detach()
    },
  }
}
