import { allPairs, createFsm } from '@kea/kit'
import { badgeCount, KeyedStore, L, LIFECYCLE, sessionGlyph, type AccountCondition, type AttentionItem, type MenuBarState, type SessionView } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LIFECYCLE_EVENTS, LIFECYCLE_TABLE, needsYou, nextLifecycle, watchMenuBar } from './lifecycle.ts'

/** Every edge of the session lifecycle, written out by hand rather than read from the table under test. */
const EXPECTED: Record<string, string> = {
  'creating launched': 'live',
  'creating failed': 'create_failed',
  'create_failed retry': 'creating',
  'live agentEnded': 'detached',
  'live archive': 'archived',
  'live delete': 'deleted',
  'detached launched': 'live',
  'detached archive': 'archived',
  'detached delete': 'deleted',
  'archived unarchive': 'detached',
  'archived delete': 'deleted',
  'deleted restore': 'detached',
}

describe('the session lifecycle table', () => {
  it('U-SES-3 · every state × event pair: the diagram’s edges move the state, every other pair is refused and changes nothing', () => {
    const pairs = allPairs(LIFECYCLE_TABLE, LIFECYCLE, LIFECYCLE_EVENTS)
    expect(pairs).toHaveLength(LIFECYCLE.length * LIFECYCLE_EVENTS.length)
    for (const { state, event, handled } of pairs) {
      const want = EXPECTED[`${state} ${event}`]
      expect(handled, `${state} × ${event}`).toBe(want !== undefined)
      const fsm = createFsm(LIFECYCLE_TABLE, { state })
      const r = fsm.send({ t: event } as never)
      expect(r.to, `${state} × ${event}`).toBe(want ?? state)
      expect(nextLifecycle(state, event)).toBe(want ?? null)
    }
  })

  it('U-SES-4 · the sidebar glyph from lifecycle, phase, attention and end reason', () => {
    const base = { lifecycle: 'live', endReason: null, phase: 'idle', attention: [], unread: false, failureKind: null } as Pick<SessionView, 'lifecycle' | 'endReason' | 'phase' | 'attention' | 'unread' | 'failureKind'>
    const g = (o: Partial<typeof base>) => sessionGlyph({ ...base, ...o })
    expect(g({ lifecycle: 'creating' })).toBe('working')
    expect(g({ lifecycle: 'create_failed' })).toBe('failed')
    expect(g({ phase: 'starting' })).toBe('working')
    expect(g({ phase: 'working' })).toBe('working')
    expect(g({ phase: 'blocked', attention: [{ kind: 'permission', key: 'k', summary: 's', source: 'hook', at: 1 }] })).toBe('needsYou')
    expect(g({ phase: 'ready', unread: true })).toBe('unread')
    expect(g({ phase: 'ready' })).toBe('idle')
    expect(g({ phase: 'idle' })).toBe('idle')
    expect(g({ phase: 'failed', failureKind: 'other' })).toBe('failed')
    for (const k of ['rate_limit', 'auth', 'billing'] as const) expect(g({ phase: 'failed', failureKind: k })).toBe('limited')
    expect(g({ lifecycle: 'detached', endReason: 'stopped' })).toBe('detached')
    expect(g({ lifecycle: 'detached', endReason: 'exited' })).toBe('detached')
    expect(g({ lifecycle: 'detached', endReason: 'crashed' })).toBe('failed')
    expect(g({ lifecycle: 'detached', endReason: 'lost' })).toBe('failed')
    expect(g({ lifecycle: 'archived', endReason: 'stopped' })).toBe('detached')
  })
})

describe('what ⌘Q and the menu-bar item need', () => {
  afterEach(() => vi.useRealTimers())

  const view = (id: string, o: Partial<SessionView>) => {
    const v = { id, title: `title ${id}`, lifecycle: 'live', endReason: null, phase: 'working', attention: [], unread: false, failureKind: null, lastActivityAt: 0, ...o } as SessionView
    return { ...v, glyph: sessionGlyph(v) }
  }

  it('U-SES-5 · core tells main the sessions ⌘Q keeps running, the On quit setting and the sessions that need you, at once and then at most once per store tick, only when it changed', () => {
    vi.useFakeTimers()
    const store = new KeyedStore<SessionView>('sessions')
    store.setMany([
      ['a', view('a', { lifecycle: 'live' })],
      ['b', view('b', { lifecycle: 'creating' })],
      ['c', view('c', { lifecycle: 'detached', endReason: 'crashed' })],
      ['d', view('d', { lifecycle: 'detached', endReason: 'stopped' })],
      ['e', view('e', { lifecycle: 'detached', endReason: 'lost' })],
      ['f', view('f', { lifecycle: 'archived', endReason: 'crashed' })],
    ])
    let onQuit: MenuBarState['onQuit'] = 'menuBar'
    const settingsListeners = new Set<() => void>()
    const sent: MenuBarState[] = []
    const w = watchMenuBar({ sessions: store, onQuit: () => onQuit, onSettings: (cb) => (settingsListeners.add(cb), () => settingsListeners.delete(cb)), send: (x) => sent.push(x) })
    expect(sent).toEqual([
      {
        live: 2,
        onQuit: 'menuBar',
        count: 2,
        sessions: [
          { id: 'c', title: 'title c', reason: 'crashed', glyph: 'failed' },
          { id: 'e', title: 'title e', reason: 'lost', glyph: 'failed' },
        ],
        badge: true,
      },
    ])
    // three changes in one tick: one message
    store.set('a', view('a', { lifecycle: 'detached', endReason: 'exited' }))
    store.set('b', view('b', { lifecycle: 'live' }))
    store.delete('c')
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(L.storeTickMs)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({ live: 1, onQuit: 'menuBar', count: 1, sessions: [{ id: 'e', title: 'title e', reason: 'lost', glyph: 'failed' }], badge: true })
    // a change that changes nothing main sees (a title of a session it does not list) sends nothing
    store.set('d', view('d', { lifecycle: 'detached', endReason: 'stopped', title: 'renamed' }))
    vi.advanceTimersByTime(L.storeTickMs)
    expect(sent).toHaveLength(2)
    // the setting changes
    onQuit = 'stopAll'
    for (const l of settingsListeners) l()
    vi.advanceTimersByTime(L.storeTickMs)
    expect(sent.at(-1)).toMatchObject({ onQuit: 'stopAll', live: 1 })
    w.dispose()
    expect(settingsListeners.size).toBe(0)
    expect(store.listenerCount).toBe(0)
    store.set('e', view('e', { lifecycle: 'live' }))
    vi.advanceTimersByTime(L.storeTickMs)
    expect(sent).toHaveLength(3)
  })
})

