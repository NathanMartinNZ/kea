import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '@kea/kit'
import { KeyedStore, L, type SessionView } from '@kea/protocol'
import { VisibleSet } from '../platform/visible.ts'
import { measureDueAt, pruneDueAt, tickDelay, type Measurable } from './disk-schedule.ts'
import { DiskService, type DiskMark, type DiskRecords, type DiskWalker } from './disk.ts'
import type { DiskWalkRequest, DiskWalkResult } from './disk-walk.ts'

const HOUR = L.diskMeasureIntervalMs
const DAY = 86_400_000
const T0 = Date.parse('2026-10-01T00:00:00Z')

describe('when a worktree is measured and pruned', () => {
  it('U-WT-17 · the measure rule: an hour after the last measurement for a live session that was active since, or one shown since; once per archive; never in the first hour after core starts; a failed walk an hour later', () => {
    const since = T0
    const s = (o: Partial<Measurable>): Measurable => ({ lifecycle: 'live', createdAt: T0 - 10 * DAY, archivedAt: null, diskAt: T0 - 5 * HOUR, lastActivityAt: T0 - 6 * HOUR, ...o })
    const hidden = { visible: false, viewedAt: null }
    // nothing touched it and nobody looked: not walked again
    expect(measureDueAt(s({}), hidden, since)).toBe(Infinity)
    expect(measureDueAt(s({}), undefined, since)).toBe(Infinity)
    expect(measureDueAt(s({ lifecycle: 'detached', lastActivityAt: T0 }), hidden, since)).toBe(Infinity)
    // active since it was measured: an hour after that measurement, but not in core's first hour
    expect(measureDueAt(s({ lastActivityAt: T0 - HOUR }), hidden, since)).toBe(since + HOUR)
    expect(measureDueAt(s({ diskAt: T0 + 2 * HOUR, lastActivityAt: T0 + 2 * HOUR + 1 }), hidden, since)).toBe(T0 + 3 * HOUR)
    // on screen, or shown since: the same, whatever its lifecycle
    expect(measureDueAt(s({ diskAt: T0 + 2 * HOUR }), { visible: true, viewedAt: null }, since)).toBe(T0 + 3 * HOUR)
    expect(measureDueAt(s({ lifecycle: 'detached', diskAt: T0 + 2 * HOUR }), { visible: false, viewedAt: T0 + 2 * HOUR + 1 }, since)).toBe(T0 + 3 * HOUR)
    expect(measureDueAt(s({ lifecycle: 'detached', diskAt: T0 + 2 * HOUR }), { visible: false, viewedAt: T0 + 2 * HOUR }, since)).toBe(Infinity)
    // never measured: a live one an hour after its creation; one nobody has shown waits for the Disk view to ask
    expect(measureDueAt(s({ diskAt: null, createdAt: T0 + 3 * HOUR }), hidden, since)).toBe(T0 + 4 * HOUR)
    expect(measureDueAt(s({ lifecycle: 'detached', diskAt: null }), hidden, since)).toBe(Infinity)
    expect(measureDueAt(s({ lifecycle: 'detached', diskAt: null }), { visible: false, viewedAt: T0 - DAY }, since)).toBe(since + HOUR)
    // archived: once per archive (the archive itself measures at once; this is for the one that missed it)
    expect(measureDueAt(s({ lifecycle: 'archived', archivedAt: T0 - DAY, diskAt: T0 - 2 * DAY }), hidden, since)).toBe(since + HOUR)
    expect(measureDueAt(s({ lifecycle: 'archived', archivedAt: T0 - DAY, diskAt: null }), hidden, since)).toBe(since + HOUR)
    expect(measureDueAt(s({ lifecycle: 'archived', archivedAt: T0 - DAY, diskAt: T0 - DAY }), { visible: true, viewedAt: T0 }, since)).toBe(Infinity)
    // a walk that failed: not before its retry time
    expect(measureDueAt(s({ lastActivityAt: T0 }), hidden, since, T0 + 7 * HOUR)).toBe(T0 + 7 * HOUR)
    expect(measureDueAt(s({ lifecycle: 'archived', archivedAt: T0, diskAt: null }), hidden, since, T0 + 7 * HOUR)).toBe(T0 + 7 * HOUR)
    // no worktree to weigh
    for (const lifecycle of ['creating', 'create_failed', 'deleted'] as const) expect(measureDueAt(s({ lifecycle, diskAt: null, lastActivityAt: T0 }), { visible: true, viewedAt: T0 }, since)).toBe(Infinity)
  })

  it('U-WT-18 · the prune rule: an archived session’s build folders go general.pruneArchivedBuildDirsDays after its archive, once per archive, never with 0 days; the one timer is never set further ahead than an hour', () => {
    const archived = { lifecycle: 'archived' as const, archivedAt: T0 }
    expect(pruneDueAt(archived, null, 7)).toBe(T0 + 7 * DAY)
    expect(pruneDueAt(archived, null, 1)).toBe(T0 + DAY)
    // 0 = never
    expect(pruneDueAt(archived, null, 0)).toBe(Infinity)
    expect(pruneDueAt(archived, null, -1)).toBe(Infinity)
    expect(pruneDueAt(archived, null, Number.NaN)).toBe(Infinity)
    // removed since this archive (by the rule or by hand): done; removed in an earlier archive: due again
    expect(pruneDueAt(archived, T0 + 1, 7)).toBe(Infinity)
    expect(pruneDueAt(archived, T0, 7)).toBe(Infinity)
    expect(pruneDueAt(archived, T0 - 1, 7)).toBe(T0 + 7 * DAY)
    // only an archived session
    for (const lifecycle of ['live', 'detached', 'creating', 'create_failed', 'deleted'] as const) expect(pruneDueAt({ lifecycle, archivedAt: T0 }, null, 7)).toBe(Infinity)
    expect(pruneDueAt({ lifecycle: 'archived', archivedAt: null }, null, 7)).toBe(Infinity)
    // one that could not be pruned is looked at again at its retry time
    expect(pruneDueAt(archived, null, 7, T0 + 8 * DAY)).toBe(T0 + 8 * DAY)

    expect(tickDelay(Infinity, T0)).toBeNull()
    expect(tickDelay(T0 + 5000, T0)).toBe(5000)
    expect(tickDelay(T0 - 5000, T0)).toBe(0)
    expect(tickDelay(T0 + 7 * DAY, T0)).toBe(HOUR)
  })
})

