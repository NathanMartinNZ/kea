// A status and the recent-signal ring to and from JSON (a report bundle, a replay fixture), in the
// shapes of `@kea/protocol` status.ts: `mono` stamps are nanosecond bigints, written as decimal strings.

import type { SignalJson, StatusStateJson } from '@kea/protocol'
import type { SignalRecord } from './machine.ts'
import type { StatusState, TableEvent } from './table.ts'

const m2s = (m: bigint | null) => (m === null ? null : m.toString())
const s2m = (s: string | null) => (s === null ? null : BigInt(s))

export function stateToJson(s: StatusState): StatusStateJson {
  return { ...s, attention: s.attention.map((a) => ({ ...a })), exactMono: m2s(s.exactMono), typedMono: m2s(s.typedMono), turnMono: m2s(s.turnMono) }
}

export function stateFromJson(j: StatusStateJson): StatusState {
  return { ...j, attention: j.attention.map((a) => ({ ...a })), exactMono: s2m(j.exactMono), typedMono: s2m(j.typedMono), turnMono: s2m(j.turnMono) }
}

export function signalToJson(r: SignalRecord): SignalJson {
  return { seq: r.seq, mono: r.mono.toString(), at: r.at, source: r.source, spooled: r.spooled, events: r.events.map((e) => ({ ...e })), ...(r.raw !== undefined ? { raw: r.raw } : {}) }
}

export function signalFromJson(j: SignalJson): Omit<SignalRecord, 'seq'> {
  return { mono: BigInt(j.mono), at: j.at, source: j.source, spooled: j.spooled, events: j.events as unknown as TableEvent[] }
}
