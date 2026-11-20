import { L, zAgentEvent, type AgentEvent } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { projectPayload } from '../kit/projection.ts'
import { antigravityProjection } from './launch.ts'
import { AntigravitySignals, createSignals, normalizeTranscriptPath, usageEvents } from './mapping.ts'

function assertValidEvents(events: readonly AgentEvent[]): void {
  for (const ev of events) {
    const parsed = zAgentEvent.safeParse(ev)
    expect(parsed.success, `invalid AgentEvent: ${JSON.stringify(ev)}`).toBe(true)
  }
}

function project(raw: Record<string, unknown>): Record<string, unknown> {
  return projectPayload(raw, antigravityProjection())
}

const LEGACY_TP = '/Users/demo/.gemini/antigravity/brain/conv-1/.system_generated/logs/transcript.jsonl'
const CANONICAL_TP = '/Users/demo/.gemini/antigravity-cli/brain/conv-1/.system_generated/logs/transcript.jsonl'

describe('antigravity mapping', () => {
  it('U-AGT-58 · normalizeTranscriptPath rewrites legacy brain paths and leaves canonical and foreign paths unchanged', () => {
    expect(normalizeTranscriptPath(null)).toBeNull()
    expect(normalizeTranscriptPath('')).toBeNull()
    expect(normalizeTranscriptPath('   ')).toBeNull()
    expect(normalizeTranscriptPath(LEGACY_TP)).toBe(CANONICAL_TP)
    expect(normalizeTranscriptPath(CANONICAL_TP)).toBe(CANONICAL_TP)
    expect(normalizeTranscriptPath('/outside/secret.jsonl')).toBe('/outside/secret.jsonl')
    expect(normalizeTranscriptPath('/Users/demo/.other/transcript.jsonl')).toBe('/Users/demo/.other/transcript.jsonl')
  })

  it('U-AGT-58 · virtual initial state: coalesced first snapshot in working or tool confirmation emits session.started and transitions in order', () => {
    const s1 = createSignals(null)
    const ev1 = s1.hook({
      payload: project({
        conversation_id: 'conv-1',
        transcript_path: LEGACY_TP,
        agent_state: 'working',
      }),
      monoMs: 100,
    })
    assertValidEvents(ev1)
    expect(ev1).toEqual([
      { t: 'session.started', agentSessionId: 'conv-1', source: 'startup', transcriptPath: CANONICAL_TP },
      { t: 'turn.started' },
    ])
    expect(s1.agentSessionId).toBe('conv-1')
    expect([...s1.sessionIds()]).toEqual(['conv-1'])

    const s2 = createSignals(null)
    const ev2 = s2.hook({
      payload: project({
        conversation_id: 'conv-2',
        transcript_path: CANONICAL_TP,
        agent_state: 'idle',
        tool_confirmation_pending: true,
      }),
      monoMs: 100,
    })
    assertValidEvents(ev2)
    expect(ev2).toEqual([
      { t: 'session.started', agentSessionId: 'conv-2', source: 'startup', transcriptPath: CANONICAL_TP },
      { t: 'attention.permission', key: 'confirm:conv-2', tool: 'Tool confirmation', summary: '' },
    ])

    // Resume launch emits source: 'resume' on first conversation_id snapshot.
    const s3 = createSignals('conv-1')
    expect(s3.agentSessionId).toBe('conv-1')
    expect([...s3.sessionIds()]).toEqual(['conv-1'])
    const ev3 = s3.hook({
      payload: project({
        conversation_id: 'conv-1',
        transcript_path: LEGACY_TP,
        agent_state: 'idle',
      }),
      monoMs: 200,
    })
    assertValidEvents(ev3)
    expect(ev3).toEqual([
      { t: 'session.started', agentSessionId: 'conv-1', source: 'resume', transcriptPath: CANONICAL_TP },
    ])
  })

  it('U-AGT-58 · full turn lifecycle initializing → working → tool_use → idle emits turn.started once and turn.finished with backgroundWork', () => {
    const s = new AntigravitySignals(null)

    const e0 = s.hook({ payload: project({ conversation_id: 'c1', agent_state: 'initializing' }), monoMs: 10 })
    const e1 = s.hook({ payload: project({ conversation_id: 'c1', agent_state: 'working' }), monoMs: 20 })
    const e2 = s.hook({ payload: project({ conversation_id: 'c1', agent_state: 'tool_use' }), monoMs: 30 })
    const e3 = s.hook({ payload: project({ conversation_id: 'c1', agent_state: 'working' }), monoMs: 40 })
    const e4 = s.hook({
      payload: project({
        conversation_id: 'c1',
        agent_state: 'idle',
        task_count: 0,
        subagents: [{ name: 'worker', role: 'search', status: 'completed' }],
      }),
      monoMs: 50,
    })
    for (const batch of [e0, e1, e2, e3, e4]) assertValidEvents(batch)
    expect(e0).toEqual([{ t: 'session.started', agentSessionId: 'c1', source: 'startup' }])
    expect(e1).toEqual([{ t: 'turn.started' }])
    expect(e2).toEqual([])
    expect(e3).toEqual([])
    expect(e4).toEqual([{ t: 'turn.finished', backgroundWork: false }])

    // Turn 2 finishes with active task_count > 0.
    s.hook({ payload: project({ conversation_id: 'c1', agent_state: 'working' }), monoMs: 60 })
    const e5 = s.hook({
      payload: project({ conversation_id: 'c1', agent_state: 'idle', task_count: 2 }),
      monoMs: 70,
    })
    assertValidEvents(e5)
    expect(e5).toEqual([{ t: 'turn.finished', backgroundWork: true }])

    // Turn 3 finishes with running subagent (projected via countWhere to integer > 0).
    s.hook({ payload: project({ conversation_id: 'c1', agent_state: 'working' }), monoMs: 80 })
    const e6 = s.hook({
      payload: project({
        conversation_id: 'c1',
        agent_state: 'idle',
        task_count: 0,
        subagents: [
          { name: 'a', role: 'r', status: 'completed' },
          { name: 'b', role: 'r', status: 'running' },
        ],
      }),
      monoMs: 90,
    })
    assertValidEvents(e6)
    expect(e6).toEqual([{ t: 'turn.finished', backgroundWork: true }])
  })

  it('U-AGT-58 · tool_confirmation_pending toggles attention.permission and attention.cleared keyed by confirm:<id>', () => {
    const s = new AntigravitySignals(null)
    s.hook({ payload: project({ conversation_id: 'c1', agent_state: 'working' }), monoMs: 10 })

    const ask = s.hook({
      payload: project({ conversation_id: 'c1', agent_state: 'tool_use', tool_confirmation_pending: true }),
      monoMs: 20,
    })
    const dup = s.hook({
      payload: project({ conversation_id: 'c1', agent_state: 'tool_use', tool_confirmation_pending: true }),
      monoMs: 30,
    })
    const clear = s.hook({
      payload: project({ conversation_id: 'c1', agent_state: 'working' }),
      monoMs: 40,
    })
    const dupClear = s.hook({
      payload: project({ conversation_id: 'c1', agent_state: 'working' }),
      monoMs: 50,
    })

    for (const batch of [ask, dup, clear, dupClear]) assertValidEvents(batch)
    expect(ask).toEqual([{ t: 'attention.permission', key: 'confirm:c1', tool: 'Tool confirmation', summary: '' }])
    expect(dup).toEqual([])
    expect(clear).toEqual([{ t: 'attention.cleared', key: 'confirm:c1' }])
    expect(dupClear).toEqual([])
  })

  it('U-AGT-58 · reviewing emits attention.question and leaving reviewing clears it before turn.started, turn.finished or turn.failed', () => {
    const targets: Array<{ next: string; expected: AgentEvent[] }> = [
      { next: 'working', expected: [{ t: 'attention.cleared', key: 'review:c1' }, { t: 'turn.started' }] },
      { next: 'tool_use', expected: [{ t: 'attention.cleared', key: 'review:c1' }, { t: 'turn.started' }] },
      {
        next: 'idle',
        expected: [{ t: 'attention.cleared', key: 'review:c1' }, { t: 'turn.finished', backgroundWork: false }],
      },
      {
        next: 'error',
        expected: [
          { t: 'attention.cleared', key: 'review:c1' },
          { t: 'turn.failed', kind: 'other', error: 'Antigravity CLI reported an error' },
        ],
      },
    ]

    for (const { next, expected } of targets) {
      const s = new AntigravitySignals(null)
      s.hook({ payload: project({ conversation_id: 'c1', agent_state: 'working' }), monoMs: 10 })
      const enter = s.hook({ payload: project({ conversation_id: 'c1', agent_state: 'reviewing' }), monoMs: 20 })
      const stay = s.hook({ payload: project({ conversation_id: 'c1', agent_state: 'reviewing' }), monoMs: 30 })
      const leave = s.hook({ payload: project({ conversation_id: 'c1', agent_state: next }), monoMs: 40 })
      for (const batch of [enter, stay, leave]) assertValidEvents(batch)
      expect(enter).toEqual([{ t: 'attention.question', key: 'review:c1', summary: 'Review requested' }])
      expect(stay).toEqual([])
      expect(leave).toEqual(expected)
    }
  })

  it('U-AGT-58 · authenticating suppresses transient signed-in startup and emits auth failure when signed out or mid-session', () => {
    // Normal signed-in startup: brief authenticating with model object → idle emits NO turn.failed.
    const signedIn = new AntigravitySignals(null)
    const t1 = signedIn.hook({
      payload: project({ agent_state: 'authenticating', model: { id: 'Gemini 4 Neon (XHigh)' } }),
      monoMs: 100,
    })
    const t2 = signedIn.hook({
      payload: project({ agent_state: 'authenticating', model: { id: 'Gemini 4 Neon (XHigh)' } }),
      monoMs: 400,
    })
    const t3 = signedIn.hook({
      payload: project({ agent_state: 'idle', model: { id: 'Gemini 4 Neon (XHigh)' } }),
      monoMs: 500,
    })
    for (const batch of [t1, t2, t3]) assertValidEvents(batch)
    expect(t1.filter((e) => e.t === 'turn.failed')).toEqual([])
    expect(t2.filter((e) => e.t === 'turn.failed')).toEqual([])
    expect(t3.filter((e) => e.t === 'turn.failed')).toEqual([])

    // Signed-out startup: repeated authenticating with model: null (projected removes `model`) emits turn.failed{kind:'auth'} once.
    const signedOut = new AntigravitySignals(null)
    const o1 = signedOut.hook({ payload: project({ agent_state: 'authenticating', model: null }), monoMs: 100 })
    const o2 = signedOut.hook({ payload: project({ agent_state: 'authenticating', model: null }), monoMs: 400 })
    const o3 = signedOut.hook({ payload: project({ agent_state: 'authenticating', model: null }), monoMs: 700 })
    for (const batch of [o1, o2, o3]) assertValidEvents(batch)
    expect(o1).toEqual([])
    expect(o2).toEqual([{ t: 'turn.failed', kind: 'auth', error: 'Antigravity CLI needs sign-in' }])
    expect(o3).toEqual([])

    // Startup stuck in authenticating >= 1500 ms even with a model object emits auth failure.
    const slowAuth = new AntigravitySignals(null)
    expect(
      slowAuth.hook({ payload: project({ agent_state: 'authenticating', model: { id: 'Gemini 4' } }), monoMs: 1000 }),
    ).toEqual([{ t: 'meta', model: 'Gemini 4' }])
    const slowFail = slowAuth.hook({
      payload: project({ agent_state: 'authenticating', model: { id: 'Gemini 4' } }),
      monoMs: 2500,
    })
    assertValidEvents(slowFail)
    expect(slowFail).toEqual([{ t: 'turn.failed', kind: 'auth', error: 'Antigravity CLI needs sign-in' }])

    // Mid-session authenticating (after seeing live state) emits auth failure immediately, recovers on idle, and can fire again.
    const midFail = signedIn.hook({
      payload: project({ agent_state: 'authenticating', model: { id: 'Gemini 4 Neon (XHigh)' } }),
      monoMs: 1000,
    })
    const midDup = signedIn.hook({
      payload: project({ agent_state: 'authenticating', model: { id: 'Gemini 4 Neon (XHigh)' } }),
      monoMs: 1300,
    })
    const recovered = signedIn.hook({
      payload: project({ agent_state: 'idle', model: { id: 'Gemini 4 Neon (XHigh)' } }),
      monoMs: 1600,
    })
    const secondDrop = signedIn.hook({
      payload: project({ agent_state: 'authenticating', model: { id: 'Gemini 4 Neon (XHigh)' } }),
      monoMs: 2000,
    })
    for (const batch of [midFail, midDup, recovered, secondDrop]) assertValidEvents(batch)
    expect(midFail).toEqual([{ t: 'turn.failed', kind: 'auth', error: 'Antigravity CLI needs sign-in' }])
    expect(midDup).toEqual([])
    expect(recovered).toEqual([])
    expect(secondDrop).toEqual([{ t: 'turn.failed', kind: 'auth', error: 'Antigravity CLI needs sign-in' }])
  })

  it('U-AGT-58 · error scopes rate_limit detection to the active model family, ignores disabled buckets, and parses reset times', () => {
    const iso = '2026-11-20T20:50:31Z'
    const isoMs = Date.parse(iso)
    const now = 1_700_000_000_000

    // Active Gemini model with exhausted 3p-5h bucket must NOT misclassify as rate_limit.
    const geminiWith3pExhausted = new AntigravitySignals(null, () => now)
    geminiWith3pExhausted.hook({
      payload: project({ conversation_id: 'c1', agent_state: 'working', model: { id: 'Gemini 3.8 Flash (Low)' } }),
      monoMs: 10,
    })
    const e1 = geminiWith3pExhausted.hook({
      payload: project({
        conversation_id: 'c1',
        agent_state: 'error',
        model: { id: 'Gemini 3.8 Flash (Low)' },
        quota: {
          '3p-5h': { remaining_fraction: 0, reset_time: iso, reset_in_seconds: 120 },
          'gemini-5h': { remaining_fraction: 0.5, reset_time: iso, reset_in_seconds: 300 },
        },
      }),
      monoMs: 20,
    })
    assertValidEvents(e1)
    expect(e1).toEqual([{ t: 'turn.failed', kind: 'other', error: 'Antigravity CLI reported an error' }])

    // Active Claude model with exhausted 3p-5h bucket → rate_limit with ISO resetsAt.
    const claudeRateLimited = new AntigravitySignals(null, () => now)
    claudeRateLimited.hook({
      payload: project({ conversation_id: 'c2', agent_state: 'working', model: { id: 'Claude Opus 5.5 (High)' } }),
      monoMs: 10,
    })
    const e2 = claudeRateLimited.hook({
      payload: project({
        conversation_id: 'c2',
        agent_state: 'error',
        quota: {
          '3p-5h': { remaining_fraction: 0, reset_time: iso, reset_in_seconds: 120 },
          'gemini-5h': { remaining_fraction: 0.8, reset_time: iso, reset_in_seconds: 300 },
        },
      }),
      monoMs: 20,
    })
    assertValidEvents(e2)
    expect(e2).toEqual([{ t: 'turn.failed', kind: 'rate_limit', error: 'Rate limit reached', resetsAt: isoMs }])

    // Active GPT model also scopes to 3p-* buckets.
    const gptRateLimited = new AntigravitySignals(null, () => now)
    const e2b = gptRateLimited.hook({
      payload: project({
        conversation_id: 'c2b',
        agent_state: 'error',
        model: { id: 'GPT-OSS 120B (Medium)' },
        quota: {
          '3p-weekly': { remaining_fraction: 0, reset_in_seconds: 120 },
          'gemini-5h': { remaining_fraction: 0.9, reset_in_seconds: 300 },
        },
      }),
      monoMs: 20,
    })
    assertValidEvents(e2b)
    expect(e2b).toContainEqual({
      t: 'turn.failed',
      kind: 'rate_limit',
      error: 'Rate limit reached',
      resetsAt: now + 120_000,
    })

    // Active Gemini model with exhausted gemini-5h bucket using remaining_amount: 0 + reset_in_seconds fallback.
    const geminiRateLimited = new AntigravitySignals(null, () => now)
    const e3 = geminiRateLimited.hook({
      payload: project({
        conversation_id: 'c3',
        agent_state: 'error',
        model: { id: 'Gemini 4 Neon (XHigh)' },
        quota: {
          'gemini-5h': { remaining_amount: 0, reset_in_seconds: 600 },
        },
      }),
      monoMs: 20,
    })
    assertValidEvents(e3)
    expect(e3).toContainEqual({
      t: 'turn.failed',
      kind: 'rate_limit',
      error: 'Rate limit reached',
      resetsAt: now + 600_000,
    })

    // Disabled exhausted bucket is ignored.
    const disabledBucket = new AntigravitySignals(null, () => now)
    const e4 = disabledBucket.hook({
      payload: project({
        conversation_id: 'c4',
        agent_state: 'error',
        model: { id: 'Gemini 4 Neon' },
        quota: {
          'gemini-5h': { remaining_fraction: 0, reset_time: iso, disabled: true },
        },
      }),
      monoMs: 20,
    })
    assertValidEvents(e4)
    expect(e4).toContainEqual({ t: 'turn.failed', kind: 'other', error: 'Antigravity CLI reported an error' })

    // Unknown model checks any non-disabled exhausted bucket.
    const unknownModel = new AntigravitySignals(null, () => now)
    const e5 = unknownModel.hook({
      payload: project({
        conversation_id: 'c5',
        agent_state: 'error',
        model: null,
        quota: {
          '3p-weekly': { remaining_fraction: 0 },
        },
      }),
      monoMs: 20,
    })
    assertValidEvents(e5)
    const failed = e5.find((e) => e.t === 'turn.failed')
    expect(failed).toEqual({ t: 'turn.failed', kind: 'rate_limit', error: 'Rate limit reached' })
    expect(failed && 'resetsAt' in failed).toBe(false)
  })

  it('U-AGT-58 · /clear closes open attention items, emits session.started{source:"clear"}, updates agentSessionId and resets title', () => {
    const s = new AntigravitySignals(null)
    s.hook({
      payload: project({
        conversation_id: 'c1',
        conversation_title: 'First Title',
        agent_state: 'reviewing',
        tool_confirmation_pending: true,
      }),
      monoMs: 10,
    })

    const cleared = s.hook({
      payload: project({
        conversation_id: 'c2',
        transcript_path: '/Users/demo/.gemini/antigravity/brain/c2/.system_generated/logs/transcript.jsonl',
        agent_state: 'idle',
      }),
      monoMs: 20,
    })
    assertValidEvents(cleared)
    expect(cleared).toEqual([
      { t: 'attention.cleared', key: 'confirm:c1' },
      { t: 'attention.cleared', key: 'review:c1' },
      {
        t: 'session.started',
        agentSessionId: 'c2',
        source: 'clear',
        transcriptPath: '/Users/demo/.gemini/antigravity-cli/brain/c2/.system_generated/logs/transcript.jsonl',
      },
      { t: 'turn.finished', backgroundWork: false },
    ])
    expect(s.agentSessionId).toBe('c2')
    expect([...s.sessionIds()]).toEqual(['c1', 'c2'])

    // Because title was reset on /clear, receiving the same title string again in c2 emits meta.title.
    const retitled = s.hook({
      payload: project({ conversation_id: 'c2', conversation_title: 'First Title', agent_state: 'idle' }),
      monoMs: 30,
    })
    assertValidEvents(retitled)
    expect(retitled).toEqual([{ t: 'meta', title: 'First Title', titleSource: 'agent' }])
  })

  it('U-AGT-58 · metadata diffs: title, model: null safety, cycle_mode default normalisation without clobbering yolo, contextUsedPct and costUsd', () => {
    // Launch where cycle_mode is absent (e.g. yolo): never emits permissionMode: 'default'.
    const yolo = new AntigravitySignals(null)
    const y1 = yolo.hook({
      payload: project({
        conversation_id: 'y1',
        agent_state: 'idle',
        model: null,
        context_window: { used_percentage: 12.5 },
        cost: { total_usd: 0.04 },
      }),
      monoMs: 10,
    })
    assertValidEvents(y1)
    expect(y1).toEqual([
      { t: 'session.started', agentSessionId: 'y1', source: 'startup' },
      { t: 'meta', contextUsedPct: 12.5, costUsd: 0.04 },
    ])

    // Same metadata repeated emits nothing.
    expect(
      yolo.hook({
        payload: project({
          conversation_id: 'y1',
          agent_state: 'idle',
          model: null,
          context_window: { used_percentage: 12.5 },
          cost: { total_usd: 0.04 },
        }),
        monoMs: 20,
      }),
    ).toEqual([])

    // Title arrives later → emits { t: 'meta', title, titleSource: 'agent' } only on change.
    const yTitle = yolo.hook({
      payload: project({ conversation_id: 'y1', agent_state: 'idle', conversation_title: 'Fix Build' }),
      monoMs: 30,
    })
    assertValidEvents(yTitle)
    expect(yTitle).toEqual([{ t: 'meta', title: 'Fix Build', titleSource: 'agent' }])
    expect(
      yolo.hook({
        payload: project({ conversation_id: 'y1', agent_state: 'idle', conversation_title: 'Fix Build' }),
        monoMs: 40,
      }),
    ).toEqual([])

    // Entering 'plan' then leaving (cycle_mode absent) normalises back to 'default'; context clamped 0–100; negative cost ignored.
    const mPlan = yolo.hook({
      payload: project({
        conversation_id: 'y1',
        agent_state: 'idle',
        model: { id: 'Gemini 3.8 Flash (Low)', effort: 'low' },
        cycle_mode: 'plan',
        context_window: { used_percentage: 140 },
        cost: { total_usd: -5 },
      }),
      monoMs: 50,
    })
    const mBackToDefault = yolo.hook({
      payload: project({
        conversation_id: 'y1',
        agent_state: 'idle',
        model: { id: 'Gemini 3.8 Flash (Low)', effort: 'low' },
        context_window: { used_percentage: -10 },
        cost: { total_usd: 0.12 },
      }),
      monoMs: 60,
    })
    const mStillDefault = yolo.hook({
      payload: project({
        conversation_id: 'y1',
        agent_state: 'idle',
      }),
      monoMs: 70,
    })
    for (const batch of [mPlan, mBackToDefault, mStillDefault]) assertValidEvents(batch)
    expect(mPlan).toEqual([
      { t: 'meta', model: 'Gemini 3.8 Flash (Low)', effort: 'low', permissionMode: 'plan', contextUsedPct: 100 },
    ])
    expect(mBackToDefault).toEqual([{ t: 'meta', permissionMode: 'default', contextUsedPct: 0, costUsd: 0.12 }])
    expect(mStillDefault).toEqual([])
  })

  it('U-AGT-58 · unknown agent_state and unparsable payloads are safely ignored and counted; tier-1b methods are no-ops', () => {
    const s = new AntigravitySignals(null)
    expect(s.hook({ payload: null as unknown as Record<string, unknown>, monoMs: 1 })).toEqual([])
    expect(s.hook({ payload: [] as unknown as Record<string, unknown>, monoMs: 2 })).toEqual([])
    expect(s.ignored.unparsable).toBe(2)

    // Unknown agent_state increments ignored.unknownStatus yet still emits metadata diffs.
    const ev = s.hook({
      payload: project({
        conversation_id: 'c1',
        agent_state: 'future_state',
        model: { id: 'Gemini 5' },
      }),
      monoMs: 3,
    })
    assertValidEvents(ev)
    expect(s.ignored.unknownStatus).toBe(1)
    expect(ev).toEqual([
      { t: 'session.started', agentSessionId: 'c1', source: 'startup' },
      { t: 'meta', model: 'Gemini 5' },
    ])

    expect(s.statusFile()).toEqual({ reading: null, registered: false, events: [], interruptCandidate: null })
    expect(s.confirmInterrupt()).toEqual([])
    expect(() => s.turnEnded()).not.toThrow()
  })

  it('U-AGT-58 · usageEvents maps quota buckets into prioritised, capped, self-describing UsageWindow entries', () => {
    const now = 1_795_200_000_000
    const payload = project({
      quota: {
        'gemini-argon-wtu-weekly': {
          remaining_fraction: 0.9,
          reset_time: '2026-11-27T19:58:03Z',
          reset_in_seconds: 604100,
        },
        '3p-5h': {
          remaining_fraction: 0,
          reset_time: '2026-11-20T20:50:31Z',
          reset_in_seconds: 2448,
        },
        '3p-weekly': {
          remaining_fraction: 0.5,
          reset_in_seconds: 3600,
        },
        'gemini-5h': {
          remaining_fraction: 0.25,
          reset_time: '2026-11-21T00:08:09Z',
        },
        'gemini-weekly': {
          remaining_fraction: 0.6,
          reset_time: '2026-11-27T00:30:26Z',
        },
        'disabled-bucket': {
          remaining_fraction: 0,
          reset_time: '2026-11-21T00:08:09Z',
          disabled: true,
        },
        'missing-fraction': {
          reset_time: '2026-11-21T00:08:09Z',
        },
        'missing-reset': {
          remaining_fraction: 0.5,
        },
      },
    })

    const out = usageEvents(payload, now)
    assertValidEvents(out)
    expect(out).toHaveLength(1)
    const ev = out[0]!
    expect(ev.t).toBe('account.usage')
    if (ev.t !== 'account.usage') return
    expect(ev.windows).toHaveLength(L.usageWindowsMax)
    expect(ev.windows.map((w) => w.id)).toEqual(['gemini-5h', 'gemini-weekly', '3p-5h', '3p-weekly'])
    expect(ev.windows[0]).toEqual({
      id: 'gemini-5h',
      shortLabel: 'Gem 5h',
      tipLabel: 'Gemini 5-hour',
      spokenLabel: 'Gemini 5-hour',
      priority: 0,
      usedPct: 75,
      resetsAt: Date.parse('2026-11-21T00:08:09Z'),
    })
    expect(ev.windows[2]).toEqual({
      id: '3p-5h',
      shortLabel: '3p 5h',
      tipLabel: 'Partner 5-hour',
      spokenLabel: 'partner 5-hour',
      priority: 2,
      usedPct: 100,
      resetsAt: Date.parse('2026-11-20T20:50:31Z'),
    })
    expect(ev.windows[3]).toEqual({
      id: '3p-weekly',
      shortLabel: '3p 7d',
      tipLabel: 'Partner weekly',
      spokenLabel: 'partner weekly',
      priority: 3,
      usedPct: 50,
      resetsAt: now + 3_600_000,
    })

    // Unknown bucket ID gets clean bounded fallback labels and priority 50; empty/disabled quota returns [].
    const longId = 'custom-future-quota-bucket-with-a-very-long-name-exceeding-twenty-four-chars'
    const unknownOut = usageEvents(
      {
        quota: {
          [longId]: { remaining_fraction: 0.4, reset_in_seconds: 60 },
        },
      },
      now,
    )
    assertValidEvents(unknownOut)
    expect(unknownOut).toHaveLength(1)
    if (unknownOut[0]?.t === 'account.usage') {
      const w = unknownOut[0].windows[0]!
      expect(w.id.length).toBeLessThanOrEqual(64)
      expect(w.shortLabel.length).toBeLessThanOrEqual(24)
      expect(w.tipLabel.length).toBeLessThanOrEqual(64)
      expect(w.spokenLabel.length).toBeLessThanOrEqual(64)
      expect(w.priority).toBe(50)
      expect(w.usedPct).toBeCloseTo(60, 6)
      expect(w.resetsAt).toBe(now + 60_000)
    }

    expect(usageEvents({})).toEqual([])
    expect(usageEvents({ quota: { 'gemini-5h': { remaining_fraction: 0.2, reset_in_seconds: 60, disabled: true } } }, now)).toEqual([])
  })
})
