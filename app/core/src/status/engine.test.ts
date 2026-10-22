import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryLogger } from '@kea/kit'
import { badgeCount, KeyedStore, L, type AgentEvent, type EndReason, type Lifecycle, type SessionView, type StatusSource } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatusBatch } from '../platform/db/batch.ts'
import { openDatabase, type KeaDb } from '../platform/db/db.ts'
import { CONTINUE_TEXT, StatusEngine } from './engine.ts'
import type { StatusNotice } from './notices.ts'
import type { ReportsOptions } from './reports.ts'
import { TRUST_KEY } from './table.ts'

const T0 = 1_790_000_000_000
const S = 1_000_000_000n
const log = () => createMemoryLogger({ process: 'core' })

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
  vi.useRealTimers()
})

let n = 0
interface H {
  db: KeaDb
  engine: StatusEngine
  batch: StatusBatch
  sessions: KeyedStore<SessionView>
  home: string
  projectId: string
  notices: StatusNotice[]
  typed: { id: string; data: string }[]
  committed: string[]
  trusted: Set<string>
  /** When each session's agent was launched, on the hook clock (the engine's `launchedAt`). */
  launched: Map<string, bigint>
  add(over?: { agent?: string; prompt?: string; lifecycle?: Lifecycle }): string
  life(id: string, lifecycle: Lifecycle, endReason?: EndReason | null): void
  ingest(id: string, source: StatusSource, ...events: AgentEvent[]): boolean
  /** Advance the hook clock by `s` seconds and return it. */
  tick(s?: number): bigint
  runtime(id: string): { phase: string; attention: string; unread: number; background: number; failure_kind: string | null; status_source: string | null }
  journal(id: string): { event: string; source: string; summary: string | null; phase_after: string }[]
  restart(): void
  dispose(): void
}

function harness(o: { trusted?: boolean; home?: string; db?: KeaDb; trustGated?: (agent: string, sessionId: string) => false | 'repo' | 'launch'; report?: ReportsOptions['agentPty'] extends unknown ? Pick<ReportsOptions, 'agentPty' | 'screen' | 'statusFile' | 'cliVersion' | 'resources' | 'platform'> : never } = {}): H {
  vi.useFakeTimers({ now: T0 })
  const home = o.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kea-status-test-'))
  if (!o.home) cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }))
  const db = o.db ?? openDatabase({ file: ':memory:', log: log() }).db
  if (!o.db) cleanup.push(() => db.abandon())
  const projectId = `01K00000000000000000000P${String(++n).padStart(2, '0')}`
  db.tx(() => db.run('INSERT INTO projects (id, name, root_path, sort_order, created_at, trust_confirmed) VALUES (?, ?, ?, ?, ?, ?)', projectId, 'p', `/repos/p${n}`, n, T0, o.trusted === false ? 0 : 1))
  const trusted = new Set<string>(o.trusted === false ? [] : [projectId])
  const sessions = new KeyedStore<SessionView>('sessions')
  const views = new Map<string, SessionView>()
  let mono = 1n * S
  const h = {} as H
  const notices: StatusNotice[] = []
  const typed: { id: string; data: string }[] = []
  const committed: string[] = []
  const launched = new Map<string, bigint>()
  const build = () => {
    const batch = new StatusBatch(db, { onCommit: (ids) => committed.push(...ids) })
    const engine = new StatusEngine({
      db,
      batch,
      log: log(),
      sessions,
      projects: { get: (id) => ({ trustConfirmed: trusted.has(id) }) },
      projectChanged: (id) => {
        if (db.get<{ t: number }>('SELECT trust_confirmed AS t FROM projects WHERE id = ?', id)?.t === 1) trusted.add(id)
      },
      home,
      version: '0.0.0-test',
      mono: () => mono,
      launchedAt: (id) => launched.get(id) ?? null,
      ...(o.trustGated ? { trustGated: o.trustGated } : {}),
      ...(o.report ? { report: o.report } : {}),
      input: async (id, data) => {
        typed.push({ id, data })
        return true
      },
    })
    engine.notices.event((x) => notices.push(x))
    return { batch, engine }
  }
  let built = build()
  // getters, so `h.engine` is the engine of the moment (restart replaces it)
  Object.defineProperties(h, {
    engine: { get: () => built.engine },
    batch: { get: () => built.batch },
  })
  Object.assign(h, {
    db,
    sessions,
    home,
    projectId,
    notices,
    typed,
    committed,
    trusted,
    launched,
    add(over = {}) {
      const id = `01K00000000000000000000S${String(++n).padStart(2, '0')}`
      db.tx(() =>
        db.run(
          `INSERT INTO sessions (id, project_id, slug, title, title_source, isolation, cwd, agent, launch_config, lifecycle, sort_order, created_at) VALUES (?, ?, ?, 'T', 'auto', 'inplace', '/r', ?, ?, 'creating', 0, ?)`,
          id, projectId, `s${n}`, over.agent ?? 'fake', JSON.stringify({ prompt: over.prompt ?? '' }), T0,
        ),
      )
      const v = { id, projectId, agent: over.agent ?? 'fake', lifecycle: 'creating', endReason: null } as unknown as SessionView
      views.set(id, v)
      sessions.set(id, v)
      if (over.lifecycle && over.lifecycle !== 'creating') h.life(id, over.lifecycle)
      return id
    },
    life(id, lifecycle, endReason = null) {
      db.tx(() => db.run('UPDATE sessions SET lifecycle = ?, end_reason = ? WHERE id = ?', lifecycle, endReason, id))
      const v = { ...views.get(id)!, lifecycle, endReason } as SessionView
      views.set(id, v)
      sessions.set(id, v)
    },
    ingest(id, source, ...events) {
      mono += S
      return built.engine.ingest({ sessionId: id, source, events, mono })
    },
    tick(s = 1) {
      mono += BigInt(s) * S
      return mono
    },
    runtime(id) {
      built.batch.flush()
      return db.get('SELECT phase, attention, unread, background, failure_kind, status_source FROM session_runtime WHERE session_id = ?', id)!
    },
    journal(id) {
      built.batch.flush()
      return db.all('SELECT event, source, summary, phase_after FROM status_events WHERE session_id = ? ORDER BY id', id)
    },
    restart() {
      built.engine.dispose()
      built.batch.dispose()
      built = build()
    },
    dispose() {
      built.engine.dispose()
      built.batch.dispose()
    },
  } satisfies Partial<Omit<H, 'engine' | 'batch'>>)
  cleanup.push(() => h.dispose())
  return h
}

