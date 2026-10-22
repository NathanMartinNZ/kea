// The watch service's Linux rules over a native watcher driven by hand and a stand-in for inotify's
// limits, so they run on every system: the entries cap, the limits met, the interim guard and the drain. The real
// kernel's side is in the integration tests (tests/integration/core-watch-linux.test.ts).

import { L } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InotifyMax, WatchLimitKind, WatchLimits } from '../../os/index.ts'
import type { LimitBanners } from './limits.ts'
import type { NativeCallback, NativeWatcher } from './native.ts'
import { Watcher, type RescanReason, type WatchMode, type WorktreeHandlers } from './watcher.ts'

// One test (U-PLT-48) makes the binding fail to load; every other test passes its own native watcher, so none loads it
const load = vi.hoisted(() => ({ fails: false }))
vi.mock('./native.ts', async (actual) => {
  const real = await actual<typeof import('./native.ts')>()
  return {
    ...real,
    loadNativeWatcher: (): NativeWatcher => {
      if (load.fails) throw new Error('@parcel/watcher is not installed')
      return real.loadNativeWatcher()
    },
  }
})

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
  vi.useRealTimers()
  load.fails = false
})

/** A native watcher driven by hand: each subscription reports `entries(dir)` (the patched binding's count) and fails with `fail(dir)`. */
function fakeNative(o: { patched: boolean }): NativeWatcher & {
  open: { dir: string; fn: NativeCallback }[]
  subscribed: string[]
  unsubscribes: number
  entries: (dir: string) => number | null
  fail: (dir: string) => string | null
  emit(dir: string, err: Error): void
} {
  const f = {
    ...(o.patched ? { keaPatch: 1 } : {}),
    open: [] as { dir: string; fn: NativeCallback }[],
    subscribed: [] as string[],
    unsubscribes: 0,
    entries: (_dir: string): number | null => null,
    fail: (_dir: string): string | null => null,
    subscribe(dir: string, fn: NativeCallback): Promise<unknown> {
      f.subscribed.push(dir)
      const err = f.fail(dir)
      if (err) return Promise.reject(new Error(err))
      f.open.push({ dir, fn })
      return Promise.resolve(o.patched ? f.entries(dir) : undefined)
    },
    unsubscribe(dir: string, fn: NativeCallback): Promise<unknown> {
      f.unsubscribes++
      const i = f.open.findIndex((s) => s.dir === dir && s.fn === fn)
      if (i >= 0) f.open.splice(i, 1)
      return Promise.resolve()
    },
    emit(dir: string, err: Error) {
      for (const s of f.open.filter((x) => x.dir === dir)) s.fn(err, [])
    },
  }
  return f
}

const ENOSPC = (dir: string): string => `inotify_add_watch on '${dir}/deep' failed: No space left on device`
const EMFILE = 'Unable to initialize inotify: Too many open files'

/** inotify's limits as the test sets them. */
function fakeLimits(max: InotifyMax): WatchLimits & { now: InotifyMax; used: number; reads: number } {
  const l = {
    now: { ...max },
    used: 1,
    reads: 0,
    max: async (): Promise<InotifyMax> => {
      l.reads++
      return { ...l.now }
    },
    userInstances: async (): Promise<number> => l.used,
    ownWatches: async (): Promise<number> => 7,
    limitOf: (m: string): WatchLimitKind | null => (m.endsWith('No space left on device') ? 'watches' : m === EMFILE ? 'instances' : null),
    setting: (k: WatchLimitKind): string => `fs.inotify.max_user_${k}`,
    fix: (k: WatchLimitKind): string => `raise max_user_${k}`,
  }
  return l
}

function banners(): LimitBanners & { shown: { message: string; fix: string | null }[]; cleared: number } {
  const b = {
    shown: [] as { message: string; fix: string | null }[],
    cleared: 0,
    set: (x: { kind: string; source: string; message: string; fix: string | null }) => {
      expect([x.kind, x.source]).toEqual(['watchLimit', 'watch'])
      b.shown.push({ message: x.message, fix: x.fix })
    },
    clear: () => void b.cleared++,
  }
  return b
}

function consumer(): WorktreeHandlers & { rescans: RescanReason[]; modes: WatchMode[]; released: number } {
  const c = {
    rescans: [] as RescanReason[],
    modes: [] as WatchMode[],
    released: 0,
    onChanges: () => undefined,
    onRescan: (why: RescanReason) => void c.rescans.push(why),
    onGit: () => undefined,
    onMode: (m: WatchMode) => void c.modes.push(m),
    onReleased: () => void c.released++,
  }
  return c
}

function service(o: ConstructorParameters<typeof Watcher>[0]): Watcher {
  const w = new Watcher(o)
  cleanups.push(() => w.dispose())
  return w
}

/** Every promise the service chains on what the stand-ins answer. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

/** Follow `root` (not a repository: one stream, no git dir) for a consumer that is on screen. */
function follow(w: Watcher, root: string, active = true): { c: ReturnType<typeof consumer>; h: ReturnType<Watcher['worktree']> } {
  const c = consumer()
  const h = w.worktree({ root, gitDir: null, commonDir: null }, c)
  h.setActive(active)
  return { c, h }
}

