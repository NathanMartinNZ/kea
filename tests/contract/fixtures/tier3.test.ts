// Tier 3 (the status heuristics that read only the terminal) against tier 1 (the agent's hooks), on recorded timelines.
// The committed timeline fixtures (fixtures/hooks/claude/<version>/tier3-timeline.json, derived from raw hook
// recordings by tools/recorder/src/timeline.ts) hold, per recording and on one clock, the real CLI's hook events, every
// PTY read with its size, the driver's keystrokes, and the bells and OSC 9/777 notifications in the output; no bytes,
// paths or text. Each is replayed through adapters/kit's Tier3 as ptyhost would feed it (activity notes from the read
// times, keystrokes, the launch prompt, bells, notifications) and compared with the hooks:
//
//   no false blocked   tier 3 raises attention only where tier 1 shows the agent waiting on the person (a
//                      PermissionRequest or Notification hook) within the tolerance
//   no invented turn   each tier-3 turn.started falls inside a tier-1 working stretch (a turn, or a compaction, less
//                      the time it waited on the person), widened by the tolerance plus tier 3's own start delay
//                      (L.tier3WorkingAfterMs)
//   turns found        each stretch longer than tier 3's start delay plus the tolerance is found: started within the
//                      delay plus the tolerance, finished within L.tier3ReadyAfterMs plus the tolerance of its end
//
// The tolerance (TOLERANCE_MS) comes on top of tier 3's own delays, which it cannot beat by design. The cassettes in
// fixtures/cassettes have no hook timeline; packages/adapters/src/kit/heuristics.test.ts runs tier 3 on them.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { L, type AgentEvent } from '@kea/protocol'
import { activityNotes, Tier3 } from '../../../packages/adapters/src/kit/heuristics.ts'
import type { Timeline } from '../../../tools/recorder/src/timeline.ts'

const TOLERANCE_MS = 2000
const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/hooks/claude')

interface Recording {
  name: string
  /** ms since the driver started */
  outputs: number[]
  keys: number[]
  bells: number[]
  notifies: number[]
  prompted: boolean
  turns: { start: number; end: number }[]
  waits: number[]
  end: number
}

const ENDS = new Set(['Stop', 'StopFailure', 'SessionEnd'])
const WAITS = new Set(['PermissionRequest', 'Notification'])

/**
 * Tier 1's working stretches: from UserPromptSubmit (or PreCompact: a compaction runs like a turn) until Stop /
 * StopFailure / SessionEnd / PostCompact, cut while the agent waits on the person (from a PermissionRequest or
 * Notification until the next other hook).
 */