const perm = (key = 'Bash: npm test'): AgentEvent => ({ t: 'attention.permission', key, tool: 'Bash', summary: 'npm test' })

describe('status engine: lifecycle, journal, trust', () => {
  it('U-ST-1 · spawn → starting, written through the batch with its journal row and source; every change journaled with its source; the session store re-reads the row at the commit', () => {
    const h = harness()
    const id = h.add({ lifecycle: 'live' })
    expect(h.engine.state(id)?.phase).toBe('starting')
    expect(h.committed).toEqual([])
    vi.advanceTimersByTime(L.storeTickMs)
    expect(h.committed).toEqual([id])
    h.ingest(id, 'hook', { t: 'session.started', agentSessionId: 'agent-1', transcriptPath: '/t/agent-1.jsonl', source: 'startup' })
    h.ingest(id, 'hook', { t: 'turn.started' })
    h.ingest(id, 'hook', { t: 'tool.started', name: 'Read' })
    h.ingest(id, 'hook', perm())
    h.ingest(id, 'transcript', { t: 'meta', title: 'Fix the tests', model: 'm-1' })
    expect(h.runtime(id)).toMatchObject({ phase: 'blocked', status_source: 'hook' })
    expect(JSON.parse(h.runtime(id).attention)).toEqual([expect.objectContaining({ kind: 'permission', key: 'Bash: npm test', source: 'hook' })])
    expect(h.journal(id)).toEqual([
      { event: 'pty.spawned', source: 'reconcile', summary: null, phase_after: 'starting' },
      { event: 'session.started', source: 'hook', summary: 'startup', phase_after: 'idle' },
      { event: 'turn.started', source: 'hook', summary: null, phase_after: 'working' },
      { event: 'attention.permission', source: 'hook', summary: 'Bash: npm test', phase_after: 'blocked' },
    ])
    expect(h.db.get('SELECT agent_session_id AS a, transcript_path AS t, title, title_source AS ts FROM sessions WHERE id = ?', id)).toEqual({ a: 'agent-1', t: '/t/agent-1.jsonl', title: 'Fix the tests', ts: 'agent' })
    expect(h.db.get('SELECT model FROM session_runtime WHERE session_id = ?', id)).toEqual({ model: 'm-1' })
    // a title the user gave in Kea is never replaced by the agent's
    h.db.tx(() => h.db.run(`UPDATE sessions SET title = 'Mine', title_source = 'user' WHERE id = ?`, id))
    h.ingest(id, 'transcript', { t: 'meta', title: 'Agent title' })
    h.batch.flush()
    expect(h.db.get('SELECT title FROM sessions WHERE id = ?', id)).toEqual({ title: 'Mine' })
    const why = h.engine.why(id)
    expect(why.entries.at(-1)!.text, 'the tool and its summary').toBe('hook · permission asked → blocked (Bash: npm test)')
    expect(why.attention.map((a) => a.key)).toEqual(['Bash: npm test'])
  })

  it('U-ST-20 · a start an adapter repeats to hand over the transcript path it found later (Command Code’s mod, at the end of the first turn) stores the path and is not a line of "Why this status?": no agent session started then; a real start in the same process (/clear) is one', () => {
    const h = harness()
    const id = h.add({ lifecycle: 'live' })
    h.ingest(id, 'hook', { t: 'session.started', agentSessionId: 'agent-1', source: 'startup' })
    h.ingest(id, 'hook', { t: 'turn.started' })
    h.ingest(id, 'hook', { t: 'session.started', agentSessionId: 'agent-1', transcriptPath: '/t/agent-1.jsonl', source: 'startup', repeated: true }, { t: 'turn.finished', backgroundWork: false })
    h.batch.flush()
    expect(h.db.get('SELECT agent_session_id AS a, transcript_path AS t FROM sessions WHERE id = ?', id), 'the path is stored').toEqual({ a: 'agent-1', t: '/t/agent-1.jsonl' })
    expect(h.journal(id).map((j) => `${j.event} → ${j.phase_after}`)).toEqual(['pty.spawned → starting', 'session.started → idle', 'turn.started → working', 'turn.finished → ready'])
    expect(h.engine.why(id).entries.map((e) => e.text)).toEqual(['reconcile · agent started → starting', 'hook · agent session started → idle (startup)', 'hook · turn started → working', 'hook · turn finished → ready'])
    // another conversation in the same process is a start, journaled although the phase does not change
    h.ingest(id, 'hook', { t: 'session.started', agentSessionId: 'agent-2', source: 'clear' })
    expect(h.journal(id).at(-1)).toEqual({ event: 'session.started', source: 'hook', summary: 'clear', phase_after: 'ready' })
  })

  it('U-ST-1 · PTY exit: after a user Stop → journaled as the user’s, no notification; crashed or lost → N3; the attention set emptied and the status gone', () => {
    const h = harness()
    const a = h.add({ lifecycle: 'live' })
    h.ingest(a, 'hook', perm())
    h.life(a, 'detached', 'stopped')
    expect(h.engine.state(a)).toBeUndefined()
    expect(h.runtime(a)).toMatchObject({ phase: 'idle', attention: '[]', status_source: 'user' })
    expect(h.journal(a).at(-1)).toEqual({ event: 'pty.exited', source: 'user', summary: 'stopped', phase_after: 'idle' })
    expect(h.notices.filter((x) => x.k === 'N3')).toEqual([])
    expect(h.notices.at(-1)).toEqual({ k: 'withdraw', sessionId: a })
    for (const reason of ['crashed', 'lost'] as const) {
      const id = h.add({ lifecycle: 'live' })
      h.life(id, 'detached', reason)
      expect(h.notices.at(-1)).toEqual({ k: 'N3', sessionId: id, reason })
      expect(h.runtime(id)).toMatchObject({ unread: 1, status_source: 'reconcile' })
      expect(h.engine.store.get(id)).toBeUndefined()
    }
    // events for a session that is not live change nothing
    expect(h.ingest(a, 'hook', { t: 'turn.started' })).toBe(false)
    // a viewed crashed session is read
    const c = h.add({ lifecycle: 'live' })
    h.life(c, 'detached', 'crashed')
    h.engine.setViewing(c)
    vi.advanceTimersByTime(L.viewedDwellMs)
    expect(h.runtime(c).unread).toBe(0)
  })

  it('U-ST-1 · trust window: no hook L.trustWindowMs after spawn in an untrusted repo → the trust question; the first hook clears it and confirms the repo; a trusted repo never asks', () => {
    const h = harness({ trusted: false })
    const id = h.add({ lifecycle: 'live' })
    vi.advanceTimersByTime(L.trustWindowMs - 1)
    expect(h.engine.state(id)?.phase).toBe('starting')
    vi.advanceTimersByTime(1)
    expect(h.engine.state(id)).toMatchObject({ phase: 'blocked', attention: [expect.objectContaining({ kind: 'question', key: TRUST_KEY })] })
    expect(h.notices).toContainEqual(expect.objectContaining({ k: 'N1', sessionId: id, trust: true }))
    h.ingest(id, 'hook', { t: 'session.started', agentSessionId: 'x', source: 'startup' })
    expect(h.engine.state(id)).toMatchObject({ phase: 'idle', attention: [] })
    expect(h.db.get('SELECT trust_confirmed AS t FROM projects WHERE id = ?', h.projectId)).toEqual({ t: 1 })
    expect(h.trusted.has(h.projectId)).toBe(true)
    // the next session in this repo: no question; a hook before the window ends cancels it too
    const next = h.add({ lifecycle: 'live' })
    vi.advanceTimersByTime(L.trustWindowMs * 2)
    expect(h.engine.state(next)?.phase).toBe('starting')
    const h2 = harness({ trusted: false })
    const early = h2.add({ lifecycle: 'live' })
    h2.ingest(early, 'hook', { t: 'session.started', agentSessionId: 'y', source: 'startup' })
    vi.advanceTimersByTime(L.trustWindowMs * 2)
    expect(h2.engine.state(early)?.phase).toBe('idle')
    // the shell pseudo-agent has no turns and no trust dialog
    const sh = h2.add({ agent: 'shell', lifecycle: 'live' })
    vi.advanceTimersByTime(L.trustWindowMs * 2)
    expect(h2.engine.state(sh)?.phase).toBe('idle')
  })

  it('U-ST-21 · the trust window is asked per launch: a session whose launch can report nothing (Command Code without its mod) gets no trust question however long it is quiet, in a repo whose trust was never confirmed; another session of the same agent, launched with its mod, gets one', () => {
    const silent = new Set<string>()
    const h = harness({ trusted: false, trustGated: (agent, id) => agent !== 'shell' && !silent.has(id) && 'repo' })
    // the launch is known before the session turns live (core's agents service holds it): the engine asks at the spawn
    const id = h.add()
    silent.add(id)
    const timers = h.engine.resourceCounts.timers
    h.life(id, 'live')
    expect(h.engine.resourceCounts.timers - timers, 'no trust window started').toBe(0)
    vi.advanceTimersByTime(L.trustWindowMs * 3)
    expect(h.engine.state(id)).toMatchObject({ phase: 'starting', attention: [] })
    expect(h.notices).toEqual([])
    expect(h.journal(id).map((j) => j.event)).toEqual(['pty.spawned'])
    const quiet = h.engine.resourceCounts.timers
    const told = h.add({ lifecycle: 'live' })
    expect(h.engine.resourceCounts.timers - quiet, 'a trust window for the launch that can report').toBe(1)
    vi.advanceTimersByTime(L.trustWindowMs)
    expect(h.engine.state(told)).toMatchObject({ phase: 'blocked', attention: [expect.objectContaining({ kind: 'question', key: TRUST_KEY })] })
    expect(h.engine.state(id)?.phase).toBe('starting')
  })

  it('U-ST-22 · whose answer the repo’s flag holds: an agent that keeps its trust per repo (Claude Code) is not watched again once an event of it came from the project; an agent that may ask at any launch (Command Code without --trust) is watched at every launch that can report, also in a project another agent’s event confirmed, and its own events say nothing about the project', () => {
    const gate = (agent: string): false | 'repo' | 'launch' => (agent === 'per-launch' ? 'launch' : agent === 'shell' ? false : 'repo')
    // a project a per-repo agent's event confirmed: the per-launch agent has its own question there all the same
    const h = harness({ trustGated: gate })
    const kept = h.add({ lifecycle: 'live' })
    vi.advanceTimersByTime(L.trustWindowMs * 2)
    expect(h.engine.state(kept), 'the per-repo agent is not asked again').toMatchObject({ phase: 'starting', attention: [] })
    const before = h.engine.resourceCounts.timers
    const asks = h.add({ agent: 'per-launch', lifecycle: 'live' })
    expect(h.engine.resourceCounts.timers - before, 'a trust window for the launch that may ask').toBe(1)
    vi.advanceTimersByTime(L.trustWindowMs)
    expect(h.engine.state(asks)).toMatchObject({ phase: 'blocked', attention: [expect.objectContaining({ kind: 'question', key: TRUST_KEY })] })
    expect(h.notices).toContainEqual(expect.objectContaining({ k: 'N1', sessionId: asks, trust: true }))
    // answered in the terminal: its first event clears the question
    h.ingest(asks, 'hook', { t: 'session.started', agentSessionId: 'x', source: 'startup' })
    expect(h.engine.state(asks)).toMatchObject({ phase: 'idle', attention: [] })
    // and the next launch of it there is watched again: only its own first event ends the window
    const again = h.add({ agent: 'per-launch', lifecycle: 'live' })
    vi.advanceTimersByTime(L.trustWindowMs - 1)
    h.ingest(again, 'hook', { t: 'session.started', agentSessionId: 'y', source: 'startup' })
    vi.advanceTimersByTime(L.trustWindowMs * 2)
    expect(h.engine.state(again)).toMatchObject({ phase: 'idle', attention: [] })

    // a project nothing confirmed: the per-launch agent's event does not confirm it for the per-repo agent
    const h2 = harness({ trusted: false, trustGated: gate })
    const first = h2.add({ agent: 'per-launch', lifecycle: 'live' })
    h2.ingest(first, 'hook', { t: 'session.started', agentSessionId: 'z', source: 'startup' })
    expect(h2.db.get('SELECT trust_confirmed AS t FROM projects WHERE id = ?', h2.projectId), 'the flag is the per-repo agent’s').toEqual({ t: 0 })
    const claude = h2.add({ lifecycle: 'live' })
    vi.advanceTimersByTime(L.trustWindowMs)
    expect(h2.engine.state(claude)).toMatchObject({ phase: 'blocked', attention: [expect.objectContaining({ kind: 'question', key: TRUST_KEY })] })
    h2.ingest(claude, 'hook', { t: 'session.started', agentSessionId: 'w', source: 'startup' })
    expect(h2.db.get('SELECT trust_confirmed AS t FROM projects WHERE id = ?', h2.projectId)).toEqual({ t: 1 })

    // a relaunch restores the live sessions while core is still being put together (its launch records come after the
    // engine): nothing is asked about a launch then. The restored per-repo session's first event confirms the repo
    let asked = 0
    const h3 = harness({ trusted: false, trustGated: (agent) => (asked++, gate(agent)) })
    const live = h3.add({ lifecycle: 'live' })
    const before3 = asked
    h3.restart()
    expect(asked - before3, 'the engine asked about no launch while it was built').toBe(0)
    h3.ingest(live, 'hook', { t: 'turn.started' })
    expect(h3.db.get('SELECT trust_confirmed AS t FROM projects WHERE id = ?', h3.projectId)).toEqual({ t: 1 })
  })

  it('U-ST-1 · a prompt passed at creation keeps starting until turn.started; isBeingViewed decides unread at turn end, and viewing a finished turn for the dwell reads it (once: a read one viewed again records nothing)', () => {
    const h = harness()
    const id = h.add({ prompt: 'fix it', lifecycle: 'live' })
    h.ingest(id, 'hook', { t: 'session.started', agentSessionId: 'x', source: 'startup' })
    expect(h.engine.state(id)?.phase).toBe('starting')
    h.ingest(id, 'hook', { t: 'turn.started' })
    h.engine.setViewing(id)
    h.ingest(id, 'hook', { t: 'turn.finished', backgroundWork: false })
    expect(h.engine.state(id)).toMatchObject({ phase: 'ready', unread: false })
    h.engine.setViewing(null)
    h.ingest(id, 'hook', { t: 'turn.started' })
    h.ingest(id, 'hook', { t: 'turn.finished', backgroundWork: false })
    expect(h.engine.state(id)?.unread).toBe(true)
    h.engine.setViewing(id)
    vi.advanceTimersByTime(L.viewedDwellMs - 1)
    expect(h.engine.state(id)?.unread).toBe(true)
    vi.advanceTimersByTime(1)
    expect(h.engine.state(id)?.unread).toBe(false)
    expect(h.notices.at(-1)).toEqual({ k: 'withdraw', sessionId: id })
    // viewed again once read: nothing changes, and nothing is kept (the recent-signal ring holds signals)
    const ring = h.engine.resourceCounts.ringEntries
    h.engine.setViewing(null)
    h.engine.setViewing(id)
    expect(h.engine.resourceCounts.timers, 'no dwell for a session with nothing to read').toBe(0)
    vi.advanceTimersByTime(L.viewedDwellMs)
    expect(h.engine.resourceCounts.ringEntries, 'no input for a view that changes nothing').toBe(ring)
  })
})

