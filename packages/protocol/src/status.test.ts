import { describe, expect, it } from 'vitest'
import type { AttentionItem, SessionView } from './index.ts'
import { attentionGroup, attentionOrder, badgeCount, clockTime, conditionText, expectedStateOf, zAgentEvent } from './status.ts'

type S = Pick<SessionView, 'id' | 'lifecycle' | 'endReason' | 'phase' | 'attention' | 'unread' | 'failureKind' | 'lastActivityAt'>
const item = (at: number): AttentionItem => ({ kind: 'permission', key: `k${at}`, summary: 's', source: 'hook', at })
let n = 0
const s = (over: Partial<S>): S => ({ id: `s${String(++n).padStart(3, '0')}`, lifecycle: 'live', endReason: null, phase: 'idle', attention: [], unread: false, failureKind: null, lastActivityAt: 0, ...over })

describe('attention order and the badge', () => {
  it('U-ST-6 · blocked first (oldest item first), then failed and crashed, then unread ready; account-level failures a condition holds, read ready, working, idle and stopped sessions are left out', () => {
    const blockedNew = s({ phase: 'blocked', attention: [item(50)], lastActivityAt: 1 })
    const blockedOld = s({ phase: 'blocked', attention: [item(60), item(20)], lastActivityAt: 99 })
    const failed = s({ phase: 'failed', failureKind: 'overloaded', unread: true, lastActivityAt: 40 })
    const crashed = s({ lifecycle: 'detached', endReason: 'crashed', lastActivityAt: 30 })
    const lost = s({ lifecycle: 'detached', endReason: 'lost', lastActivityAt: 35 })
    const unreadOld = s({ phase: 'ready', unread: true, lastActivityAt: 10 })
    const unreadNew = s({ phase: 'ready', unread: true, lastActivityAt: 70 })
    const limited = s({ phase: 'failed', failureKind: 'rate_limit', unread: true })
    const out = [
      s({ phase: 'ready', unread: false }),
      s({ phase: 'working' }),
      s({ phase: 'starting' }),
      s({ phase: 'idle' }),
      s({ lifecycle: 'detached', endReason: 'stopped' }),
      s({ lifecycle: 'detached', endReason: 'exited' }),
      s({ lifecycle: 'archived', endReason: 'crashed' }),
      limited,
    ]
    const all = [unreadNew, out[0]!, failed, blockedNew, crashed, ...out.slice(1), unreadOld, blockedOld, lost]
    expect(attentionOrder(all, new Set([limited.id])).map((x) => x.id)).toEqual([blockedOld, blockedNew, crashed, lost, failed, unreadOld, unreadNew].map((x) => x.id))
    for (const x of out) expect(attentionGroup(x, new Set([limited.id])), x.id).toBeNull()
    // a status restored blocked (attention set non-empty) counts whatever its phase says
    expect(attentionGroup(s({ phase: 'working', attention: [item(1)] }))).toBe(0)
  })

  it('U-ST-6 · the badge counts sessions that need the person, and the sessions an account condition holds once, as the condition', () => {
    const held = [s({ phase: 'failed', failureKind: 'rate_limit', unread: true }), s({ phase: 'failed', failureKind: 'rate_limit', unread: true })]
    const others = [s({ phase: 'blocked', attention: [item(1)] }), s({ phase: 'ready', unread: true }), s({ phase: 'working' })]
    expect(badgeCount([...held, ...others], [{ sessionIds: held.map((x) => x.id) }])).toBe(3)
    expect(badgeCount(others, [{ sessionIds: [] }])).toBe(2)
  })

  it('U-ST-18 · a session failed on an account-level kind counts as the condition while one holds it; once none does (the condition cleared with it still failed) it is in group 1 like any failure: in ⌘J’s order, the badge and the menu bar', () => {
    // four sessions hit a usage limit with no reset time; one is continued by hand, its turn.finished ends the condition
    const limited = [10, 20, 30].map((at) => s({ phase: 'failed', failureKind: 'rate_limit', unread: true, lastActivityAt: at }))
    const blocked = s({ phase: 'blocked', attention: [item(5)] })
    const overloaded = s({ phase: 'failed', failureKind: 'overloaded', lastActivityAt: 15 })
    const all = [...limited, blocked, overloaded]
    const held = new Set(limited.map((x) => x.id))
    // held: the condition stands for them (counted once, listed as its own line)
    for (const x of limited) expect(attentionGroup(x, held), x.id).toBeNull()
    expect(badgeCount(all, [{ sessionIds: [...held] }])).toBe(3)
    // released: each needs the person again
    for (const x of limited) expect(attentionGroup(x, new Set()), x.id).toBe(1)
    expect(attentionGroup(limited[0]!), 'no condition given: none holds it').toBe(1)
    expect(attentionOrder(all, new Set()).map((x) => x.id)).toEqual([blocked, limited[0]!, overloaded, limited[1]!, limited[2]!].map((x) => x.id))
    expect(badgeCount(all, [])).toBe(5)
    // one still held, two released (it left the condition by a new turn that failed on overload, say): each counted once
    expect(badgeCount(all, [{ sessionIds: [limited[0]!.id] }])).toBe(5)
  })

  it('U-ST-6 · the report picker’s word for a status, and every agent event shape parses', () => {
    expect(expectedStateOf({ lifecycle: 'live', phase: 'starting' })).toBe('working')
    expect(expectedStateOf({ lifecycle: 'live', phase: 'blocked' })).toBe('needsMe')
    expect(expectedStateOf({ lifecycle: 'live', phase: 'failed' })).toBe('finished')
    expect(expectedStateOf({ lifecycle: 'live', phase: 'idle' })).toBe('idle')
    expect(expectedStateOf({ lifecycle: 'detached', phase: 'idle' })).toBe('ended')
    expect(zAgentEvent.safeParse({ t: 'turn.failed', error: 'x', kind: 'rate_limit', resetsAt: 5 }).success).toBe(true)
    expect(zAgentEvent.safeParse({ t: 'turn.failed', error: 'x', kind: 'nope' }).success).toBe(false)
    expect(zAgentEvent.safeParse({ t: 'unknown' }).success).toBe(false)
  })

  it('U-ST-11 · a condition line\'s words: limited until / since / reset, billing, and signed out with the agent\'s login command when it has one', () => {
    const at = Date.UTC(2026, 9, 10, 13, 0)
    expect(conditionText({ kind: 'rate_limit', state: 'active', since: at, resetsAt: at + 3_600_000 })).toBe(`limited until ${clockTime(at + 3_600_000)}`)
    expect(conditionText({ kind: 'rate_limit', state: 'active', since: at, resetsAt: null })).toBe(`limited since ${clockTime(at)}`)
    expect(conditionText({ kind: 'rate_limit', state: 'reset', since: at, resetsAt: at })).toBe('limit reset')
    expect(conditionText({ kind: 'billing', state: 'active', since: at, resetsAt: null }, 'agent login')).toBe('billing problem')
    expect(conditionText({ kind: 'auth', state: 'active', since: at, resetsAt: null }, 'agent login')).toBe('signed out — run agent login')
    expect(conditionText({ kind: 'auth', state: 'active', since: at, resetsAt: null }, null)).toBe('signed out')
  })
})
