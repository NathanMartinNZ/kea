import { allPairs } from '@kea/kit'
import { L, PHASE, type AttentionItem, type Phase, type StatusSource } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { SessionMachine, type SignalRecord } from './machine.ts'
import { initialStatus, STATUS_FILE_KEY, STATUS_TABLE, step, TABLE_EVENTS, TRUST_KEY, type StatusState, type StepInput, type TableEvent, type TableEventType } from './table.ts'

const T0 = 1_790_000_000_000
const S = 1_000_000_000n // one second in ns
const K = 'Bash: npm test'
const item = (key = K, over: Partial<AttentionItem> = {}): AttentionItem => ({ kind: 'permission', key, summary: key, source: 'hook', at: T0, ...over })

function inPhase(phase: Phase): StatusState {
  const s = initialStatus(T0)
  s.phase = phase
  if (phase === 'blocked') s.attention = [item()]
  if (phase === 'failed') s.failureKind = 'overloaded'
  if (phase === 'ready') s.unread = true
  return s
}

const inp = (over: Partial<StepInput> = {}): StepInput => ({ source: 'hook', at: T0 + 1000, mono: 10n * S, prompt: false, noTurns: false, viewing: false, ...over })

/** One representative event of each type, for the exhaustive pass (U-ST-1). */
const SAMPLE: Record<TableEventType, TableEvent> = {
  'session.started': { t: 'session.started', agentSessionId: 'a1', source: 'startup' },
  'turn.started': { t: 'turn.started' },
  'tool.started': { t: 'tool.started', name: 'Bash', summary: 'ls' },
  'tool.finished': { t: 'tool.finished', name: 'Bash', ok: true },
  'attention.permission': { t: 'attention.permission', key: 'Edit: a.ts', tool: 'Edit', summary: 'a.ts' },
  'attention.question': { t: 'attention.question', key: 'q', summary: 'Which one?' },
  'attention.cleared': { t: 'attention.cleared', key: K },
  'turn.finished': { t: 'turn.finished', backgroundWork: false },
  'turn.interrupted': { t: 'turn.interrupted' },
  'turn.failed': { t: 'turn.failed', error: 'overloaded', kind: 'overloaded' },
  compacting: { t: 'compacting', active: true },
  'session.ended': { t: 'session.ended', reason: 'clear' },
  meta: { t: 'meta', model: 'm' },
  'pty.spawned': { t: 'pty.spawned' },
  'trust.timeout': { t: 'trust.timeout' },
  'user.viewed': { t: 'user.viewed' },
  'user.typed': { t: 'user.typed' },
  statusFile: { t: 'statusFile', status: 'idle' },
  reconcile: { t: 'reconcile', phase: 'idle' },
}

const all = (to: Phase): Record<Phase, Phase> => Object.fromEntries(PHASE.map((p) => [p, to])) as Record<Phase, Phase>
const same = (): Record<Phase, Phase> => Object.fromEntries(PHASE.map((p) => [p, p])) as Record<Phase, Phase>

/**
 * The status table restated by hand: for each event (its SAMPLE), the phase each phase moves to. A phase missing from a
 * row is a pair the table does not list: a no-op. (statusFile's sample `idle`: a row in every live phase: the agent at
 * its prompt while starting, a turn no hook started finished while working, nothing with a hook item pending while
 * blocked.)
 */
const EXPECTED: Record<(typeof TABLE_EVENTS)[number], Partial<Record<Phase, Phase>>> = {
  'pty.spawned': all('starting'),
  'session.started': { starting: 'idle', working: 'working', blocked: 'blocked', ready: 'ready', failed: 'failed', idle: 'idle' },
  'trust.timeout': { starting: 'blocked' },
  'turn.started': all('working'),
  'tool.started': { starting: 'working', working: 'working', blocked: 'blocked', ready: 'working', failed: 'working', idle: 'working' },
  'tool.finished': {},
  'attention.permission': all('blocked'),
  'attention.question': all('blocked'),
  'attention.cleared': { blocked: 'working' },
  'turn.finished': all('ready'),
  'turn.interrupted': all('ready'),
  'turn.failed': all('failed'),
  compacting: same(),
  'session.ended': same(),
  meta: {},
  'user.viewed': { ready: 'ready', failed: 'failed' },
  'user.typed': { blocked: 'blocked' },
  statusFile: { starting: 'idle', idle: 'idle', working: 'ready', blocked: 'blocked', ready: 'ready', failed: 'failed' },
}

