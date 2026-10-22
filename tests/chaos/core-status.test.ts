// Status inputs out of order: two hook connections read in either order, events in the same millisecond, sessions
// interleaved, a spooled event drained after live ones. The status engine in-process (tests/support/status.ts): the
// order its inputs arrive in must never decide a session's status, only their `mono` (emission) stamps.

import type { AgentEvent, StatusSource } from '@kea/protocol'
import { SessionMachine } from '@kea/core/src/status/machine.ts'
import { initialStatus } from '@kea/core/src/status/table.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { engineUnderTest, type EngineUnderTest } from '../support/status.ts'

let cleanup: (() => unknown)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
})

const SESSIONS = 20
const T0 = 1_790_000_000_000

/** A small seeded PRNG (mulberry32), so a failure replays. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Input {
  sessionId: string
  source: StatusSource
  events: AgentEvent[]
  mono: bigint
  at: number
  spooled: boolean
}

/**
 * One session's inputs in emission order: three turns, each with a permission prompt that is raised and answered in the
 * same millisecond as the tool around it, and a last turn that ends blocked on a prompt (odd sessions) or finished. The
 * second turn's `turn.finished` is the one a spool holds.
 */
function emitted(sessionId: string, i: number): { inputs: Input[]; pairs: number[]; spooled: number } {
  const inputs: Input[] = []
  const pairs: number[] = []
  let mono = 1_000_000n
  let at = T0 + i
  let spooled = -1
  const push = (events: AgentEvent[], o: { sameMs?: boolean; spool?: boolean } = {}) => {
    if (o.sameMs) {
      mono += 1n // the same millisecond, one nanosecond later
      pairs.push(inputs.length - 1)
    } else {
      mono += 7_000_000n + BigInt(i) * 1_000n
      at += 7
    }
    if (o.spool) spooled = inputs.length
    inputs.push({ sessionId, source: 'hook', events, mono, at, spooled: o.spool === true })
  }
  push([{ t: 'session.started', agentSessionId: `7f1c2a9e-0000-4000-8000-${String(i).padStart(12, '0')}`, source: 'startup' }])
  for (const turn of [1, 2, 3]) {
    push([{ t: 'turn.started' }])
    push([{ t: 'tool.started', name: 'Bash', summary: `step ${turn}` }])
    push([{ t: 'attention.permission', key: `Bash: step ${turn}`, tool: 'Bash', summary: `step ${turn}` }], { sameMs: true })
    push([{ t: 'attention.cleared', key: `Bash: step ${turn}` }])
    push([{ t: 'tool.finished', name: 'Bash', summary: `step ${turn}`, ok: true }], { sameMs: true })
    push([{ t: 'turn.finished', backgroundWork: false, lastMessage: `done ${turn}` }], { spool: turn === 2 })
  }
  push([{ t: 'turn.started' }])
  if (i % 2 === 1) push([{ t: 'attention.permission', key: 'Edit: src/a.ts', tool: 'Edit', summary: 'src/a.ts' }], { sameMs: true })
  else push([{ t: 'turn.finished', backgroundWork: false, lastMessage: 'all done' }])
  return { inputs, pairs, spooled }
}

/** The order one session's inputs arrive in: each same-millisecond pair read the other way round, the spooled one last. */
function arrival(e: ReturnType<typeof emitted>): Input[] {
  const out = [...e.inputs]
  for (const p of e.pairs) [out[p], out[p + 1]] = [out[p + 1]!, out[p]!]
  const spooled = out.findIndex((x) => x.spooled)
  out.push(...out.splice(spooled, 1))
  return out
}

function feed(t: EngineUnderTest, inputs: Input[]): void {
  for (const x of inputs) expect(t.engine.ingest({ sessionId: x.sessionId, source: x.source, events: x.events, mono: x.mono, at: x.at, spooled: x.spooled })).toBe(true)
}

function engine(): EngineUnderTest {
  const t = engineUnderTest({ sessions: SESSIONS, mono: () => 0n })
  cleanup.push(() => t.dispose())
  return t
}

describe('status inputs out of order', () => {
  it('C-RACE-5 · same-millisecond pairs read in either order, 20 sessions interleaved and a spooled event drained after later live ones: each session ends exactly as its inputs applied in mono order', () => {
    const ordered = engine()
    const raced = engine()
    const rnd = prng(0x5ca1ab1e)
    const plans = ordered.ids.map((_, i) => ({ ordered: emitted(ordered.ids[i]!, i), raced: emitted(raced.ids[i]!, i) }))

    // the reference: every session's inputs in emission order, one session after another
    for (const p of plans) feed(ordered, p.ordered.inputs)

    // the race: each session's inputs in their arrival order, the sessions interleaved at random
    const queues = plans.map((p) => arrival(p.raced))
    while (queues.some((q) => q.length)) {
      const open = queues.filter((q) => q.length)
      feed(raced, [open[Math.floor(rnd() * open.length)]!.shift()!])
    }

    for (const [i, id] of raced.ids.entries()) {
      const want = ordered.engine.state(ordered.ids[i]!)!
      const got = raced.engine.state(id)!
      expect(got, `session ${i}`).toEqual(want)
      expect(got.phase).toBe(i % 2 === 1 ? 'blocked' : 'ready')
      expect(got.attention.map((a) => a.key)).toEqual(i % 2 === 1 ? ['Edit: src/a.ts'] : [])
      // the recent-signal ring lists them by emission, the spooled one in its place
      expect(raced.engine.machine(id)!.ring.map((r) => r.mono)).toEqual(ordered.engine.machine(ordered.ids[i]!)!.ring.map((r) => r.mono))
      expect(raced.engine.machine(id)!.ring.find((r) => r.spooled)?.events).toEqual([{ t: 'turn.finished', backgroundWork: false, lastMessage: 'done 2' }])
      // what the database and the sessions store read is the same status
      expect({ ...raced.runtime(id), session_id: null }).toEqual({ ...ordered.runtime(ordered.ids[i]!), session_id: null })
    }

    // and the race matters: applied in arrival order instead, the sessions would end otherwise
    const naive = plans.map((p, i) => {
      const m = new SessionMachine({ start: initialStatus(T0), startMono: null, prompt: false, noTurns: false })
      let mono = 0n
      for (const x of arrival(p.raced)) m.apply({ ...x, mono: ++mono }, false)
      return { i, state: m.state }
    })
    expect(naive.filter(({ i, state }) => state.phase !== raced.engine.state(raced.ids[i]!)!.phase || state.attention.length !== raced.engine.state(raced.ids[i]!)!.attention.length).length).toBeGreaterThan(0)
  })
})
