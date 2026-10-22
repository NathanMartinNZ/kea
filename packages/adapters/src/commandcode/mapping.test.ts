import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { L, type AgentEvent } from '@kea/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOD_EVENTS, SESSION_END, SESSION_START, TOOL_WAITING } from './contract.ts'
import { CommandCodeSignals, failureKind, MAPPED_EVENTS, MOD_MAPPING, normalise } from './mapping.ts'
import { modHarness, type ModHarness } from './mod-harness.ts'

const ID = 'a40a7934-365e-4afd-a57a-506cb16fa4e9'
const NEXT = '78b89de3-536d-4bc0-abbb-338bffcfa9a9'
const TRANSCRIPT = `/tmp/h/.commandcode/projects/private-tmp-kea-fixture-z6-tg-wy-demo/${ID}.jsonl`
const WAIT = L.ccPermissionQueuedMs
/** The recordings of this CLI version, and beside them the sequences made by hand (`derived.*`, each saying so in its first line). */
const FIXTURES = fileURLToPath(new URL('../../../../fixtures/hooks/commandcode/1.79.2/', import.meta.url))

// the shapes 1.79.2 delivers: only the fields the mod reads matter, the rest is there to be dropped
const usage = { inputTokens: 27, outputTokens: 46, cacheReadTokens: 0, cacheWriteTokens: 0 }
const queued = (id: string, toolName: string, input: Record<string, unknown>) => ({ toolCallId: id, toolName, input })
const running = (id: string, toolName: string) => ({ toolCallId: id, toolName, description: null })
const completed = (id: string, toolName: string, text = 'ok') => ({ toolCallId: id, toolName, result: [{ type: 'text', text }], deferred: false })
const runEnd = (stopReason: string, finalText = '') => ({ result: { finalText, stopReason, turnCount: 1, usage, systemPromptTokens: 5120, nextState: { sessionId: ID, messages: [{ role: 'user', content: 'x'.repeat(50_000) }] } } })

function started(h: ModHarness = modHarness()): ModHarness {
  h.hook('onSessionStart', { source: 'startup', sessionId: ID })
  h.emit('run_start', { sessionId: ID })
  h.take()
  return h
}

