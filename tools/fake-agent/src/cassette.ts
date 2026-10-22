// Cassette replay: asciicast v2 — a JSON header line, then `[time, code, data]` events. Only output events (`"o"`)
// are replayed; input, resize and marker events are skipped. Pure parsing and scheduling here; the runner writes the
// data at the scheduled times.

export interface CastHeader {
  version: 2
  width: number
  height: number
  idle_time_limit?: number
  [k: string]: unknown
}

export interface CastEvent {
  /** Seconds since the start of the recording. */
  t: number
  data: string
}

export class CastError extends Error {}

export function parseCast(text: string, source = 'cassette'): { header: CastHeader; events: CastEvent[] } {
  const lines = text.split('\n')
  let header: CastHeader | null = null
  const events: CastEvent[] = []
  let lastT = 0
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim()
    if (line === '') continue
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      throw new CastError(`${source}:${i + 1}: not JSON`)
    }
    if (header === null) {
      const h = v as Partial<CastHeader> | null
      if (typeof h !== 'object' || h === null || Array.isArray(h) || h.version !== 2) throw new CastError(`${source}:${i + 1}: expected an asciicast v2 header ({"version": 2, …})`)
      if (typeof h.width !== 'number' || typeof h.height !== 'number') throw new CastError(`${source}:${i + 1}: header needs width and height`)
      header = h as CastHeader
      continue
    }
    if (!Array.isArray(v) || v.length < 3 || typeof v[0] !== 'number' || typeof v[1] !== 'string' || typeof v[2] !== 'string') {
      throw new CastError(`${source}:${i + 1}: expected [time, code, data]`)
    }
    const t = v[0] as number
    if (!(t >= lastT)) throw new CastError(`${source}:${i + 1}: time goes backwards (${t} < ${lastT})`)
    lastT = t
    if (v[1] === 'o') events.push({ t, data: v[2] as string })
  }
  if (header === null) throw new CastError(`${source}: empty (no header)`)
  return { header, events }
}

/**
 * When to write each event, in ms from the start of the replay: event time / speed, with every gap capped at
 * `maxIdleMs` (default: the header's `idle_time_limit`). Speed 0 means as fast as possible (all at 0).
 */
export function castSchedule(events: readonly CastEvent[], opts: { speed: number; maxIdleMs: number | null; header?: CastHeader }): { atMs: number; data: string }[] {
  const cap = opts.maxIdleMs ?? (typeof opts.header?.idle_time_limit === 'number' ? opts.header.idle_time_limit * 1000 : Infinity)
  const out: { atMs: number; data: string }[] = []
  let prevT = 0
  let at = 0
  for (const e of events) {
    if (opts.speed > 0) at += Math.min((e.t - prevT) * 1000, cap) / opts.speed
    prevT = e.t
    out.push({ atMs: at, data: e.data })
  }
  return out
}
