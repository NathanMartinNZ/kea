import { describe, expect, it } from 'vitest'
import type { SessionView } from '@kea/protocol'
import { fakeProject, fakeSession, restatus } from './fakes.ts'
import { jumpTargets, matchesFilter, moveIndex, MruCycle, neighbour, nextNeedingYou, orderSessions, relativeTime, rowLabel, rowMeta, rowTitle, sessionStructure, sidebarRows, statusWords, type SidebarInput, type SidebarRow } from './model.ts'

const A = fakeProject({ name: 'storefront', sortOrder: 2, createdAt: 10 })
const B = fakeProject({ name: 'docs-site', sortOrder: 1, createdAt: 20 })
const C = fakeProject({ name: 'toolkit', sortOrder: 3, createdAt: 5 })

function rowsText(rows: readonly SidebarRow[], sessions: readonly SessionView[]): string[] {
  const title = (id: string) => sessions.find((s) => s.id === id)?.title ?? id
  const name = (id: string) => [A, B, C].find((p) => p.id === id)?.name ?? id
  return rows.map((r) => (r.kind === 'project' ? `${r.collapsed ? '▸' : '▾'} ${name(r.projectId)}` : r.kind === 'archived' ? `  Archived (${r.count})${r.expanded ? ' open' : ''}` : `  ${r.archived ? '(a) ' : ''}${title(r.sessionId)}`))
}

function input(over: Partial<SidebarInput>): SidebarInput {
  return { projects: [A, B, C], sessions: [], order: 'stable', filter: '', archivedOpen: new Set(), ...over }
}

