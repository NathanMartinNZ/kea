import { describe, expect, it, vi } from 'vitest'
import { allPairs, createFsm } from './fsm.ts'
import type { FsmDef, TransitionRecord } from './fsm.ts'

// A small machine in the shape of the real ones (a dev server's lifecycle).
const STATES = ['stopped', 'starting', 'running', 'stopping'] as const
type S = (typeof STATES)[number]
type E = { t: 'start' } | { t: 'listening'; port: number } | { t: 'exit'; code: number } | { t: 'stop' }
const EVENTS = ['start', 'listening', 'exit', 'stop'] as const satisfies readonly E['t'][]
interface Ctx {
  allowStart: boolean
  port?: number
}

function def(onTransition?: (r: TransitionRecord<S, E>) => void): FsmDef<S, E, Ctx> {
  return {
    initial: 'stopped',
    onTransition,
    now: () => 1234,
    transitions: {
      stopped: { start: (ctx) => (ctx.allowStart ? 'starting' : null) },
      starting: {
        listening: (ctx, ev) => {
          ctx.port = ev.port
          return { to: 'running', note: `port ${ev.port}` }
        },
        exit: (_ctx, ev) => ({ to: 'stopped', note: `exit ${ev.code} while starting` }),
        stop: () => 'stopping',
      },
      running: { exit: () => 'stopped', stop: () => 'stopping', listening: (_c, _e, from) => from },
      stopping: { exit: () => 'stopped' },
    },
  }
}

describe('createFsm', () => {
  it('U-FSM-1 · transitions by table, journals changes with notes, narrows events per handler', () => {
    const journal: Array<TransitionRecord<S, E>> = []
    const fsm = createFsm(def((r) => journal.push(r)))
    const ctx: Ctx = { allowStart: true }
    expect(fsm.state).toBe('stopped')
    expect(fsm.send({ t: 'start' }, ctx)).toEqual({ from: 'stopped', to: 'starting', changed: true, handled: true })
    expect(fsm.send({ t: 'listening', port: 5173 }, ctx)).toMatchObject({ to: 'running', note: 'port 5173', changed: true })
    expect(ctx.port).toBe(5173)
    expect(fsm.send({ t: 'listening', port: 1 }, ctx)).toMatchObject({ to: 'running', changed: false, handled: true })
    expect(journal).toEqual([
      { from: 'stopped', to: 'starting', event: { t: 'start' }, at: 1234 },
      { from: 'starting', to: 'running', event: { t: 'listening', port: 5173 }, note: 'port 5173', at: 1234 },
    ])
  })

  it('U-FSM-1 · a missing (state, event) pair or a refusing guard is a no-op, never a throw', () => {
    const onTransition = vi.fn()
    const fsm = createFsm(def(onTransition))
    expect(fsm.send({ t: 'exit', code: 1 }, { allowStart: true })).toEqual({ from: 'stopped', to: 'stopped', changed: false, handled: false })
    expect(fsm.send({ t: 'start' }, { allowStart: false })).toEqual({ from: 'stopped', to: 'stopped', changed: false, handled: true })
    expect(fsm.can('start')).toBe(true)
    expect(fsm.can('stop')).toBe(false)
    expect(onTransition).not.toHaveBeenCalled()
    expect(createFsm(def(), { state: 'running' }).state).toBe('running')
  })

  it.each(allPairs(def(), STATES, EVENTS))('U-FSM-1 · exhaustive table: $state × $event', ({ state, event, handled }) => {
    const fsm = createFsm(def(), { state })
    const ev = { start: { t: 'start' }, listening: { t: 'listening', port: 1 }, exit: { t: 'exit', code: 0 }, stop: { t: 'stop' } }[event] as E
    const res = fsm.send(ev, { allowStart: true })
    expect(res.handled).toBe(handled)
    if (!handled) expect(res).toEqual({ from: state, to: state, changed: false, handled: false })
    expect(STATES).toContain(fsm.state)
  })
})

describe('allPairs', () => {
  it('U-FSM-2 · enumerates every state × event pair in order, marking handled ones', () => {
    const pairs = allPairs(def(), STATES, EVENTS)
    expect(pairs).toHaveLength(STATES.length * EVENTS.length)
    expect(pairs[0]).toEqual({ state: 'stopped', event: 'start', handled: true })
    expect(pairs[1]).toEqual({ state: 'stopped', event: 'listening', handled: false })
    expect(pairs.filter((p) => p.handled)).toHaveLength(1 + 3 + 3 + 1)
  })

  it('U-FSM-2 · throws when the table uses a state or event missing from the lists', () => {
    expect(() => allPairs(def(), ['stopped', 'starting', 'running'], EVENTS)).toThrow('state "stopping"')
    expect(() => allPairs(def(), STATES, ['start', 'exit', 'stop'])).toThrow('event "listening"')
  })
})
