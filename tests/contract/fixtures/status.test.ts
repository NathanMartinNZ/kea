// Claude's live status files (tier 1b) against the adapter: the recorded files (fixtures/status/claude/<version>/, one
// per state) parse, with `status` and `waitingFor` in the contract's known sets, and unknown values are ignored and
// counted (an unknown `waitingFor` still reads as waiting, of kind `unknown`, with the raw value as its detail);
// `sequence.json`, a whole recorded session, replayed through one ClaudeSignals (its hooks and file transitions in time
// order) yields the file's observations in order, its Esc turns (`busy` → `idle` with no `Stop` since the prompt) as
// interrupt candidates that confirm to `turn.interrupted`, and nothing else: the turn that ended with Stop and the
// /compact are not interrupts.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AgentEvent, StatusFileReading } from '@kea/protocol'
import { FIELDS, HOOK_EVENTS, STATUS_VALUES, WAITING_FOR } from '../../../packages/adapters/src/claude/contract.ts'
import { ClaudeSignals, parseStatusFile } from '../../../packages/adapters/src/claude/mapping.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/status/claude')
const versions = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((v) => fs.existsSync(path.join(ROOT, v, 'sequence.json'))) : []

type Entry = { t: number; source: 'file' | 'hook' | 'screen' | 'input'; what: string | { status: string | null; waitingFor: string | null } }

const read = (v: string, f: string) => fs.readFileSync(path.join(ROOT, v, f), 'utf8')

/** The reading a known status file gives: `waiting` takes its kind from WAITING_FOR and keeps the raw value. */
function expected(status: string, waitingFor: string | null): StatusFileReading {
  if (status !== 'waiting') return { status: status as StatusFileReading['status'] }
  return { status: 'waiting', waitingFor: WAITING_FOR[waitingFor!]!, detail: waitingFor! }
}

describe('Claude status files', () => {
  it('K-FX-7 · recorded status files parse with known values (unknown ones ignored and counted); sequence.json replayed through the adapter gives its tier-1b observations in order and its Esc turns as interrupted', () => {
    expect(versions.length, 'recorded versions').toBeGreaterThan(0)
    for (const v of versions) {
      // one file per state: known values, parsed to the mapped reading; the registered file has no status yet
      for (const f of fs.readdirSync(path.join(ROOT, v)).filter((x) => x.endsWith('.json') && x !== 'sequence.json')) {
        const o = JSON.parse(read(v, f)) as { status?: string; waitingFor?: string; sessionId: string }
        const p = parseStatusFile(read(v, f))
        if (o.status === undefined) {
          expect(p, `${v}/${f}: registered, no status (still the agent's file)`).toMatchObject({ ok: true, sessionId: o.sessionId, reading: null })
          continue
        }
        expect(STATUS_VALUES, `${v}/${f} status`).toContain(o.status)
        if (o.status === 'waiting') expect(Object.keys(WAITING_FOR), `${v}/${f} waitingFor`).toContain(o.waitingFor)
        expect(p, `${v}/${f}`).toMatchObject({ ok: true, sessionId: o.sessionId, reading: expected(o.status, o.waitingFor ?? null) })
      }

      // unknown values: ignored and counted; a waiting session still reads as waiting
      const base = JSON.parse(read(v, 'busy.json')) as Record<string, unknown>
      const sid = String(base.sessionId)
      const s0 = new ClaudeSignals(sid)
      expect(s0.statusFile(JSON.stringify({ ...base, status: 'pondering' })).reading).toBeNull()
      expect(s0.statusFile(JSON.stringify({ ...base, status: 'waiting', waitingFor: 'tea break' })).reading).toEqual({ status: 'waiting', waitingFor: 'unknown', detail: 'tea break' })
      expect(s0.ignored).toMatchObject({ unknownStatus: 1, unknownWait: 1 })

      // the whole session, in time order
      const seq = JSON.parse(read(v, 'sequence.json')) as { entries: Entry[] }
      const signals = new ClaudeSignals(sid)
      const observed: StatusFileReading[] = []
      const interrupts: { t: number; events: AgentEvent[] }[] = []
      const want: StatusFileReading[] = []
      const fileText = (w: { status: string | null; waitingFor: string | null }) => {
        const o: Record<string, unknown> = { ...base, sessionId: sid }
        delete o.status
        delete o.waitingFor
        if (w.status !== null) o.status = w.status
        if (w.waitingFor !== null) o.waitingFor = w.waitingFor
        return JSON.stringify(o)
      }
      for (const e of [...seq.entries].sort((a, b) => a.t - b.t)) {
        if (e.source === 'hook' && typeof e.what === 'string') {
          const [event, arg] = e.what.split(' ')
          if (!(HOOK_EVENTS as readonly string[]).includes(event!)) continue // not injected: never arrives
          const payload: Record<string, unknown> = { [FIELDS.event]: event, [FIELDS.sessionId]: sid, [FIELDS.cwd]: base.cwd, [FIELDS.transcriptPath]: '' }
          if (event === 'SessionStart') payload[FIELDS.source] = arg
          else if (event === 'SessionEnd') payload[FIELDS.reason] = arg
          else if (arg) payload[FIELDS.toolName] = arg
          signals.hook({ payload, monoMs: e.t })
        } else if (e.source === 'file') {
          if (typeof e.what === 'string') {
            expect(signals.statusFile(null).reading, 'removed').toBeNull()
            continue
          }
          if (e.what.status !== null) {
            const r = expected(e.what.status, e.what.waitingFor)
            if (JSON.stringify(want.at(-1)) !== JSON.stringify(r)) want.push(r)
          }
          const out = signals.statusFile(fileText(e.what))
          if (out.reading) observed.push(out.reading)
          if (out.interruptCandidate !== null) interrupts.push({ t: e.t, events: signals.confirmInterrupt(out.interruptCandidate) })
        }
      }
      expect(observed, `${v}: tier-1b observations in order`).toEqual(want)
      // the Esc turns: Esc before any output (turn 2), Esc at a permission prompt (turn 3); each confirmed
      const escs = seq.entries.filter((e) => e.source === 'input' && e.what === 'key Esc').map((e) => e.t)
      expect(interrupts.map((i) => i.events), `${v}: interrupts`).toEqual(escs.map(() => [{ t: 'turn.interrupted' }]))
      for (const [i, esc] of escs.entries()) expect(interrupts[i]!.t, `${v}: interrupt ${i + 1} follows its Esc`).toBeGreaterThan(esc)
      expect(signals.ignored, `${v}: nothing ignored`).toEqual({ unknownStatus: 0, unknownWait: 0, foreignSession: 0, unparsable: 0, unknownEvent: 0 })
    }
  })
})