describe('the spawn', () => {
  it('U-ST-10 · the status starts at the agent’s launch, not when its session turns live: a hook the agent emitted in between is applied in its place after the spawn, and one stamped before the launch (an earlier agent’s) is dropped', () => {
    const h = harness()
    const id = h.add()
    const earlier = h.tick()
    const launch = h.tick()
    h.launched.set(id, launch)
    // the agent starts and reports its session before core has recorded the launch and turned the session live
    const started = h.tick()
    h.tick()
    h.life(id, 'live')
    expect(h.engine.state(id)!.phase).toBe('starting')
    expect(h.engine.ingest({ sessionId: id, source: 'hook', events: [{ t: 'session.started', agentSessionId: 'a-1', source: 'startup' }], mono: started })).toBe(true)
    expect(h.engine.state(id)!.phase, 'the early SessionStart applied').toBe('idle')
    // an envelope of an earlier agent of the session (stamped before this launch) changes nothing
    h.engine.ingest({ sessionId: id, source: 'hook', events: [{ t: 'turn.started' }], mono: earlier })
    expect(h.engine.state(id)!.phase).toBe('idle')
    // the spawn is the ring's first entry, at the launch; the hook follows it
    expect(h.engine.machine(id)!.ring.map((r) => [r.source, r.events.map((e) => e.t).join(), r.mono])).toEqual([
      ['reconcile', 'pty.spawned', launch],
      ['hook', 'session.started', started],
    ])
  })

  it('U-ST-14 · hooks off, the status file on (disableAllHooks): its first reading — a file just registered, no status yet — ends the trust window, answers the trust question and confirms the repo; then the file alone drives the turn, the prompt (N1) and the finish (N2)', () => {
    const h = harness({ trusted: false })
    const id = h.add({ lifecycle: 'live' })
    vi.advanceTimersByTime(L.trustWindowMs)
    expect(h.engine.state(id)).toMatchObject({ phase: 'blocked', attention: [expect.objectContaining({ key: TRUST_KEY })] })
    // the user answers the trust dialog in the terminal: Claude registers its status file, no hook ever comes
    h.engine.statusFile(id, null, { mono: h.tick() })
    expect(h.engine.state(id)).toMatchObject({ phase: 'idle', attention: [] })
    expect(h.notices).toContainEqual({ k: 'withdraw', sessionId: id, keys: [TRUST_KEY] })
    expect(h.db.get('SELECT trust_confirmed AS t FROM projects WHERE id = ?', h.projectId)).toEqual({ t: 1 })
    h.notices.length = 0
    h.engine.statusFile(id, { status: 'idle' }, { mono: h.tick() })
    h.engine.statusFile(id, { status: 'busy' }, { mono: h.tick() })
    expect(h.engine.state(id)?.phase).toBe('working')
    h.engine.statusFile(id, { status: 'waiting', waitingFor: 'permission', detail: 'permission prompt' }, { mono: h.tick() })
    expect(h.engine.state(id)).toMatchObject({ phase: 'blocked', attention: [expect.objectContaining({ kind: 'permission', source: 'status-file' })] })
    expect(h.notices.filter((x) => x.k === 'N1')).toHaveLength(1)
    h.engine.statusFile(id, { status: 'busy' }, { mono: h.tick() })
    expect(h.engine.state(id)).toMatchObject({ phase: 'working', attention: [] })
    h.engine.statusFile(id, { status: 'idle' }, { mono: h.tick(20) })
    expect(h.engine.state(id)).toMatchObject({ phase: 'ready', unread: true })
    expect(h.notices.filter((x) => x.k === 'N2')).toEqual([expect.objectContaining({ k: 'N2', sessionId: id })])
    expect(h.journal(id).filter((j) => j.source === 'status-file').map((j) => j.phase_after)).toEqual(['idle', 'working', 'blocked', 'working', 'ready'])
    // a reading before the window ends: no trust question at all
    const h2 = harness({ trusted: false })
    const early = h2.add({ lifecycle: 'live' })
    h2.engine.statusFile(early, { status: 'idle' }, { mono: h2.tick() })
    vi.advanceTimersByTime(L.trustWindowMs * 2)
    expect(h2.engine.state(early)?.phase).toBe('idle')
    expect(h2.notices.filter((x) => x.k === 'N1')).toEqual([])
  })

  it('U-ST-15 · a Stop and the status file’s idle finish one turn with one N2, in either order; a turn a Stop hook keeps going (the file goes busy again) withdraws that N2', () => {
    const h = harness()
    const id = h.add({ lifecycle: 'live' })
    h.ingest(id, 'hook', { t: 'session.started', agentSessionId: 'a', source: 'startup' })
    const n2 = () => h.notices.filter((x) => x.k === 'N2').length
    // Stop first, then the file (Claude writes it 10–18 ms after the hook)
    h.engine.statusFile(id, { status: 'busy' }, { mono: h.tick() })
    h.ingest(id, 'hook', { t: 'turn.started' })
    h.ingest(id, 'hook', { t: 'turn.finished', backgroundWork: false })
    h.engine.statusFile(id, { status: 'idle' }, { mono: h.tick() })
    expect(h.engine.state(id)?.phase).toBe('ready')
    expect(n2()).toBe(1)
    // a turn the hooks did not see start: the file's idle finishes it, and a Stop read late (placed before it) adds no second N2
    h.engine.statusFile(id, { status: 'busy' }, { mono: h.tick() })
    const stopAt = h.tick()
    h.engine.statusFile(id, { status: 'idle' }, { mono: h.tick() })
    expect(n2()).toBe(2)
    h.engine.ingest({ sessionId: id, source: 'hook', events: [{ t: 'turn.finished', backgroundWork: false }], mono: stopAt })
    expect(h.engine.state(id)?.phase).toBe('ready')
    expect(n2(), 'the pair posts one N2').toBe(2)
    // a user's Stop hook keeps the turn going: Kea's own Stop finished it (N2), then the file says busy again
    h.ingest(id, 'hook', { t: 'turn.started' })
    h.ingest(id, 'hook', { t: 'turn.finished', backgroundWork: false })
    expect(n2()).toBe(3)
    h.notices.length = 0
    h.engine.statusFile(id, { status: 'busy' }, { mono: h.tick() })
    expect(h.engine.state(id)).toMatchObject({ phase: 'working', unread: false })
    expect(h.notices).toContainEqual({ k: 'withdraw', sessionId: id })
  })

  it('U-ST-16 · one prompt, one item, one N1, whichever is read first: the status file’s waiting or the hook that names the prompt — also when the hook, emitted first, is read late and placed before the file’s reading', () => {
    const h = harness()
    const id = h.add({ lifecycle: 'live' })
    h.ingest(id, 'hook', { t: 'session.started', agentSessionId: 'a', source: 'startup' })
    h.ingest(id, 'hook', { t: 'turn.started' })
    const n1 = () => h.notices.filter((x) => x.k === 'N1' && x.sessionId === id)
    // the hook first, then the file: the file adds nothing
    h.ingest(id, 'hook', perm())
    h.engine.statusFile(id, { status: 'waiting', waitingFor: 'permission', detail: 'permission prompt' }, { mono: h.tick() })
    expect(h.engine.state(id)!.attention.map((a) => a.key)).toEqual(['Bash: npm test'])
    expect(n1()).toHaveLength(1)
    h.ingest(id, 'hook', { t: 'attention.cleared', key: 'Bash: npm test' })
    // the file first, then the hook in order: the hook's item takes over the file's notification
    h.engine.statusFile(id, { status: 'waiting', waitingFor: 'permission', detail: 'permission prompt' }, { mono: h.tick() })
    h.ingest(id, 'hook', perm('Bash: npm run lint'))
    expect(h.engine.state(id)!.attention.map((a) => a.key)).toEqual(['Bash: npm run lint'])
    expect(n1()).toHaveLength(2)
    expect(h.notices).toContainEqual({ k: 'rekey', sessionId: id, from: 'status-file', to: 'Bash: npm run lint' })
    h.ingest(id, 'hook', { t: 'attention.cleared', key: 'Bash: npm run lint' })
    // the hook emitted first but read after the file (spooled): placed before it, still one N1, its key the hook's
    const emitted = h.tick()
    h.engine.statusFile(id, { status: 'waiting', waitingFor: 'permission', detail: 'permission prompt' }, { mono: h.tick() })
    expect(n1()).toHaveLength(3)
    h.notices.length = 0
    h.engine.ingest({ sessionId: id, source: 'hook', events: [perm('Bash: make')], mono: emitted })
    expect(h.engine.state(id)!.attention.map((a) => a.key)).toEqual(['Bash: make'])
    expect(n1(), 'no second N1 for the same prompt').toEqual([])
    expect(h.notices).toEqual([{ k: 'rekey', sessionId: id, from: 'status-file', to: 'Bash: make' }])
  })
})