// ── the service ────────────────────────────────────────────────────────────────────────────────────

const AT_REST = { rows: 0, queued: 0, walking: 0, workers: 0, timers: 0, work: 0, retries: 0 }

function view(id: string, cwd: string, o: Partial<SessionView> = {}): SessionView {
  return {
    id, projectId: 'P1', slug: id.toLowerCase(), title: id, titleSource: 'auto', isolation: 'worktree', cwd, branch: `kea/${id}`, baseBranch: 'main', baseCommit: null, portBase: null,
    agent: 'shell', agentSessionId: null, launch: {}, lifecycle: 'live', endReason: null, sortOrder: 0, pinnedOrder: 0, createdAt: Date.now(), archivedAt: null, diskBytes: null, diskAt: null,
    phase: 'ready', attention: [], background: false, failureKind: null, unread: false, lastActivityAt: Date.now(), model: null, effort: null, permissionMode: null, costUsd: null, contextPct: null,
    glyph: 'idle', label: null, creation: null, setup: null, teardownFailed: false, worktreeMissing: false, serverRunning: false, ...o,
  } as SessionView
}

interface World {
  disk: DiskService
  store: KeyedStore<SessionView>
  visible: VisibleSet
  marks: Map<string, DiskMark>
  walks: DiskWalkRequest[]
  turns: string[]
  cwd: string
  /** What the next walks answer (null: the walk fails). */
  answer: { value: DiskWalkResult | null }
  /** `general.pruneArchivedBuildDirsDays`, and its change told to the service. */
  days: { value: number }
  setDays(n: number): void
  settingsListeners: Set<() => void>
  walker: { workers: number; released: number }
  /** The sessions' setup scripts are running. */
  settingUp: { value: boolean }
  set(id: string, o?: Partial<SessionView>): SessionView
}