describe('commandcode mod events', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('U-AGT-7 · the mod’s events → AgentEvents row for row (tool_errored included); a batch queued with nothing run raises a permission once the wait is over, not just before it', () => {
    const h = modHarness()
    // the session hook carries the id; the plain `session_start` event (which has none) is not even subscribed to
    h.hook('onSessionStart', { source: 'startup', sessionId: ID })
    expect(h.take().events).toEqual([{ t: 'session.started', agentSessionId: ID, source: 'startup' }])
    expect(h.signals.agentSessionId).toBe(ID)
    h.emit('run_start', { sessionId: ID })
    expect(h.take().events).toEqual([{ t: 'turn.started' }])
    h.emit('model_request_start', { model: 'deepseek/deepseek-v4-flash' })
    h.emit('model_request_start', { model: 'deepseek/deepseek-v4-flash' }) // every request of a turn says it: sent once
    expect(h.take().events).toEqual([{ t: 'meta', model: 'deepseek/deepseek-v4-flash' }])

    // a tool that runs at once (26 ms on the recorded run): started and finished with its input's summary, no permission
    h.emit('tool_queued', queued('t1', 'shell_command', { command: 'echo kea-probe', description: 'Print a marker' }))
    expect(h.take().sent).toEqual([]) // never forwarded: its input is kept for the events that follow
    vi.advanceTimersByTime(26)
    h.emit('tool_running', running('t1', 'shell_command'))
    h.emit('tool_completed', completed('t1', 'shell_command', 'kea-probe\n'))
    expect(h.take().events).toEqual([
      { t: 'tool.started', name: 'shell_command', summary: 'echo kea-probe' },
      { t: 'tool.finished', name: 'shell_command', summary: 'echo kea-probe', ok: true },
    ])
    vi.advanceTimersByTime(WAIT * 2)
    expect(h.take().events).toEqual([])
    expect(h.timers).toBe(0)

    // a tool that fails: tool.finished{ok:false}
    h.emit('tool_queued', queued('t2', 'read_file', { file_path: '/tmp/demo/missing.txt' }))
    h.emit('tool_running', running('t2', 'read_file'))
    h.emit('tool_errored', { toolCallId: 't2', toolName: 'read_file', error: 'ENOENT: no such file or directory', deferred: false })
    expect(h.take().events).toEqual([
      { t: 'tool.started', name: 'read_file', summary: '/tmp/demo/missing.txt' },
      { t: 'tool.finished', name: 'read_file', summary: '/tmp/demo/missing.txt', ok: false },
    ])

    // queued and nothing runs: Command Code is asking. No alarm just below the threshold, the alarm at it
    h.emit('tool_queued', queued('t3', 'write_file', { file_path: '/tmp/demo/notes/todo.md', content: '- one\n'.repeat(5000) }))
    vi.advanceTimersByTime(WAIT - 1)
    expect(h.take().events).toEqual([])
    vi.advanceTimersByTime(1)
    const asked = h.take()
    expect(asked.events).toEqual([{ t: 'attention.permission', key: 't3', tool: 'write_file', summary: '/tmp/demo/notes/todo.md' }])
    expect(asked.sent).toEqual([{ type: TOOL_WAITING, sessionId: ID, toolCallId: 't3', toolName: 'write_file', input: { file_path: '/tmp/demo/notes/todo.md' } }])
    vi.advanceTimersByTime(WAIT * 3)
    expect(h.take().events).toEqual([]) // once per wait
    // allowed: the item is cleared as the tool starts
    h.emit('tool_running', running('t3', 'write_file'))
    h.emit('tool_completed', completed('t3', 'write_file'))
    expect(h.take().events).toEqual([
      { t: 'attention.cleared', key: 't3' },
      { t: 'tool.started', name: 'write_file', summary: '/tmp/demo/notes/todo.md' },
      { t: 'tool.finished', name: 'write_file', summary: '/tmp/demo/notes/todo.md', ok: true },
    ])

    // the turn ends: its last message, cut to the summary length; the conversation in `nextState` never leaves the mod
    h.emit('run_end', runEnd('end_turn', `Done. ${'y'.repeat(1000)}`))
    const end = h.take()
    expect(end.events).toEqual([{ t: 'turn.finished', lastMessage: `Done. ${'y'.repeat(L.hookSummaryMaxChars - 6)}`, backgroundWork: false }])
    expect(JSON.stringify(end.sent).length).toBeLessThan(600)
    expect(end.sent[0]).toEqual({ type: 'run_end', sessionId: ID, result: { stopReason: 'end_turn', finalText: `Done. ${'y'.repeat(L.hookSummaryMaxChars - 6)}` } })
    h.emit('session_titled', { title: 'Explain the demo repository' })
    expect(h.take().events).toEqual([{ t: 'meta', title: 'Explain the demo repository', titleSource: 'agent' }])

    // refused: tool_denied clears the item, and the run ends with `permission_denied` (the turn is over)
    h.emit('run_start', { sessionId: ID })
    h.emit('tool_queued', queued('t4', 'write_file', { file_path: '/tmp/demo/a.txt' }))
    vi.advanceTimersByTime(WAIT)
    h.emit('tool_denied', { toolCallId: 't4', toolName: 'write_file' })
    h.emit('run_end', runEnd('permission_denied'))
    expect(h.take().events).toEqual([{ t: 'turn.started' }, { t: 'attention.permission', key: 't4', tool: 'write_file', summary: '/tmp/demo/a.txt' }, { t: 'attention.cleared', key: 't4' }, { t: 'turn.finished', backgroundWork: false }])

    // Esc while it asks: interrupted clears and ends the turn; the run_end that follows adds nothing
    h.emit('run_start', { sessionId: ID })
    h.emit('tool_queued', queued('t5', 'shell_command', { command: 'rm -rf build' }))
    vi.advanceTimersByTime(WAIT)
    h.emit('interrupted', {})
    h.emit('run_end', runEnd('interrupted'))
    expect(h.take().events).toEqual([{ t: 'turn.started' }, { t: 'attention.permission', key: 't5', tool: 'shell_command', summary: 'rm -rf build' }, { t: 'attention.cleared', key: 't5' }, { t: 'turn.interrupted' }])
    vi.advanceTimersByTime(WAIT * 2)
    expect(h.take().events).toEqual([])

    // a failed run: its kind from the HTTP status, its text shown; the run_end that follows adds nothing
    h.emit('run_start', { sessionId: ID })
    h.emit('run_error', { error: { name: 'TransportError', message: 'Authentication failed. Your API key may be invalid or expired.', status: 401, retryable: false, responseBody: '{"type":"error"}' } })
    h.emit('run_end', runEnd('run_error'))
    expect(h.take().events).toEqual([{ t: 'turn.started' }, { t: 'turn.failed', error: 'Authentication failed. Your API key may be invalid or expired.', kind: 'auth' }])

    // the rest of the table
    h.emit('permission_mode_changed', { mode: 'auto-accept' })
    h.emit('permission_mode_changed', { mode: 'bypass' })
    h.emit('permission_mode_changed', { mode: 'default' })
    h.emit('compaction_start', {})
    h.emit('compaction_done', {})
    expect(h.take().events).toEqual([
      { t: 'meta', permissionMode: 'accept-edits' },
      { t: 'meta', permissionMode: 'yolo' },
      { t: 'meta', permissionMode: 'default' },
      { t: 'compacting', active: true },
      { t: 'compacting', active: false },
    ])
    h.hook('onSessionEnd', { reason: 'shutdown' })
    expect(h.take().events).toEqual([{ t: 'session.ended', reason: 'shutdown' }])
    expect(h.timers).toBe(0)
    expect(h.signals.ignored.unknownEvent).toBe(0)

    // the table has a row for every event the contract names, and nothing else; an unknown event maps to nothing
    expect(Object.keys(MOD_MAPPING).sort()).toEqual([...MOD_EVENTS, SESSION_START, SESSION_END, TOOL_WAITING].sort())
    expect([...MAPPED_EVENTS].sort()).toEqual(Object.keys(MOD_MAPPING).sort())
    expect(normalise({ type: 'turn_start', turnNumber: 1 })).toEqual([])
    expect(normalise({})).toEqual([])
    const s = new CommandCodeSignals(null)
    expect(s.hook({ payload: { type: 'future_event' }, monoMs: 0 })).toEqual([])
    expect(s.ignored.unknownEvent).toBe(1)
    // error kinds: status first, then the text, else other
    expect(failureKind(429, '')).toBe('rate_limit')
    expect(failureKind(529, '')).toBe('overloaded')
    expect(failureKind(402, '')).toBe('billing')
    expect(failureKind(undefined, 'TransportError Rate limit exceeded')).toBe('rate_limit')
    expect(failureKind(500, 'Internal error')).toBe('other')
    expect(failureKind(undefined, 'Not authenticated. Please run "cmd login" first.')).toBe('auth')
  })

  it('U-AGT-46 · three calls queued, the second asked about and refused while the third still needs its answer: the item moves to the third at once and never drops while a prompt is on screen; the refusal ends the batch, so nothing of it runs', () => {
    // the sequence is derived from reading the CLI's bundle, not recorded: the file says so in its first line
    const file = path.join(FIXTURES, 'derived.refused-batch.jsonl')
    const [note, ...rows] = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(note).toMatch(/^\/\/ DERIVED, NOT RECORDED\. /)
    const calls = rows.map((l) => JSON.parse(l) as { ms: number; kind: 'event' | 'hook'; name: string; arg: Record<string, unknown> })
    const [READ, RUN, WRITE] = ['toolu_derived_1_0', 'toolu_derived_1_1', 'toolu_derived_1_2'] as const
    expect(calls.filter((c) => c.name === 'tool_queued').map((c) => c.arg.toolCallId)).toEqual([READ, RUN, WRITE])

    const h = modHarness()
    const open = new Set<string>()
    /** Each moment something changed: when (at a call of the file, or in the time before it), the events, the items open after them, and the fewest open after any one of them. */
    const moments: { when: string; events: AgentEvent[]; open: string[]; fewest: number }[] = []
    let at = 0
    const look = (when: string): void => {
      const { events } = h.take()
      const attention = events.filter((e) => e.t === 'attention.permission' || e.t === 'attention.cleared')
      if (attention.length === 0) return
      let fewest = Infinity
      for (const e of attention) {
        if (e.t === 'attention.permission') open.add(e.key)
        else if (e.t === 'attention.cleared') open.delete(e.key ?? '')
        fewest = Math.min(fewest, open.size)
      }
      moments.push({ when, events: attention, open: [...open], fewest })
    }
    for (const c of calls) {
      // the time between two calls passes first: what a timer of the mod's own sends is seen apart from what the call does
      vi.advanceTimersByTime(c.ms - at)
      at = c.ms
      look(`before ${c.name}`)
      if (c.kind === 'hook') h.hook(c.name, c.arg)
      else h.emit(c.name, c.arg)
      look(c.name)
    }
    const queuedAt = calls.find((c) => c.name === 'tool_queued')!.ms
    const deniedAt = calls.find((c) => c.name === 'tool_denied')!.ms
    const endAt = calls.find((c) => c.name === 'run_end')!.ms
    expect(deniedAt - queuedAt).toBeGreaterThan(WAIT) // the refusal comes with the item up
    expect(endAt - deniedAt).toBeGreaterThan(WAIT * 5) // and the third prompt stays on screen for a long while
    expect(moments).toEqual([
      // the read needs no answer: once the batch's wait is over the item is the command's
      { when: 'before tool_denied', events: [{ t: 'attention.permission', key: RUN, tool: 'shell_command', summary: 'npm test' }], open: [RUN], fewest: 1 },
      // the person refuses it. The CLI says so and puts the write's prompt up, with no event for it: the item is the
      // write's now, raised before the other is taken down, so at no event in between is none open
      {
        when: 'tool_denied',
        events: [
          { t: 'attention.permission', key: WRITE, tool: 'write_file', summary: '/private/tmp/kea-fixture-xxxxxx/demo/x.txt' },
          { t: 'attention.cleared', key: RUN },
        ],
        open: [WRITE],
        fewest: 1,
      },
      // that prompt stays as long as the person likes: nothing repeats the item, nothing takes it down. Allowed (no
      // event for that either): a refusal ended the batch before anything ran, so the run ends
      { when: 'run_end', events: [{ t: 'attention.cleared', key: WRITE }], open: [], fewest: 0 },
    ])
    expect(h.signals.agentSessionId).toBe(ID)
    expect(h.timers).toBe(0)
  })

  it('U-AGT-39 · the permission timer is per batch, and the item follows the prompts: calls are asked about in order, a read-only tool is not the one named when another waits, a refusal moves an item that is up to the next call (and raises none before the wait is over), and any refusal ends the batch', () => {
    const h = started()
    // three calls queued together; nothing runs: one item, for the first tool that changes something
    h.emit('tool_queued', queued('a', 'read_file', { file_path: '/tmp/demo/README.md' }))
    vi.advanceTimersByTime(WAIT - 100)
    h.emit('tool_queued', queued('b', 'shell_command', { command: 'npm test' }))
    h.emit('tool_queued', queued('c', 'write_file', { file_path: '/tmp/demo/x.txt' }))
    vi.advanceTimersByTime(99)
    expect(h.take().events).toEqual([]) // the batch's wait counts from its first call
    vi.advanceTimersByTime(1)
    expect(h.take().events).toEqual([{ t: 'attention.permission', key: 'b', tool: 'shell_command', summary: 'npm test' }])
    // b refused, then c: each refusal is told as it is made; after the last there is nothing left to ask
    h.emit('tool_denied', { toolCallId: 'b', toolName: 'shell_command' })
    const next = h.take()
    expect(next.sent.map((x) => x.type)).toEqual([TOOL_WAITING, 'tool_denied']) // the new item first: it never drops
    expect(next.events).toEqual([{ t: 'attention.permission', key: 'c', tool: 'write_file', summary: '/tmp/demo/x.txt' }, { t: 'attention.cleared', key: 'b' }])
    h.emit('tool_denied', { toolCallId: 'c', toolName: 'write_file' })
    expect(h.take().events).toEqual([{ t: 'attention.cleared', key: 'c' }])
    expect(h.timers).toBe(0)
    // nothing of a batch runs after a refusal (the read that needed no answer included): the run ends
    h.emit('run_end', runEnd('permission_denied'))
    expect(h.take().events).toEqual([{ t: 'turn.finished', backgroundWork: false }])

    // answered before the wait is over: no item for the refused call, and none at once for the next. If that one is
    // still unanswered when the batch's wait ends, the item names it, not a call that already has its answer
    h.emit('run_start', { sessionId: ID })
    h.emit('tool_queued', queued('p', 'shell_command', { command: 'git push' }))
    h.emit('tool_queued', queued('q', 'write_file', { file_path: '/tmp/demo/y.txt' }))
    vi.advanceTimersByTime(WAIT - 100)
    h.emit('tool_denied', { toolCallId: 'p', toolName: 'shell_command' })
    expect(h.take().events).toEqual([{ t: 'turn.started' }])
    vi.advanceTimersByTime(99)
    expect(h.take().events).toEqual([])
    vi.advanceTimersByTime(1)
    expect(h.take().events).toEqual([{ t: 'attention.permission', key: 'q', tool: 'write_file', summary: '/tmp/demo/y.txt' }])
    h.emit('run_end', runEnd('permission_denied'))
    expect(h.take().events).toEqual([{ t: 'attention.cleared', key: 'q' }, { t: 'turn.finished', backgroundWork: false }])
    expect(h.timers).toBe(0)

    // a batch of read-only tools that waits (paths outside the folder): the first is named, then the next
    h.emit('run_start', { sessionId: ID })
    h.emit('tool_queued', queued('d', 'read_file', { file_path: '/etc/hosts' })) // os-ok: test data
    h.emit('tool_queued', queued('e', 'grep', { pattern: 'TODO', path: '/etc' }))
    vi.advanceTimersByTime(WAIT)
    expect(h.take().events).toEqual([{ t: 'turn.started' }, { t: 'attention.permission', key: 'd', tool: 'read_file', summary: '/etc/hosts' }]) // os-ok: test data
    h.emit('tool_denied', { toolCallId: 'd', toolName: 'read_file' })
    expect(h.take().events).toEqual([{ t: 'attention.permission', key: 'e', tool: 'grep', summary: '/etc' }, { t: 'attention.cleared', key: 'd' }])
    // every call of it refused: the batch is over and its timer gone
    h.emit('tool_denied', { toolCallId: 'e', toolName: 'grep' })
    expect(h.take().events).toEqual([{ t: 'attention.cleared', key: 'e' }])
    expect(h.timers).toBe(0)
    h.emit('run_end', runEnd('permission_denied'))
    h.take()

    // the item named a call that needed no answer (an allow rule of the person's); the prompt was for the next one and
    // is refused: that refusal is not the item's call, and the run's end clears it
    h.emit('run_start', { sessionId: ID })
    h.emit('tool_queued', queued('r', 'shell_command', { command: 'ls' }))
    h.emit('tool_queued', queued('s', 'write_file', { file_path: '/tmp/demo/z.txt' }))
    vi.advanceTimersByTime(WAIT)
    h.emit('tool_denied', { toolCallId: 's', toolName: 'write_file' })
    expect(h.take().events).toEqual([{ t: 'turn.started' }, { t: 'attention.permission', key: 'r', tool: 'shell_command', summary: 'ls' }])
    expect(h.timers).toBe(0)
    h.emit('run_end', runEnd('permission_denied'))
    expect(h.take().events).toEqual([{ t: 'attention.cleared', key: 'r' }, { t: 'turn.finished', backgroundWork: false }])

    // a tool name the CLI does not know is refused at once, with no prompt and without ending the batch: no item for
    // it, the other call runs, and one that waits is named when the wait is over
    h.emit('run_start', { sessionId: ID })
    h.emit('tool_queued', queued('u', 'no_such_tool', {}))
    h.emit('tool_queued', queued('v', 'shell_command', { command: 'make' }))
    h.emit('tool_denied', { toolCallId: 'u', toolName: 'no_such_tool' })
    expect(h.take().events).toEqual([{ t: 'turn.started' }])
    vi.advanceTimersByTime(WAIT)
    expect(h.take().events).toEqual([{ t: 'attention.permission', key: 'v', tool: 'shell_command', summary: 'make' }])
    h.emit('tool_running', running('v', 'shell_command'))
    h.emit('tool_completed', completed('v', 'shell_command'))
    expect(h.take().events.map((e) => e.t)).toEqual(['attention.cleared', 'tool.started', 'tool.finished'])
    expect(h.timers).toBe(0)
    h.emit('run_end', runEnd('end_turn'))
    h.take()

    // a hook of the person's own blocks a tool: not a permission; the next batch gets its own timer
    h.emit('run_start', { sessionId: ID })
    h.emit('tool_queued', queued('f', 'shell_command', { command: 'git push' }))
    vi.advanceTimersByTime(WAIT - 1)
    h.emit('tool_hook_blocked', { toolCallId: 'f', toolName: 'shell_command' })
    h.emit('tool_queued', queued('g', 'shell_command', { command: 'git status' }))
    vi.advanceTimersByTime(WAIT - 1)
    expect(h.take().events).toEqual([{ t: 'turn.started' }])
    vi.advanceTimersByTime(1)
    expect(h.take().events).toEqual([{ t: 'attention.permission', key: 'g', tool: 'shell_command', summary: 'git status' }])
    // a new run forgets the old batch (a run that ended without saying so)
    h.emit('run_start', { sessionId: ID })
    expect(h.timers).toBe(0)
    expect(h.take().events).toEqual([{ t: 'attention.cleared', key: 'g' }, { t: 'turn.started' }])

    // an item raised while another is open (an event was lost) replaces it: the adapter holds one at a time
    const s = new CommandCodeSignals(ID)
    const waitingFor = (id: string) => s.hook({ payload: { type: TOOL_WAITING, sessionId: ID, toolCallId: id, toolName: 'write_file', input: { file_path: `/tmp/${id}` } }, monoMs: 0 })
    expect(waitingFor('w1')).toEqual([{ t: 'attention.permission', key: 'w1', tool: 'write_file', summary: '/tmp/w1' }])
    expect(waitingFor('w2')).toEqual([{ t: 'attention.permission', key: 'w2', tool: 'write_file', summary: '/tmp/w2' }, { t: 'attention.cleared', key: 'w1' }])
    expect(waitingFor('w2')).toEqual([{ t: 'attention.permission', key: 'w2', tool: 'write_file', summary: '/tmp/w2' }])
    expect(s.hook({ payload: { type: 'run_start', sessionId: ID }, monoMs: 0 })).toEqual([{ t: 'attention.cleared', key: 'w2' }, { t: 'turn.started' }])

    // the mod's memory of one run is capped: calls beyond the cap are forwarded without their input
    const small = started(modHarness({ options: { maxTools: 2 } }))
    for (const id of ['1', '2', '3']) small.emit('tool_queued', queued(id, 'shell_command', { command: `echo ${id}` }))
    for (const id of ['1', '2', '3']) small.emit('tool_running', running(id, 'shell_command'))
    expect(small.take().events).toEqual([
      { t: 'tool.started', name: 'shell_command', summary: 'echo 1' },
      { t: 'tool.started', name: 'shell_command', summary: 'echo 2' },
      { t: 'tool.started', name: 'shell_command', summary: '' },
    ])
  })

  it('U-AGT-40 · session ids and the transcript path: the path rides on the first event after the file exists; /clear starts a new conversation; a resume has its path at once', () => {
    const h = modHarness()
    h.hook('onSessionStart', { source: 'startup', sessionId: ID })
    h.emit('run_start', { sessionId: ID })
    // no file yet (it appears when the first turn commits): nothing about a transcript
    expect(h.take().events).toEqual([{ t: 'session.started', agentSessionId: ID, source: 'startup' }, { t: 'turn.started' }])
    h.transcripts.set(ID, TRANSCRIPT)
    h.emit('run_end', runEnd('end_turn', 'Done.'))
    // the session's start again, now with its path (how core learns a transcript) and marked as a repeat (no session
    // started now: the journal leaves it out, U-ST-20), then the turn's end
    expect(h.take().events).toEqual([
      { t: 'session.started', agentSessionId: ID, transcriptPath: TRANSCRIPT, source: 'startup', repeated: true },
      { t: 'turn.finished', lastMessage: 'Done.', backgroundWork: false },
    ])
    // found once: later events do not repeat it
    h.emit('run_start', { sessionId: ID })
    h.emit('run_end', runEnd('end_turn', 'Again.'))
    expect(h.take().events.map((e) => e.t)).toEqual(['turn.started', 'turn.finished'])
    expect(h.signals.sessionIds()).toEqual(new Set([ID]))

    // /clear: the session ends as `replaced` (not an exit) and another starts in the same process
    h.hook('onSessionEnd', { reason: 'replaced' })
    h.hook('onSessionStart', { source: 'startup', sessionId: NEXT })
    expect(h.take().events).toEqual([{ t: 'session.started', agentSessionId: NEXT, source: 'clear' }])
    expect(h.signals.agentSessionId).toBe(NEXT)
    expect(h.signals.sessionIds()).toEqual(new Set([ID, NEXT]))
    const next = TRANSCRIPT.replace(ID, NEXT)
    h.transcripts.set(NEXT, next)
    h.emit('run_start', { sessionId: NEXT })
    expect(h.take().events).toEqual([{ t: 'session.started', agentSessionId: NEXT, transcriptPath: next, source: 'clear', repeated: true }, { t: 'turn.started' }])

    // a resumed session's file is there from the start
    const r = modHarness({ agentSessionId: ID })
    r.transcripts.set(ID, TRANSCRIPT)
    r.hook('onSessionStart', { source: 'resume', sessionId: ID })
    expect(r.take().events).toEqual([{ t: 'session.started', agentSessionId: ID, transcriptPath: TRANSCRIPT, source: 'resume' }])
    // a path that is not a transcript's is not passed on (core also refuses one outside the agent's folder)
    const odd = modHarness()
    odd.transcripts.set(ID, '/tmp/h/.commandcode/projects/x/notes.txt')
    odd.hook('onSessionStart', { source: 'startup', sessionId: ID })
    expect(odd.take().events).toEqual([{ t: 'session.started', agentSessionId: ID, source: 'startup' }])
    // a start without an id says nothing
    const none = modHarness()
    none.hook('onSessionStart', { source: 'startup' })
    expect(none.take().events).toEqual([])
  })

  it('U-AGT-49 · a run that starts under another conversation id with no session hook before it is that conversation’s start: said as a real start (journaled, not a repeat), the new id the one later resumes target, and the new transcript’s path given under the new id, never under the old one; a session whose start hook never came is learned from its first run the same way', () => {
    // the sequence is made by hand (1.79.2 always sends the hooks): the file says so in its first line
    const file = path.join(FIXTURES, 'derived.unannounced-session.jsonl')
    const [note, ...rows] = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(note).toMatch(/^\/\/ DERIVED, NOT RECORDED\. /)
    const calls = rows.map((l) => JSON.parse(l) as { ms: number; kind: 'event' | 'hook'; name: string; arg: Record<string, unknown> })
    const starts = calls.filter((c) => c.name === 'run_start').map((c) => c.arg.sessionId)
    expect(starts).toEqual([ID, NEXT, NEXT])
    expect(calls.filter((c) => c.kind === 'hook').map((c) => c.name), 'no hook says the conversation changed').toEqual(['onSessionStart'])
    const next = TRANSCRIPT.replace(ID, NEXT)

    /** The file replayed; `found` puts a conversation's transcript on disk just before the n-th call. What each call made. */
    const replay = (found: Record<number, [string, string]>): { h: ModHarness; made: AgentEvent[][] } => {
      const h = modHarness()
      const made = calls.map((c, n) => {
        const f = found[n]
        if (f) h.transcripts.set(f[0], f[1])
        if (c.kind === 'hook') h.hook(c.name, c.arg)
        else h.emit(c.name, c.arg)
        return h.take().events
      })
      return { h, made }
    }
    const at = (name: string, nth: number): number => calls.map((c, n) => (c.name === name ? n : -1)).filter((n) => n >= 0)[nth] as number

    // 1. each transcript appears when its conversation's first turn commits (as on 1.79.2): before that run's end
    const a = replay({ [at('run_end', 0)]: [ID, TRANSCRIPT], [at('run_end', 1)]: [NEXT, next] })
    expect(a.made.filter((m) => m.length > 0)).toEqual([
      [{ t: 'session.started', agentSessionId: ID, source: 'startup' }],
      [{ t: 'turn.started' }],
      [{ t: 'session.started', agentSessionId: ID, transcriptPath: TRANSCRIPT, source: 'startup', repeated: true }, { t: 'turn.finished', lastMessage: 'First.', backgroundWork: false }],
      // the run under another id: a start, in the same process (as after /clear), before its turn
      [{ t: 'session.started', agentSessionId: NEXT, source: 'clear' }, { t: 'turn.started' }],
      // its transcript, found at the turn's end: the new conversation's, said again as its start
      [{ t: 'session.started', agentSessionId: NEXT, transcriptPath: next, source: 'clear', repeated: true }, { t: 'turn.finished', lastMessage: 'Second.', backgroundWork: false }],
      [{ t: 'turn.started' }],
      [{ t: 'turn.finished', lastMessage: 'Third.', backgroundWork: false }],
    ])
    expect(a.h.signals.agentSessionId).toBe(NEXT)
    expect(a.h.signals.sessionIds()).toEqual(new Set([ID, NEXT]))
    // no event names the new transcript under the old conversation
    for (const e of a.made.flat()) if (e.t === 'session.started' && e.transcriptPath === next) expect(e.agentSessionId).toBe(NEXT)

    // 2. the other conversation's transcript is there already (one taken up again): the start carries its path at once
    const b = replay({ [at('run_end', 0)]: [ID, TRANSCRIPT], [at('run_start', 1)]: [NEXT, next] })
    expect(b.made[at('run_start', 1)]).toEqual([{ t: 'session.started', agentSessionId: NEXT, transcriptPath: next, source: 'clear' }, { t: 'turn.started' }])
    expect(b.made[at('run_end', 1)]).toEqual([{ t: 'turn.finished', lastMessage: 'Second.', backgroundWork: false }])

    // 3. a session whose start hook never reached Kea is learned from its first run: a start, as a launch's is
    const lost = modHarness()
    lost.emit('run_start', { sessionId: ID })
    expect(lost.take().events).toEqual([{ t: 'session.started', agentSessionId: ID, source: 'startup' }, { t: 'turn.started' }])
    expect(lost.signals.agentSessionId).toBe(ID)
    // and a resumed launch that runs under another id than the one it was started for
    const other = modHarness({ agentSessionId: ID })
    other.emit('run_start', { sessionId: NEXT })
    expect(other.take().events).toEqual([{ t: 'session.started', agentSessionId: NEXT, source: 'clear' }, { t: 'turn.started' }])
    expect(other.signals.sessionIds()).toEqual(new Set([ID, NEXT]))
    // the session's end under an id Kea does not hold starts nothing
    const ending = modHarness({ agentSessionId: ID })
    ending.hook('onSessionEnd', { reason: 'exit', sessionId: NEXT })
    expect(ending.take().events).toEqual([{ t: 'session.ended', reason: 'exit' }])
    expect(ending.signals.agentSessionId).toBe(ID)
  })

  it('U-AGT-41 · the mod observes only: without Kea’s option it sends nothing, a failing delivery or a throwing API never reaches the agent, and it subscribes to exactly the contract’s events', () => {
    // not Kea's launch (the file loaded by hand, or an option that does not decode): silent
    for (const option of [null, '', 'not-base64-json']) {
      const h = modHarness({ option })
      h.hook('onSessionStart', { source: 'startup', sessionId: ID })
      h.emit('run_start', { sessionId: ID })
      h.emit('tool_queued', queued('t', 'write_file', { file_path: '/tmp/x' }))
      vi.advanceTimersByTime(WAIT * 2)
      expect(h.sent).toEqual([])
      expect(h.timers).toBe(0)
    }
    const h = modHarness()
    expect(h.subscribed.sort()).toEqual([...MOD_EVENTS].sort())
    expect(h.hooks.sort()).toEqual(['onSessionEnd', 'onSessionStart'])
    expect(h.flags).toEqual({ kea: '' })
    // payloads of any shape: nothing throws into the agent
    for (const e of [null, undefined, 'text', 42, [], { toolCallId: 7 }, { result: 'x' }, { error: null }]) {
      expect(() => h.emit('run_end', e as never)).not.toThrow()
      expect(() => h.emit('tool_queued', e as never)).not.toThrow()
      expect(() => h.emit('tool_running', e as never)).not.toThrow()
    }
    expect(() => h.hook('onSessionStart', null as never)).not.toThrow()
    expect(() => h.hook('onSessionEnd', undefined as never)).not.toThrow()
    const events: AgentEvent[] = h.take().events
    for (const e of events) expect(typeof e.t).toBe('string')
  })
})
