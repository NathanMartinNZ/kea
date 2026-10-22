import { afterEach, describe, expect, it, vi } from 'vitest'
import { L } from '@kea/protocol'
import type { Project, PtyInfo, SessionView } from '@kea/protocol'
import { Drafts, newDraft } from '../features/composer/state.ts'
import { fakeProject, fakePty, fakeSession, restatus } from '../features/sessions/fakes.ts'
import { MruCycle, projectStructure, sessionStructure } from '../features/sessions/model.ts'
import { rememberScroll, scrollMarkCount } from '../features/terminal/scrollMarks.ts'
import { forgetWhatGoes } from '../shell/forget.ts'
import { fileTabMemory, fileTabsOf, setFileTabs } from '../shell/fileTabs.svelte.ts'
import { openFileTab } from '../shell/tabs.ts'
import { lastActive, savedTab, tabMemory } from '../shell/terminalPane.ts'
import { FrameStore, nextFrame } from './frameStore.ts'

/** A manual frame clock: callbacks wait until `frame()`. */
function frames() {
  const queue: (() => void)[] = []
  return {
    schedule: (cb: () => void) => void queue.push(cb),
    frame: () => {
      for (const cb of queue.splice(0)) cb()
    },
    get waiting() {
      return queue.length
    },
  }
}