describe('the watch service on Linux’s terms', () => {
  it('U-PLT-48 · a watcher binding that does not load, where inotify’s limits apply: the worktree polls and no stream is left starting; the look at which binding it is never throws out of the start (it crashed core over and over)', async () => {
    load.fails = true
    const w = service({ limits: fakeLimits({ watches: 100, instances: 128 }) })
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => void unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    cleanups.push(() => process.off('unhandledRejection', onUnhandled))
    const a = follow(w, '/w/a')
    await settled()
    await new Promise<void>((r) => setImmediate(r))
    expect(a.c.modes.at(-1)).toBe('poll')
    expect(w.followed().map((x) => x.mode)).toEqual(['poll'])
    expect(w.counts.streams).toBe(0)
    expect(unhandled).toEqual([])
  })

  it('U-PLT-22 · the entries cap: followed streams over watch_entries_max entries in all are released oldest first, as in an eviction, never one on screen but the one just started; a worktree released this way is followed again when it is shown and there is room for what it held, and refused at once while there is none', async () => {
    const f = fakeNative({ patched: true })
    const part = Math.floor(L.watchEntriesMax * 0.4)
    const sizes = new Map<string, number>([
      ['/w/a', part],
      ['/w/b', part],
      ['/w/c', part],
      ['/w/huge', L.watchEntriesMax + 1],
    ])
    f.entries = (dir) => sizes.get(dir) ?? 1
    const w = service({ native: f, limits: null })

    const a = follow(w, '/w/a')
    await settled()
    a.h.setActive(false)
    const b = follow(w, '/w/b')
    await settled()
    b.h.setActive(false)
    expect(w.counts.entries).toBe(2 * part)
    // the third takes the followed worktrees past the cap: the oldest that nobody looks at goes
    const c = follow(w, '/w/c')
    await settled()
    expect(a.c.released, 'the oldest, off screen').toBe(1)
    expect(w.followed().map((x) => x.root)).toEqual(['/w/c', '/w/b'])
    expect(w.counts).toMatchObject({ entries: 2 * part, entriesReleased: 1, evictions: 0 })
    expect(f.open.map((s) => s.dir).sort()).toEqual(['/w/b', '/w/c'])

    // shown again while both followed ones are on screen: no room for what it held, so it is not followed (no walk)
    b.h.setActive(true)
    const subscribes = f.subscribed.length
    const again = follow(w, '/w/a')
    expect(again.c.released, 'told at once, as for a stream refused over the cap').toBe(1)
    expect(f.subscribed.length).toBe(subscribes)
    expect(w.counts.entriesReleased).toBe(2)

    // one goes off screen: there is room now, and following it releases that one
    b.h.setActive(false)
    const back = follow(w, '/w/a')
    await settled()
    expect(back.c.released).toBe(0)
    expect(b.c.released).toBe(1)
    expect(w.followed().map((x) => [x.root, x.mode, x.entries])).toEqual([
      ['/w/a', 'live', part],
      ['/w/c', 'live', part],
    ])

    // a tree that alone holds more than the cap: released itself, and nothing on screen is touched
    const huge = follow(w, '/w/huge')
    await settled()
    expect(huge.c.released).toBe(1)
    expect([back.c.released, c.c.released]).toEqual([0, 0])
    expect(w.counts.entries).toBe(2 * part)
    expect(f.open.map((s) => s.dir).sort()).toEqual(['/w/a', '/w/c'])
  })

  it('U-PLT-30 · the watch limit with the prebuilt binding: a subscription that fails with ENOSPC leaves its worktree polling with one banner (the limit, Kea’s watches, the fix); every stream ends and the followed ones start again, once, not the one that failed; nothing is subscribed while the limit holds (poll, focus, a worktree shown); raised, everything starts and the banner goes; with the patch nothing is drained; each time a limit comes to be held or is let go the service says so (core tells main, for the platform report’s inotify line)', async () => {
    vi.useFakeTimers()
    const f = fakeNative({ patched: false })
    const l = fakeLimits({ watches: 100, instances: 128 })
    const shown = banners()
    const w = service({ native: f, limits: l })
    w.bindBanners(shown)
    const held: boolean[] = []
    w.onLimitHeld((h) => held.push(h))

    const a = follow(w, '/w/a')
    await settled()
    expect(a.c.modes.at(-1)).toBe('live')
    f.fail = (dir) => (dir === '/w/b' ? ENOSPC(dir) : null)
    const b = follow(w, '/w/b')
    await settled()
    expect(b.c.modes.at(-1), 'refresh on focus, activation and finished tools').toBe('poll')
    expect(w.counts.limitHeld).toBe(1)
    expect(held).toEqual([true])
    expect(shown.shown).toEqual([{ message: expect.stringContaining('fs.inotify.max_user_watches = 100'), fix: 'raise max_user_watches' }])
    expect(shown.shown[0]?.message).toContain('Kea holds 7 watches')
    // the drain: `a` ended (its watches and the failed one's went with the backend) and started again; `b` was not tried
    expect(f.unsubscribes).toBe(1)
    expect(f.subscribed).toEqual(['/w/a', '/w/b', '/w/a'])
    expect(a.c.modes.slice(-3)).toEqual(['poll', 'starting', 'live'])
    expect(a.c.rescans.at(-1)).toBe('restart')

    // while the limit holds nothing is subscribed: the poll refreshes, a window focused and a worktree shown read it again
    await vi.advanceTimersByTimeAsync(3 * L.watchPollMs)
    w.focus()
    const c = follow(w, '/w/c')
    await settled()
    expect(f.subscribed).toEqual(['/w/a', '/w/b', '/w/a'])
    expect(b.c.rescans.filter((r) => r === 'poll').length).toBe(3)
    expect(c.c.modes.at(-1)).toBe('poll')
    expect(l.reads).toBeGreaterThanOrEqual(4)

    // raised: the next refresh starts every followed worktree, the banner goes
    f.fail = () => null
    l.now.watches = 200
    w.focus()
    await settled()
    expect(f.subscribed.slice(3).sort()).toEqual(['/w/b', '/w/c'])
    expect([b.c.modes.at(-1), c.c.modes.at(-1)]).toEqual(['live', 'live'])
    expect([w.counts.limitHeld, shown.cleared]).toEqual([0, 1])
    expect(held).toEqual([true, false])

    // met again: held again, but the drain was this launch's one and the banner too
    f.fail = (dir) => (dir === '/w/d' ? ENOSPC(dir) : null)
    const d = follow(w, '/w/d')
    await settled()
    expect(d.c.modes.at(-1)).toBe('poll')
    expect(w.counts.limitHeld).toBe(1)
    expect(held, 'told again, though the banner is not shown again').toEqual([true, false, true])
    expect(f.unsubscribes).toBe(1)
    expect(shown.shown.length).toBe(1)

    // the patched binding frees what a failed subscription added itself: no drain. A stream that ends with ENOSPC (a
    // directory made later that could not be watched) holds the limit too, and is not started again while it holds.
    const p = fakeNative({ patched: true })
    const lp = fakeLimits({ watches: 100, instances: 128 })
    const wp = service({ native: p, limits: lp })
    const x = follow(wp, '/w/x')
    await settled()
    p.fail = (dir) => (dir === '/w/y' ? ENOSPC(dir) : null)
    follow(wp, '/w/y')
    await settled()
    expect(p.unsubscribes).toBe(0)
    expect(x.c.modes.at(-1)).toBe('live')
    lp.now.watches = 300
    wp.focus()
    await settled()
    p.fail = () => null
    p.emit('/w/x', new Error(ENOSPC('/w/x')))
    await settled()
    expect(x.c.modes.at(-1)).toBe('poll')
    expect(wp.counts.limitHeld).toBe(1)
    await vi.advanceTimersByTimeAsync(L.watchRestartMs + L.watchPollMs)
    expect(p.subscribed.filter((s) => s === '/w/x').length, 'not started again while the limit holds').toBe(1)
  })

  it('U-PLT-31 · the instance limit: with the prebuilt binding no first subscription is made while this user’s inotify instances are at max_user_instances (it would hang core’s thread), and the worktree polls with the banner; once one is free the next refresh starts it; the patched binding is not guarded and its rejection holds the same limit', async () => {
    vi.useFakeTimers()
    const f = fakeNative({ patched: false })
    const l = fakeLimits({ watches: 100, instances: 4 })
    l.used = 4
    const shown = banners()
    const w = service({ native: f, limits: l })
    w.bindBanners(shown)
    const a = follow(w, '/w/a')
    await settled()
    expect(f.subscribed, 'never tried').toEqual([])
    expect(a.c.modes.at(-1)).toBe('poll')
    expect(shown.shown).toEqual([{ message: expect.stringContaining('fs.inotify.max_user_instances = 4'), fix: 'raise max_user_instances' }])
    await vi.advanceTimersByTimeAsync(L.watchPollMs)
    expect(f.subscribed).toEqual([])
    l.used = 3
    await vi.advanceTimersByTimeAsync(L.watchPollMs)
    await settled()
    expect(f.subscribed).toEqual(['/w/a'])
    expect(a.c.modes.at(-1)).toBe('live')
    expect(shown.cleared).toBe(1)
    // with a stream live the backend is up: the next subscription needs no look
    const reads = l.reads
    follow(w, '/w/b')
    await settled()
    expect(f.subscribed).toEqual(['/w/a', '/w/b'])
    expect(l.reads).toBe(reads)

    const p = fakeNative({ patched: true })
    const lp = fakeLimits({ watches: 100, instances: 4 })
    lp.used = 4
    p.fail = () => EMFILE
    const wp = service({ native: p, limits: lp })
    const x = follow(wp, '/w/x')
    await settled()
    expect(p.subscribed, 'tried: the patch rejects at once').toEqual(['/w/x'])
    expect([x.c.modes.at(-1), wp.counts.limitHeld]).toEqual(['poll', 1])
  })
})
