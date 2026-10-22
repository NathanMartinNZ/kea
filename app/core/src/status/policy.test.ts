import { Emitter } from '@kea/kit'
import { KeyedStore, L, type AccountCondition, type AttentionItem, type NotificationOp, type SessionView } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StatusNotice } from './notices.ts'
import { clip, NotificationPolicy, oneLine, type NotifySettings } from './policy.ts'

afterEach(() => vi.useRealTimers())

const item = (key: string, kind: AttentionItem['kind'] = 'permission', summary = key): AttentionItem => ({ kind, key, summary, source: 'hook', at: 1 })

function view(id: string, o: Partial<SessionView> = {}): SessionView {
  return { id, projectId: 'p1', title: `Task ${id}`, lifecycle: 'live', endReason: null, phase: 'working', attention: [], unread: false, failureKind: null, lastActivityAt: 0, glyph: 'working', agent: 'claude', ...o } as SessionView
}

interface H {
  p: NotificationPolicy
  out: NotificationOp[]
  sessions: KeyedStore<SessionView>
  conditions: KeyedStore<AccountCondition>
  settings: NotifySettings
  fire(n: StatusNotice): void
  /** Advance the monotonic clock (and timers) by `ms`. */
  tick(ms: number): void
  view: { id: string | null }
  posts(): Extract<NotificationOp, { op: 'post' }>[]
  withdrawn(): string[]
  exits: Map<string, { code: number | null; signal: number | null }>
}

function harness(ids: string[] = ['a', 'b', 'c', 'd', 'e', 'f'], o: { before?: (s: KeyedStore<SessionView>) => void } = {}): H {
  vi.useFakeTimers()
  const sessions = new KeyedStore<SessionView>('sessions')
  for (const id of ids) sessions.set(id, view(id))
  o.before?.(sessions)
  const conditions = new KeyedStore<AccountCondition>('status.conditions')
  const notices = new Emitter<StatusNotice>({ name: 'test.notices' })
  const settings: NotifySettings = { needsYou: true, finished: true, failed: true, sound: false, onlyWhenUnfocused: true }
  const out: NotificationOp[] = []
  const viewing = { id: null as string | null }
  const exits = new Map<string, { code: number | null; signal: number | null }>()
  let mono = 10_000
  const p = new NotificationPolicy({
    notices: (cb) => notices.event(cb),
    sessions,
    conditions,
    projectName: (id) => (id === 'p1' ? 'kea' : null),
    agentName: (a) => (a === 'claude' ? 'Claude Code' : a),
    settings: () => settings,
    viewing: () => viewing.id,
    exitOf: (id) => exits.get(id) ?? null,
    mono: () => mono,
    out: (x) => out.push(x),
  })
  return {
    p,
    out,
    sessions,
    conditions,
    settings,
    view: viewing,
    exits,
    fire: (n) => notices.fire(n),
    tick: (ms) => {
      mono += ms
      vi.advanceTimersByTime(ms)
    },
    posts: () => out.filter((x): x is Extract<NotificationOp, { op: 'post' }> => x.op === 'post'),
    withdrawn: () => out.filter((x) => x.op === 'withdraw').map((x) => x.tag),
  }
}

const n1 = (sessionId: string, key = 'Bash: npm test', o: Partial<AttentionItem> = {}, trust = false): StatusNotice => ({ k: 'N1', sessionId, item: { ...item(key), ...o }, trust })
const n2 = (sessionId: string, turnMs: number | null = L.notifyMinTurnMs, lastMessage: string | null = 'All tests pass.', background = false): StatusNotice => ({ k: 'N2', sessionId, turnMs, lastMessage, background })

