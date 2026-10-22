// Table-driven state machines. Session lifecycle, status phase, dev-server lifecycle, the creation pipeline, mirror
// park/unpark, the highlight worker and account conditions are all data: a table of (state, event type) → handler. A
// missing pair is a no-op, never a throw. `allPairs` enumerates every state × event pair so each table can be tested
// exhaustively from the same table the code runs. `onTransition` is the journal hook.

/** What a handler returns: the next state, the next state with a note for the journal, or null (refuse). */
export type Transition<S extends string> = S | { to: S; note?: string } | null

export type FsmHandler<S extends string, Ev, C> = (ctx: C, ev: Ev, from: S) => Transition<S>

/** state → event type → handler. The handler's event is narrowed to its type. */
export type FsmTable<S extends string, E extends { t: string }, C> = {
  [St in S]?: { [K in E['t']]?: FsmHandler<S, Extract<E, { t: K }>, C> }
}

export interface TransitionRecord<S extends string, E> {
  from: S
  to: S
  event: E
  note?: string
  /** Wall-clock ms (journals are shown to people). */
  at: number
}

export interface FsmDef<S extends string, E extends { t: string }, C> {
  initial: S
  transitions: FsmTable<S, E, C>
  /** Called after every change of state (not for refused, unhandled or same-state events). */
  onTransition?: (rec: TransitionRecord<S, E>) => void
  /** Stamps `at` (default `Date.now`). */
  now?: () => number
}

export interface SendResult<S extends string> {
  from: S
  to: S
  changed: boolean
  /** A handler exists for (state, event type) — even if it refused (returned null). */
  handled: boolean
  note?: string
}

export interface Fsm<S extends string, E extends { t: string }, C> {
  readonly state: S
  /** Apply `ev`. A missing (state, event) pair or a null result leaves the state unchanged. */
  send(ev: E, ctx?: C): SendResult<S>
  /** True when the current state has a handler for event type `t` (its guard may still refuse). */
  can(t: E['t']): boolean
}

type AnyHandler<S extends string, E, C> = FsmHandler<S, E, C>

function lookup<S extends string, E extends { t: string }, C>(
  table: FsmTable<S, E, C>,
  state: S,
  t: E['t'],
): AnyHandler<S, E, C> | undefined {
  const row = table[state] as Record<string, AnyHandler<S, E, C> | undefined> | undefined
  if (!row || !Object.hasOwn(row, t)) return undefined
  return row[t]
}

export function createFsm<S extends string, E extends { t: string }, C = undefined>(
  def: FsmDef<S, E, C>,
  opts: { state?: S } = {},
): Fsm<S, E, C> {
  let state: S = opts.state ?? def.initial
  const now = def.now ?? Date.now
  return {
    get state() {
      return state
    },
    can(t) {
      return lookup(def.transitions, state, t) !== undefined
    },
    send(ev, ctx) {
      const from = state
      const handler = lookup(def.transitions, from, ev.t)
      if (!handler) return { from, to: from, changed: false, handled: false }
      const out = handler(ctx as C, ev, from)
      if (out === null) return { from, to: from, changed: false, handled: true }
      const to = typeof out === 'string' ? out : out.to
      const note = typeof out === 'string' ? undefined : out.note
      const changed = to !== from
      state = to
      if (changed) def.onTransition?.({ from, to, event: ev, ...(note !== undefined ? { note } : {}), at: now() })
      return { from, to, changed, handled: true, ...(note !== undefined ? { note } : {}) }
    },
  }
}

export interface FsmPair<S extends string, T extends string> {
  state: S
  event: T
  /** The table has a handler for this pair. */
  handled: boolean
}

/**
 * Every state × event-type pair, in the order given, for exhaustive table tests
 * (`it.each(allPairs(def, STATES, EVENTS))`). Throws if the table mentions a state or an event
 * type missing from the lists, so the lists cannot silently fall behind the table.
 */
export function allPairs<S extends string, E extends { t: string }, C>(
  def: Pick<FsmDef<S, E, C>, 'transitions'>,
  states: readonly S[],
  eventTypes: readonly E['t'][],
): Array<FsmPair<S, E['t']>> {
  const stateSet = new Set<string>(states)
  const eventSet = new Set<string>(eventTypes)
  const unknown: string[] = []
  for (const [st, row] of Object.entries(def.transitions as Record<string, Record<string, unknown> | undefined>)) {
    if (!stateSet.has(st)) unknown.push(`state "${st}"`)
    for (const t of Object.keys(row ?? {})) if (!eventSet.has(t)) unknown.push(`event "${t}" (in state "${st}")`)
  }
  if (unknown.length > 0) throw new Error(`allPairs: the table uses ${unknown.join(', ')} not in the lists given`)
  const out: Array<FsmPair<S, E['t']>> = []
  for (const state of states) {
    for (const event of eventTypes) {
      out.push({ state, event, handled: lookup(def.transitions, state, event) !== undefined })
    }
  }
  return out
}