describe('sidebar rows', () => {
  it('U-SB-2 · projects in manual order; sessions newest first and never moved by status; one collapsed Archived (n) row per project only when n > 0', () => {
    const s1 = fakeSession({ projectId: A.id, title: 'old', sortOrder: 3, createdAt: 1 })
    const s2 = fakeSession({ projectId: A.id, title: 'new', sortOrder: 1, createdAt: 3 })
    const s3 = fakeSession({ projectId: A.id, title: 'middle', sortOrder: 2, createdAt: 2 })
    const s4 = fakeSession({ projectId: B.id, title: 'seo-pass', lifecycle: 'archived', endReason: 'stopped' })
    const s5 = fakeSession({ projectId: B.id, title: 'gone', lifecycle: 'deleted', endReason: 'stopped' })
    const sessions = [s1, s2, s3, s4, s5]
    const rows = sidebarRows(input({ sessions }))
    expect(rowsText(rows, sessions)).toEqual(['▾ docs-site', '  Archived (1)', '▾ storefront', '  new', '  middle', '  old', '▾ toolkit'])

    // a status change never moves a row in stable order, and the lists' structure does not change with it
    const working = sessions.map((s) => (s === s1 ? restatus(s1, { phase: 'blocked', attention: [{ kind: 'permission', key: 'k', summary: 'x', source: 'hook', at: 5 }], lastActivityAt: 99 }) : s))
    expect(working[0]!.glyph).toBe('needsYou')
    expect(rowsText(sidebarRows(input({ sessions: working })), working)).toEqual(rowsText(rows, sessions))
    expect(sessionStructure('stable')(working[0]!)).toBe(sessionStructure('stable')(s1))

    // the drag order persists: a session moved to the top has the lowest sortOrder and stays there
    const moved = sessions.map((s) => (s === s1 ? { ...s1, sortOrder: 0 } : s))
    expect(rowsText(sidebarRows(input({ sessions: moved })), moved).slice(2, 6)).toEqual(['▾ storefront', '  old', '  new', '  middle'])

    // the Archived group opens on request, listing its sessions
    expect(rowsText(sidebarRows(input({ sessions, archivedOpen: new Set([B.id]) })), sessions).slice(0, 3)).toEqual(['▾ docs-site', '  Archived (1) open', '  (a) seo-pass'])

    // a collapsed project hides its sessions and its Archived row
    const collapsed = sidebarRows(input({ projects: [A, { ...B, collapsed: true }, C], sessions }))
    expect(rowsText(collapsed, sessions).slice(0, 2)).toEqual(['▸ docs-site', '▾ storefront'])
  })

  it('U-SB-2 · general.sessionOrder "attention": sessions needing you first (stable among themselves), then by last activity', () => {
    const at = (n: number) => [{ kind: 'question' as const, key: `q${n}`, summary: 'q', source: 'hook' as const, at: n }]
    const a = fakeSession({ title: 'a', sortOrder: 1, lastActivityAt: 10 })
    const b = fakeSession({ title: 'b', sortOrder: 2, lastActivityAt: 50, phase: 'blocked', attention: at(1) })
    const c = fakeSession({ title: 'c', sortOrder: 3, lastActivityAt: 30 })
    const d = fakeSession({ title: 'd', sortOrder: 4, lastActivityAt: 5, phase: 'blocked', attention: at(2) })
    expect(orderSessions([a, b, c, d], 'attention').map((s) => s.title)).toEqual(['b', 'd', 'c', 'a'])
    expect(orderSessions([a, b, c, d], 'stable').map((s) => s.title)).toEqual(['a', 'b', 'c', 'd'])
    // in this mode the needs-you state is part of the layout
    expect(sessionStructure('attention')(b)).not.toBe(sessionStructure('attention')(restatus(b, { phase: 'idle', attention: [] })))
  })

  it('U-ST-6 · "attention" order: blocked (oldest first), then failed and crashed, then unread ready, then the rest by last activity; a row an account condition holds is labelled by its kind', () => {
    const q = (at: number) => [{ kind: 'question' as const, key: `q${at}`, summary: 'q', source: 'hook' as const, at }]
    const idle = fakeSession({ title: 'idle', lastActivityAt: 90 })
    const read = fakeSession({ title: 'read', phase: 'ready', unread: false, lastActivityAt: 80 })
    const unread = fakeSession({ title: 'unread', phase: 'ready', unread: true, lastActivityAt: 20 })
    const failed = fakeSession({ title: 'failed', phase: 'failed', failureKind: 'overloaded', unread: true, lastActivityAt: 60 })
    const crashed = fakeSession({ title: 'crashed', lifecycle: 'detached', endReason: 'crashed', lastActivityAt: 50 })
    const limited = fakeSession({ title: 'limited', phase: 'failed', failureKind: 'rate_limit', unread: true, lastActivityAt: 70 })
    const late = fakeSession({ title: 'late', phase: 'blocked', attention: q(40), lastActivityAt: 1 })
    const early = fakeSession({ title: 'early', phase: 'blocked', attention: q(10), lastActivityAt: 99 })
    const order = orderSessions([idle, read, unread, failed, crashed, limited, late, early], 'attention', new Set([limited.id])).map((s) => s.title)
    expect(order).toEqual(['early', 'late', 'crashed', 'failed', 'unread', 'idle', 'read', 'limited'])
    // once no condition holds it, a usage limit's session is a failure like any other
    expect(orderSessions([idle, read, unread, failed, crashed, limited, late, early], 'attention').map((s) => s.title)).toEqual(['early', 'late', 'crashed', 'failed', 'limited', 'unread', 'idle', 'read'])
    expect(limited.glyph).toBe('limited')
    expect(rowLabel(limited)).toBe('limited')
    expect(rowLabel(restatus(limited, { failureKind: 'auth' }))).toBe('signed out')
    expect(rowLabel(restatus(limited, { failureKind: 'billing' }))).toBe('billing')
    expect(rowLabel(late)).toBe('question')
    expect(rowLabel(failed)).toBeNull()
    // what the glyph says to assistive technology is the status in words, never the bare label (A-4)
    expect([late, limited, restatus(limited, { failureKind: 'auth' }), restatus(limited, { failureKind: 'billing' })].map(statusWords)).toEqual(['Needs an answer', 'Waiting on a usage limit', 'Signed out', 'Waiting on billing'])
    expect(statusWords(restatus(late, { attention: [{ ...late.attention[0]!, kind: 'permission' }] }))).toBe('Needs permission')
    expect([idle, unread, failed, crashed].map(statusWords)).toEqual(['Idle', 'Finished, unread', 'Failed', 'Crashed'])
    expect(rowTitle(restatus(read, { background: true }))).toBe('Background tasks running')
  })

  it('U-SB-3 · the filter matches title or branch, ignoring case; ⌘1…9 are the first nine visible session rows top to bottom', () => {
    const many = Array.from({ length: 12 }, (_, i) => fakeSession({ projectId: i < 4 ? B.id : A.id, title: `task ${i}`, branch: `kea/branch-${i}`, sortOrder: i }))
    const rows = sidebarRows(input({ sessions: many }))
    expect(jumpTargets(rows)).toEqual(many.slice(0, 9).map((s) => s.id))
    // a collapsed project's sessions are not visible, so the numbers move on to the next project's
    const folded = sidebarRows(input({ projects: [A, { ...B, collapsed: true }, C], sessions: many }))
    expect(jumpTargets(folded)).toEqual(many.slice(4, 12).map((s) => s.id))
    // archived sessions count only when their group is open
    const arch = [fakeSession({ projectId: B.id, title: 'x', lifecycle: 'archived', endReason: 'stopped' }), fakeSession({ projectId: B.id, title: 'y', sortOrder: 9 })]
    expect(jumpTargets(sidebarRows(input({ sessions: arch })))).toEqual([arch[1]!.id])
    expect(jumpTargets(sidebarRows(input({ sessions: arch, archivedOpen: new Set([B.id]) })))).toEqual([arch[1]!.id, arch[0]!.id])

    expect(matchesFilter({ title: 'Fix Auth redirect', branch: null }, 'auth')).toBe(true)
    expect(matchesFilter({ title: 'x', branch: 'kea/SEO-pass' }, 'seo')).toBe(true)
    expect(matchesFilter({ title: 'x', branch: 'kea/y' }, 'zzz')).toBe(false)
    expect(matchesFilter({ title: 'x', branch: null }, '   ')).toBe(true)
    // filtering: projects without a match go, collapsed ones and Archived groups open to show their matches
    const f = [fakeSession({ projectId: A.id, title: 'billing page' }), fakeSession({ projectId: B.id, title: 'old billing', lifecycle: 'archived', endReason: 'exited' }), fakeSession({ projectId: C.id, title: 'other' })]
    const fr = sidebarRows(input({ projects: [{ ...A, collapsed: true }, B, C], sessions: f, filter: 'BILL' }))
    expect(rowsText(fr, f)).toEqual(['▾ docs-site', '  Archived (1) open', '  (a) old billing', '▾ storefront', '  billing page'])
  })

  it('U-SB-4 · ⌃Tab steps back through the most recently used sessions while ⌃ is held, and the one reached becomes the most recent on release', () => {
    const m = new MruCycle()
    for (const id of ['a', 'b', 'c', 'd']) m.visit(id) // d is on screen, then c, b, a
    expect(m.list()).toEqual(['d', 'c', 'b', 'a'])
    // ⌃ held: Tab, Tab → b; the order is frozen during the cycle
    expect(m.step(1, true, 'd')).toBe('c')
    expect(m.step(1, true, 'c')).toBe('b')
    expect(m.cycling).toBe(true)
    expect(m.list()).toEqual(['d', 'c', 'b', 'a'])
    m.release()
    expect(m.list()).toEqual(['b', 'd', 'c', 'a'])
    // a single press (⌃ released at once, or the menu) toggles between the two most recent
    expect(m.step(1, false, 'b')).toBe('d')
    expect(m.step(1, false, 'd')).toBe('b')
    // ⌃⇧Tab goes the other way, wrapping
    expect(m.step(-1, false, 'b')).toBe('a')
    // sessions that are gone drop out
    m.prune((id) => id !== 'c')
    expect(m.list()).not.toContain('c')
    // a click while cycling ends the cycle and counts as the visit
    m.step(1, true, 'a')
    m.visit('d')
    expect(m.cycling).toBe(false)
    expect(m.list()[0]).toBe('d')
    // nothing visited yet: nowhere to go
    expect(new MruCycle().step(1, false, null)).toBe(null)
  })

  it("U-SB-4 · ⌘J goes to the next session that needs you in attention order — the one that has needed you longest first, then on from the one shown, round again; failed, crashed and unread finished ones after the blocked; a usage limit's sessions left out while it holds them; none when nobody else needs you", () => {
    const item = (at: number) => [{ kind: 'permission' as const, key: `k${at}`, summary: 's', source: 'hook' as const, at }]
    const x = fakeSession({ phase: 'blocked', attention: item(30) })
    const y = fakeSession({ phase: 'blocked', attention: [...item(40), ...item(10)] })
    const z = fakeSession({ phase: 'working' })
    const f = fakeSession({ phase: 'failed', failureKind: 'overloaded', unread: true, lastActivityAt: 50 })
    const c = fakeSession({ lifecycle: 'detached', endReason: 'crashed', lastActivityAt: 60 })
    const r = fakeSession({ phase: 'ready', unread: true, lastActivityAt: 5 })
    const held = fakeSession({ phase: 'failed', failureKind: 'rate_limit', unread: true, lastActivityAt: 1 })
    const all = [x, y, z, f, c, r, held]
    const holds = new Set([held.id])
    expect(nextNeedingYou(all, null, holds)).toBe(y.id)
    const seen: string[] = []
    let cur: string | null = null
    for (let i = 0; i < 6; i++) seen.push((cur = nextNeedingYou(all, cur, holds))!)
    expect(seen).toEqual([y.id, x.id, f.id, c.id, r.id, y.id])
    // the condition cleared while it stayed failed: it needs you again, oldest of the failures
    expect(nextNeedingYou(all, x.id)).toBe(held.id)
    expect(nextNeedingYou(all, z.id, holds), 'from a session that needs nothing: the first').toBe(y.id)
    expect(nextNeedingYou([z])).toBe(null)
    expect(nextNeedingYou([x, z], x.id), 'only the one shown needs you').toBe(null)
    // deleted and archived sessions are not in the sidebar's list, so never a target
    expect(nextNeedingYou([{ ...y, lifecycle: 'deleted' }, x])).toBe(x.id)
    expect(nextNeedingYou([{ ...c, lifecycle: 'archived' }])).toBe(null)
  })

  it('U-SB-4 · trailing meta reads now, minutes, hours, days', () => {
    const now = 1_000_000_000
    expect(relativeTime(now - 5_000, now)).toBe('now')
    expect(relativeTime(now - 2 * 60_000, now)).toBe('2m')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h')
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe('4d')
    expect(relativeTime(now + 10_000, now)).toBe('now')
  })
})

