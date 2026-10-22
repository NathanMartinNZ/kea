// One live session's status machine: the table (table.ts) plus precedence by tier and the order events are
// applied in. Pure and synchronous, so the engine, the replay tests (U-ST-7) and a report's replay all run the same
// thing.
//
//   precedence  a heuristic (tier 3) event is ignored when a tier-1/1b/2 input arrived less than
//                      L.heuristicSuppressMs earlier (by `mono`), except the user-input rule (table.ts `turnStarted`);
//                      the table keeps a heuristic from removing attention items. A tier-1 event always applies.
//   order       inputs are applied as they arrive. One that arrives after an input with a later `mono` stamp (two
//                      hook connections read out of order, a spooled event drained after a live one) is put in its
//                      place, and the status is recomputed from the ring's base, so arrival order never decides. One
//                      older than the ring's base is too late to place and changes nothing (the reconcile covers it).
//   the ring   the last L.signalRingEntries inputs, in `mono` order, with the status before the oldest: the
//                      recent-signal ring a status report carries, and what a late input is placed into. The
//                      transcript's usage updates (meta only: model, cost, context; one per assistant message) are no
//                      signal: they update the status and the base and stay out of the ring, so a long answer cannot
//                      push a turn's hooks out of a report.

import { L, type StatusSource } from '@kea/protocol'
import { cloneStatus, step, type StatusState, type StepResult, type TableEvent } from './table.ts'

/** One input: an envelope's or a signal's events, with when it was emitted (`mono`, ns) and received (`at`, wall ms). */
export interface SignalRecord {
  /** Arrival order (a report lists signals as they arrived). */
  seq: number
  mono: bigint
  at: number
  source: StatusSource
  /** Drained from a spool (Kea was not running). */
  spooled: boolean
  events: TableEvent[]
  /** The projected envelope or signal it came from (≤ L.hookEnvelopeMaxBytes as JSON), for a report. */
  raw?: unknown
}

export interface AppliedStep {
  ev: TableEvent
  result: StepResult
  /** A heuristic event ignored because an exact one arrived less than L.heuristicSuppressMs before. */
  ignored: boolean
}

export interface Applied {
  before: StatusState
  after: StatusState
  /** The input's own steps: as applied (in order), or as replayed in its place (reordered). */
  steps: AppliedStep[]
  /** The input arrived after one with a later `mono` and was put in its place. */
  reordered: boolean
  /** Older than the ring's base: too late to place, nothing changed. */
  dropped: boolean
}

const EXACT: ReadonlySet<StatusSource> = new Set(['hook', 'status-file', 'transcript'])

/** A transcript record that only reports usage (meta with no title): kept out of the ring (U-ST-19). */
function usageOnly(rec: SignalRecord): boolean {
  return rec.source === 'transcript' && rec.events.length > 0 && rec.events.every((e) => e.t === 'meta' && !e.title)
}
const SUPPRESS_NS = BigInt(L.heuristicSuppressMs) * 1_000_000n

export interface MachineOptions {
  /** The status to start from: the spawn's, or one restored from the database. */
  start: StatusState
  /** Inputs emitted before this (`mono`, ns) belong to an earlier agent and are dropped; null accepts all (a restored status). */
  startMono: bigint | null
  /** The agent was started with a prompt. */
  prompt: boolean
  /** The `shell` pseudo-agent: no turns. */
  noTurns: boolean
}

export class SessionMachine {
  private base: StatusState
  private baseMono: bigint | null
  // bounded: L.signalRingEntries inputs, the oldest folded into `base`
  private log: SignalRecord[] = []
  private cur: StatusState
  private seq = 0
  readonly prompt: boolean
  readonly noTurns: boolean

  constructor(o: MachineOptions) {
    this.base = cloneStatus(o.start)
    this.baseMono = o.startMono
    this.cur = cloneStatus(o.start)
    this.prompt = o.prompt
    this.noTurns = o.noTurns
  }

  get state(): StatusState {
    return this.cur
  }

  /** The recent-signal ring, oldest first by `mono`. */
  get ring(): readonly SignalRecord[] {
    return this.log
  }

  /** The status before the ring's oldest input, and that input's lower bound (`mono`). */
  get ringBase(): { state: StatusState; mono: bigint | null } {
    return { state: this.base, mono: this.baseMono }
  }

  /** Apply one input. `viewing`: whether the session is being viewed now. */
  apply(input: Omit<SignalRecord, 'seq'>, viewing: boolean): Applied {
    const rec: SignalRecord = { ...input, seq: this.seq++ }
    const before = this.cur
    if (this.baseMono !== null && rec.mono < this.baseMono) return { before, after: before, steps: [], reordered: false, dropped: true }
    if (usageOnly(rec)) {
      // no signal for the ring: the values go into the status and into the base, which a recompute starts from
      const r = this.run(this.cur, rec, viewing)
      this.cur = r.state
      let b = this.base
      for (const ev of rec.events) b = step(b, ev, { source: rec.source, at: rec.at, mono: rec.mono, prompt: this.prompt, noTurns: this.noTurns, viewing }).state
      this.base = b
      return { before, after: this.cur, steps: r.steps, reordered: false, dropped: false }
    }
    const last = this.log[this.log.length - 1]
    if (!last || rec.mono >= last.mono) {
      const r = this.run(this.cur, rec, viewing)
      this.cur = r.state
      this.log.push(rec)
      this.fold(viewing)
      return { before, after: this.cur, steps: r.steps, reordered: false, dropped: false }
    }
    // Placed by its emission time; everything after it is applied again
    let at = this.log.length
    while (at > 0 && this.log[at - 1]!.mono > rec.mono) at--
    this.log.splice(at, 0, rec)
    let s = this.base
    let own: AppliedStep[] = []
    for (const r of this.log) {
      const out = this.run(s, r, viewing)
      s = out.state
      if (r === rec) own = out.steps
    }
    this.cur = s
    this.fold(viewing)
    return { before, after: this.cur, steps: own, reordered: true, dropped: false }
  }

  /** Keep the ring at L.signalRingEntries: the oldest inputs go into the base. */
  private fold(viewing: boolean): void {
    while (this.log.length > L.signalRingEntries) {
      const oldest = this.log.shift()!
      this.base = this.run(this.base, oldest, viewing).state
      this.baseMono = oldest.mono
    }
  }

  private run(from: StatusState, rec: SignalRecord, viewing: boolean): { state: StatusState; steps: AppliedStep[] } {
    let s = from
    const steps: AppliedStep[] = []
    const heuristic = rec.source === 'heuristic'
    for (const ev of rec.events) {
      const userInput = ev.t === 'turn.started' && s.phase === 'blocked' && s.typedMono !== null
      if (heuristic && !userInput && s.exactMono !== null && rec.mono - s.exactMono < SUPPRESS_NS) {
        steps.push({ ev, result: { state: s, effects: [], handled: false, changed: false }, ignored: true })
        continue
      }
      const result = step(s, ev, { source: rec.source, at: rec.at, mono: rec.mono, prompt: this.prompt, noTurns: this.noTurns, viewing })
      s = result.state
      steps.push({ ev, result, ignored: false })
    }
    if (EXACT.has(rec.source) || (heuristic && !s.sawHeuristic)) {
      s = cloneStatus(s)
      if (EXACT.has(rec.source)) s.exactMono = rec.mono
      if (heuristic) s.sawHeuristic = true
    }
    return { state: s, steps }
  }
}
