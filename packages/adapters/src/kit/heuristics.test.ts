import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { L, type AgentEvent } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { activityNotes, Tier3, TIER3_KEYS } from './heuristics.ts'

const CASSETTES = fileURLToPath(new URL('../../../../fixtures/cassettes/', import.meta.url))

type Input = { at: number; key?: true; active?: boolean; bell?: true; notify?: string }

/** A cassette as tier 3 sees it: keystrokes (typed input, not the terminal's query replies) and ptyhost's activity notes; plus its markers. */
function trace(name: string, cutAfter?: string): { inputs: Input[]; marks: Record<string, number> } {
  const lines = fs.readFileSync(`${CASSETTES}${name}.cast`, 'utf8').split('\n').filter(Boolean).slice(1)
  const ev = lines.map((l) => JSON.parse(l) as [number, string, string]).map(([t, k, d]) => ({ at: Math.round(t * 1000), k, d }))
  const marks: Record<string, number> = {}
  for (const e of ev) if (e.k === 'm') marks[e.d] = e.at
  const end = cutAfter ? marks[cutAfter]! + L.activityReportMs : Number.POSITIVE_INFINITY
  const outs = ev.filter((e) => e.k === 'o' && e.at <= end).map((e) => e.at)
  const keys: Input[] = ev.filter((e) => e.k === 'i' && !e.d.startsWith('\x1b') && e.at <= end).map((e) => ({ at: e.at, key: true }))
  const acts: Input[] = activityNotes(outs).map((n) => ({ at: n.at, active: n.active }))
  return { inputs: [...keys, ...acts].sort((a, b) => a.at - b.at), marks }
}

/** Drive Tier3 through the inputs, ticking at every deadline in between; the events with their times. */
function run(t: Tier3, inputs: readonly Input[], until: number): { at: number; e: AgentEvent }[] {
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
    const evs = i.key ? t.keystroke(i.at) : i.bell ? t.bell(i.at) : i.notify !== undefined ? t.notify(i.notify, i.at) : t.activity(i.active!, i.at)
    for (const e of evs) out.push({ at: i.at, e })
  }
  tickTo(until)
  return out
}

describe('tier-3 heuristics', () => {
  it('U-AGT-16 · on a cassette-derived activity trace: working detected after the prompt, ready once output stops; typing alone is not work', () => {
    const { inputs, marks } = trace('claude-classic-explain', 'answered')
    const evs = run(new Tier3(), inputs, marks.answered! + 2 * L.tier3ReadyAfterMs)
    const started = evs.filter((x) => x.e.t === 'turn.started')
    const finished = evs.filter((x) => x.e.t === 'turn.finished')
    expect(started).toHaveLength(1)
    // the prompt was submitted at the `waiting` mark; output flowed from then on
    expect(started[0]!.at).toBeGreaterThanOrEqual(marks.waiting!)
    expect(started[0]!.at - marks.waiting!).toBeLessThanOrEqual(L.tier3WorkingAfterMs + L.activityReportMs)
    expect(finished).toHaveLength(1)
    expect(finished[0]!.at).toBeGreaterThanOrEqual(marks.answered! + L.tier3ReadyAfterMs)
    expect(finished[0]!.at - marks.answered!).toBeLessThanOrEqual(L.tier3ReadyAfterMs + L.activityReportMs)
    expect(finished[0]!.e).toEqual({ t: 'turn.finished', backgroundWork: false })
    // nothing raised attention: the cassette has no bell
    expect(evs.filter((x) => x.e.t.startsWith('attention'))).toEqual([])
    // the typing before Enter (output echoed for ~2 s) never counted as work
    expect(evs.filter((x) => x.at < marks.waiting!)).toEqual([])
  })

  it('U-AGT-16 · bell and OSC 9/777 → a question with the text; a launch prompt counts as the keystroke; with a tier-1 source tier 3 never finishes a turn', () => {
    const t = new Tier3()
    expect(t.bell(10)).toEqual([{ t: 'attention.question', key: TIER3_KEYS.bell, summary: 'The terminal rang the bell' }])
    expect(t.notify('Claude needs your permission to use Bash', 20)).toEqual([{ t: 'attention.question', key: TIER3_KEYS.notify, summary: 'Claude needs your permission to use Bash' }])
    // an argv prompt: output right after spawn starts the turn with no keystroke
    const p = new Tier3({ prompted: 0 })
    expect(p.activity(true, 100)).toEqual([])
    expect(p.deadline()).toBe(100 + L.tier3WorkingAfterMs)
    expect(p.tick(100 + L.tier3WorkingAfterMs - 1)).toEqual([])
    expect(p.tick(100 + L.tier3WorkingAfterMs)).toEqual([{ t: 'turn.started' }])
    // output with no prompt (an idle redraw) is not a turn
    const idle = new Tier3()
    idle.activity(true, 0)
    expect(idle.deadline()).toBeNull()
    expect(idle.tick(10 * L.tier3WorkingAfterMs)).toEqual([])
    // tier 1 present: no tier-3 finish, and no timer for it
    p.tier1 = true
    p.activity(false, 5000)
    expect(p.deadline()).toBeNull()
    expect(p.tick(5000 + 10 * L.tier3ReadyAfterMs)).toEqual([])
    // … and no turn of its own: the next keystroke followed by output starts one again (so output after the user
    // answers a blocked session shows it working)
    const h = new Tier3()
    h.tier1 = true
    h.keystroke(0)
    h.activity(true, 10)
    expect(h.tick(10 + L.tier3WorkingAfterMs)).toEqual([{ t: 'turn.started' }])
    expect(h.isWorking).toBe(false)
    h.keystroke(20_000)
    expect(h.tick(20_000 + L.tier3WorkingAfterMs)).toEqual([{ t: 'turn.started' }])
    // activity notes from output: active at the first output, inactive one report period after the last, rate-limited
    expect(activityNotes([0, 10, 20, 1000, 1001])).toEqual([
      { at: 0, active: true },
      { at: 20 + L.activityReportMs, active: false },
      { at: 1000, active: true },
      { at: 1001 + L.activityReportMs, active: false },
    ])
  })
})