const dirs: string[] = []
const worlds: World[] = []

function world(): World {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-disk-')))
  dirs.push(cwd)
  const store = new KeyedStore<SessionView>('sessions')
  const marks = new Map<string, DiskMark>()
  const sized = new Map<string, { bytes: number; at: number }>()
  const walks: DiskWalkRequest[] = []
  const turns: string[] = []
  const answer: World['answer'] = { value: { bytes: 4096, rebuildableBytes: 0, capped: false, entries: 3, ms: 1 } }
  const days = { value: 0 }
  const settingUp = { value: false }
  const walkerState = { workers: 0, released: 0 }
  const records: DiskRecords = {
    mark: (id) => (marks.has(id) ? { ...marks.get(id)! } : null),
    setMark: (id, m) => void marks.set(id, { ...m }),
    dropMark: (id) => void marks.delete(id),
    measured: (id, bytes, at) => void sized.set(id, { bytes, at }),
    unmeasured: (id) => void sized.delete(id),
    place: () => ({ cwd, worktreeRoot: path.dirname(cwd), busy: false }),
    sweep: () => undefined,
  }
  const walker: DiskWalker = {
    walk: async (req) => {
      walkerState.workers = 1
      walks.push(req)
      return answer.value
    },
    // this project is not git's: no removal gets as far as a look
    holdsGit: async () => null,
    release: () => {
      walkerState.workers = 0
      walkerState.released++
    },
    get workers() {
      return walkerState.workers
    },
    dispose: () => {
      walkerState.workers = 0
    },
  }
  const visible = new VisibleSet()
  const settingsListeners = new Set<() => void>()
  const disk = new DiskService({
    home: cwd,
    log: createMemoryLogger({ process: 'core' }),
    records,
    sessions: {
      store,
      refresh: (id) => {
        const v = store.get(id)
        const s = sized.get(id)
        if (v && s) store.set(id, { ...v, diskBytes: s.bytes, diskAt: s.at })
      },
      exclusive: (id, fn) => {
        turns.push(id)
        return fn()
      },
      settingUp: () => settingUp.value,
    },
    // not a git project: the walk asks git nothing, and nothing says which folders can be rebuilt
    projects: { get: () => ({ isGit: false, settings: {} }) },
    pruneDays: () => days.value,
    onSettings: (cb) => {
      settingsListeners.add(cb)
      return () => void settingsListeners.delete(cb)
    },
    visible,
    env: async () => ({}),
    walker,
  })
  const w: World = {
    disk,
    store,
    visible,
    marks,
    walks,
    turns,
    cwd,
    answer,
    days,
    setDays(n) {
      days.value = n
      for (const l of [...settingsListeners]) l()
    },
    settingsListeners,
    walker: walkerState,
    settingUp,
    set(id, o = {}) {
      const v = { ...(store.get(id) ?? view(id, cwd)), ...o }
      store.set(id, v)
      return v
    },
  }
  worlds.push(w)
  return w
}

