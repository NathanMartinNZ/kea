// The status engine under volume: the recent-signal rings stay within their caps through 100 000 signals and go with
// their sessions, and the reports folder stays within its limits through 100 reports. The engine in-process
// (tests/support/status.ts), as core.ts wires it.

import fs from 'node:fs'
import path from 'node:path'
import { L, type AgentEvent, type StatusSource } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { engineUnderTest } from '../support/status.ts'
import { heapUsed, leakCycles } from './ptyhost-leak.ts'

let cleanup: (() => unknown)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
})

const SIGNALS = 100_000
const SESSIONS = 20
/** Signals per measured cycle. */
const PER_CYCLE = 500

/** The i-th signal of a session: turns of tool calls, a prompt now and then, tier 1b/2/3 signals among the hooks. */
function signal(i: number): { source: StatusSource; events: AgentEvent[]; raw?: unknown } {
  switch (i % 10) {
    case 0:
      return { source: 'hook', events: [{ t: 'turn.started' }], raw: { hook_event_name: 'UserPromptSubmit', prompt: `prompt ${i}` } }
    case 1:
    case 3:
    case 5:
      return { source: 'hook', events: [{ t: 'tool.started', name: 'Bash', summary: `cmd ${i}` }], raw: { tool_input: { command: `cmd ${i}` } } }
    case 2:
    case 4:
    case 6:
      return { source: 'hook', events: [{ t: 'tool.finished', name: 'Bash', summary: `cmd ${i}`, ok: true }] }
    case 7:
      // an envelope past the hook cap is kept as its size only
      return { source: 'hook', events: [{ t: 'attention.permission', key: `Bash: ${i}`, tool: 'Bash' }], raw: { tool_input: { command: 'x'.repeat(L.hookEnvelopeMaxBytes + 1) } } }
    case 8:
      return { source: 'transcript', events: [{ t: 'attention.cleared', key: `Bash: ${i - 1}` }] }
    default:
      return { source: i % 20 === 9 ? 'heuristic' : 'hook', events: [{ t: 'turn.finished', backgroundWork: false, lastMessage: `done ${i}` }] }
  }
}

describe('recent-signal rings', () => {
  it(`L-ST-1 · ${SIGNALS} signals across ${SESSIONS} live sessions: every ring within L.signalRingEntries entries of at most L.hookEnvelopeMaxBytes each throughout, core heap within budget; 0 rings once all are detached`, async () => {
    const t = engineUnderTest({ sessions: SESSIONS })
    cleanup.push(() => t.dispose())
    let sent = 0
    let ringMax = 0
    let rawMax = 0
    const growth = await leakCycles({
      total: SIGNALS / PER_CYCLE,
      async cycle() {
        for (let k = 0; k < PER_CYCLE; k++, sent++) {
          const s = signal(Math.floor(sent / SESSIONS))
          t.engine.ingest({ sessionId: t.ids[sent % SESSIONS]!, ...s })
        }
        t.batch.flush()
        for (const id of t.ids) {
          const ring = t.engine.machine(id)!.ring
          ringMax = Math.max(ringMax, ring.length)
          for (const r of ring) if (r.raw !== undefined) rawMax = Math.max(rawMax, Buffer.byteLength(JSON.stringify(r.raw)))
        }
      },
      measure: heapUsed,
    })
    expect(sent).toBe(SIGNALS)
    expect(ringMax).toBe(L.signalRingEntries)
    expect(rawMax).toBeLessThanOrEqual(L.hookEnvelopeMaxBytes)
    expect(t.engine.resourceCounts).toMatchObject({ sessions: SESSIONS, ringEntries: SESSIONS * L.signalRingEntries })
    expect(growth.ok, `heap growth ${JSON.stringify({ slope: growth.slope, absolute: growth.absolute })}`).toBe(true)

    // every agent PTY ends (detached): its status goes, and its ring with it
    for (const id of t.ids) t.life(id, 'detached', 'exited')
    expect(t.engine.resourceCounts).toMatchObject({ sessions: 0, ringEntries: 0, timers: 0 })
    for (const id of t.ids) expect(t.engine.machine(id)).toBeUndefined()
  })
})

describe('status reports on disk', () => {
  it('L-ST-2 · 100 status reports: the reports folder within L.reportsKept and L.reportsMaxBytes after each; the newest kept; the counts match what is on disk', async () => {
    const t = engineUnderTest({ sessions: 4 })
    cleanup.push(() => t.dispose())
    const transcript = path.join(t.home, 'transcript.jsonl')
    fs.writeFileSync(transcript, 'x'.repeat(L.reportTranscriptBytes * 2))
    for (const id of t.ids) {
      t.engine.ingest({ sessionId: id, source: 'hook', events: [{ t: 'session.started', agentSessionId: id.toLowerCase(), transcriptPath: transcript, source: 'startup' }] })
      for (let i = 0; i < L.signalRingEntries; i++) t.engine.ingest({ sessionId: id, source: 'hook', events: [{ t: 'tool.started', name: 'Read', summary: `file ${i}` }], raw: { pad: 'p'.repeat(1_000) } })
    }
    const dir = t.engine.reports.dir
    const bytes = (p: string): number => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).reduce((n, f) => n + bytes(path.join(p, f)), 0) : fs.statSync(p).size)
    const expected = ['working', 'needsMe', 'finished', 'idle', 'ended'] as const
    let last = ''
    for (let i = 0; i < 100; i++) {
      last = (await t.engine.report(t.ids[i % t.ids.length]!, expected[i % expected.length]!, `report ${i}`)).dir
      const present = fs.readdirSync(dir)
      expect(present.length).toBeLessThanOrEqual(L.reportsKept)
      expect(bytes(dir)).toBeLessThanOrEqual(L.reportsMaxBytes)
      expect(present).toContain(path.basename(last))
    }
    expect(fs.readdirSync(dir)).toHaveLength(L.reportsKept)
    const counts = t.engine.reports.counts()
    expect(counts.total).toBe(L.reportsKept)
    const onDisk = fs.readdirSync(dir).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n, 'report.json'), 'utf8')).expected as string)
    for (const e of expected) expect(counts[e], e).toBe(onDisk.filter((x) => x === e).length)
  })
})