describe('reordering', () => {
  /** Core's move: out of the order, then in at `index` (projects.move / sessions.move). */
  const apply = (all: readonly string[], id: string, index: number) => {
    const rest = all.filter((x) => x !== id)
    return [...rest.slice(0, index), id, ...rest.slice(index)]
  }

  it('U-PRJ-4 · a drop or ⌥↑ / ⌥↓ puts the row just past its target, from above or below; rows shown apart (archived) never shift it', () => {
    const all = ['a', 'b', 'c', 'd']
    expect(apply(all, 'a', moveIndex(all, 'a', 'c')!)).toEqual(['b', 'c', 'a', 'd'])
    expect(apply(all, 'd', moveIndex(all, 'd', 'b')!)).toEqual(['a', 'd', 'b', 'c'])
    expect(apply(all, 'b', moveIndex(all, 'b', 'c')!)).toEqual(['a', 'c', 'b', 'd'])
    expect(apply(all, 'c', moveIndex(all, 'c', 'b')!)).toEqual(['a', 'c', 'b', 'd'])
    expect(moveIndex(all, 'a', 'a')).toBeNull()
    expect(moveIndex(all, 'a', 'gone')).toBeNull()
    // 'x' is archived (listed apart, still in core's order): moving d up past c lands right before c
    const withArchived = ['a', 'x', 'b', 'c', 'd']
    const shown = ['a', 'b', 'c', 'd']
    expect(apply(withArchived, 'd', moveIndex(withArchived, 'd', neighbour(shown, 'd', -1)!)!)).toEqual(['a', 'x', 'b', 'd', 'c'])
    expect(neighbour(shown, 'a', -1)).toBeNull()
    expect(neighbour(shown, 'd', 1)).toBeNull()
    expect(neighbour(shown, 'b', 1)).toBe('c')
    expect(neighbour(shown, 'gone', 1)).toBeNull()
  })
})

