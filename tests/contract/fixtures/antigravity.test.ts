// Antigravity CLI's recorded status-line feed sequences, individual snapshots, and transcripts against the adapter.
//
// fixtures/statusline/antigravity/<version>/ holds scrubbed status-line payloads and full turn sequences recorded on
// the real CLI:
//   sequence.session1.jsonl         fresh launch → model selection → turn 1 → mode cycle → tool confirmation deny →
//                                   tool confirmation approve → /clear
//   sequence.session2-resume.jsonl  resumed conversation (--conversation=<id>) → restored title & context → 2 turns
//   start.json, working.json, idle.json, tool-confirmation.json, clear.json, resumed.json, authenticating.json
//
// fixtures/transcripts/antigravity/<version>/*.jsonl holds scrubbed transcript states at key points of a session:
//   finished.jsonl, confirming.jsonl, interrupted-ctrlc.jsonl, interrupted-esc.jsonl

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zAgentEvent, zUsageWindow, type AgentEvent } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { antigravityAdapter } from '../../../packages/adapters/src/antigravity/adapter.ts'
import { antigravityProjection } from '../../../packages/adapters/src/antigravity/launch.ts'
import { projectPayload } from '../../../packages/adapters/src/kit/projection.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATUSLINE_ROOT = path.resolve(HERE, '../../../fixtures/statusline/antigravity')
const TRANSCRIPTS_ROOT = path.resolve(HERE, '../../../fixtures/transcripts/antigravity')

type Dict = Record<string, unknown>

const versions = (root: string): string[] =>
  fs.existsSync(root) ? fs.readdirSync(root).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort() : []

const readJson = (file: string): Dict => JSON.parse(fs.readFileSync(file, 'utf8')) as Dict

const readJsonl = (file: string): Dict[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Dict)

const CONV_1 = 'ccdd9152-4a43-431f-a012-3dd2439220a0'
const CONV_2 = '77f055e0-77a0-4ec8-9f12-d184b3b76fed'
const CANONICAL_TP_1 = `/Users/HOME__/.gemini/antigravity-cli/brain/${CONV_1}/.system_generated/logs/transcript.jsonl`
const CANONICAL_TP_2 = `/Users/HOME__/.gemini/antigravity-cli/brain/${CONV_2}/.system_generated/logs/transcript.jsonl`
const FIXTURE_ENV = { HOME: '/Users/HOME__' }

