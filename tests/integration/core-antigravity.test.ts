// Antigravity CLI sessions in core: tools/fake-agent `--as antigravity` as the `agy` on PATH, started with the argv the
// adapter builds, so its session-only `--settings` runs real `kea-helper feed antigravity` processes into core's intake
// (and into the session spool while intake is down). Reconcile reads step transcripts under `<HOME>/.gemini/antigravity-cli/brain/`.

import fs from 'node:fs'
import path from 'node:path'
import { spoolPath } from '@kea/core/src/agents/spool.ts'
import { L, type SessionView } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { antigravityAdapter } from '../../packages/adapters/src/antigravity/adapter.ts'
import { antigravityProjection } from '../../packages/adapters/src/antigravity/launch.ts'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { until } from '../support/holders.ts'
import { repo } from './core-sessions-support.ts'
import { startAgentSessions, type AgentSessionsUnderTest } from './core-agents-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

interface AntigravityUnderTest extends AgentSessionsUnderTest {
  /** (Re)write the `agy` stand-in: a scenario, a quota file, a version. Its home is the session environment's sandboxed HOME. */
  agy(env?: Record<string, string>): void
  start(projectId: string, prompt: string, more?: Record<string, unknown>): Promise<SessionView>
  /** The running agent's argv. */
  argv(id: string): string[]
}

async function antigravity(o: Parameters<typeof startAgentSessions>[0] = {}): Promise<AntigravityUnderTest> {
  const base = await startAgentSessions({
    ...o,
    env: {
      ANTIGRAVITY_CSRF_TOKEN: 'leaked-outer-csrf-token',
      ANTIGRAVITY_AGENT: '1',
      ...o.env,
    },
  })
  cleanup.push(() => base.dispose())
  const s: AntigravityUnderTest = Object.assign(base, {
    agy(env: Record<string, string> = {}) {
      writeAgentShim(base.binDir, 'antigravity', { env: { FAKE_AGENT_HOME: base.userHome, ...env } })
    },
    start: (projectId: string, prompt: string, more: Record<string, unknown> = {}) =>
      base.create(projectId, prompt, { agent: 'antigravity', ...more }),
    argv: (id: string) =>
      base.c.core.terminals
        .sessionRecords(id)
        .filter((x) => x.kind === 'agent' && x.state === 'running')
        .at(-1)!.argv,
  })
  s.agy()
  await s.c.core.agents.detect('antigravity')
  return s
}

function fixture(name = 'demo') {
  const r = repo(name)
  cleanup.push(() => r.dispose())
  return r
}

function parseSettingsArg(argv: readonly string[]): Record<string, unknown> {
  const token = argv.find((a) => a.startsWith('--settings='))
  expect(token).toBeDefined()
  return JSON.parse(token!.slice('--settings='.length)) as Record<string, unknown>
}