describe('the needs-you count and list', () => {
  afterEach(() => vi.useRealTimers())

  const item = (kind: AttentionItem['kind'], at: number): AttentionItem => ({ kind, key: `${kind}-${at}`, summary: 's', source: 'hook', at })
  const view = (id: string, o: Partial<SessionView>) => {
    const v = { id, title: `T${id}`, lifecycle: 'live', endReason: null, phase: 'working', attention: [], unread: false, failureKind: null, lastActivityAt: 0, agent: 'claude', ...o } as SessionView
    return { ...v, glyph: sessionGlyph(v) }
  }

  it('U-NT-2 · the count is the attention set in its order (blocked oldest first, failed and crashed, unread ready), each line with its glyph and why; an account condition counts once, as one line; nothing archived or deleted; the badge switch goes along; main hears of a condition change', () => {
    const views = [
      view('ready', { phase: 'ready', unread: true, lastActivityAt: 5 }),
      view('read', { phase: 'ready', unread: false }),
      view('q', { phase: 'blocked', attention: [item('question', 20)] }),
      view('perm', { phase: 'blocked', attention: [item('permission', 10)] }),
      view('fail', { phase: 'failed', failureKind: 'overloaded', unread: true, lastActivityAt: 3 }),
      view('crash', { lifecycle: 'detached', endReason: 'crashed', lastActivityAt: 4 }),
      view('stopped', { lifecycle: 'detached', endReason: 'stopped' }),
      view('lim1', { phase: 'failed', failureKind: 'rate_limit', unread: true }),
      view('lim2', { phase: 'failed', failureKind: 'rate_limit', unread: true }),
      view('arch', { lifecycle: 'archived', endReason: 'crashed' }),
      view('del', { lifecycle: 'deleted', endReason: 'lost' }),
      view('work', { phase: 'working' }),
    ]
    const cond: AccountCondition = { agent: 'claude', kind: 'rate_limit', state: 'active', since: 1, resetsAt: null, sessionIds: ['lim1', 'lim2'] }
    const r = needsYou(views, [cond], (a) => (a === 'claude' ? 'Claude Code' : a))
    expect(r.sessions.map((x) => [x.id, x.reason, x.glyph])).toEqual([
      ['perm', 'permission', 'needsYou'],
      ['q', 'question', 'needsYou'],
      ['fail', 'failed', 'failed'],
      ['crash', 'crashed', 'failed'],
      ['ready', 'finished', 'unread'],
      ['lim1', 'limited', 'limited'],
    ])
    expect(r.sessions.at(-1)!.title, 'the condition’s line names the agent').toBe('Claude Code')
    expect(r.count).toBe(6)
    expect(r.count, 'protocol’s badgeCount agrees').toBe(badgeCount(views, [cond]))
    // a condition holding nobody is no line; sessions failed on a limit that no condition holds count themselves
    expect(needsYou(views, [{ ...cond, sessionIds: [] }]).count, 'a condition holding nobody is no line').toBe(7)
    expect(needsYou(views, [{ ...cond, sessionIds: [] }]).sessions.map((x) => x.id)).toEqual(['perm', 'q', 'lim1', 'lim2', 'fail', 'crash', 'ready'])

    vi.useFakeTimers()
    const store = new KeyedStore<SessionView>('sessions')
    store.setMany(views.map((v) => [v.id, v]))
    const conditions = new KeyedStore<AccountCondition>('status.conditions')
    let badge = true
    const sent: MenuBarState[] = []
    const w = watchMenuBar({ sessions: store, conditions, agentName: () => 'Claude Code', badge: () => badge, onQuit: () => 'menuBar', onSettings: () => () => undefined, send: (x) => sent.push(x) })
    expect(sent.at(-1)).toMatchObject({ count: 7, badge: true })
    conditions.set('claude', cond)
    vi.advanceTimersByTime(L.storeTickMs)
    expect(sent.at(-1)).toMatchObject({ count: 6 })
    badge = false
    store.set('work', view('work', { phase: 'blocked', attention: [item('permission', 1)] }))
    vi.advanceTimersByTime(L.storeTickMs)
    expect(sent.at(-1)).toMatchObject({ count: 7, badge: false })
    expect(sent.at(-1)!.sessions[0]!.id, 'the oldest blocked first').toBe('work')
    w.dispose()
    expect(conditions.listenerCount).toBe(0)
  })
})