describe('Antigravity CLI recorded status-line sequences, quota snapshots and transcripts', () => {
  it('K-FX-10 · status-line projection strips PII, replays recorded session1 & session2-resume sequences and snapshots to exact AgentEvents and priority-ordered UsageWindows, reconciles recorded transcripts, and counts unknown agent_state safely', async () => {
    const slVersions = versions(STATUSLINE_ROOT)
    expect(slVersions.length, 'recorded statusline versions').toBeGreaterThan(0)
    const proj = antigravityProjection()

    for (const v of slVersions) {
      const dir = path.join(STATUSLINE_ROOT, v)

      // 1) Privacy projection on every recorded JSON snapshot and JSONL sequence line
      const snapshotFiles = [
        'start.json',
        'working.json',
        'idle.json',
        'tool-confirmation.json',
        'clear.json',
        'resumed.json',
        'authenticating.json',
      ]
      for (const name of snapshotFiles) {
        const raw = readJson(path.join(dir, name))
        const projected = projectPayload(raw, proj)
        expect(projected.email, `${v}/${name} strips email`).toBeUndefined()
        expect(projected.cwd, `${v}/${name} strips cwd`).toBeUndefined()
        expect(projected.workspace, `${v}/${name} strips workspace`).toBeUndefined()
        expect(projected.plan_tier, `${v}/${name} strips plan_tier`).toBeUndefined()
        expect(projected.vcs, `${v}/${name} strips vcs`).toBeUndefined()
      }

      // Subagent array projection: strips subagent names/roles and counts only status === 'running'
      const withSubagents: Dict = {
        ...readJson(path.join(dir, 'working.json')),
        subagents: [
          { name: 'secret-helper-1', role: 'researcher', status: 'running' },
          { name: 'secret-helper-2', role: 'verifier', status: 'completed' },
          { name: 'secret-helper-3', role: 'coder', status: 'running' },
        ],
      }
      const projectedSubagents = projectPayload(withSubagents, proj)
      expect(projectedSubagents.subagents).toBe(2)
      expect(JSON.stringify(projectedSubagents)).not.toContain('secret-helper')

      // 2) Full replay of sequence.session1.jsonl (fresh launch -> turns -> mode cycle -> confirm deny/approve -> /clear)
      const seq1Raw = readJsonl(path.join(dir, 'sequence.session1.jsonl'))
      const sig1 = antigravityAdapter.signals(null)
      const events1: AgentEvent[] = []
      for (const [i, raw] of seq1Raw.entries()) {
        const projected = projectPayload(raw, proj)
        expect(projected.email).toBeUndefined()
        expect(projected.cwd).toBeUndefined()
        expect(projected.workspace).toBeUndefined()
        const stepEvents = sig1.hook({ payload: projected, monoMs: i * 300 })
        for (const e of stepEvents) {
          expect(zAgentEvent.safeParse(e).success, `${v}/sequence.session1[${i}]: ${JSON.stringify(e)}`).toBe(true)
          if (e.t === 'session.started' && e.transcriptPath) {
            expect(antigravityAdapter.ownsTranscript?.(e.transcriptPath, FIXTURE_ENV), e.transcriptPath).toBe(true)
          }
        }
        events1.push(...stepEvents)
      }

      expect(events1, `${v}/sequence.session1.jsonl events`).toEqual([
        { t: 'meta', model: 'Gemini 4 Neon (XHigh)', contextUsedPct: 0 },
        { t: 'meta', model: 'Gemini 3.8 Flash (Low)', effort: 'low' },
        {
          t: 'session.started',
          agentSessionId: CONV_1,
          source: 'startup',
          transcriptPath: CANONICAL_TP_1,
        },
        { t: 'turn.started' },
        { t: 'meta', permissionMode: 'auto' },
        { t: 'meta', contextUsedPct: 1.39007568359375 },
        { t: 'meta', contextUsedPct: 1.4143943786621094 },
        { t: 'meta', contextUsedPct: 1.4632225036621094 },
        { t: 'turn.finished', backgroundWork: false },
        { t: 'meta', contextUsedPct: 1.4787673950195312 },
        { t: 'meta', permissionMode: 'plan' },
        { t: 'meta', permissionMode: 'default' },
        { t: 'turn.started' },
        {
          t: 'attention.permission',
          key: `confirm:${CONV_1}`,
          tool: 'Tool confirmation',
          summary: '',
        },
        { t: 'meta', contextUsedPct: 1.3761520385742188 },
        { t: 'turn.finished', backgroundWork: false },
        { t: 'attention.cleared', key: `confirm:${CONV_1}` },
        { t: 'turn.started' },
        {
          t: 'attention.permission',
          key: `confirm:${CONV_1}`,
          tool: 'Tool confirmation',
          summary: '',
        },
        { t: 'meta', contextUsedPct: 1.3949394226074219 },
        { t: 'attention.cleared', key: `confirm:${CONV_1}` },
        { t: 'turn.finished', backgroundWork: false },
        { t: 'meta', contextUsedPct: 1.4288902282714844 },
        {
          t: 'session.started',
          agentSessionId: CONV_2,
          source: 'clear',
          transcriptPath: CANONICAL_TP_2,
        },
        { t: 'meta', contextUsedPct: 0 },
      ])
      expect(sig1.agentSessionId).toBe(CONV_2)
      expect([...sig1.sessionIds()]).toEqual([CONV_1, CONV_2])
      expect(sig1.ignored).toEqual({
        unknownStatus: 0,
        unknownWait: 0,
        foreignSession: 0,
        unparsable: 0,
        unknownEvent: 0,
      })

      // 3) Full replay of sequence.session2-resume.jsonl (resumed conversation -> title & context restored -> 2 turns)
      const seq2Raw = readJsonl(path.join(dir, 'sequence.session2-resume.jsonl'))
      const sig2 = antigravityAdapter.signals(CONV_1)
      const events2: AgentEvent[] = []
      for (const [i, raw] of seq2Raw.entries()) {
        const projected = projectPayload(raw, proj)
        const stepEvents = sig2.hook({ payload: projected, monoMs: i * 300 })
        for (const e of stepEvents) {
          expect(zAgentEvent.safeParse(e).success, `${v}/sequence.session2-resume[${i}]: ${JSON.stringify(e)}`).toBe(true)
          if (e.t === 'session.started' && e.transcriptPath) {
            expect(antigravityAdapter.ownsTranscript?.(e.transcriptPath, FIXTURE_ENV), e.transcriptPath).toBe(true)
          }
        }
        events2.push(...stepEvents)
      }

      expect(events2, `${v}/sequence.session2-resume.jsonl events`).toEqual([
        { t: 'meta', model: 'Gemini 4 Neon (XHigh)', contextUsedPct: 0 },
        {
          t: 'session.started',
          agentSessionId: CONV_1,
          source: 'resume',
          transcriptPath: CANONICAL_TP_1,
        },
        {
          t: 'meta',
          title: 'Repository Purpose Explanation',
          titleSource: 'agent',
          permissionMode: 'accept-edits',
        },
        { t: 'meta', effort: 'xhigh', contextUsedPct: 1.4288902282714844 },
        { t: 'turn.started' },
        { t: 'turn.finished', backgroundWork: false },
        { t: 'meta', contextUsedPct: 1.4642715454101562 },
        { t: 'turn.started' },
        { t: 'turn.finished', backgroundWork: false },
        { t: 'meta', contextUsedPct: 1.4702796936035156 },
      ])
      expect(sig2.agentSessionId).toBe(CONV_1)
      expect([...sig2.sessionIds()]).toEqual([CONV_1])
      expect(sig2.ignored).toEqual({
        unknownStatus: 0,
        unknownWait: 0,
        foreignSession: 0,
        unparsable: 0,
        unknownEvent: 0,
      })

      // 4) Signed-out authenticating.json (model: null across repeated ticks) -> turn.failed{kind:'auth'} on tick 2
      const authProjected = projectPayload(readJson(path.join(dir, 'authenticating.json')), proj)
      const sigAuth = antigravityAdapter.signals(null)
      expect(sigAuth.hook({ payload: authProjected, monoMs: 0 })).toEqual([{ t: 'meta', contextUsedPct: 0 }])
      expect(sigAuth.hook({ payload: authProjected, monoMs: 300 })).toEqual([
        { t: 'turn.failed', kind: 'auth', error: 'Antigravity CLI needs sign-in' },
      ])

      // 5) Usage mapping across recorded snapshots
      const now = Date.parse('2026-11-20T20:09:43Z')
      expect(antigravityAdapter.usage!.map(projectPayload(readJson(path.join(dir, 'start.json')), proj), now)).toEqual([])
      expect(antigravityAdapter.usage!.map(authProjected, now)).toEqual([])

      for (const qFile of ['working.json', 'idle.json', 'tool-confirmation.json', 'clear.json', 'resumed.json']) {
        const projected = projectPayload(readJson(path.join(dir, qFile)), proj)
        const usageEv = antigravityAdapter.usage!.map(projected, now)
        expect(usageEv, `${v}/${qFile} usage events`).toHaveLength(1)
        const ev = usageEv[0]!
        expect(zAgentEvent.safeParse(ev).success, `${v}/${qFile} zAgentEvent`).toBe(true)
        if (ev.t !== 'account.usage') throw new Error(`${v}/${qFile}: expected account.usage`)
        expect(ev.windows.map((w) => w.id), `${v}/${qFile} window order`).toEqual([
          'gemini-5h',
          'gemini-weekly',
          '3p-5h',
          '3p-weekly',
        ])
        for (const w of ev.windows) {
          expect(zUsageWindow.safeParse(w).success, `${v}/${qFile} ${w.id}`).toBe(true)
        }
      }

      const workingUsage = antigravityAdapter.usage!.map(
        projectPayload(readJson(path.join(dir, 'working.json')), proj),
        now,
      )[0]!
      if (workingUsage.t !== 'account.usage') throw new Error('expected account.usage')
      expect(workingUsage.windows).toEqual([
        {
          id: 'gemini-5h',
          shortLabel: 'Gem 5h',
          tipLabel: 'Gemini 5-hour',
          spokenLabel: 'Gemini 5-hour',
          priority: 0,
          usedPct: (1 - 0.6610572) * 100,
          resetsAt: Date.parse('2026-11-21T00:08:09Z'),
        },
        {
          id: 'gemini-weekly',
          shortLabel: 'Gem 7d',
          tipLabel: 'Gemini weekly',
          spokenLabel: 'Gemini weekly',
          priority: 1,
          usedPct: (1 - 0.61308664) * 100,
          resetsAt: Date.parse('2026-11-27T00:30:26Z'),
        },
        {
          id: '3p-5h',
          shortLabel: '3p 5h',
          tipLabel: 'Partner 5-hour',
          spokenLabel: 'partner 5-hour',
          priority: 2,
          usedPct: 100,
          resetsAt: Date.parse('2026-11-20T20:50:31Z'),
        },
        {
          id: '3p-weekly',
          shortLabel: '3p 7d',
          tipLabel: 'Partner weekly',
          spokenLabel: 'partner weekly',
          priority: 3,
          usedPct: (1 - 0.4948088) * 100,
          resetsAt: Date.parse('2026-11-27T15:50:31Z'),
        },
      ])

      // 6) Forward-compatibility: unknown extra fields and unknown agent_state never throw; unknownStatus increments
      const workingRaw = readJson(path.join(dir, 'working.json'))
      const futureRaw: Dict = {
        ...workingRaw,
        agent_state: 'quantum_compacting',
        future_nested: { a: 1, b: [true, 'x'] },
      }
      const sigFuture = antigravityAdapter.signals(null)
      const futureEvents = sigFuture.hook({ payload: projectPayload(futureRaw, proj), monoMs: 100 })
      expect(sigFuture.ignored.unknownStatus).toBe(1)
      expect(futureEvents.map((e) => e.t)).toEqual(['session.started', 'meta'])
    }

    // 7) Recorded transcripts in fixtures/transcripts/antigravity/<version>/*.jsonl -> golden ReconcileResults
    const trVersions = versions(TRANSCRIPTS_ROOT)
    expect(trVersions.length, 'recorded transcript versions').toBeGreaterThan(0)
    for (const v of trVersions) {
      const dir = path.join(TRANSCRIPTS_ROOT, v)
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
      const actual: Record<string, unknown> = {}
      for (const f of files) {
        const name = f.slice(0, -'.jsonl'.length)
        actual[name] = await antigravityAdapter.reconcile({
          keaSessionId: '01JXKEASESSION0000000000AA',
          agentSessionId: CONV_1,
          transcriptPath: path.join(dir, f),
          cwd: '/Users/HOME__/demo',
          launch: { prompt: '' },
        })
      }
      expect(actual, `${v} transcript reconcile results`).toEqual({
        confirming: { phase: 'working', model: 'gemini-3.8-flash-low' },
        finished: { phase: 'finished', model: 'gemini-3.8-flash-low' },
        'interrupted-ctrlc': { phase: 'working', model: 'gemini-3.8-flash-low' },
        'interrupted-esc': { phase: 'working', model: 'gemini-3.8-flash-low' },
      })
    }
  })
})