function spoolLines(home: string, id: string): string[] {
  try {
    return fs.readFileSync(spoolPath(home, id), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

describe('the antigravity adapter end to end (fake agent, real kea-helper feed)', () => {
  it('I-AGT-14 · full Antigravity CLI lifecycle through real kea-helper feed: detection, launch and dangerous-mode gating, live state transitions, /clear, rate-limit and sign-in conditions, append-only spool replay across core down, transcript reconcile and resume, and single-envelope usage meter', async () => {
    const s = await antigravity()
    const r = fixture()
    const p = await s.project(r.root)

    // 1. Detection finds fake `agy` on PATH, parses version (1.5.13), modes from `--help` stderr, and models from `agy models`.
    const detected = s.c.core.agents.store.get('antigravity')!
    expect(detected).toMatchObject({
      id: 'antigravity',
      displayName: 'Antigravity CLI',
      state: 'ready',
      version: '1.5.13',
      path: path.join(s.binDir, 'agy'),
      loggedIn: null,
      notice: null,
      rightButtonMenu: true,
    })
    expect(antigravityAdapter.detectionTtlMs).toBe(L.agModelsTtlMs)
    expect(antigravityAdapter.trustGated).toBe(false)
    expect(detected.options.permissionModes.map((m) => m.id)).toEqual(['default', 'accept-edits', 'plan', 'auto'])
    expect(detected.options.models[0]).toEqual({
      id: 'default',
      label: "Default (Antigravity's own)",
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      isDefault: true,
    })
    expect(detected.options.models).toEqual(
      expect.arrayContaining([
        { id: 'gemini-4-neon', label: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'], isDefault: false },
        { id: 'gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'], isDefault: false },
        { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], isDefault: false },
        { id: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)', efforts: [], isDefault: false },
        { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', efforts: [], isDefault: false },
      ]),
    )

    const quotaFile = path.join(s.userHome, 'quota.json')
    const resetFiveHourIso = new Date(Date.now() + 5 * 3600_000).toISOString()
    const resetWeeklyIso = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const rateLimitIso = new Date(Date.now() + 2 * 3600_000).toISOString()
    fs.writeFileSync(
      quotaFile,
      JSON.stringify({
        'gemini-5h': { remaining_fraction: 0.25, remaining_amount: 25, reset_time: resetFiveHourIso },
        'gemini-weekly': { remaining_fraction: 0.2, remaining_amount: 20, reset_time: resetWeeklyIso },
        '3p-5h': { remaining_fraction: 0, remaining_amount: 0, reset_time: resetFiveHourIso, disabled: true },
      }),
    )

    const lifecycleScenario = `version: 1
steps:
  - hook: initializing
  - hook: working
  - transcript: { record: user, text: "{{prompt}}" }
  - transcript: { record: running }
  - wait: { answer: "1" }
  - hook: tool_confirmation
  - wait: { answer: "2" }
  - hook: tool_confirmation_clear
  - wait: { answer: "3" }
  - hook: reviewing
  - wait: { answer: "4" }
  - hook: working
  - wait: { answer: "5" }
  - hook: { event: idle, fields: { subagents: [ { name: "secret-sub", role: "coder", status: "completed" } ] } }
  - wait: { answer: "6" }
  - hook: working
  - hook: { event: idle, fields: { subagents: [ { name: "secret-sub", role: "coder", status: "running" } ] } }
  - wait: { answer: "7" }
  - hook: reviewing
  - wait: { answer: "8" }
  - hook: { event: clear, fields: { subagents: [] } }
  - wait: { answer: "9" }
  - hook: { event: working, fields: { conversation_title: "Antigravity lifecycle title" } }
  - wait: { answer: "a" }
  - hook: { event: error, fields: { quota: { "gemini-5h": { remaining_fraction: 0, remaining_amount: 0, reset_time: "${rateLimitIso}" } } } }
  - wait: { answer: "b" }
  - hook: working
  - hook: authenticating
  - wait: { answer: "c" }
  - hook: working
  - transcript: { record: user, text: "spooled turn" }
  - transcript: { record: assistant, text: "spooled reply" }
  - hook: idle
  - wait: { answer: "d" }
  - hook: snapshot
  - wait: { answer: "e" }
  - hook: working
  - hook: idle
  - wait: key
`
    s.agy({ FAKE_AGENT_SCENARIO: s.scenario('lifecycle.yaml', lifecycleScenario), FAKE_AGENT_QUOTA: quotaFile })

    // 2. Launch in a Kea worktree: `permissionMode: 'yolo'` is stripped while `allowDangerousModes` is false.
    const v = await s.start(p.id, 'run the tests', {
      config: { model: 'gemini-4-neon-high', effort: 'high', permissionMode: 'yolo' },
    })
    expect(v.agent).toBe('antigravity')
    const logged = (await s.call<{ text: string }>('sessions.creationLog', { id: v.id })).text.split('\n')[0]!
    expect(logged).toMatch(/ create worktree \S+ on kea\/run-tests \(agent antigravity\)$/)

    const argv = s.argv(v.id)
    expect(argv).toContain('--model=gemini-4-neon')
    expect(argv).toContain('--effort=high')
    expect(argv).toContain('--prompt-interactive=run the tests')
    expect(argv).not.toContain('--dangerously-skip-permissions')
    expect(argv.some((a) => a.startsWith('--mode='))).toBe(false)
    const inlineSettings = parseSettingsArg(argv)
    expect(inlineSettings.clearScrollbackOnResize).toBe(false)
    expect(inlineSettings.trustedWorkspaces).toEqual([v.cwd])
    const statusLine = inlineSettings.statusLine as { type: string; command: string; stack_with_default: boolean }
    expect(statusLine.type).toBe('command')
    expect(statusLine.stack_with_default).toBe(true)
    expect(statusLine.command).toContain(`'feed' 'antigravity' '--session' '${v.id}' '--home' '${s.h.home}' '--project'`)

    // Parent `ANTIGRAVITY_*` variables are stripped from the child process environment.
    expect(s.env.ANTIGRAVITY_CSRF_TOKEN).toBe('leaked-outer-csrf-token')
    const spawnCall = s.c.calls
      .filter((c) => c.m === 'pty.spawn')
      .find((c) => (c.a.spec as { cwd?: string })?.cwd === v.cwd)!
    const spawnedEnv = (spawnCall.a.spec as { env: Record<string, string> }).env
    expect(Object.keys(spawnedEnv).filter((k) => k.startsWith('ANTIGRAVITY_'))).toEqual([])

    // 3. Live feed through real `kea-helper feed` → `core.sock` → `applyHook`.
    // initializing → working: phase working, agentSessionId and transcriptPath recorded in DB.
    const working = await s.until(v.id, 'working on first turn', (x) => x.phase === 'working' && x.agentSessionId !== null)
    const firstConvId = working.agentSessionId!
    expect(firstConvId).toMatch(/^[0-9a-f-]{36}$/)
    const firstTranscript = path.join(
      s.userHome,
      '.gemini',
      'antigravity-cli',
      'brain',
      firstConvId,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    )
    await until(
      'first transcript path stored in DB',
      () => s.c.core.db.get<{ t: string | null }>('SELECT transcript_path AS t FROM sessions WHERE id = ?', v.id)?.t === firstTranscript,
    )
    expect(s.c.core.projects.get(p.id)!.trustConfirmed).toBe(false)

    // Usage meter populated from the first feed snapshot's `quota` buckets (single envelope serves both status and usage).
    const usage = s.c.core.status.usage
    const accountKey = `antigravity:${path.join(s.userHome, '.gemini', 'antigravity-cli')}`
    await until('initial usage reading reported', () => usage.store.get(accountKey) !== undefined)
    expect(usage.store.get(accountKey)).toMatchObject({
      agent: 'antigravity',
      windows: [
        {
          id: 'gemini-5h',
          shortLabel: 'Gem 5h',
          tipLabel: 'Gemini 5-hour',
          spokenLabel: 'Gemini 5-hour',
          priority: 0,
          usedPct: 75,
          resetsAt: Date.parse(resetFiveHourIso),
        },
        {
          id: 'gemini-weekly',
          shortLabel: 'Gem 7d',
          tipLabel: 'Gemini weekly',
          spokenLabel: 'Gemini weekly',
          priority: 1,
          usedPct: 80,
          resetsAt: Date.parse(resetWeeklyIso),
        },
      ],
    })

    // tool_confirmation → blocked (permission: Tool confirmation); tool_confirmation_clear → working.
    s.type(v.id, '1')
    const confirmBlocked = await s.until(v.id, 'blocked on tool confirmation', (x) => x.phase === 'blocked')
    expect(confirmBlocked.attention).toMatchObject([{ kind: 'permission', key: `confirm:${firstConvId}`, source: 'hook' }])
    const ringEvents = () =>
      s.c.core.status
        .machine(v.id)!
        .ring.filter((r) => r.source === 'hook')
        .flatMap((r) => r.events)
    expect(ringEvents()).toContainEqual({
      t: 'attention.permission',
      key: `confirm:${firstConvId}`,
      tool: 'Tool confirmation',
      summary: '',
    })

    s.type(v.id, '2')
    const confirmCleared = await s.until(v.id, 'confirmation cleared back to working', (x) => x.phase === 'working')
    expect(confirmCleared.attention).toEqual([])

    // reviewing → blocked (question: Review requested); leaving reviewing → cleared.
    s.type(v.id, '3')
    const reviewBlocked = await s.until(v.id, 'blocked on review request', (x) => x.phase === 'blocked')
    expect(reviewBlocked.attention).toMatchObject([
      { kind: 'question', key: `review:${firstConvId}`, summary: 'Review requested', source: 'hook' },
    ])

    s.type(v.id, '4')
    const reviewCleared = await s.until(v.id, 'review cleared back to working', (x) => x.phase === 'working')
    expect(reviewCleared.attention).toEqual([])

    // idle with completed subagent → ready with background: false (countWhere ignores completed subagents).
    s.type(v.id, '5')
    const readyNoBg = await s.until(v.id, 'ready with completed subagent', (x) => x.phase === 'ready')
    expect(readyNoBg.background).toBe(false)

    // Second turn with running subagent → idle sets background: true.
    s.type(v.id, '6')
    const readyWithBg = await s.until(v.id, 'ready with running subagent', (x) => x.phase === 'ready' && x.background === true)
    expect(readyWithBg.background).toBe(true)

    // /clear (new conversation_id) while reviewing → open attention cleared, agentSessionId and transcriptPath updated in DB.
    s.type(v.id, '7')
    await s.until(v.id, 'blocked on review before clear', (x) => x.phase === 'blocked')
    s.type(v.id, '8')
    const afterClear = await s.until(
      v.id,
      'cleared to new conversation id',
      (x) => x.agentSessionId !== null && x.agentSessionId !== firstConvId && x.phase === 'ready',
    )
    const secondConvId = afterClear.agentSessionId!
    expect(secondConvId).toMatch(/^[0-9a-f-]{36}$/)
    expect(afterClear.attention).toEqual([])
    const secondTranscript = path.join(
      s.userHome,
      '.gemini',
      'antigravity-cli',
      'brain',
      secondConvId,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    )
    await until(
      'second transcript path stored in DB',
      () =>
        s.c.core.db.get<{ a: string | null; t: string | null }>(
          'SELECT agent_session_id AS a, transcript_path AS t FROM sessions WHERE id = ?',
          v.id,
        )?.t === secondTranscript,
    )

    // conversation_title change → session title updated (titleSource: 'agent').
    s.type(v.id, '9')
    const titled = await s.until(
      v.id,
      'session title updated from feed',
      (x) => x.phase === 'working' && x.title === 'Antigravity lifecycle title',
    )
    expect(titled.titleSource).toBe('agent')

    // error with exhausted matching quota bucket → failed, account condition (rate_limit with parsed resetsAt).
    s.type(v.id, 'a')
    const rateFailed = await s.until(v.id, 'failed on rate limit', (x) => x.phase === 'failed' && x.failureKind === 'rate_limit')
    expect(rateFailed.failureKind).toBe('rate_limit')
    expect(s.c.core.status.conditions.get('antigravity')).toMatchObject({
      agent: 'antigravity',
      kind: 'rate_limit',
      state: 'active',
      resetsAt: Date.parse(rateLimitIso),
      sessionIds: [v.id],
    })

    // authenticating mid-session → failed with auth condition.
    s.type(v.id, 'b')
    const authFailed = await s.until(v.id, 'failed on mid-session auth', (x) => x.phase === 'failed' && x.failureKind === 'auth')
    expect(authFailed.failureKind).toBe('auth')
    expect(s.c.core.status.conditions.get('antigravity')).toMatchObject({
      agent: 'antigravity',
      kind: 'auth',
      state: 'active',
      resetsAt: null,
      sessionIds: [v.id],
    })

    // 4. Spool replay across core down: close intake while fake `agy` runs `working → idle`, verify `spool.ndjson` has
    // append-only envelopes with no `"statusline": true` mark, restart core, verify ordered replay and unread `ready`.
    s.c.core.agents.dispose()
    s.type(v.id, 'c')
    await until('working and idle envelopes spooled', () => spoolLines(s.h.home, v.id).length >= 2)
    const rawSpoolLines = spoolLines(s.h.home, v.id)
    const spooledEnvelopes = rawSpoolLines.map(
      (l) => JSON.parse(l) as { adapter: string; keaSessionId: string; statusline?: boolean; payload: Record<string, unknown> },
    )
    expect(spooledEnvelopes.map((e) => e.payload.agent_state)).toEqual(['working', 'idle'])
    for (const [idx, env] of spooledEnvelopes.entries()) {
      expect(env.adapter).toBe('antigravity')
      expect(env.keaSessionId).toBe(v.id)
      expect(env.statusline).toBeUndefined()
      expect(rawSpoolLines[idx]).not.toContain('"statusline":true')
    }

    await s.relaunch()
    const replayed = await s.until(v.id, 'spooled turn replayed to ready', (x) => x.phase === 'ready')
    expect(replayed.unread).toBe(true)
    expect(s.c.core.agents.stats.spoolApplied).toBeGreaterThanOrEqual(2)
    expect(s.c.core.agents.stats.spoolSkipped).toBe(0)
    expect(fs.existsSync(spoolPath(s.h.home, v.id))).toBe(false)
    const tailJournal = s.c.core.db
      .all<{ source: string; event: string; phase_after: string }>(
        "SELECT source, event, phase_after FROM status_events WHERE session_id = ? AND source = 'hook' ORDER BY id",
        v.id,
      )
      .slice(-2)
    expect(tailJournal.map((j) => `${j.event}→${j.phase_after}`)).toEqual(['turn.started→working', 'turn.finished→ready'])

    // 6. Usage meter (`status.usage`) through single feed envelope: pure-quota snapshot refreshes `status.usage`,
    // and toggling `agents.antigravity.usageLimits` off clears `status.usage` while live status transitions keep working.
    fs.writeFileSync(
      quotaFile,
      JSON.stringify({
        'gemini-5h': { remaining_fraction: 0.35, remaining_amount: 35, reset_time: resetFiveHourIso },
        'gemini-weekly': { remaining_fraction: 0.2, remaining_amount: 20, reset_time: resetWeeklyIso },
      }),
    )
    s.type(v.id, 'd')
    await until(
      'pure-quota snapshot refreshed usage meter',
      () => s.c.core.status.usage.store.get(accountKey)?.windows[0]?.usedPct === 65,
    )
    expect(s.view(v.id)!.phase).toBe('ready')

    await s.c.core.settings.set('agents.antigravity.usageLimits', false)
    expect(s.c.core.status.usage.size).toBe(0)
    fs.writeFileSync(
      quotaFile,
      JSON.stringify({
        'gemini-5h': { remaining_fraction: 0.1, remaining_amount: 10, reset_time: resetFiveHourIso },
      }),
    )
    const envelopesBeforeOffTurn = s.envelopes.filter((e) => e.keaSessionId === v.id).length
    s.type(v.id, 'e')
    await until(
      'working and idle envelopes arrived while usageLimits is off',
      () => s.envelopes.filter((e) => e.keaSessionId === v.id).length >= envelopesBeforeOffTurn + 2,
    )
    await s.until(v.id, 'ready after turn with usageLimits off', (x) => x.phase === 'ready')
    expect(s.c.core.status.usage.size).toBe(0)

    // 5. Reconcile against the recorded step transcript (`DONE` without `tool_calls` → `'finished'`, `model` populated),
    // then stop & resume (`--conversation=<post-clear-id>` and `--settings` re-passed so the live feed works again).
    const reconciled = await antigravityAdapter.reconcile({
      keaSessionId: v.id,
      agentSessionId: secondConvId,
      transcriptPath: secondTranscript,
      cwd: v.cwd,
      launch: { prompt: 'run the tests' },
    })
    expect(reconciled).toEqual({ phase: 'finished', model: 'gemini-4-neon' })

    await s.call('sessions.stop', { id: v.id })
    await s.until(v.id, 'stopped', (x) => x.lifecycle === 'detached')
    s.agy({
      FAKE_AGENT_SCENARIO: s.scenario(
        'resumed.yaml',
        `version: 1
steps:
  - hook: initializing
  - hook: working
  - hook: { event: idle, fields: { conversation_title: "Resumed Antigravity turn" } }
  - wait: key
`,
      ),
    })
    await s.call('sessions.resume', { id: v.id })
    const resumed = await s.until(
      v.id,
      'resumed turn finished',
      (x) => x.lifecycle === 'live' && x.phase === 'ready' && x.title === 'Resumed Antigravity turn',
    )
    expect(resumed.agentSessionId).toBe(secondConvId)
    const resumedArgv = s.argv(v.id)
    expect(resumedArgv[1]).toBe(`--conversation=${secondConvId}`)
    expect(resumedArgv).toContain('--model=gemini-4-neon')
    expect(resumedArgv).toContain('--effort=high')
    const resumedSettings = parseSettingsArg(resumedArgv)
    expect((resumedSettings.statusLine as { command: string }).command).toContain(
      `'feed' 'antigravity' '--session' '${v.id}'`,
    )

    // In-place launch omits `trustedWorkspaces`; enabling `allowDangerousModes` passes `--dangerously-skip-permissions`
    // (with no `--mode` flag) on both launch and resume.
    await s.c.core.settings.set('agents.antigravity.allowDangerousModes', true)
    expect(s.c.core.agents.store.get('antigravity')!.options.permissionModes.map((m) => m.id)).toContain('yolo')

    const inPlaceYolo = await s.start(p.id, 'in the checkout', {
      isolation: 'inplace',
      config: { permissionMode: 'yolo' },
    })
    expect(inPlaceYolo.cwd).toBe(r.root)
    const inPlaceArgv = s.argv(inPlaceYolo.id)
    expect(inPlaceArgv).toContain('--dangerously-skip-permissions')
    expect(inPlaceArgv.some((a) => a.startsWith('--mode='))).toBe(false)
    const inPlaceSettings = parseSettingsArg(inPlaceArgv)
    expect(inPlaceSettings.trustedWorkspaces).toBeUndefined()
    await s.until(inPlaceYolo.id, 'in-place yolo turn ready', (x) => x.phase === 'ready')

    await s.call('sessions.stop', { id: inPlaceYolo.id })
    await s.until(inPlaceYolo.id, 'in-place yolo stopped', (x) => x.lifecycle === 'detached')
    await s.call('sessions.resume', { id: inPlaceYolo.id })
    await s.until(inPlaceYolo.id, 'in-place yolo resumed', (x) => x.lifecycle === 'live')
    const inPlaceResumedArgv = s.argv(inPlaceYolo.id)
    expect(inPlaceResumedArgv).toContain(`--conversation=${s.view(inPlaceYolo.id)!.agentSessionId}`)
    expect(inPlaceResumedArgv).toContain('--dangerously-skip-permissions')
    expect(inPlaceResumedArgv.some((a) => a.startsWith('--mode='))).toBe(false)
  })

  it('I-AGT-15 · degradation, privacy and trust isolation: user active statusLine suppresses feed and trust window, disabled statusLine injects feed, untrusted transcript_path is rejected, repo trustConfirmed stays false, and private fields never enter envelopes', async () => {
    const s = await antigravity()
    const r = fixture()
    const p = await s.project(r.root)
    const userSettingsDir = path.join(s.userHome, '.gemini', 'antigravity-cli')
    const userSettingsFile = path.join(userSettingsDir, 'settings.json')
    fs.mkdirSync(userSettingsDir, { recursive: true })

    // 1. User's own active `statusLine` in `<fakeHome>/.gemini/antigravity-cli/settings.json`:
    // detect() emits soft notice, buildLaunch omits statusLine and sets SpawnSpec.silent = true, core starts no trust
    // window, and falls back to tier-3 heuristics + tier-2 transcript reconcile.
    fs.writeFileSync(
      userSettingsFile,
      JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } }),
    )
    const detOwn = await s.c.core.agents.detect('antigravity')
    expect(detOwn.notice).toBe(
      'Antigravity CLI uses your own status line; Kea will estimate status from terminal activity.',
    )
    expect(s.c.core.agents.store.get('antigravity')!.notice).toBe(detOwn.notice)

    s.agy({
      FAKE_AGENT_SCENARIO: s.scenario(
        'silent.yaml',
        `version: 1
steps:
  - print: "SILENT-READY\\r\\n"
  - wait: key
`,
      ),
    })
    const silentSession = await s.start(p.id, '')
    expect(s.c.core.agents.silentLaunch(silentSession.id)).toBe(true)
    const silentSettings = parseSettingsArg(s.argv(silentSession.id))
    expect(silentSettings.statusLine).toBeUndefined()
    expect(silentSettings.clearScrollbackOnResize).toBe(false)
    expect(silentSettings.trustedWorkspaces).toEqual([silentSession.cwd])
    // No trust timer is armed for a silent launch (and Antigravity is not trust-gated).
    expect(s.c.core.status.resourceCounts.timers).toBe(0)
    expect(s.envelopes.filter((e) => e.keaSessionId === silentSession.id)).toEqual([])
    await s.call('sessions.stop', { id: silentSession.id })
    await s.until(silentSession.id, 'silent session stopped', (x) => x.lifecycle === 'detached')

    // 2. User's disabled `statusLine` (`enabled: false`): Kea injects its `statusLine` and receives exact tier-1 feed events.
    // 3. Untrusted `transcript_path` (`/etc/passwd` and `<fakeHome>/other.jsonl`) rejected by `ownsTranscript`, never stored in DB.
    // 4. Antigravity events never set Claude's `projects.trust_confirmed` repo flag.
    // 5. Privacy check on received and spooled envelopes: `email`, `cwd`, `workspace`, and subagent `name`/`role` never appear.
    fs.writeFileSync(
      userSettingsFile,
      JSON.stringify({ statusLine: { type: 'command', command: 'echo mine', enabled: false } }),
    )
    const detDisabled = await s.c.core.agents.detect('antigravity')
    expect(detDisabled.notice).toBeNull()
    expect(s.c.core.agents.store.get('antigravity')!.notice).toBeNull()

    const systemPasswdPath = path.join('/', 'etc', 'passwd')
    const outsideHomePath = path.join(s.userHome, 'other.jsonl')
    s.agy({
      FAKE_AGENT_SCENARIO: s.scenario(
        'privacy-and-untrusted.yaml',
        `version: 1
fireSessionStart: false
steps:
  - hook: { event: working, fields: { transcript_path: "${systemPasswdPath}", subagents: [ { name: "private-subagent-name", role: "private-subagent-role", status: "running" } ] } }
  - wait: { answer: "1" }
  - hook: { event: clear, fields: { transcript_path: "${outsideHomePath}" } }
  - wait: { answer: "2" }
  - hook: { event: clear }
  - hook: { event: idle, fields: { subagents: [ { name: "private-subagent-name", role: "private-subagent-role", status: "completed" } ] } }
  - wait: key
`,
      ),
    })

    const v = await s.start(p.id, 'verify privacy and transcript ownership')
    expect(s.c.core.agents.silentLaunch(v.id)).toBe(false)
    const injectedSettings = parseSettingsArg(s.argv(v.id))
    expect((injectedSettings.statusLine as { command: string }).command).toContain(
      `'feed' 'antigravity' '--session' '${v.id}'`,
    )

    await s.until(v.id, 'working with first untrusted transcript path', (x) => x.phase === 'working' && x.agentSessionId !== null)
    const firstId = s.view(v.id)!.agentSessionId!
    expect(s.c.core.agents.stats.foreignTranscript).toBe(1)
    expect(
      s.c.core.db.get<{ t: string | null }>('SELECT transcript_path AS t FROM sessions WHERE id = ?', v.id)?.t,
    ).toBeNull()

    // Second untrusted transcript path on `/clear` (`<fakeHome>/other.jsonl`) is also rejected.
    s.type(v.id, '1')
    await s.until(
      v.id,
      'cleared with second untrusted transcript path',
      (x) => x.agentSessionId !== null && x.agentSessionId !== firstId && x.phase === 'ready',
    )
    const secondId = s.view(v.id)!.agentSessionId!
    expect(s.c.core.agents.stats.foreignTranscript).toBe(2)
    expect(
      s.c.core.db.get<{ t: string | null }>('SELECT transcript_path AS t FROM sessions WHERE id = ?', v.id)?.t,
    ).toBeNull()

    // Valid `/clear` under `<fakeHome>/.gemini/antigravity-cli/brain/...` is accepted and stored.
    s.type(v.id, '2')
    const validClear = await s.until(
      v.id,
      'cleared with valid brain transcript path',
      (x) => x.agentSessionId !== null && x.agentSessionId !== secondId,
    )
    const validId = validClear.agentSessionId!
    const validTranscript = path.join(
      s.userHome,
      '.gemini',
      'antigravity-cli',
      'brain',
      validId,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    )
    await until(
      'valid brain transcript path stored in DB',
      () =>
        s.c.core.db.get<{ t: string | null }>('SELECT transcript_path AS t FROM sessions WHERE id = ?', v.id)?.t ===
        validTranscript,
    )
    expect(s.c.core.status.why(v.id).estimated).toBe(false)

    // Antigravity events never confirm Claude Code's per-repository trust flag.
    expect(s.c.core.projects.get(p.id)!.trustConfirmed).toBe(false)

    // Privacy check on every received envelope: only projected top-level keys appear, and `email`, `cwd`, `workspace`,
    // and subagent `name`/`role` never reach core.
    const pr = antigravityProjection()
    const allowedTopKeys = new Set([
      ...pr.keep.map((k) => k.split('.')[0]!),
      ...pr.summarise.map((k) => k.split('.')[0]!),
      ...(pr.countWhere ?? []).map((c) => c.path.split('.')[0]!),
      ...(pr.keepMap ?? []).map((m) => m.path.split('.')[0]!),
    ])
    const sessionEnvelopes = s.envelopes.filter((e) => e.keaSessionId === v.id)
    expect(sessionEnvelopes.length).toBeGreaterThanOrEqual(4)
    for (const env of sessionEnvelopes) {
      expect(env.adapter).toBe('antigravity')
      for (const k of Object.keys(env.payload)) {
        expect(allowedTopKeys, `unexpected top-level payload key ${k}`).toContain(k)
      }
      expect(env.payload).not.toHaveProperty('email')
      expect(env.payload).not.toHaveProperty('cwd')
      expect(env.payload).not.toHaveProperty('workspace')
      expect(typeof env.payload.subagents).toBe('number')
    }
    const serialized = JSON.stringify(sessionEnvelopes)
    expect(serialized).not.toContain('fixture@example.invalid')
    expect(serialized).not.toContain('private-subagent-name')
    expect(serialized).not.toContain('private-subagent-role')
    expect(serialized).not.toContain(v.cwd)
  })
})