describe('restart', () => {
  it('U-ST-5 · a restored live status is shown at once, unconfirmed; spooled and unconfirmed changes post nothing; the first live signal, a reconcile or L.unconfirmedStatusMs confirms it', () => {
    const h = harness()
    const a = h.add({ lifecycle: 'live' })
    const b = h.add({ lifecycle: 'live' })
    const c = h.add({ lifecycle: 'live' })
    for (const id of [a, b, c]) {
      h.ingest(id, 'hook', { t: 'turn.started' })
      h.ingest(id, 'hook', perm())
    }
    h.batch.flush()
    h.restart()
    h.notices.length = 0
    for (const id of [a, b, c]) {
      expect(h.engine.state(id)).toMatchObject({ phase: 'blocked', attention: [expect.objectContaining({ key: 'Bash: npm test' })] })
      expect(h.engine.store.get(id)).toMatchObject({ unconfirmed: true, source: 'hook' })
    }
    // a: spooled events drained (Kea was not running): applied in file order, no notification
    h.engine.ingest({ sessionId: a, source: 'hook', events: [{ t: 'attention.cleared', key: 'Bash: npm test' }], mono: h.tick(), spooled: true })
    h.engine.ingest({ sessionId: a, source: 'hook', events: [{ t: 'turn.finished', backgroundWork: false }], mono: h.tick(), spooled: true })
    h.engine.ingest({ sessionId: a, source: 'hook', events: [{ t: 'turn.started' }, { t: 'turn.failed', error: 'boom', kind: 'overloaded' }], mono: h.tick(), spooled: true })
    expect(h.engine.state(a)?.phase).toBe('failed')
    expect(h.notices.filter((x) => x.k !== 'withdraw')).toEqual([])
    expect(h.engine.isUnconfirmed(a)).toBe(true)
    // b: a reconcile disagrees: it wins, is journaled, confirms, and notifies nothing
    h.engine.reconcile(b, { phase: 'ready', unread: true })
    expect(h.engine.state(b)?.phase).toBe('ready')
    expect(h.engine.isUnconfirmed(b)).toBe(false)
    expect(h.journal(b).at(-1)).toMatchObject({ event: 'reconcile', source: 'reconcile', phase_after: 'ready' })
    expect(h.notices.filter((x) => x.k !== 'withdraw')).toEqual([])
    // c: the first live signal confirms; what it brings is news and may notify
    h.ingest(c, 'hook', { t: 'turn.finished', backgroundWork: false })
    expect(h.engine.isUnconfirmed(c)).toBe(false)
    expect(h.notices).toContainEqual(expect.objectContaining({ k: 'N2', sessionId: c }))
    // a: no live signal, no reconcile: confirmed as it is after L.unconfirmedStatusMs
    vi.advanceTimersByTime(L.unconfirmedStatusMs)
    expect(h.engine.store.get(a)).toMatchObject({ unconfirmed: false })
  })

  it('U-ST-12 · a reconcile that completes with nothing to say confirms the restored status as it is: same phase and attention, nothing journaled, nothing posted, no timer left', () => {
    const h = harness()
    const id = h.add({ lifecycle: 'live' })
    h.ingest(id, 'hook', { t: 'turn.started' })
    h.ingest(id, 'hook', perm())
    h.batch.flush()
    h.restart()
    h.notices.length = 0
    const journaled = h.journal(id).length
    const timers = h.engine.resourceCounts.timers
    expect(h.engine.isUnconfirmed(id)).toBe(true)
    expect(h.engine.reconcile(id, null)).toBe(true)
    expect(h.engine.isUnconfirmed(id)).toBe(false)
    expect(h.engine.store.get(id)).toMatchObject({ unconfirmed: false })
    expect(h.engine.state(id)).toMatchObject({ phase: 'blocked', attention: [expect.objectContaining({ key: 'Bash: npm test' })] })
    h.batch.flush()
    expect(h.journal(id).length).toBe(journaled)
    expect(h.notices.filter((x) => x.k !== 'withdraw')).toEqual([])
    expect(h.engine.resourceCounts.timers, 'the unconfirmed-status timer cleared').toBe(timers - 1)
    expect(h.engine.reconcile('01NOSUCHSESSION0000000000Z', null)).toBe(false)
  })
})