describe('status table', () => {
  it('U-ST-1 · every phase × event pair: the table’s rows move as written, every other pair is a no-op', () => {
    const pairs = allPairs(STATUS_TABLE, PHASE, TABLE_EVENTS)
    expect(pairs.length).toBe(PHASE.length * TABLE_EVENTS.length)
    for (const { state, event, handled } of pairs) {
      const want = EXPECTED[event as (typeof TABLE_EVENTS)[number]][state]
      expect(handled, `${state} × ${event} is a row of the table`).toBe(want !== undefined)
      const before = inPhase(state)
      const r = step(before, SAMPLE[event], inp())
      if (want === undefined) {
        expect(r.state.phase, `${state} × ${event}`).toBe(state)
        if (event !== 'meta') expect(r.changed, `${state} × ${event} changes nothing`).toBe(false)
        expect(r.effects.filter((e) => e.k !== 'title'), `${state} × ${event}`).toEqual([])
      } else expect(r.state.phase, `${state} × ${event}`).toBe(want)
    }
  })

  it('U-ST-1 · spawned: starting with the attention set, unread, background and failure emptied; the shell pseudo-agent runs idle', () => {
    const b = inPhase('blocked')
    b.unread = true
    b.background = true
    const r = step(b, { t: 'pty.spawned' }, inp())
    expect(r.state).toMatchObject({ phase: 'starting', attention: [], unread: false, background: false, failureKind: null })
    expect(step(inPhase('failed'), { t: 'pty.spawned' }, inp({ noTurns: true })).state).toMatchObject({ phase: 'idle', failureKind: null })
  })

  it('U-ST-1 · session.started: starting → idle (stays starting with a prompt), stores the agent’s ids; the trust question is added by the trust window and cleared by it', () => {
    const ev: TableEvent = { t: 'session.started', agentSessionId: 'abc', transcriptPath: '/t/abc.jsonl', source: 'startup' }
    const r = step(inPhase('starting'), ev, inp())
    expect(r.state.phase).toBe('idle')
    expect(r.effects).toContainEqual({ k: 'agentSession', agentSessionId: 'abc', transcriptPath: '/t/abc.jsonl' })
    expect(step(inPhase('starting'), ev, inp({ prompt: true })).state.phase).toBe('starting')

    const trust = step(inPhase('starting'), { t: 'trust.timeout' }, inp({ source: 'reconcile' }))
    expect(trust.state.phase).toBe('blocked')
    expect(trust.state.attention).toEqual([{ kind: 'question', key: TRUST_KEY, summary: 'Trust this folder? — answer in the terminal', source: 'reconcile', at: T0 + 1000 }])
    expect(trust.effects).toContainEqual(expect.objectContaining({ k: 'N1', trust: true }))
    const after = step(trust.state, ev, inp())
    expect(after.state).toMatchObject({ phase: 'idle', attention: [] })
    expect(after.effects).toContainEqual({ k: 'withdraw', keys: [TRUST_KEY] })
    // the trust window only fires while starting
    expect(step(inPhase('working'), { t: 'trust.timeout' }, inp()).state.phase).toBe('working')
  })

  it('U-ST-1 · turn.started empties the attention set and unread (a new prompt answers everything); a background start keeps both', () => {
    const b = inPhase('blocked')
    b.unread = true
    b.background = true
    const user = step(b, { t: 'turn.started' }, inp())
    expect(user.state).toMatchObject({ phase: 'working', attention: [], unread: false, background: false })
    expect(user.effects).toContainEqual({ k: 'withdraw' })
    const bg = step(b, { t: 'turn.started', trigger: 'background' }, inp())
    expect(bg.state).toMatchObject({ phase: 'blocked', attention: [item()], unread: true, background: false })
    const r = inPhase('ready')
    expect(step(r, { t: 'turn.started', trigger: 'background' }, inp()).state).toMatchObject({ phase: 'working', unread: true })
  })

  it('U-ST-1 · attention: the first item notifies (N1), a repeat refreshes it in place; two pending prompts are cleared one by one; a parallel tool finishing changes nothing', () => {
    let s = step(inPhase('working'), { t: 'attention.permission', key: K, tool: 'Bash', summary: 'npm test' }, inp()).state
    expect(s.phase).toBe('blocked')
    const second = step(s, { t: 'attention.permission', key: 'Edit: b.ts', tool: 'Edit', summary: 'b.ts' }, inp({ at: T0 + 2000 }))
    expect(second.effects.some((e) => e.k === 'N1'), 'only the first item notifies').toBe(false)
    s = second.state
    const refreshed = step(s, { t: 'attention.permission', key: K, tool: 'Bash', summary: 'npm test (again)' }, inp({ at: T0 + 3000 }))
    expect(refreshed.state.attention.map((a) => [a.key, a.summary, a.at])).toEqual([
      [K, 'npm test (again)', T0 + 1000],
      ['Edit: b.ts', 'b.ts', T0 + 2000],
    ])
    // a parallel tool (or a subagent's) starting and finishing while the prompts wait
    for (const ev of [{ t: 'tool.started', name: 'Read' }, { t: 'tool.finished', name: 'Read', ok: true }, { t: 'tool.started', name: 'Bash', subagent: true }, { t: 'tool.finished', name: 'Bash', ok: false, subagent: true }] as TableEvent[]) {
      const r = step(s, ev, inp())
      expect(r.state.phase, ev.t).toBe('blocked')
      expect(r.state.attention.length).toBe(2)
    }
    const one = step(s, { t: 'attention.cleared', key: K }, inp())
    expect(one.state.phase).toBe('blocked')
    expect(one.effects).toContainEqual({ k: 'withdraw', keys: [K] })
    const two = step(one.state, { t: 'attention.cleared', key: 'Edit: b.ts' }, inp())
    expect(two.state).toMatchObject({ phase: 'working', attention: [] })
    expect(step(s, { t: 'attention.cleared' }, inp()).state).toMatchObject({ phase: 'working', attention: [] })
  })

  it('U-ST-1 · turn ends: Stop with background tasks → ready + background (no permanent spinner); a denied prompt with no hook is cleared by the interrupt marker, read and silent; unread follows isBeingViewed', () => {
    const working = inPhase('working')
    working.turnMono = 5n * S
    const done = step(working, { t: 'turn.finished', backgroundWork: true, lastMessage: 'done' }, inp({ mono: 25n * S }))
    expect(done.state).toMatchObject({ phase: 'ready', background: true, unread: true })
    expect(done.effects).toContainEqual({ k: 'N2', turnMs: 20_000, lastMessage: 'done', background: true })
    expect(done.effects).toContainEqual({ k: 'conditionClear' })
    expect(step(working, { t: 'turn.finished', backgroundWork: false }, inp({ viewing: true })).state.unread).toBe(false)

    // Manual mode, the prompt answered "No": no hook; the transcript's interrupt marker
    const denied = step(inPhase('blocked'), { t: 'turn.interrupted' }, inp({ source: 'transcript' }))
    expect(denied.state).toMatchObject({ phase: 'ready', attention: [], unread: false })
    expect(denied.effects.filter((e) => e.k === 'N1' || e.k === 'N2' || e.k === 'N3')).toEqual([])
  })

  it('U-ST-1 · turn.failed: failed, unread, its kind; a per-session error notifies (N3), an account-level one joins the condition instead', () => {
    const r = step(inPhase('blocked'), { t: 'turn.failed', error: 'API overloaded', kind: 'overloaded' }, inp())
    expect(r.state).toMatchObject({ phase: 'failed', attention: [], unread: true, failureKind: 'overloaded' })
    expect(r.effects).toContainEqual({ k: 'N3', kind: 'overloaded', error: 'API overloaded' })
    for (const kind of ['rate_limit', 'auth', 'billing'] as const) {
      const a = step(inPhase('working'), { t: 'turn.failed', error: 'x', kind, resetsAt: T0 + 9 }, inp())
      expect(a.effects.some((e) => e.k === 'N3'), kind).toBe(false)
      expect(a.effects).toContainEqual({ k: 'condition', kind, resetsAt: T0 + 9 })
    }
    // leaving failed clears the kind (it is kept only while failed)
    expect(step(r.state, { t: 'turn.started' }, inp()).state.failureKind).toBeNull()
  })

  it('U-ST-1 · compacting sets the tooltip without a phase change; session.ended(clear) changes nothing; viewing marks read and withdraws; typing while blocked is remembered', () => {
    const c = step(inPhase('working'), { t: 'compacting', active: true }, inp())
    expect(c.state).toMatchObject({ phase: 'working', compacting: true })
    expect(c.changed).toBe(true)
    const ended = step(inPhase('ready'), { t: 'session.ended', reason: 'clear' }, inp())
    expect(ended).toMatchObject({ handled: true, changed: false })
    const v = step(inPhase('ready'), { t: 'user.viewed' }, inp({ source: 'user' }))
    expect(v.state.unread).toBe(false)
    expect(v.effects).toContainEqual({ k: 'withdraw' })
    const typed = step(inPhase('blocked'), { t: 'user.typed' }, inp({ source: 'user', mono: 42n }))
    expect(typed.state).toMatchObject({ phase: 'blocked', typedMono: 42n })
    expect(typed.changed).toBe(false)
  })

  it('U-ST-1 · tier 1b: waiting on a permission prompt or a question with nothing pending → blocked; a dialog is not attention; busy / idle / shell clear only status-file items; shell is background work', () => {
    const perm = step(inPhase('working'), { t: 'statusFile', status: 'waiting', waitingFor: 'permission', detail: 'permission prompt' }, inp({ source: 'status-file' }))
    expect(perm.state.phase).toBe('blocked')
    expect(perm.state.attention).toEqual([{ kind: 'permission', key: STATUS_FILE_KEY, summary: 'permission prompt', source: 'status-file', at: T0 + 1000 }])
    const q = step(inPhase('working'), { t: 'statusFile', status: 'waiting', waitingFor: 'question' }, inp({ source: 'status-file' }))
    expect(q.state.attention[0]).toMatchObject({ kind: 'question', key: STATUS_FILE_KEY })
    expect(step(inPhase('working'), { t: 'statusFile', status: 'waiting', waitingFor: 'other' }, inp({ source: 'status-file' })).state.phase).toBe('working')
    // a hook item pending: the file adds nothing and clears nothing
    expect(step(inPhase('blocked'), { t: 'statusFile', status: 'busy' }, inp({ source: 'status-file' })).state).toMatchObject({ phase: 'blocked', attention: [item()] })
    expect(step(perm.state, { t: 'statusFile', status: 'busy' }, inp({ source: 'status-file' })).state).toMatchObject({ phase: 'working', attention: [] })
    const shell = step(perm.state, { t: 'statusFile', status: 'shell' }, inp({ source: 'status-file' }))
    expect(shell.state).toMatchObject({ phase: 'ready', attention: [], background: true })
    expect(step(shell.state, { t: 'statusFile', status: 'idle' }, inp({ source: 'status-file' })).state.background).toBe(false)
    // background tasks a hook reported stay until the next turn
    const hookBg = step(inPhase('working'), { t: 'turn.finished', backgroundWork: true }, inp()).state
    expect(step(hookBg, { t: 'statusFile', status: 'idle' }, inp({ source: 'status-file' })).state.background).toBe(true)
  })

  it('U-ST-1 · tier 1b supersedes the user-input rule: the file leaving `waiting` means the prompt it showed was answered — hook items go too; a hook naming the prompt the file showed replaces the file’s item', () => {
    const file = (status: 'busy' | 'idle' | 'shell' | 'waiting', waitingFor?: 'permission' | 'question') => ({ t: 'statusFile', status, ...(waitingFor ? { waitingFor } : {}) }) as TableEvent
    const sf = inp({ source: 'status-file' })
    // PermissionRequest, then the file shows the prompt; approved: the file goes busy before the long tool's PostToolUse
    let s = step(inPhase('working'), { t: 'attention.permission', key: K, tool: 'Bash', summary: 'npm test' }, inp()).state
    s = step(s, file('waiting', 'permission'), sf).state
    expect(s.attention.map((a) => a.key)).toEqual([K])
    const answered = step(s, file('busy'), sf)
    expect(answered.state).toMatchObject({ phase: 'working', attention: [] })
    expect(answered.effects).toContainEqual({ k: 'withdraw', keys: [K] })
    // a busy reading with no `waiting` before it (a rewrite of the same status) leaves the hook's item alone
    const hookOnly = step(inPhase('working'), { t: 'attention.permission', key: K, tool: 'Bash' }, inp()).state
    expect(step(hookOnly, file('busy'), sf).state).toMatchObject({ phase: 'blocked', attention: [{ key: K }] })
    // the file shows the prompt before the hook names it: one item, the hook's
    let first = step(inPhase('working'), file('waiting', 'permission'), sf).state
    first = step(first, { t: 'attention.permission', key: K, tool: 'Bash', summary: 'npm test' }, inp()).state
    expect(first.attention.map((a) => [a.key, a.source])).toEqual([[K, 'hook']])
  })

  it('U-ST-13 · tier 1b is a full exact source: any status-file reading (a just-registered file too) answers the trust question; busy starts a turn from starting, idle, ready or failed, withdrawing a posted N2; waiting blocks from any live phase; idle ends a turn no hook started; one prompt is one item and one N1; an unknown wait is a silent, estimated question', () => {
    const sf = inp({ source: 'status-file' })
    const file = (status: 'busy' | 'idle' | 'shell' | 'waiting' | null, waitingFor?: 'permission' | 'question' | 'other' | 'unknown', detail?: string) => ({ t: 'statusFile', status, ...(waitingFor ? { waitingFor } : {}), ...(detail ? { detail } : {}) }) as TableEvent
    const n1 = (effects: { k: string }[]) => effects.filter((e) => e.k === 'N1')
    // the trust dialog writes no file: a file of the agent's, even one with no status yet, proves it answered
    const trust = step(inPhase('starting'), { t: 'trust.timeout' }, inp({ source: 'reconcile' })).state
    const registered = step(trust, file(null), sf)
    expect(registered.state).toMatchObject({ phase: 'idle', attention: [] })
    expect(registered.effects).toContainEqual({ k: 'withdraw', keys: [TRUST_KEY] })
    expect(step(trust, file(null), inp({ source: 'status-file', prompt: true })).state.phase, 'with an argv prompt: starting until the turn').toBe('starting')
    expect(step(trust, file('busy'), sf).state).toMatchObject({ phase: 'working', attention: [] })
    const trustThenPrompt = step(trust, file('waiting', 'permission', 'permission prompt'), sf)
    expect(trustThenPrompt.state.attention.map((a) => [a.key, a.source])).toEqual([[STATUS_FILE_KEY, 'status-file']])
    expect(n1(trustThenPrompt.effects), 'the prompt after the trust question is news').toHaveLength(1)
    expect(step(trust, file('idle'), sf).state).toMatchObject({ phase: 'idle', attention: [] })
    // busy: a turn, from every phase without one
    for (const p of ['starting', 'idle', 'ready', 'failed'] as const) expect(step(inPhase(p), file('busy'), sf).state.phase, p).toBe('working')
    const going = step(inPhase('ready'), file('busy'), inp({ source: 'status-file', mono: 30n * S }))
    expect(going.state).toMatchObject({ unread: false, turnMono: 30n * S })
    expect(going.effects, 'the turn goes on (a Stop hook kept it going): its N2 is withdrawn').toContainEqual({ k: 'withdraw' })
    // waiting: blocked from every live phase, with N1; a dialog is not attention
    for (const p of ['starting', 'idle', 'working', 'ready', 'failed'] as const) {
      const r = step(inPhase(p), file('waiting', 'question', 'input needed'), sf)
      expect(r.state, p).toMatchObject({ phase: 'blocked', attention: [{ kind: 'question', key: STATUS_FILE_KEY, source: 'status-file' }] })
      expect(n1(r.effects), p).toHaveLength(1)
      expect(step(inPhase(p), file('waiting', 'other'), sf).state.phase, `${p}: a dialog is not attention`).toBe(p)
    }
    // a hook names the prompt the file showed: its item replaces the file's, and the notification already posted is the hook item's now
    const shown = step(inPhase('working'), file('waiting', 'permission', 'permission prompt'), sf).state
    const named = step(shown, { t: 'attention.permission', key: K, tool: 'Bash', summary: 'npm test' }, inp())
    expect(named.state.attention.map((a) => [a.key, a.source])).toEqual([[K, 'hook']])
    expect(n1(named.effects), 'one prompt, one N1').toEqual([])
    expect(named.effects).toContainEqual({ k: 'rekey', from: STATUS_FILE_KEY, to: K })
    // idle from working: a turn no hook started (hooks off) is finished: ready, unread, N2
    const working = step(inPhase('ready'), file('busy'), inp({ source: 'status-file', mono: 5n * S })).state
    const done = step(working, file('idle'), inp({ source: 'status-file', mono: 25n * S }))
    expect(done.state).toMatchObject({ phase: 'ready', unread: true })
    expect(done.effects).toContainEqual({ k: 'N2', turnMs: 20_000, lastMessage: null, background: false })
    expect(step(working, file('shell'), sf).state, 'a background shell left running: background work').toMatchObject({ phase: 'ready', background: true })
    // a turn a hook started ends with its Stop, or the adapter's interrupt rule after its grace
    const hooked = step(inPhase('ready'), { t: 'turn.started' }, inp()).state
    expect(step(hooked, file('idle'), sf).state.phase).toBe('working')
    // idle while starting: the agent waits at its prompt (an argv prompt keeps it starting until its turn)
    expect(step(inPhase('starting'), file('idle'), sf).state.phase).toBe('idle')
    expect(step(inPhase('starting'), file('idle'), inp({ source: 'status-file', prompt: true })).state.phase).toBe('starting')
    // an unknown wait: shown as a question the file only estimates, with no notification (Kea never guesses loudly)
    const unknown = step(inPhase('working'), file('waiting', 'unknown', 'goal vote'), sf)
    expect(unknown.state).toMatchObject({ phase: 'blocked', attention: [{ kind: 'question', key: STATUS_FILE_KEY, summary: 'goal vote', source: 'status-file', estimated: true }] })
    expect(n1(unknown.effects)).toEqual([])
    // … and a hook that then names a prompt is news
    expect(n1(step(unknown.state, { t: 'attention.permission', key: K, tool: 'Bash', summary: 'npm test' }, inp()).effects)).toHaveLength(1)
  })
})

