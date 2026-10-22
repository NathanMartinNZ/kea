import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { L, type AgentEvent } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { projectPayload } from '../kit/projection.ts'
import { projection } from './launch.ts'
import { ClaudeSignals, failureKind, NOTIFICATION_KEYS, normalise } from './mapping.ts'

const DIR = fileURLToPath(new URL('../../../../fixtures/hooks/claude/2.1.296/', import.meta.url))
/** A recorded payload as core receives it: projected by the helper's rules. */
const fx = (name: string): Record<string, unknown> => projectPayload(JSON.parse(fs.readFileSync(`${DIR}${name}.json`, 'utf8')), projection())
const signals = () => new ClaudeSignals('febfcaa0-7279-439f-9091-ed587cf5f54d')

describe('claude mapping', () => {
  it('U-AGT-3 · normalise: every recorded payload → its events, keys by tool + summary, subagents flagged, permission mode and model as meta', () => {
    const meta = { t: 'meta', permissionMode: 'manual', effort: 'medium' } as const
    const cases: [string, AgentEvent[]][] = [
      [
        'SessionStart',
        [
          { t: 'session.started', agentSessionId: 'febfcaa0-7279-439f-9091-ed587cf5f54d', transcriptPath: '/tmp/kea-world/home/.claude/projects/-private-tmp-kea-fixture-xxxxxx-demo/febfcaa0-7279-439f-9091-ed587cf5f54d.jsonl', source: 'startup' },
          { t: 'meta', model: 'claude-opus-5-5' },
        ],
      ],
      ['SessionStart.compact', [{ t: 'session.started', agentSessionId: 'febfcaa0-7279-439f-9091-ed587cf5f54d', transcriptPath: expect.stringMatching(/\.jsonl$/) as unknown as string, source: 'compact' }, { t: 'meta', model: 'claude-opus-5-5' }]],
      // no effort on UserPromptSubmit; `permission_mode: "default"` is Manual
      ['UserPromptSubmit', [{ t: 'turn.started' }, { t: 'meta', permissionMode: 'manual' }]],
      ['UserPromptSubmit.task-notification', [{ t: 'turn.started', trigger: 'background' }, { t: 'meta', permissionMode: 'manual' }]],
      ['PreToolUse', [{ t: 'tool.started', name: 'Bash', summary: 'touch build.log' }, meta]],
      ['PermissionRequest', [{ t: 'attention.permission', key: 'Bash: touch build.log', tool: 'Bash', summary: 'touch build.log' }, meta]],
      ['PostToolUse', [{ t: 'tool.finished', name: 'Bash', summary: 'touch build.log', ok: true }, { t: 'attention.cleared', key: 'Bash: touch build.log' }, meta]],
      [
        'PostToolUseFailure',
        [
          { t: 'tool.finished', name: 'Read', summary: '/private/tmp/kea-fixture-xxxxxx/demo/missing.txt', ok: false },
          { t: 'attention.cleared', key: 'Read: /private/tmp/kea-fixture-xxxxxx/demo/missing.txt' },
          meta,
        ],
      ],
      // AskUserQuestion: a question (its PreToolUse and, on 2.1.296, its PermissionRequest), cleared by its PostToolUse
      ['PreToolUse.AskUserQuestion', [{ t: 'tool.started', name: 'AskUserQuestion', summary: 'Which option do you prefer?' }, { t: 'attention.question', key: 'AskUserQuestion: Which option do you prefer?', summary: 'Which option do you prefer?' }, meta]],
      ['PermissionRequest.AskUserQuestion', [{ t: 'attention.question', key: 'AskUserQuestion: Which option do you prefer?', summary: 'Which option do you prefer?' }, meta]],
      ['PostToolUse.AskUserQuestion', [{ t: 'tool.finished', name: 'AskUserQuestion', summary: 'Which option do you prefer?', ok: true }, { t: 'attention.cleared', key: 'AskUserQuestion: Which option do you prefer?' }, meta]],
      // subagent tool events are flagged; their PostToolUse clears only its own key
      ['PreToolUse.subagent', [{ t: 'tool.started', name: 'Read', summary: '/private/tmp/kea-fixture-xxxxxx/demo/README.md', subagent: true }, meta]],
      ['PostToolUse.subagent', [{ t: 'tool.finished', name: 'Read', summary: '/private/tmp/kea-fixture-xxxxxx/demo/README.md', ok: true, subagent: true }, { t: 'attention.cleared', key: 'Read: /private/tmp/kea-fixture-xxxxxx/demo/README.md' }, meta]],
      ['Stop', [{ t: 'turn.finished', lastMessage: expect.stringMatching(/^DONE-ONE/) as unknown as string, backgroundWork: false }, meta]],
      ['SubagentStop', [meta]],
      ['Notification.permission_prompt', [{ t: 'attention.permission', key: NOTIFICATION_KEYS.permission, summary: 'Claude needs your permission' }]],
      ['PreCompact', [{ t: 'compacting', active: true }]],
      ['PostCompact', [{ t: 'compacting', active: false }]],
      ['SessionEnd', [{ t: 'session.ended', reason: 'prompt_input_exit' }]],
      ['MessageDisplay', []],
      ['PostToolBatch', []],
    ]
    for (const [name, want] of cases) expect([name, normalise(fx(name))]).toEqual([name, want])
    // every recorded payload is covered by the cases
    const recorded = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length))
    expect(recorded.sort()).toEqual(cases.map((c) => c[0]).sort())

    // Stop with background tasks or crons → background work (the projection counts the arrays)
    const stop = fx('Stop')
    expect(normalise({ ...stop, background_tasks: 1 })[0]).toMatchObject({ t: 'turn.finished', backgroundWork: true })
    expect(normalise({ ...stop, session_crons: 2 })[0]).toMatchObject({ t: 'turn.finished', backgroundWork: true })
    // a Stop from inside a subagent never finishes the turn
    expect(normalise({ ...stop, agent_id: 'a1' }).filter((e) => e.t === 'turn.finished')).toEqual([])
    // SessionEnd(reason=clear) is journaled only: just session.ended
    expect(normalise({ hook_event_name: 'SessionEnd', reason: 'clear' })).toEqual([{ t: 'session.ended', reason: 'clear' }])
    // /clear: a new id from SessionStart(source=clear); a custom session name → the user's title
    expect(normalise({ hook_event_name: 'SessionStart', session_id: 'new-id', source: 'clear', session_title: 'My name' })).toEqual([
      { t: 'session.started', agentSessionId: 'new-id', source: 'clear' },
      { t: 'meta', title: 'My name', titleSource: 'user' },
    ])
    // a mode other than default is reported as is; a payload without permission_mode carries no mode (the last stands)
    expect(normalise({ hook_event_name: 'UserPromptSubmit', permission_mode: 'acceptEdits' })[1]).toEqual({ t: 'meta', permissionMode: 'acceptEdits' })
    expect(normalise({ hook_event_name: 'UserPromptSubmit' })).toEqual([{ t: 'turn.started' }])
    // a PostToolUse clears only its own key
    const other = normalise({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(other.find((e) => e.t === 'attention.cleared')).toEqual({ t: 'attention.cleared', key: 'Bash: ls' })
    // elicitation → question; idle and needs-input notifications are ignored; unknown events give nothing
    expect(normalise({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: 'Pick one' })).toEqual([{ t: 'attention.question', key: NOTIFICATION_KEYS.question, summary: 'Pick one' }])
    expect(normalise({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'x' })).toEqual([])
    expect(normalise({ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'x' })).toEqual([])
    expect(normalise({ hook_event_name: 'SomethingNew' })).toEqual([])
    expect(normalise({})).toEqual([])
  })

  it('U-AGT-3 · a late Notification(permission_prompt) within L.permissionDedupeMs of a PermissionRequest is dropped; after it, or alone, it raises the item', () => {
    const s = signals()
    expect(s.hook({ payload: fx('PermissionRequest'), monoMs: 1000 })[0]).toMatchObject({ t: 'attention.permission' })
    expect(s.hook({ payload: fx('Notification.permission_prompt'), monoMs: 1000 + L.permissionDedupeMs - 1 })).toEqual([])
    expect(s.hook({ payload: fx('Notification.permission_prompt'), monoMs: 1000 + L.permissionDedupeMs })[0]).toMatchObject({ t: 'attention.permission', key: NOTIFICATION_KEYS.permission })
    expect(signals().hook({ payload: fx('Notification.permission_prompt'), monoMs: 5 })).toHaveLength(1)
    // unknown events are counted
    const t = signals()
    t.hook({ payload: fx('MessageDisplay'), monoMs: 1 })
    expect(t.ignored.unknownEvent).toBe(1)
  })

  it('U-AGT-3 · session ids: the launch’s, then each SessionStart’s (/clear, resume) become the conversation later resumes target', () => {
    const s = signals()
    expect([...s.sessionIds()]).toEqual(['febfcaa0-7279-439f-9091-ed587cf5f54d'])
    s.hook({ payload: { hook_event_name: 'SessionStart', session_id: 'after-clear', source: 'clear' }, monoMs: 1 })
    expect(s.agentSessionId).toBe('after-clear')
    expect([...s.sessionIds()].sort()).toEqual(['after-clear', 'febfcaa0-7279-439f-9091-ed587cf5f54d'])
    s.hook({ payload: { hook_event_name: 'SessionStart', session_id: 'second-clear', source: 'clear' }, monoMs: 2 })
    expect([...s.sessionIds()].sort()).toEqual(['after-clear', 'febfcaa0-7279-439f-9091-ed587cf5f54d', 'second-clear'])
  })

  it('U-AGT-14 · failure kinds: every known StopFailure error → its kind, anything else other; no resetsAt until a real usage-limit text is captured', () => {
    expect(failureKind('rate_limit')).toBe('rate_limit')
    expect(failureKind('overloaded')).toBe('overloaded')
    expect(failureKind('authentication_failed')).toBe('auth')
    expect(failureKind('billing_error')).toBe('billing')
    for (const e of ['invalid_request', 'server_error', '', undefined, 'toString', '__proto__']) expect(failureKind(e)).toBe('other')
    const [ev] = normalise({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'Claude usage limit reached.' })
    expect(ev).toEqual({ t: 'turn.failed', error: 'Claude usage limit reached.', kind: 'rate_limit' })
    expect(normalise({ hook_event_name: 'StopFailure', error: 'authentication_failed' })[0]).toEqual({ t: 'turn.failed', error: 'authentication_failed', kind: 'auth' })
    expect('resetsAt' in ev!).toBe(false)
  })
})