describe('compact sidebar rows', () => {
  it('U-LAYOUT-7 · a compact row\'s tooltip leads with the full title, then what its meta would show, then its note; a full-width row keeps its note only', () => {
    const now = 10 * 60_000
    const idle = fakeSession({ title: 'Fix the long checkout redirect', lastActivityAt: now - 3 * 60_000 })
    expect(rowTitle(idle)).toBeUndefined()
    expect(rowTitle(idle, now)).toBe('Fix the long checkout redirect · 3m')
    const asking = restatus(idle, { phase: 'blocked', attention: [{ kind: 'permission', key: 'k', summary: 'x', source: 'hook', at: 5 }] })
    expect(rowTitle(asking, now)).toBe('Fix the long checkout redirect · Needs permission')
    expect(rowMeta(restatus(idle, { teardownFailed: true }), now)).toBe('Teardown failed')
    expect(rowMeta(restatus(idle, { worktreeMissing: true }), now)).toBe('Worktree missing')
    expect(rowMeta(restatus(idle, { serverRunning: true }), now)).toBe('Dev server running')
    const busy = restatus(idle, { phase: 'ready', background: true })
    expect(rowTitle(busy)).toBe('Background tasks running')
    expect(rowTitle(busy, now)).toBe(`Fix the long checkout redirect · ${relativeTime(busy.lastActivityAt, now)} · Background tasks running`)
    const failed = fakeSession({ title: 'Broken', lifecycle: 'create_failed', creation: { step: 'add', error: 'git worktree add failed', notices: [], logBytes: 0 } })
    expect(rowTitle(failed)).toBe('git worktree add failed')
    expect(rowTitle(failed, now)).toBe('Broken · Creation failed · git worktree add failed')
  })
})