describe('the disk service', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    for (const w of worlds.splice(0)) w.disk.dispose()
    vi.useRealTimers()
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('U-WT-19 · one timer for every session, only while something is due: a measurement while a window is open, a prune also without one; walks run one at a time on a thread that is let go when none waits; an archive is measured at once; a capped walk and a failed one are said as such', async () => {
    const w = world()
    const { disk } = w
    const window = {}
    w.set('A', { lastActivityAt: T0 - HOUR, createdAt: T0 - DAY })
    w.set('B', { lifecycle: 'detached', createdAt: T0 - DAY })
    w.set('C', { isolation: 'inplace' })
    disk.start()
    // a row for each session with a worktree of its own; nothing armed without a window, and nothing walked at start
    expect([...disk.store.keys()]).toEqual(['A', 'B'])
    expect(disk.store.get('A')).toEqual({ bytes: null, rebuildableBytes: null, capped: false, at: null, measuring: false, visible: false, viewedAt: null })
    expect(disk.resourceCounts).toEqual({ ...AT_REST, rows: 2 })
    expect(vi.getTimerCount()).toBe(0)

    // a window opens: A (live, never measured) is due an hour after core started; one timer
    disk.window(1)
    expect(disk.resourceCounts.timers).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(HOUR - 1)
    expect(w.walks).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await disk.idle()
    expect(w.walks.map((x) => x.root)).toEqual([w.cwd])
    expect(w.walks[0]).toEqual({ root: w.cwd, rebuildable: [], timeoutMs: L.diskWalkTimeoutMs })
    expect(disk.store.get('A')).toMatchObject({ bytes: 4096, at: T0 + HOUR, measuring: false, rebuildableBytes: null })
    expect(w.store.get('A')).toMatchObject({ diskBytes: 4096, diskAt: T0 + HOUR })
    // the thread is let go once nothing waits; A is measured and idle, B was never shown: nothing is due, no timer
    expect(w.walker.workers).toBe(0)
    expect(disk.resourceCounts).toEqual({ ...AT_REST, rows: 2 })
    expect(vi.getTimerCount()).toBe(0)

    // the agent works again: due an hour after the measurement; the window closes: the timer goes; it opens: armed again
    w.set('A', { lastActivityAt: Date.now() + 1 })
    expect(disk.resourceCounts.timers).toBe(1)
    disk.window(-1)
    expect(disk.resourceCounts.timers).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    expect(w.walks).toHaveLength(1)
    disk.window(1)
    await vi.advanceTimersByTimeAsync(0)
    await disk.idle()
    expect(w.walks).toHaveLength(2)

    // B is shown, then left: last seen now, written at once, and due an hour after core's start (long past)
    w.visible.set(window, 'B')
    expect(disk.store.get('B')).toMatchObject({ visible: true, viewedAt: null })
    expect(w.marks.has('B')).toBe(false)
    w.visible.set(window, null)
    expect(disk.store.get('B')).toMatchObject({ visible: false, viewedAt: Date.now() })
    expect(w.marks.get('B')).toMatchObject({ viewedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    await disk.idle()
    expect(w.walks).toHaveLength(3)

    // the Disk view asks: only what is older than an hour or never measured; its Refresh: everything, one walk at a time
    expect(disk.measureStale(false)).toBe(0)
    w.answer.value = { bytes: 8192, rebuildableBytes: 0, capped: true, entries: 9, ms: L.diskWalkTimeoutMs }
    expect(disk.measureStale(true)).toBe(2)
    expect(disk.resourceCounts).toMatchObject({ queued: 1, walking: 1 })
    expect(disk.store.get('A')?.measuring).toBe(true)
    expect(disk.store.get('B')?.measuring).toBe(true)
    // asked again while both wait or run: no second walk of the one waiting, one more of the one running, after it
    expect(disk.measureStale(true)).toBe(1)
    await disk.idle()
    expect(w.walks).toHaveLength(6)
    // a walk cancelled at the cap says so: at least that much
    expect(disk.store.get('B')).toMatchObject({ bytes: 8192, capped: true, measuring: false })
    expect(w.marks.get('B')).toMatchObject({ capped: true })

    // a walk that fails: the size stays, and it is tried an hour later, not at once
    w.answer.value = null
    w.set('A', { lastActivityAt: Date.now() + 1 })
    await vi.advanceTimersByTimeAsync(HOUR)
    await disk.idle()
    expect(w.walks).toHaveLength(7)
    expect(disk.store.get('A')).toMatchObject({ bytes: 8192, measuring: false })
    expect(disk.resourceCounts).toMatchObject({ retries: 1, timers: 1 })
    await vi.advanceTimersByTimeAsync(HOUR - 1)
    expect(w.walks).toHaveLength(7)
    w.answer.value = { bytes: 100, rebuildableBytes: 0, capped: false, entries: 1, ms: 1 }
    await vi.advanceTimersByTimeAsync(1)
    await disk.idle()
    expect(w.walks).toHaveLength(8)
    expect(disk.resourceCounts.retries).toBe(0)

    // archived: measured at once, whatever the hour; then never again by the schedule
    w.set('A', { lifecycle: 'archived', archivedAt: Date.now() })
    await disk.idle()
    expect(w.walks).toHaveLength(9)
    expect(disk.resourceCounts.timers).toBe(0)

    // With a prune period the timer is armed for it, also with no window; it is never further than an hour ahead
    disk.window(-1)
    w.setDays(7)
    expect(disk.resourceCounts.timers).toBe(1)
    await vi.advanceTimersByTimeAsync(7 * DAY - HOUR)
    expect(w.turns).toEqual([])
    await vi.advanceTimersByTimeAsync(HOUR)
    await disk.idle()
    // the prune ran in the session's own turn; this project is not git's, so nothing can be removed: looked at again in an hour
    expect(w.turns).toEqual(['A'])
    expect(disk.resourceCounts).toMatchObject({ retries: 1, timers: 1 })
    await vi.advanceTimersByTimeAsync(HOUR)
    await disk.idle()
    expect(w.turns).toEqual(['A', 'A'])
    // Never while the session is being set up: the removal is refused with the reason, by hand and for the
    // prune, which looks again an hour later
    w.settingUp.value = true
    await expect(disk.removeBuildFolders('A')).rejects.toMatchObject({ code: 'wrong_state', message: expect.stringMatching(/setup is running/) })
    await vi.advanceTimersByTimeAsync(HOUR)
    await disk.idle()
    expect(w.turns).toEqual(['A', 'A', 'A', 'A'])
    expect(disk.resourceCounts).toMatchObject({ retries: 1, timers: 1 })
    w.settingUp.value = false
    w.turns.length = 2
    // 0 days: never
    w.setDays(0)
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    await disk.idle()
    expect(w.turns).toEqual(['A', 'A'])
    expect(disk.resourceCounts.timers).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    // a session whose worktree is gone has no row; shutdown leaves no timer
    w.set('B', { worktreeMissing: true })
    expect(disk.store.has('B')).toBe(false)
    disk.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(w.settingsListeners.size).toBe(0)
    expect(w.store.listenerCount).toBe(0)
  })

  it('U-WT-20 · sessions come and go 200 times (created, shown, measured, hidden, archived, pruned at, deleted): no timer, row, mark, retry or queue entry is left, and the service has let its walker go (a stand-in here, which counts what it was asked to hold; the real thread ending after a walk and after a prune is I-WT-17 and I-WT-18)', async () => {
    const w = world()
    const { disk } = w
    const window = {}
    w.days.value = 1
    disk.start()
    disk.window(1)
    expect(disk.resourceCounts).toEqual(AT_REST)
    for (let i = 0; i < 200; i++) {
      const id = `S${i}`
      w.set(id, { createdAt: Date.now(), lastActivityAt: Date.now() })
      w.visible.set(window, id)
      expect(disk.measureStale(false)).toBe(1)
      await disk.idle()
      // a walk that fails now and then leaves a retry note
      w.answer.value = i % 5 === 0 ? null : { bytes: 1000 + i, rebuildableBytes: 0, capped: i % 7 === 0, entries: 1, ms: 1 }
      w.set(id, { lastActivityAt: Date.now() + 1 })
      await vi.advanceTimersByTimeAsync(HOUR)
      await disk.idle()
      w.visible.set(window, null)
      w.set(id, { lifecycle: 'archived', archivedAt: Date.now() })
      await disk.idle()
      expect(disk.resourceCounts.rows).toBe(1)
      // past the prune period: the timer fires, the prune fails (no git here) and notes a retry
      await vi.advanceTimersByTimeAsync(DAY)
      await disk.idle()
      expect(disk.resourceCounts.timers).toBe(1)
      w.store.delete(id)
      await disk.idle()
      expect(disk.resourceCounts, `after cycle ${i}`).toEqual(AT_REST)
      expect(w.marks.size, `marks after cycle ${i}`).toBe(0)
      expect(vi.getTimerCount(), `timers after cycle ${i}`).toBe(0)
    }
    expect(w.walks.length).toBeGreaterThanOrEqual(400)
    expect(w.walker.workers).toBe(0)
    disk.dispose()
    expect(disk.store.isDisposed).toBe(true)
  })
})
