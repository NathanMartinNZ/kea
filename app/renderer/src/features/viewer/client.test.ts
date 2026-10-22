import { allPairs, createFsm } from '@kea/kit/fsm'
import { L } from '@kea/protocol/limits'
import { describe, expect, it } from 'vitest'
import { HighlightClient, type HighlightJob, type WorkerLike } from './client.ts'
import { WORKER_EVENTS, WORKER_STATES, workerLifecycle, type WorkerEvent, type WorkerState } from './lifecycle.ts'
import type { FromWorker, ToWorker } from './worker/protocol.ts'

/** A stand-in worker: it records what it is sent, and the test answers for it. */
class FakeWorker implements WorkerLike {
  static all: FakeWorker[] = []
  readonly got: ToWorker[] = []
  terminated = false
  onmessage: ((e: { data: FromWorker }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor() {
    FakeWorker.all.push(this)
  }
  postMessage(m: ToWorker): void {
    if (this.terminated) throw new Error('posted to a terminated worker')
    this.got.push(m)
  }
  terminate(): void {
    this.terminated = true
  }
  say(m: FromWorker): void {
    this.onmessage?.({ data: m })
  }
}

/** Timers the test fires by moving time. */
class FakeTimers {
  private t = 0
  private seq = 0
  private readonly pending = new Map<number, { at: number; fn: () => void }>()
  setTimeout = (fn: () => void, ms: number) => {
    this.pending.set(++this.seq, { at: this.t + ms, fn })
    return this.seq
  }
  clearTimeout = (h: unknown) => void this.pending.delete(h as number)
  advance(ms: number): void {
    this.t += ms
    for (const [id, p] of [...this.pending]) {
      if (p.at > this.t) continue
      this.pending.delete(id)
      p.fn()
    }
  }
  get size(): number {
    return this.pending.size
  }
}

const chunk = (id: number, from: number, to: number): FromWorker => ({ t: 'chunk', id, from, to, starts: new Uint32Array(to - from + 1), data: new Uint32Array(0) })

function job(doc: string, log: string[]): HighlightJob {
  return { doc, lang: 'typescript', text: `// ${doc}`, from: 0, budgetMs: null, onChunk: (c) => void log.push(`${doc} chunk ${c.from}-${c.to}`), onDone: (r) => void log.push(`${doc} done ${r.failed ?? r.stoppedAt}`) }
}

describe('the highlight worker lifecycle', () => {
  it('U-FV-10 · the worker starts on first use, ends after the idle timeout with no file tab visible, is recycled above the grammar limit, and starts again on the next request', () => {
    // ── the table, pair by pair ──
    const want: Record<WorkerState, Partial<Record<WorkerEvent['t'], WorkerState>>> = {
      off: { request: 'on' },
      on: { request: 'on', shown: 'on', hidden: 'idle', over: 'off', crashed: 'off' },
      idle: { request: 'on', shown: 'on', hidden: 'idle', timeout: 'off', over: 'off', crashed: 'off' },
    }
    for (const { state, event, handled } of allPairs(workerLifecycle, WORKER_STATES, WORKER_EVENTS)) {
      const fsm = createFsm(workerLifecycle, { state })
      const r = fsm.send({ t: event })
      expect(handled, `${state} × ${event} handled`).toBe(want[state][event] !== undefined)
      // a pair the table does not name changes nothing (a timeout that fires late, a crash report from a dead worker)
      expect(r.to, `${state} × ${event}`).toBe(want[state][event] ?? state)
    }

    // ── the client ──
    FakeWorker.all = []
    const timers = new FakeTimers()
    const client = new HighlightClient({ spawn: () => new FakeWorker(), timers })
    const log: string[] = []
    // nothing starts before the first request, whatever is visible
    client.setVisible(true)
    expect(client.state).toBe('off')
    expect(FakeWorker.all).toHaveLength(0)
    expect(client.stats).toEqual({ workers: 0, pending: 0, starts: 0, grammars: 0, idleTimers: 0 })

    const a = client.tokenize(job('a', log))
    expect(client.state).toBe('on')
    const w1 = FakeWorker.all[0]!
    expect(w1.got).toEqual([{ t: 'tokenize', id: 1, doc: 'a', lang: 'typescript', text: '// a', from: 0, budgetMs: null }])
    w1.say(chunk(1, 0, 150))
    w1.say({ t: 'done', id: 1, lines: 150, stoppedAt: null, grammars: 4 })
    expect(log).toEqual(['a chunk 0-150', 'a done null'])
    expect(client.stats).toEqual({ workers: 1, pending: 0, starts: 1, grammars: 4, idleTimers: 0 })
    a.cancel() // after the end: nothing to cancel, nothing sent
    expect(w1.got).toHaveLength(1)

    // a cancelled request: the worker is told, and what still arrives for it is dropped
    const b = client.tokenize(job('b', log))
    b.cancel()
    b.cancel()
    expect(w1.got.slice(1)).toEqual([expect.objectContaining({ t: 'tokenize', id: 2 }), { t: 'cancel', id: 2 }])
    w1.say(chunk(2, 0, 10))
    w1.say({ t: 'done', id: 2, lines: 10, stoppedAt: null, grammars: 4 })
    expect(log).toHaveLength(2)
    expect(client.stats.pending).toBe(0)

    // ── idle: no file or diff tab visible for L.highlightIdleMs → terminated ──
    client.setVisible(false)
    expect(client.state).toBe('idle')
    expect(client.stats.idleTimers).toBe(1)
    timers.advance(L.highlightIdleMs - 1)
    expect(w1.terminated).toBe(false)
    // a tab shown again in time keeps the worker and clears the timer
    client.setVisible(true)
    expect(client.state).toBe('on')
    expect(timers.size).toBe(0)
    timers.advance(L.highlightIdleMs * 2)
    expect(w1.terminated).toBe(false)
    client.setVisible(false)
    timers.advance(L.highlightIdleMs)
    expect(w1.terminated).toBe(true)
    expect(client.state).toBe('off')
    expect(client.stats).toEqual({ workers: 0, pending: 0, starts: 1, grammars: 0, idleTimers: 0 })
    // a message that was already on its way from the dead worker is not heard
    w1.say({ t: 'done', id: 1, lines: 1, stoppedAt: null, grammars: 99 })
    expect(client.state).toBe('off')

    // ── restart on the next request ──
    client.setVisible(true)
    client.tokenize(job('c', log))
    expect(FakeWorker.all).toHaveLength(2)
    const w2 = FakeWorker.all[1]!
    expect(client.stats).toMatchObject({ workers: 1, starts: 2, pending: 1 })

    // ── recycled above the grammar limit: the running requests start again on a fresh worker ──
    const d = client.tokenize({ ...job('d', log), from: 40 })
    w2.say(chunk(3, 0, 150))
    w2.say({ t: 'done', id: 3, lines: 150, stoppedAt: null, grammars: L.highlightGrammarsMax })
    // at the limit is not above it
    expect(w2.terminated).toBe(false)
    const e = client.tokenize(job('e', log))
    w2.say({ t: 'done', id: 5, lines: 1, stoppedAt: null, grammars: L.highlightGrammarsMax + 1 })
    expect(w2.terminated).toBe(true)
    expect(FakeWorker.all).toHaveLength(3)
    const w3 = FakeWorker.all[2]!
    // d was still running: sent again, from its first line (the old worker's saved states are gone)
    expect(w3.got).toEqual([{ t: 'tokenize', id: 4, doc: 'd', lang: 'typescript', text: '// d', from: 0, budgetMs: null }])
    expect(client.state).toBe('on')
    expect(client.stats).toMatchObject({ workers: 1, starts: 3, pending: 1, grammars: 0 })
    w3.say({ t: 'done', id: 4, lines: 1, stoppedAt: 77, grammars: 2 })
    expect(log.at(-1)).toBe('d done 77')
    d.cancel()
    e.cancel()
    // recycled with nothing running: no new worker until the next request
    client.tokenize(job('f', log))
    w3.say({ t: 'failed', id: 6, message: 'no grammar', grammars: L.highlightGrammarsMax + 5 })
    expect(log.at(-1)).toBe('f done no grammar')
    expect(w3.terminated).toBe(true)
    expect(client.state).toBe('off')
    expect(FakeWorker.all).toHaveLength(3)

    // ── a worker error ends it and fails what it had; the next request starts another ──
    client.tokenize(job('g', log))
    const w4 = FakeWorker.all[3]!
    w4.onerror?.(new Error('boom'))
    expect(w4.terminated).toBe(true)
    expect(log.at(-1)).toBe('g done the highlight worker stopped')
    expect(client.stats).toMatchObject({ workers: 0, pending: 0 })
    client.tokenize(job('h', log))
    expect(FakeWorker.all).toHaveLength(5)

    // ── a request made while nothing is visible does not keep the worker for ever; `forget` reaches the worker ──
    client.setVisible(false)
    const w5 = FakeWorker.all[4]!
    client.forget('h')
    expect(w5.got.at(-1)).toEqual({ t: 'forget', doc: 'h' })
    expect(client.stats.pending).toBe(0)
    timers.advance(L.highlightIdleMs)
    expect(w5.terminated).toBe(true)
    client.tokenize(job('i', log))
    expect(client.state).toBe('idle')
    const w6 = FakeWorker.all[5]!
    timers.advance(L.highlightIdleMs)
    expect(w6.terminated).toBe(true)
    // the request nobody was looking at ends with the worker
    expect(log.at(-1)).toBe('i done the highlight worker went idle')
    expect(client.stats).toEqual({ workers: 0, pending: 0, starts: 6, grammars: 0, idleTimers: 0 })

    client.tokenize(job('j', log))
    client.dispose()
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true)
    expect(timers.size).toBe(0)
    expect(client.stats).toMatchObject({ workers: 0, pending: 0, idleTimers: 0 })
    // the two limits' values themselves
    expect([L.highlightGrammarsMax, L.highlightIdleMs]).toEqual([25, 5 * 60 * 1000])
  })
})