describe('the notification policy', () => {
  it('U-NT-1 · not while viewed (or, by default, while Kea has focus; the trust question only unfocused); N2 only for turns ≥ L.notifyMinTurnMs; one live per session, replaced; a burst of L.notifyBurstCount sessions within L.notifyBurstMs collapses into one; withdrawn when the reason goes', () => {
    const h = harness()
    // Kea focused (onlyWhenUnfocused, the default): nothing; the session viewed: nothing
    h.p.setAppFocused(true)
    h.fire(n1('a'))
    h.settings.onlyWhenUnfocused = false
    h.view.id = 'a'
    h.fire(n1('a'))
    expect(h.out, 'viewed, or Kea focused').toEqual([])
    // focused but another session is viewed (the setting off): posted; the trust question still waits for unfocus
    h.view.id = 'b'
    h.fire(n1('a', 'trust', { kind: 'question', summary: 'Trust this folder? — answer in the terminal' }, true))
    expect(h.out).toEqual([])
    h.fire(n1('a'))
    expect(h.posts()).toEqual([{ op: 'post', tag: 's:a', sessionId: 'a', title: 'Task a · needs permission', subtitle: 'kea', body: 'Bash: npm test', sound: false }])
    h.fire({ k: 'withdraw', sessionId: 'a' })
    h.p.setAppFocused(false)
    h.settings.onlyWhenUnfocused = true
    h.view.id = null
    h.out.length = 0

    // A turn shorter than L.notifyMinTurnMs finishing posts nothing; one at least that long posts N2
    h.fire(n2('b', L.notifyMinTurnMs - 1))
    expect(h.out).toEqual([])
    h.fire(n2('b'))
    expect(h.posts().map((x) => [x.tag, x.title, x.body])).toEqual([['s:b', 'Task b · finished', 'All tests pass.']])
    // one live per session: a new one for b replaces it (the same tag; main closes the old one)
    h.fire({ k: 'N3', sessionId: 'b', reason: 'overloaded' })
    expect(h.posts().map((x) => [x.tag, x.title])).toEqual([
      ['s:b', 'Task b · finished'],
      ['s:b', 'Task b · failed'],
    ])
    expect(h.p.liveTags()).toEqual(['s:b'])

    // An answered item withdraws its own notification only; a withdrawal without keys takes whatever is live
    h.tick(L.notifyBurstMs + 1)
    h.out.length = 0
    h.fire(n1('c', 'Bash: rm -rf build'))
    h.fire({ k: 'withdraw', sessionId: 'c', keys: ['Edit: src/a.ts'] })
    expect(h.withdrawn(), 'another item answered').toEqual([])
    h.fire({ k: 'withdraw', sessionId: 'c', keys: ['Bash: rm -rf build'] })
    expect(h.withdrawn()).toEqual(['s:c'])
    h.fire({ k: 'withdraw', sessionId: 'b' })
    expect(h.withdrawn()).toEqual(['s:c', 's:b'])
    h.fire({ k: 'withdraw', sessionId: 'b' })
    expect(h.withdrawn(), 'nothing live: nothing to withdraw').toEqual(['s:c', 's:b'])
    expect(h.p.liveTags()).toEqual([])

    // The burst: L.notifyBurstCount sessions within L.notifyBurstMs collapse into one; the ones posted are withdrawn
    h.tick(L.notifyBurstMs + 1)
    h.out.length = 0
    const burst = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, L.notifyBurstCount)
    for (const id of burst) {
      h.fire(n1(id))
      h.tick(Math.floor(L.notifyBurstMs / (L.notifyBurstCount + 1)))
    }
    expect(h.posts().filter((x) => x.tag.startsWith('s:')).map((x) => x.sessionId)).toEqual(burst.slice(0, -1))
    expect(h.withdrawn()).toEqual(burst.slice(0, -1).map((id) => `s:${id}`))
    const summary = h.posts().at(-1)!
    expect(summary).toMatchObject({ tag: 'burst', sessionId: null, title: `${L.notifyBurstCount} sessions need you` })
    expect(summary.body).toBe(burst.map((id) => `Task ${id}`).join(', '))
    expect(h.p.liveTags()).toEqual(['burst'])
    // one more within the window joins it, updated in place
    h.fire(n2('f'))
    expect(h.posts().at(-1)).toMatchObject({ tag: 'burst', title: `${L.notifyBurstCount + 1} sessions need you` })
    // the burst's sessions are answered: it goes with the last of them
    for (const id of [...burst, 'f']) h.fire({ k: 'withdraw', sessionId: id })
    expect(h.withdrawn().at(-1)).toBe('burst')
    expect(h.p.liveTags()).toEqual([])
    // past the window, posts are single again
    h.tick(L.notifyBurstMs + 1)
    h.fire(n1('a'))
    expect(h.posts().at(-1)!.tag).toBe('s:a')

    // A session archived or deleted takes its notification along; an account condition's goes when it clears
    h.sessions.set('a', view('a', { lifecycle: 'archived' }))
    expect(h.withdrawn().at(-1)).toBe('s:a')
    const c: AccountCondition = { agent: 'claude', kind: 'rate_limit', state: 'active', since: 0, resetsAt: null, sessionIds: ['b'] }
    h.conditions.set('claude', c)
    h.fire({ k: 'N4', condition: c })
    expect(h.posts().at(-1)!.tag).toBe('c:claude')
    h.conditions.delete('claude')
    expect(h.withdrawn().at(-1)).toBe('c:claude')
    h.p.dispose()
    expect(h.p.resourceCounts).toEqual({ live: 0, recent: 0, burst: 0, timers: 0 })
  })

  it('U-NT-3 · bodies: the tool and its one-line summary (never what follows it: file contents), the last message, the error kind or exit; control characters removed; cut at L.notifyBodyMaxChars on a grapheme boundary', () => {
    const h = harness()
    // a Write tool's summary as an adapter that went wrong would give it: the path, then the file
    h.fire(n1('a', 'Write: src/secret.ts', { summary: 'src/secret.ts\nexport const TOKEN = "hunter2"\n' }))
    expect(h.posts()[0]!.body, 'the tool and its one-line summary (the key)').toBe('Write: src/secret.ts')
    h.fire(n1('b', 'q', { kind: 'question', summary: 'Which database?\u001b[31m Postgres or SQLite?' }))
    expect(h.posts()[1]).toMatchObject({ title: 'Task b · has a question', body: 'Which database? [31m Postgres or SQLite?' })
    // N2: the agent's last message, one line, cut; background work noted
    const long = `${'Refactored the parser and '.repeat(8)}done.`
    h.tick(L.notifyBurstMs + 1)
    h.fire(n2('c', L.notifyMinTurnMs, `First line\n${long}`, true))
    const b = h.posts()[2]!.body.split('\n')
    expect(b[0]!.length).toBeLessThanOrEqual(L.notifyBodyMaxChars)
    expect(b[0]!.startsWith('First line Refactored')).toBe(true)
    expect(b[0]!.endsWith('…')).toBe(true)
    expect(b[1]).toBe('(background tasks still running)')
    // N3: the error kind; a crash by its exit code or signal, a lost terminal
    h.exits.set('d', { code: 1, signal: null })
    h.exits.set('e', { code: null, signal: 9 })
    h.tick(L.notifyBurstMs + 1)
    h.fire({ k: 'N3', sessionId: 'd', reason: 'crashed' })
    h.tick(L.notifyBurstMs + 1)
    h.fire({ k: 'N3', sessionId: 'e', reason: 'crashed' })
    h.tick(L.notifyBurstMs + 1)
    h.fire({ k: 'N3', sessionId: 'f', reason: 'lost' })
    h.tick(L.notifyBurstMs + 1)
    h.fire({ k: 'N3', sessionId: 'a', reason: 'overloaded' })
    expect(h.posts().slice(3).map((x) => x.body)).toEqual(['exited 1', 'killed by signal 9', 'terminal lost', 'overloaded'])
    // a title from the agent is data: one line, no control characters
    h.sessions.set('b', view('b', { title: 'Fix\u0007 login\r\nbug' }))
    h.tick(L.notifyBurstMs + 1)
    h.fire(n1('b'))
    expect(h.posts().at(-1)!.title).toBe('Fix login bug · needs permission')

    // a permission item without a tool in its key (raised by a notification): its summary
    h.tick(L.notifyBurstMs + 1)
    h.fire({ k: 'withdraw', sessionId: 'c' })
    h.fire(n1('c', 'prompt:permission', { summary: 'The agent needs your permission to use Bash' }))
    expect(h.posts().at(-1)!.body).toBe('The agent needs your permission to use Bash')

    // the cut: on a grapheme boundary, never through an emoji sequence or a letter with its accent
    const family = '👩‍👩‍👧‍👦' // 11 UTF-16 units, one grapheme
    const s = 'x'.repeat(L.notifyBodyMaxChars - 5) + family + 'tail'
    const cut = clip(s)
    expect(cut.length).toBeLessThanOrEqual(L.notifyBodyMaxChars)
    expect(cut).toBe(`${'x'.repeat(L.notifyBodyMaxChars - 5)}…`)
    const accents = 'é'.repeat(L.notifyBodyMaxChars)
    const cut2 = clip(accents)
    expect(cut2.endsWith('é…')).toBe(true)
    expect(cut2.length).toBeLessThanOrEqual(L.notifyBodyMaxChars)
    expect(clip('short')).toBe('short')
    expect(oneLine(' a\n\tb\u009bc ')).toBe('a b c')
  })

  it('U-NT-4 · sound only for needs-you, only when switched on; each kind its own switch (N4 and N5 follow Failed); N4 updated in place, then N5; after a relaunch at most one summary of what changed while Kea was closed', async () => {
    const h = harness()
    h.fire(n1('a'))
    h.settings.sound = true
    h.tick(L.notifyBurstMs + 1)
    h.fire(n1('b'))
    h.tick(L.notifyBurstMs + 1)
    h.fire(n2('c'))
    expect(h.posts().map((x) => [x.sessionId, x.sound])).toEqual([
      ['a', false],
      ['b', true],
      ['c', false],
    ])
    // Each kind off by its own switch
    h.out.length = 0
    h.settings.needsYou = false
    h.settings.finished = false
    h.tick(L.notifyBurstMs + 1)
    h.fire(n1('d'))
    h.fire(n2('d'))
    expect(h.out).toEqual([])
    h.fire({ k: 'N3', sessionId: 'd', reason: 'overloaded' })
    expect(h.posts().map((x) => x.title)).toEqual(['Task d · failed'])
    // N4 updated in place as sessions join (one tag per agent), then N5 at the reset; off with Failed
    const resetsAt = new Date(2026, 9, 10, 15, 0).getTime()
    const c1: AccountCondition = { agent: 'claude', kind: 'rate_limit', state: 'active', since: 0, resetsAt, sessionIds: ['a'] }
    h.fire({ k: 'N4', condition: c1 })
    h.fire({ k: 'N4', condition: { ...c1, sessionIds: ['a', 'b', 'c', 'd'] } })
    h.fire({ k: 'N5', condition: { ...c1, state: 'reset', sessionIds: ['a', 'b', 'c', 'd'] } })
    expect(h.posts().slice(1).map((x) => [x.tag, x.title, x.body, x.sessionId])).toEqual([
      ['c:claude', 'Claude Code · usage limit reached', '1 session waiting · resets 15:00', 'a'],
      ['c:claude', 'Claude Code · usage limit reached', '4 sessions waiting · resets 15:00', 'a'],
      ['c:claude', 'Claude Code · limit reset', '4 sessions waiting', 'a'],
    ])
    h.fire({ k: 'N4', condition: { agent: 'claude', kind: 'auth', state: 'active', since: 0, resetsAt: null, sessionIds: ['e'] } })
    expect(h.posts().at(-1)).toMatchObject({ title: 'Claude Code · signed out', body: '1 session waiting' })
    h.settings.failed = false
    h.out.length = 0
    h.fire({ k: 'N3', sessionId: 'e', reason: 'overloaded' })
    h.fire({ k: 'N5', condition: c1 })
    expect(h.out).toEqual([])
    h.p.dispose()

    // A relaunch. Two sessions needed you already when Kea quit; while it was closed, four more came to (their
    // spooled events and the launch reconcile notify nothing), one of which posts its own once live. The
    // summary names the others in ⌘J's order
    const r = harness(['a', 'b', 'c', 'd', 'e', 'f'], {
      before: (s) => {
        s.set('a', view('a', { phase: 'blocked', attention: [item('k')], glyph: 'needsYou' }))
        s.set('b', view('b', { phase: 'ready', unread: true, glyph: 'unread' }))
      },
    })
    let started!: () => void
    r.p.settleAfter(new Promise<void>((resolve) => (started = resolve)))
    for (const id of ['c', 'd']) r.sessions.set(id, view(id, { phase: 'ready', unread: true, glyph: 'unread' }))
    r.sessions.set('e', view('e', { lifecycle: 'detached', endReason: 'crashed', glyph: 'failed' }))
    r.sessions.set('f', view('f', { phase: 'blocked', attention: [item('k')], glyph: 'needsYou' }))
    r.fire(n1('f'))
    // a session started since the launch did not change while Kea was closed, even when it needs you unannounced (its
    // request came while the window viewed it)
    r.sessions.set('g', view('g', { phase: 'blocked', attention: [item('k')], glyph: 'needsYou' }))
    r.view.id = 'g'
    r.fire(n1('g'))
    // and the session the window views when startup settles is not news either
    r.view.id = 'd'
    started()
    await Promise.resolve()
    r.tick(L.unconfirmedStatusMs - 1)
    expect(r.posts().map((x) => x.tag)).toEqual(['s:f'])
    r.tick(1)
    expect(r.posts().slice(1)).toEqual([{ op: 'post', tag: 'summary', sessionId: null, title: '2 sessions changed while Kea was closed', subtitle: '', body: 'Task e, Task c', sound: false }])
    // once: nothing more later
    r.tick(L.unconfirmedStatusMs * 2)
    expect(r.posts()).toHaveLength(2)
    expect(r.p.resourceCounts.timers, 'the time-to-live timer only').toBe(1)
    r.p.dispose()
  })

  it('U-NT-6 · a notification is forgotten L.notificationTtlMs after it was posted, by the monotonic clock: one timer while any is live, none after', () => {
    const h = harness()
    h.fire(n1('a'))
    h.tick(L.notifyBurstMs + 1)
    h.fire(n1('b'))
    expect(h.p.resourceCounts).toMatchObject({ live: 2, timers: 1 })
    h.tick(L.notificationTtlMs - L.notifyBurstMs - 1)
    expect(h.p.liveTags()).toEqual(['s:b'])
    h.tick(L.notifyBurstMs + 1)
    expect(h.p.resourceCounts).toMatchObject({ live: 0, timers: 0 })
    // forgotten, not withdrawn: main expires its own (notifier.ts)
    expect(h.withdrawn()).toEqual([])
  })

  it('U-NT-9 · a finished turn that goes on (the status file busy again) withdraws its N2; a hook item that replaces the status file’s item for the same prompt takes over its N1, so answering the hook’s item withdraws it', () => {
    const h = harness()
    h.fire(n2('a'))
    expect(h.p.liveTags()).toEqual(['s:a'])
    h.fire({ k: 'withdraw', sessionId: 'a' })
    expect(h.withdrawn()).toEqual(['s:a'])
    // the file showed the prompt first (N1 for its item), then the hook named it
    h.tick(L.notifyBurstMs + 1)
    h.fire(n1('b', 'status-file', { source: 'status-file', summary: 'permission prompt' }))
    h.fire({ k: 'rekey', sessionId: 'b', from: 'status-file', to: 'Bash: npm test' })
    expect(h.posts().filter((x) => x.tag === 's:b')).toHaveLength(1)
    h.fire({ k: 'withdraw', sessionId: 'b', keys: ['status-file'] })
    expect(h.p.liveTags(), 'the file’s key is not the notification’s any more').toEqual(['s:b'])
    h.fire({ k: 'withdraw', sessionId: 'b', keys: ['Bash: npm test'] })
    expect(h.withdrawn()).toEqual(['s:a', 's:b'])
  })
})