describe('account conditions', () => {
  it('U-ST-8 · 10 sessions hit the usage limit: one condition, N4 updated in place, badge 1, none in N3; overloaded stays per session; resetsAt → reset + N5; Continue all types continue + Enter into exactly the held sessions; survives a restart via kv', async () => {
    const h = harness()
    const resetsAt = T0 + 30 * 60_000
    const ids = Array.from({ length: 10 }, () => h.add({ lifecycle: 'live' }))
    const other = h.add({ lifecycle: 'live' })
    const otherAgent = h.add({ agent: 'other', lifecycle: 'live' })
    for (const [i, id] of ids.entries()) {
      vi.advanceTimersByTime(10_000) // ten failures within two minutes
      h.ingest(id, 'hook', { t: 'turn.started' })
      h.ingest(id, 'hook', { t: 'turn.failed', error: 'limit', kind: 'rate_limit', ...(i === 3 ? { resetsAt } : {}) })
    }
    h.ingest(other, 'hook', { t: 'turn.started' })
    h.ingest(other, 'hook', { t: 'turn.failed', error: 'overloaded', kind: 'overloaded' })
    const cond = h.engine.conditions.get('fake')!
    expect(cond).toMatchObject({ agent: 'fake', kind: 'rate_limit', state: 'active', resetsAt, sessionIds: ids })
    expect(h.engine.conditions.store.size).toBe(1)
    const n4 = h.notices.filter((x) => x.k === 'N4')
    expect(n4.length).toBe(10) // one notification, updated in place as each joins (the policy replaces it)
    expect(n4.at(-1)).toMatchObject({ condition: { sessionIds: ids } })
    expect(h.notices.filter((x) => x.k === 'N3').map((x) => (x as { sessionId: string }).sessionId)).toEqual([other])
    for (const id of ids) expect(h.runtime(id)).toMatchObject({ phase: 'failed', failure_kind: 'rate_limit' })
    const views = [...ids, other].map((id) => ({ id, lifecycle: 'live' as const, endReason: null, phase: h.engine.state(id)!.phase, attention: [], unread: true, failureKind: h.engine.state(id)!.failureKind, lastActivityAt: T0 }))
    expect(badgeCount(views, h.engine.conditions.store.values())).toBe(2) // the condition once, the overloaded session once
    // restart: the condition comes back from kv; Continue all is not offered before the reset
    h.restart()
    expect(h.engine.conditions.get('fake')).toEqual(cond)
    await expect(h.engine.continueAll('fake')).rejects.toThrow(/reset/)
    // the clock reaches the reset (checked at least every L.conditionCheckMs)
    vi.advanceTimersByTime(resetsAt - Date.now())
    expect(h.engine.conditions.get('fake')).toMatchObject({ state: 'reset' })
    expect(h.notices.filter((x) => x.k === 'N5').length).toBe(1)
    // one session moved on by itself (a new turn): it leaves the condition
    h.ingest(ids[0]!, 'hook', { t: 'turn.started' })
    const sent = await h.engine.continueAll('fake')
    expect(sent).toEqual(ids.slice(1))
    expect(h.typed).toEqual(ids.slice(1).map((id) => ({ id, data: CONTINUE_TEXT })))
    expect(h.engine.conditions.get('fake')).toBeUndefined()
    expect(h.db.get(`SELECT value FROM kv WHERE key = 'condition:fake'`)).toBeUndefined()
    // another agent's turn does not clear it; this agent's first turn.finished does
    h.ingest(ids[1]!, 'hook', { t: 'turn.started' })
    h.ingest(ids[1]!, 'hook', { t: 'turn.failed', error: 'signed out', kind: 'auth' })
    expect(h.engine.conditions.get('fake')).toMatchObject({ kind: 'auth', state: 'active' })
    h.ingest(otherAgent, 'hook', { t: 'turn.started' })
    h.ingest(otherAgent, 'hook', { t: 'turn.finished', backgroundWork: false })
    expect(h.engine.conditions.get('fake')).toBeDefined()
    h.ingest(other, 'hook', { t: 'turn.started' })
    h.ingest(other, 'hook', { t: 'turn.finished', backgroundWork: false })
    expect(h.engine.conditions.get('fake')).toBeUndefined()
  })

  it('U-ST-8 · a usage limit that reset while Kea was away: restored, moved to reset and N5 posted once after start, to a listener that subscribed once the engine was built', async () => {
    const h = harness()
    const resetsAt = T0 + 60_000
    const ids = [h.add({ lifecycle: 'live' }), h.add({ lifecycle: 'live' })]
    for (const id of ids) {
      h.ingest(id, 'hook', { t: 'turn.started' })
      h.ingest(id, 'hook', { t: 'turn.failed', error: 'limit', kind: 'rate_limit', resetsAt })
    }
    h.batch.flush()
    h.engine.dispose() // Kea quits; the clock passes the reset while it is away
    vi.setSystemTime(resetsAt + 5 * 60_000)
    h.notices.length = 0
    h.restart()
    expect(h.engine.conditions.get('fake')).toMatchObject({ resetsAt, sessionIds: ids })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.engine.conditions.get('fake')).toMatchObject({ state: 'reset', sessionIds: ids })
    expect(h.notices.filter((x) => x.k === 'N5').map((x) => (x as { condition: { sessionIds: string[] } }).condition.sessionIds)).toEqual([ids])
    await vi.advanceTimersByTimeAsync(L.conditionCheckMs * 2)
    expect(h.notices.filter((x) => x.k === 'N5').length).toBe(1)
  })

  it('U-ST-17 · a usage limit whose sessions all moved on before its reset time ends at the reset with no N5 (nothing is left to continue)', () => {
    const h = harness()
    const resetsAt = T0 + 60_000
    const ids = [h.add({ lifecycle: 'live' }), h.add({ lifecycle: 'live' })]
    for (const id of ids) {
      h.ingest(id, 'hook', { t: 'turn.started' })
      h.ingest(id, 'hook', { t: 'turn.failed', error: 'limit', kind: 'rate_limit', resetsAt })
    }
    // each starts a new turn (the user typed again): they leave the condition, which stays active until its reset
    for (const id of ids) h.ingest(id, 'hook', { t: 'turn.started' })
    expect(h.engine.conditions.get('fake')).toMatchObject({ state: 'active', sessionIds: [] })
    h.notices.length = 0
    vi.advanceTimersByTime(resetsAt - Date.now())
    expect(h.engine.conditions.get('fake')).toBeUndefined()
    expect(h.notices.filter((x) => x.k === 'N5')).toEqual([])
  })
})