const rec = (source: StatusSource, mono: bigint, ...events: TableEvent[]): Omit<SignalRecord, 'seq'> => ({ source, mono, at: T0 + Number(mono / 1_000_000n), spooled: false, events })

function started(): SessionMachine {
  const m = new SessionMachine({ start: initialStatus(T0), startMono: 0n, prompt: false, noTurns: false })
  m.apply(rec('reconcile', 0n, { t: 'pty.spawned' }), false)
  m.apply(rec('hook', S, { t: 'session.started', agentSessionId: 'a', source: 'startup' }), false)
  return m
}

describe('precedence, subagents and order', () => {
  it('U-ST-2 · a heuristic event within L.heuristicSuppressMs of an exact one is ignored; later it applies but never removes an attention item', () => {
    const suppress = BigInt(L.heuristicSuppressMs) * 1_000_000n
    const m = started()
    m.apply(rec('hook', 2n * S, { t: 'turn.started' }), false)
    const early = m.apply(rec('heuristic', 2n * S + suppress - 1n, { t: 'turn.finished', backgroundWork: false }), false)
    expect(early.steps[0]!.ignored).toBe(true)
    expect(m.state.phase).toBe('working')
    const late = m.apply(rec('heuristic', 2n * S + suppress, { t: 'turn.finished', backgroundWork: false }), false)
    expect(late.steps[0]!.ignored).toBe(false)
    expect(m.state.phase).toBe('ready')
    // a tier-1b or tier-2 input counts as exact too
    for (const exact of ['status-file', 'transcript'] as const) {
      const n = started()
      n.apply(rec(exact, 3n * S, { t: 'turn.started' }), false)
      expect(n.apply(rec('heuristic', 4n * S, { t: 'turn.finished', backgroundWork: false }), false).steps[0]!.ignored, exact).toBe(true)
    }
    // past the window, still no removal: blocked stays blocked
    const b = started()
    b.apply(rec('hook', 2n * S, { t: 'attention.permission', key: K, tool: 'Bash', summary: 'npm test' }), false)
    for (const ev of [{ t: 'turn.finished', backgroundWork: false }, { t: 'turn.interrupted' }, { t: 'attention.cleared' }, { t: 'turn.started' }, { t: 'turn.failed', error: 'x', kind: 'other' }] as TableEvent[]) {
      b.apply(rec('heuristic', 2n * S + suppress * 2n, ev), false)
      expect(b.state.phase, ev.t).toBe('blocked')
    }
    // a heuristic may add one (a bell, an OSC notification)
    const q = started()
    q.apply(rec('heuristic', S + suppress, { t: 'attention.question', key: 'bell', summary: 'bell' }), false)
    expect(q.state.attention.map((a) => a.source)).toEqual(['heuristic'])
  })

  it('U-ST-2 · the user-input rule: keystrokes while blocked, then a second of output (tier 3) with no new attention event → hook permission items cleared, journaled as user + heuristic; questions stay', () => {
    const m = started()
    m.apply(rec('hook', 2n * S, { t: 'attention.permission', key: K, tool: 'Bash', summary: 'npm test' }), false)
    // output without a keystroke first: ignored (within the window) and could not clear anyway
    m.apply(rec('heuristic', 3n * S, { t: 'turn.started' }), false)
    expect(m.state.phase).toBe('blocked')
    m.apply(rec('user', 3n * S, { t: 'user.typed' }), false)
    const r = m.apply(rec('heuristic', 4n * S, { t: 'turn.started' }), false)
    expect(m.state).toMatchObject({ phase: 'working', attention: [] })
    expect(r.steps[0]!.result.note).toBe('user + heuristic')
    // a new attention event after the keystroke resets it; a question is not cleared by the rule
    const n = started()
    n.apply(rec('hook', 2n * S, { t: 'attention.question', key: 'q', summary: 'Which?' }), false)
    n.apply(rec('user', 3n * S, { t: 'user.typed' }), false)
    n.apply(rec('hook', 4n * S, { t: 'attention.permission', key: K, tool: 'Bash' }), false)
    n.apply(rec('heuristic', 5n * S, { t: 'turn.started' }), false)
    expect(n.state.attention.length).toBe(2)
    n.apply(rec('user', 6n * S, { t: 'user.typed' }), false)
    n.apply(rec('heuristic', 7n * S, { t: 'turn.started' }), false)
    expect(n.state).toMatchObject({ phase: 'blocked', attention: [expect.objectContaining({ key: 'q' })] })
  })

  it('U-ST-3 · subagent events neither finish the turn nor add or clear main-agent attention, nor move ready back to working', () => {
    const m = started()
    m.apply(rec('hook', 2n * S, { t: 'turn.started' }), false)
    m.apply(rec('hook', 3n * S, { t: 'tool.started', name: 'Task', subagent: true }, { t: 'tool.finished', name: 'Task', ok: true, subagent: true }), false)
    expect(m.state.phase).toBe('working')
    m.apply(rec('hook', 4n * S, { t: 'attention.permission', key: K, tool: 'Bash' }), false)
    m.apply(rec('hook', 5n * S, { t: 'tool.started', name: 'Read', subagent: true }, { t: 'tool.finished', name: 'Read', ok: true, subagent: true }), false)
    expect(m.state).toMatchObject({ phase: 'blocked', attention: [expect.objectContaining({ key: K })] })
    m.apply(rec('hook', 6n * S, { t: 'turn.finished', backgroundWork: true }), false)
    // a background subagent keeps working after Stop: the row stays ready
    m.apply(rec('hook', 7n * S, { t: 'tool.started', name: 'Bash', subagent: true }), false)
    expect(m.state).toMatchObject({ phase: 'ready', background: true })
  })

  it('U-ST-4 · order: inputs apply by their mono stamp — a late one is put in its place and the status recomputed; one older than the ring’s base is dropped; the ring keeps L.signalRingEntries', () => {
    // arrival: permission (mono 4) before its tool's start (mono 3) — the result is as if in order: blocked
    const m = started()
    m.apply(rec('hook', 2n * S, { t: 'turn.started' }), false)
    m.apply(rec('hook', 4n * S, { t: 'attention.permission', key: K, tool: 'Bash' }), false)
    const late = m.apply(rec('hook', 3n * S, { t: 'tool.started', name: 'Bash' }), false)
    expect(late.reordered).toBe(true)
    expect(m.state).toMatchObject({ phase: 'blocked' })
    // and the other way round: turn.finished (6) applied, then a spooled attention (5) drained late → ready, not blocked
    m.apply(rec('hook', 6n * S, { t: 'turn.finished', backgroundWork: false }), false)
    const spooled = m.apply({ ...rec('hook', 5n * S, { t: 'attention.question', key: 'q' }), spooled: true }, false)
    expect(spooled.reordered).toBe(true)
    expect(m.state).toMatchObject({ phase: 'ready', attention: [] })
    expect(m.ring.map((r) => r.mono)).toEqual([...m.ring.map((r) => r.mono)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    // before the agent started: an earlier agent's
    const fresh = new SessionMachine({ start: initialStatus(T0), startMono: 10n * S, prompt: false, noTurns: false })
    expect(fresh.apply(rec('hook', 9n * S, { t: 'turn.started' }), false).dropped).toBe(true)
    // bounded ring; the base moves with it and a late input older than the base is dropped
    for (let i = 0; i < L.signalRingEntries + 10; i++) m.apply(rec('hook', 100n * S + BigInt(i), { t: 'tool.started', name: 'Read' }), false)
    expect(m.ring.length).toBe(L.signalRingEntries)
    expect(m.apply(rec('hook', 50n * S, { t: 'attention.question', key: 'old' }), false).dropped).toBe(true)
    expect(m.state.phase).toBe('working')
  })

  it('U-ST-19 · the transcript’s usage updates (meta only) stay out of the recent-signal ring: a long answer’s hundreds of them cannot push the turn’s hooks out of a report; their values hold through a reordered input', () => {
    const m = started()
    m.apply(rec('hook', 2n * S, { t: 'turn.started' }), false)
    m.apply(rec('hook', 3n * S, { t: 'tool.started', name: 'Bash' }), false)
    const hooks = m.ring.length
    // one usage record per assistant message, more than the ring holds
    for (let i = 1; i <= L.signalRingEntries + 50; i++) m.apply(rec('transcript', 4n * S + BigInt(i), { t: 'meta', model: 'opus', costUsd: i / 100, contextUsedPct: i % 100 }), false)
    expect(m.ring.length, 'the ring holds the hooks, not the usage').toBe(hooks)
    expect(m.ring.map((r) => r.source)).not.toContain('transcript')
    expect(m.state).toMatchObject({ phase: 'working', model: 'opus', costUsd: (L.signalRingEntries + 50) / 100 })
    // a late hook placed in the ring recomputes the status from the ring's base: the usage is kept
    m.apply(rec('hook', 6n * S, { t: 'tool.finished', name: 'Bash', ok: true }), false)
    const late = m.apply({ ...rec('hook', 5n * S, { t: 'tool.started', name: 'Read' }), spooled: true }, false)
    expect(late.reordered).toBe(true)
    expect(m.state).toMatchObject({ phase: 'working', model: 'opus', costUsd: (L.signalRingEntries + 50) / 100 })
    // a transcript record that is more than usage (a turn's end) is a signal like any other
    m.apply(rec('transcript', 9n * S, { t: 'turn.finished', backgroundWork: false }), false)
    expect(m.ring.at(-1)!.source).toBe('transcript')
  })
})