function workingStretches(hooks: readonly { event: string; at: number }[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let state: 'idle' | 'working' | 'blocked' = 'idle'
  let start = 0
  for (const h of hooks) {
    if (state === 'idle' && (h.event === 'UserPromptSubmit' || h.event === 'PreCompact')) {
      state = 'working'
      start = h.at
    } else if (state === 'working' && (ENDS.has(h.event) || h.event === 'PostCompact')) {
      out.push({ start, end: h.at })
      state = 'idle'
    } else if (state === 'working' && WAITS.has(h.event)) {
      out.push({ start, end: h.at })
      state = 'blocked'
    } else if (state === 'blocked' && ENDS.has(h.event)) state = 'idle'
    else if (state === 'blocked' && !WAITS.has(h.event)) {
      state = 'working'
      start = h.at
    }
  }
  return out
}

/** Every case of every committed timeline fixture. */
function recordings(): Recording[] {
  const out: Recording[] = []
  for (const version of fs.readdirSync(HOOKS).sort()) {
    const file = path.join(HOOKS, version, 'tier3-timeline.json')
    if (!fs.existsSync(file)) continue
    const tl = JSON.parse(fs.readFileSync(file, 'utf8')) as Timeline
    for (const c of tl.cases) {
      const hooks = c.hooks.map(([event, at]) => ({ event, at }))
      const outputs = c.reads.map(([at]) => at)
      out.push({
        name: `${version}/${c.name}`,
        outputs,
        keys: c.keys,
        bells: c.bells,
        notifies: c.notifies,
        prompted: c.prompted,
        turns: workingStretches(hooks),
        waits: hooks.filter((h) => WAITS.has(h.event)).map((h) => h.at),
        end: Math.max(...outputs, ...hooks.map((h) => h.at)) + L.tier3ReadyAfterMs + TOLERANCE_MS,
      })
    }
  }
  return out
}

/** Tier 3 over a recording, ticking at each deadline; its events with their times. */
function replay(r: Recording): { at: number; e: AgentEvent }[] {
  const t = new Tier3({ prompted: r.prompted ? 0 : null })
  type In = { at: number; k: 'key' | 'bell' | 'notify' | 'act'; active?: boolean }
  const inputs: In[] = [
    ...r.keys.map((at): In => ({ at, k: 'key' })),
    ...r.bells.map((at): In => ({ at, k: 'bell' })),
    ...r.notifies.map((at): In => ({ at, k: 'notify' })),
    ...activityNotes(r.outputs).map((n): In => ({ at: n.at, k: 'act', active: n.active })),
  ].sort((a, b) => a.at - b.at)
  const out: { at: number; e: AgentEvent }[] = []
  const tickTo = (at: number) => {
    for (let d = t.deadline(); d !== null && d <= at; d = t.deadline()) {
      const evs = t.tick(d)
      if (evs.length === 0) break
      for (const e of evs) out.push({ at: d, e })
    }
  }
  for (const i of inputs) {
    tickTo(i.at)
    const evs = i.k === 'key' ? t.keystroke(i.at) : i.k === 'bell' ? t.bell(i.at) : i.k === 'notify' ? t.notify('', i.at) : t.activity(i.active!, i.at)
    for (const e of evs) out.push({ at: i.at, e })
  }
  tickTo(r.end)
  return out
}

describe('tier 3 against tier 1', () => {
  it('K-FX-6 · tier-3 heuristics on the committed timelines agree with their hook timeline within 2 s beyond tier 3’s own delays: no false blocked, no invented turn, every turn long enough found', () => {
    const all = recordings()
    expect(all.length, 'committed timeline cases').toBeGreaterThan(0)
    let found = 0
    for (const r of all) {
      const evs = replay(r)
      // no false blocked
      for (const a of evs.filter((x) => x.e.t.startsWith('attention.'))) {
        expect(
          r.waits.some((w) => Math.abs(w - a.at) <= TOLERANCE_MS),
          `${r.name}: attention at ${a.at.toFixed(0)} ms with no wait in tier 1`,
        ).toBe(true)
      }
      // no invented turn
      for (const s of evs.filter((x) => x.e.t === 'turn.started')) {
        const ok = r.turns.some((t) => s.at >= t.start - TOLERANCE_MS && s.at <= t.end + L.tier3WorkingAfterMs + TOLERANCE_MS)
        expect(ok, `${r.name}: tier 3 started a turn at ${s.at.toFixed(0)} ms; tier 1's turns: ${JSON.stringify(r.turns)}`).toBe(true)
      }
      // turns long enough are found, start and end
      for (const t of r.turns.filter((x) => x.end - x.start > L.tier3WorkingAfterMs + TOLERANCE_MS)) {
        found++
        const s = evs.find((x) => x.e.t === 'turn.started' && x.at >= t.start - TOLERANCE_MS)
        expect(s && s.at <= t.start + L.tier3WorkingAfterMs + TOLERANCE_MS, `${r.name}: the turn at ${t.start.toFixed(0)} ms found`).toBe(true)
        const f = evs.find((x) => x.e.t === 'turn.finished' && x.at >= t.end - TOLERANCE_MS)
        expect(f && f.at <= t.end + L.tier3ReadyAfterMs + TOLERANCE_MS, `${r.name}: the turn ending at ${t.end.toFixed(0)} ms finished`).toBe(true)
      }
    }
    console.log(`K-FX-6: ${all.length} recordings, ${all.reduce((n, r) => n + r.turns.length, 0)} tier-1 turns (${found} long enough for tier 3)`)
  })
})