/** A holder ring file holding `data` (header: "KEAR", version, capacity, earliest and latest seq). */
function ringFile(data: Buffer, capacity: number): Buffer {
  const out = Buffer.alloc(L.ringHeaderBytes + capacity)
  out.write('KEAR', 0, 'latin1')
  out.writeUInt16LE(1, 4)
  out.writeBigUInt64LE(BigInt(capacity), 8)
  const earliest = Math.max(0, data.length - capacity)
  out.writeBigUInt64LE(BigInt(earliest), 16)
  out.writeBigUInt64LE(BigInt(data.length), 24)
  for (let s = earliest; s < data.length; s++) out[L.ringHeaderBytes + (s % capacity)] = data[s]!
  return out
}

describe('reporting a wrong status', () => {
  it('U-ST-9 · the bundle has every part, each part within its cap, and building it changes nothing about the session; a screen that does not come in time is listed missing', async () => {
    const PTY = 'abcdefghij'.slice(0, L.ptyIdLength)
    let screenFn: (pty: string) => Promise<string | null> = async () => 'the screen'
    const statusFile = path.join(os.tmpdir(), `kea-status-file-${process.pid}-${++n}.json`)
    cleanup.push(() => fs.rmSync(statusFile, { force: true }))
    fs.writeFileSync(statusFile, JSON.stringify({ status: 'waiting' }))
    const h = harness({ report: { agentPty: () => PTY, screen: (p) => screenFn(p), statusFile: () => statusFile, cliVersion: () => '9.9.9', resources: () => ({ 'core.status': 1 }) } })
    const id = h.add({ lifecycle: 'live' })
    const transcript = path.join(h.home, 'transcript.jsonl')
    fs.writeFileSync(transcript, Array.from({ length: 4000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(40) })).join('\n'))
    h.ingest(id, 'hook', { t: 'session.started', agentSessionId: 'a', transcriptPath: transcript, source: 'startup' })
    for (let i = 0; i < L.signalRingEntries + 30; i++) h.ingest(id, 'hook', { t: 'tool.started', name: `T${i}` }, { t: 'turn.started' })
    h.ingest(id, 'hook', perm())
    const ringData = Buffer.alloc(L.reportRingBytes * 2, 'r')
    ringData.write('THE-END', ringData.length - 7)
    fs.mkdirSync(path.join(h.home, 'sessions', id), { recursive: true })
    fs.writeFileSync(path.join(h.home, 'sessions', id, `${PTY}.ring`), ringFile(ringData, L.reportRingBytes * 3))
    h.batch.flush()
    const before = { state: structuredClone(h.engine.state(id)), runtime: h.runtime(id), journal: h.journal(id).length, ring: h.engine.machine(id)!.ring.length }

    const { dir, ms } = await h.engine.report(id, 'working', 'it asked me nothing')
    expect(ms).toBeLessThan(L.reportCaptureMs)
    expect(path.dirname(dir)).toBe(path.join(h.home, 'reports'))
    expect(path.basename(dir)).toMatch(new RegExp(`^\\d{8}-\\d{6}-\\d{3}-${id}$`))
    expect(fs.readdirSync(dir).sort()).toEqual(['report.json', 'resources.json', 'ring.bin', 'screen.txt', 'signals.ndjson', 'status-events.ndjson', 'status-file.json', 'transcript.jsonl'])
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'))
    expect(r).toMatchObject({ format: 1, kea: { version: '0.0.0-test' }, sessionId: id, agent: 'fake', cliVersion: '9.9.9', lifecycle: 'live', phase: 'blocked', background: false, unread: false, expected: 'working', note: 'it asked me nothing', unconfirmed: false, missing: [] })
    expect(r.attention).toEqual([expect.objectContaining({ key: 'Bash: npm test' })])
    expect(typeof r.wall).toBe('number')
    expect(r.mono).toMatch(/^\d+$/)
    expect(r.start).toMatchObject({ prompt: false, noTurns: false })
    const lines = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)
    expect(lines('status-events.ndjson').length).toBe(Math.min(L.reportEvents, before.journal))
    expect(lines('signals.ndjson').length).toBe(L.signalRingEntries)
    const seqs = lines('signals.ndjson').map((l) => JSON.parse(l).seq as number)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    const t = fs.readFileSync(path.join(dir, 'transcript.jsonl'))
    expect(t.length).toBe(L.reportTranscriptBytes)
    expect(fs.readFileSync(transcript).subarray(-L.reportTranscriptBytes).equals(t)).toBe(true)
    const ring = fs.readFileSync(path.join(dir, 'ring.bin'))
    expect(ring.length).toBe(L.reportRingBytes)
    expect(ring.subarray(-7).toString()).toBe('THE-END')
    expect(fs.readFileSync(path.join(dir, 'screen.txt'), 'utf8')).toBe('the screen')
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'resources.json'), 'utf8'))).toEqual({ 'core.status': 1 })
    // nothing about the session changed
    expect(h.engine.state(id)).toEqual(before.state)
    expect(h.runtime(id)).toEqual(before.runtime)
    expect(h.journal(id).length).toBe(before.journal)
    expect(h.engine.machine(id)!.ring.length).toBe(before.ring)
    expect(h.engine.reports.counts()).toMatchObject({ total: 1, working: 1 })

    // ptyhost does not answer in time: the bundle is written without the screen, which it names
    screenFn = () => new Promise(() => {})
    const late = h.engine.report(id, 'needsMe')
    await vi.advanceTimersByTimeAsync(L.reportCaptureMs)
    const second = await late
    expect(JSON.parse(fs.readFileSync(path.join(second.dir, 'report.json'), 'utf8')).missing).toEqual(['screen (late)'])
    expect(h.engine.reports.counts()).toMatchObject({ total: 2, working: 1, needsMe: 1 })
  })

  it('U-ST-23 · report.json holds the platform report as the caller gives it (scrubbed: core passes its Copy Diagnostics scrub), and names it missing while main has sent none', async () => {
    const report = {
      system: 'linux' as const,
      version: 'Linux 6.8.0',
      arch: 'arm64',
      lines: [{ id: 'logout' as const, label: 'After you log out', value: 'sessions end at your last logout, as on macOS', fix: 'Run `loginctl enable-linger` to keep sessions running after you log out' }],
    }
    let sent: typeof report | null = null
    const h = harness({ report: { platform: () => sent } })
    const id = h.add({ lifecycle: 'live' })
    h.ingest(id, 'hook', perm())
    const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) as { platform: unknown; missing: string[] }

    const before = read((await h.engine.report(id, 'working')).dir)
    expect(before.platform).toBeNull()
    expect(before.missing).toContain('platform')

    sent = report
    const after = read((await h.engine.report(id, 'needsMe')).dir)
    expect(after.platform).toEqual(report)
    expect(after.missing).not.toContain('platform')
  })
})