describe('coalesced sidebar updates', () => {
  it('U-SB-1 · many status changes in one frame render once; each row hears only of its own change, its project of its rows, the list only of layout changes', () => {
    const clock = frames()
    const store = new FrameStore<SessionView>({ schedule: clock.schedule, structure: sessionStructure('stable'), group: (s) => s.projectId })
    const projects = ['01PAAAAAAAAAAAAAAAAAAAAAAA', '01PBBBBBBBBBBBBBBBBBBBBBBB']
    const map = new Map<string, SessionView>()
    for (let i = 0; i < 50; i++) {
      const s = fakeSession({ projectId: projects[i % 2]!, title: `s${i}`, sortOrder: i })
      map.set(s.id, s)
    }
    const ids = [...map.keys()]
    store.push(map, null)
    expect(store.size).toBe(0) // nothing until the frame
    clock.frame()
    expect(store.size).toBe(50)
    expect(store.flushes).toBe(1)

    const heard = new Map<string, number>()
    const count = (k: string) => () => heard.set(k, (heard.get(k) ?? 0) + 1)
    for (const id of ids) store.subscribeRow(id, count(id))
    for (const p of projects) store.subscribeGroup(p, count(p))
    store.subscribeList(count('list'))
    const list = store.values()

    // 100 status changes to 10 sessions within one frame: one flush, each changed row notified once
    const touched = ids.slice(0, 10)
    for (let round = 0; round < 10; round++) {
      for (const id of touched) {
        const prev = map.get(id)!
        const next = restatus(prev, { phase: round % 2 ? 'working' : 'ready', unread: true, lastActivityAt: round })
        map.set(id, next)
        store.push(map, [id])
      }
    }
    expect(clock.waiting).toBe(1)
    clock.frame()
    expect(store.flushes).toBe(2)
    for (const id of touched) expect(heard.get(id), id).toBe(1)
    for (const id of ids.slice(10)) expect(heard.get(id), id).toBeUndefined()
    expect(heard.get(projects[0]!)).toBe(1)
    expect(heard.get(projects[1]!)).toBe(1)
    expect(heard.get('list'), 'a status change does not lay the list out again').toBeUndefined()
    expect(store.values()).toBe(list)

    // a new session changes the layout: the list hears it once
    heard.clear()
    const added = fakeSession({ projectId: projects[0]!, title: 'new', sortOrder: -1 })
    map.set(added.id, added)
    store.push(map, [added.id])
    clock.frame()
    expect(heard.get('list')).toBe(1)
    expect(store.values()).not.toBe(list)

    // a core restart brings a snapshot of equal rows: nobody re-renders
    heard.clear()
    const copy = new Map([...map].map(([k, v]) => [k, structuredClone(v)]))
    store.push(copy, null)
    clock.frame()
    expect(heard.size).toBe(0)

    // a removed row: its subscribers, its project and the list hear it
    heard.clear()
    copy.delete(ids[0]!)
    store.push(copy, [ids[0]!])
    clock.frame()
    expect(store.get(ids[0]!)).toBeUndefined()
    expect([...heard.keys()].sort()).toEqual([ids[0]!, 'list', projects[0]!].sort())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // The window's own scheduler, on a display whose frame is longer than a store tick (60 Hz: 16.7 ms). Its fallback
  // timer, there for a window that gets no frames, must not flush a shown window before its frame: an update just
  // after a frame would be flushed by the timer and the next by the frame, both before one paint.
  it('U-SB-6 · on a display whose frame is longer than a store tick the window’s stores flush at most once per frame', () => {
    vi.useFakeTimers()
    const callbacks: (() => void)[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => (callbacks.push(cb), callbacks.length))
    const paint = () => {
      for (const cb of callbacks.splice(0)) cb()
    }
    const FRAME = L.storeTickMs + 1 // a 60 Hz frame, in whole milliseconds
    const store = new FrameStore<number>({ schedule: nextFrame })
    let n = 0
    const update = () => store.push(new Map([['a', ++n]]), ['a'])
    const perFrame: number[] = []
    for (let f = 0; f < 10; f++) {
      const before = store.flushes
      update() // just after a frame
      vi.advanceTimersByTime(FRAME - 1)
      update() // just before the next
      vi.advanceTimersByTime(1)
      paint()
      perFrame.push(store.flushes - before)
    }
    expect(perFrame).toEqual(perFrame.map(() => 1))
    expect(store.get('a')).toBe(n)
    // a window that gets no frames (hidden or covered) still flushes, after the fallback, which is longer than a frame
    // at 30 Hz
    expect(L.frameFallbackMs).toBeGreaterThan(1000 / 30)
    const before = store.flushes
    update()
    vi.advanceTimersByTime(L.frameFallbackMs - 1)
    expect(store.flushes).toBe(before)
    vi.advanceTimersByTime(1)
    expect([store.flushes, store.get('a')]).toEqual([before + 1, n])
    paint() // the frame that comes when it is shown again flushes nothing twice
    expect(store.flushes).toBe(before + 1)
  })
})

describe('per-session window state comes back to baseline', () => {
  it('U-SB-5 · a hundred projects, sessions and PTYs come and go through the window’s own pruning (shell/forget.ts): the store copies and their listeners, the last active tabs and the sessions’ saved ones, the file tabs, the scroll marks, the ⌃Tab order, the drafts and the open Archived groups are back to empty', () => {
    const clock = frames()
    const stores = {
      projects: new FrameStore<Project>({ schedule: clock.schedule, structure: projectStructure }),
      sessions: new FrameStore<SessionView>({ schedule: clock.schedule, structure: sessionStructure('stable'), group: (s) => s.projectId }),
      terminals: new FrameStore<PtyInfo>({ schedule: clock.schedule, structure: (t) => `${t.sessionId}|${t.state}|${t.kind}|${t.title ?? ''}` }),
    }
    const mru = new MruCycle()
    const drafts = new Drafts()
    let archivedOpen: ReadonlySet<string> = new Set()
    const unwire = forgetWhatGoes(stores, { drafts, mru, pending: () => null, archivedOpen: () => archivedOpen, setArchivedOpen: (next) => (archivedOpen = next) })
    const baseline = { tabs: tabMemory(), saved: savedTab.size, files: fileTabMemory(), marks: scrollMarkCount() }
    const maps = { projects: new Map<string, Project>(), sessions: new Map<string, SessionView>(), terminals: new Map<string, PtyInfo>() }
    const push = (changed: { projects?: string; sessions?: string; terminals?: string }) => {
      if (changed.projects) stores.projects.push(maps.projects, [changed.projects])
      if (changed.sessions) stores.sessions.push(maps.sessions, [changed.sessions])
      if (changed.terminals) stores.terminals.push(maps.terminals, [changed.terminals])
      clock.frame()
    }
    for (let i = 0; i < 100; i++) {
      // a project, a session in it and its PTY appear; the window shows them: rows listen, the session is visited on its
      // tab, a file is opened in it, the tab's view is released scrolled up, a draft is written, the project's Archived
      // group is opened
      const p = fakeProject({ name: `p${i}` })
      const s = fakeSession({ projectId: p.id, title: `s${i}` })
      const t = fakePty({ sessionId: s.id })
      maps.projects.set(p.id, p)
      maps.sessions.set(s.id, s)
      maps.terminals.set(t.ptyId, t)
      push({ projects: p.id, sessions: s.id, terminals: t.ptyId })
      const offs = [stores.sessions.subscribeRow(s.id, () => {}), stores.sessions.subscribeGroup(p.id, () => {}), stores.projects.subscribeRow(p.id, () => {}), stores.terminals.subscribeRow(t.ptyId, () => {})]
      mru.visit(s.id)
      lastActive.set(s.id, t.ptyId)
      savedTab.set(s.id, { kind: 'shell', ptyId: t.ptyId })
      setFileTabs(s.id, openFileTab(fileTabsOf(s.id), { path: `src/f${i}.ts`, mode: 'file', pin: true }).tabs)
      rememberScroll(t.ptyId, { top: 1, fromBottom: 10, length: 50 })
      drafts.set(p.id, newDraft(p))
      archivedOpen = new Set([...archivedOpen, p.id])
      // and go, as core deletes them: the PTY, the session, then the project; their rows unmount
      maps.terminals.delete(t.ptyId)
      push({ terminals: t.ptyId })
      maps.sessions.delete(s.id)
      push({ sessions: s.id })
      maps.projects.delete(p.id)
      push({ projects: p.id })
      for (const off of offs) off()
    }
    unwire()
    const left = (st: FrameStore<never>) => ({ rows: st.size, listeners: st.subscribers, list: st.values().length })
    expect({ projects: left(stores.projects as never), sessions: left(stores.sessions as never), terminals: left(stores.terminals as never) }).toEqual({
      projects: { rows: 0, listeners: 0, list: 0 },
      sessions: { rows: 0, listeners: 0, list: 0 },
      terminals: { rows: 0, listeners: 0, list: 0 },
    })
    expect({ tabs: tabMemory(), saved: savedTab.size, files: fileTabMemory(), marks: scrollMarkCount() }, 'the last active tabs (the window’s and what each session is known to remember), the file tabs and the scroll marks').toEqual(baseline)
    expect({ mru: mru.size, drafts: drafts.size, archivedOpen: archivedOpen.size }).toEqual({ mru: 0, drafts: 0, archivedOpen: 0 })
  })
})
