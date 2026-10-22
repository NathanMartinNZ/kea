// The watch service on its own: `Watcher` over the real native watcher (`@parcel/watcher`'s binding, as core loads it)
// or over a native watcher driven by hand (a start that hangs, an injected error). Repositories come from
// tools/repo-factory in temp directories. What the files service does with the events is core-files.test.ts.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isAvailable, L } from '@kea/protocol'
import type { Changes } from '@kea/core/src/platform/watch/batcher.ts'
import { loadNativeWatcher, type NativeCallback, type NativeEvent, type NativeOptions, type NativeWatcher } from '@kea/core/src/platform/watch/native.ts'
import { Watcher, type GitChange, type RescanReason, type WatchMode, type WorktreeHandlers, type WorktreeWatch } from '@kea/core/src/platform/watch/watcher.ts'
import { WORKTREE_EXCLUSIONS } from '@kea/core/src/platform/watch/exclusions.ts'
import { fixtureGitEnv, tinyRepo } from '@kea-tools/repo-factory/src/index.ts'
import { ManualClock } from '../../app/ptyhost/src/test-support.ts'
import { until } from '../support/holders.ts'
import { coreOs } from '../../app/core/src/os/index.ts'

// Live updates need the native watcher: FSEvents on macOS, inotify through Kea's patched build on Linux.
const watching = isAvailable(coreOs.watcher)
/** Kernel exclusions a stream gets: FSEvents' cap on macOS, every candidate on Linux. */
const cap = (isAvailable(coreOs.watcher) ? coreOs.watcher.exclusionsMax : null) ?? WORKTREE_EXCLUSIONS.length

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function tempDir(prefix = 'kea-watch-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
}

/** A repository with `n` linked worktrees beside it; each entry is what `Watcher.worktree` needs. */
function repoWithWorktrees(n: number): { main: Req; linked: Req[] } {
  const repo = tinyRepo()
  cleanups.push(() => repo.dispose())
  const commonDir = path.join(repo.root, '.git')
  const linked: Req[] = []
  for (let i = 0; i < n; i++) {
    const root = path.join(path.dirname(repo.root), `wt${i}`)
    git(repo.root, 'worktree', 'add', '-q', '-b', `b${i}`, root)
    linked.push({ root, gitDir: git(root, 'rev-parse', '--absolute-git-dir'), commonDir })
  }
  return { main: { root: repo.root, gitDir: commonDir, commonDir }, linked }
}

interface Req {
  root: string
  gitDir: string | null
  commonDir: string | null
}

/** A consumer that writes down what it is told. */
function consumer(): WorktreeHandlers & { changes: Map<string, string>; rescans: RescanReason[]; gits: GitChange[]; modes: WatchMode[]; released: number } {
  const c = {
    changes: new Map<string, string>(),
    rescans: [] as RescanReason[],
    gits: [] as GitChange[],
    modes: [] as WatchMode[],
    released: 0,
    onChanges(ch: Changes) {
      for (const [p, k] of ch) c.changes.set(p, k)
    },
    onRescan: (why: RescanReason) => void c.rescans.push(why),
    onGit: (g: GitChange) => void c.gits.push(g),
    onMode: (m: WatchMode) => void c.modes.push(m),
    onReleased: () => void c.released++,
  }
  return c
}

interface Sub {
  dir: string
  fn: NativeCallback
  opts: NativeOptions
}

/** The real binding, with every open subscription written down. */
function recording(): { native: NativeWatcher; open: Sub[]; dirs(): string[]; subscribes: number; peak: number } {
  const real = loadNativeWatcher()
  const r = {
    open: [] as Sub[],
    subscribes: 0,
    peak: 0,
    dirs: () => r.open.map((s) => s.dir).sort(),
    native: {
      async subscribe(dir: string, fn: NativeCallback, opts: NativeOptions) {
        await real.subscribe(dir, fn, opts)
        r.subscribes++
        r.open.push({ dir, fn, opts })
        r.peak = Math.max(r.peak, r.open.length)
      },
      async unsubscribe(dir: string, fn: NativeCallback, opts: NativeOptions) {
        const i = r.open.findIndex((s) => s.dir === dir && s.fn === fn)
        if (i >= 0) r.open.splice(i, 1)
        await real.unsubscribe(dir, fn, opts)
      },
    },
  }
  return r
}

/** A native watcher driven by hand. */
function fakeNative(): NativeWatcher & { open: Sub[]; subscribes: number; unsubscribes: number; hang: boolean; fail: string | null; hung: (() => void)[]; emit(dir: string, err: Error | null, events: NativeEvent[]): void } {
  const f = {
    open: [] as Sub[],
    subscribes: 0,
    unsubscribes: 0,
    hang: false,
    fail: null as string | null,
    hung: [] as (() => void)[],
    subscribe(dir: string, fn: NativeCallback, opts: NativeOptions): Promise<unknown> {
      f.subscribes++
      if (f.fail) return Promise.reject(new Error(f.fail))
      const opened = (): void => void f.open.push({ dir, fn, opts })
      if (f.hang) return new Promise<void>((resolve) => f.hung.push(() => (opened(), resolve())))
      opened()
      return Promise.resolve()
    },
    unsubscribe(dir: string, fn: NativeCallback): Promise<unknown> {
      f.unsubscribes++
      const i = f.open.findIndex((s) => s.dir === dir && s.fn === fn)
      if (i >= 0) f.open.splice(i, 1)
      return Promise.resolve()
    },
    emit(dir: string, err: Error | null, events: NativeEvent[]) {
      for (const s of f.open.filter((x) => x.dir === dir)) s.fn(err, events)
    },
  }
  return f
}

const settled = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function watcher(o: ConstructorParameters<typeof Watcher>[0]): Watcher {
  const w = new Watcher(o)
  cleanups.push(() => w.dispose())
  return w
}

describe('the watch service', () => {
  it('I-FT-3 · "must be re-scanned" is one full refresh on the same subscription; any other error ends the stream: poll mode, one restart after L.watchRestartMs, a full refresh when it is live again; nothing escapes', async () => {
    const native = fakeNative()
    const clock = new ManualClock()
    const w = watcher({ native, clock })
    const c = consumer()
    const a = w.worktree({ root: '/w/one', gitDir: null, commonDir: null }, c)
    a.setActive(true)
    await settled()
    expect(a.mode).toBe('live')
    expect(c.rescans).toEqual(['start']) // whatever happened before the stream opened is unknown
    expect(native.subscribes).toBe(1)

    // FSEvents dropped events (the error arrives with whatever it still had, and the stream goes on)
    const dropped = new Error('Events were dropped by the FSEvents client. File system must be re-scanned.')
    native.emit('/w/one', dropped, [{ path: '/w/one/a', type: 'create' }])
    native.emit('/w/one', dropped, [{ path: '/w/one/b', type: 'create' }])
    native.emit('/w/one', null, [{ path: '/w/one/c', type: 'update' }])
    clock.advance(L.watchBatchMs)
    expect(c.rescans).toEqual(['start', 'dropped']) // one, however many errors the window held
    expect(c.changes.size).toBe(0) // a full refresh covers the single paths
    expect(a.mode).toBe('live')
    expect([native.subscribes, native.unsubscribes]).toEqual([1, 0]) // the same subscription
    native.emit('/w/one', null, [{ path: '/w/one/d', type: 'update' }])
    clock.advance(L.watchBatchMs)
    expect([...c.changes]).toEqual([['d', 'update']]) // and it still delivers

    // any other error: the stream is over
    native.emit('/w/one', new Error('FSEvents stream ended'), [])
    expect(a.mode).toBe('poll')
    expect(native.unsubscribes).toBe(1)
    expect(w.counts).toMatchObject({ polls: 1, restarts: 1 })
    clock.advance(L.watchRestartMs - 1)
    expect(native.subscribes).toBe(1)
    clock.advance(1)
    expect(native.subscribes).toBe(2) // restarted
    await settled()
    expect(a.mode).toBe('live')
    expect(c.rescans).toEqual(['start', 'dropped', 'restart'])
    expect(w.counts).toMatchObject({ polls: 0, restarts: 0, streams: 1 })
    expect(c.modes).toEqual(['live', 'poll', 'starting', 'live'])

    // the watched root deleted: the stream is dead without an error to say so
    native.emit('/w/one', null, [{ path: '/w/one', type: 'delete' }])
    expect(a.mode).toBe('poll')

    // a consumer that throws is fatal in a native callback: it must not get out
    const bad = w.worktree({ root: '/w/two', gitDir: null, commonDir: null }, { ...consumer(), onChanges: () => { throw new Error('consumer bug') } })
    bad.setActive(true)
    await settled()
    native.emit('/w/two', null, [{ path: '/w/two/x', type: 'create' }])
    expect(() => clock.advance(L.watchBatchMs)).not.toThrow()
  })

  it('I-FT-27 · a file whose creation and removal the watcher hands on in two of its batches, both inside one L.watchBatchMs window, is reported removed: whoever read the tree between the two batches (a worktree shown) does not keep a file that is gone; the rest of the window is coalesced as before', async () => {
    const native = fakeNative()
    const clock = new ManualClock()
    const w = watcher({ native, clock })
    const c = consumer()
    const a = w.worktree({ root: '/w/one', gitDir: null, commonDir: null }, c)
    a.setActive(true)
    await settled()
    // one batch of the watcher's: brief.txt made (a worktree shown now lists it), beside a file saved twice
    native.emit('/w/one', null, [{ path: '/w/one/brief.txt', type: 'create' }, { path: '/w/one/kept.txt', type: 'update' }])
    clock.advance(L.watchBatchMs - 1)
    // its next batch, still inside the same L.watchBatchMs window: brief.txt is gone
    native.emit('/w/one', null, [{ path: '/w/one/brief.txt', type: 'delete' }, { path: '/w/one/kept.txt', type: 'update' }])
    expect(c.changes.size, 'still collecting').toBe(0)
    clock.advance(1)
    expect(Object.fromEntries(c.changes)).toEqual({ 'brief.txt': 'delete', 'kept.txt': 'update' })
  })

  it.runIf(watching)('I-FT-27 · with the real watcher: a file removed as soon as the watcher hands its creation on (read between the two, as a worktree shown is) is reported removed, its removal coming in a later batch of the watcher’s, inside one L.watchBatchMs window or after it', async () => {
    const real = loadNativeWatcher()
    const root = tempDir()
    const brief = path.join(root, 'brief.txt')
    const wrapped = new Map<NativeCallback, NativeCallback>()
    const native: NativeWatcher = {
      keaPatch: real.keaPatch,
      subscribe(dir, fn, opts) {
        const f: NativeCallback = (err, events) => {
          // its creation handed on: it is there to be read, and removed at once, before the watch service has it
          if (events.some((e) => e.path === brief && e.type === 'create') && fs.existsSync(brief)) fs.rmSync(brief)
          fn(err, events)
        }
        wrapped.set(fn, f)
        return real.subscribe(dir, f, opts)
      },
      unsubscribe: (dir, fn, opts) => real.unsubscribe(dir, wrapped.get(fn) ?? fn, opts),
    }
    const w = watcher({ native })
    const c = consumer()
    const h = w.worktree({ root, gitDir: null, commonDir: null }, c)
    h.setActive(true)
    await until('live', () => h.mode === 'live')
    fs.writeFileSync(brief, 'x')
    await until('brief.txt reported removed', () => c.changes.get('brief.txt') === 'delete')
    expect(fs.existsSync(brief)).toBe(false)
  })

  it('I-FT-4 · a start that never answers is poll mode after L.watchStartTimeoutMs: a full refresh every poll interval while active, none while not, never a second start beside the hung one; a start that fails is retried at each poll', async () => {
    const native = fakeNative()
    native.hang = true
    const clock = new ManualClock()
    const w = watcher({ native, clock })
    const c = consumer()
    const a = w.worktree({ root: '/w/slow', gitDir: null, commonDir: null }, c)
    a.setActive(true)
    await settled()
    expect(a.mode).toBe('starting')
    clock.advance(L.watchStartTimeoutMs - 1)
    await settled()
    expect(a.mode).toBe('starting')
    clock.advance(1)
    await settled()
    expect(a.mode).toBe('poll')
    expect(c.rescans).toEqual([])
    clock.advance(L.watchPollMs * 3)
    expect(c.rescans).toEqual(['poll', 'poll', 'poll'])
    expect(native.subscribes).toBe(1) // the hung start is still out: no second one
    // not visible: no poll at all
    a.setActive(false)
    expect(w.counts.polls).toBe(0)
    clock.advance(L.watchPollMs * 3)
    expect(c.rescans).toHaveLength(3)
    a.setActive(true)
    // the hung start answers after all: that stream is closed again, the next poll starts a fresh one
    native.hang = false
    native.hung.splice(0).forEach((answer) => answer())
    await settled()
    expect(native.unsubscribes).toBe(1)
    expect(native.open).toHaveLength(0)
    clock.advance(L.watchPollMs)
    await settled()
    expect(native.subscribes).toBe(2)
    expect(a.mode).toBe('live')
    expect(c.rescans.at(-1)).toBe('start')
    expect(w.counts.polls).toBe(0) // no timer while the stream works

    // a start that fails (the directory is gone): poll mode at once, retried at each poll, live when it works
    native.fail = 'No such file or directory'
    const c2 = consumer()
    const b = w.worktree({ root: '/w/missing', gitDir: null, commonDir: null }, c2)
    b.setActive(true)
    await settled()
    expect(b.mode).toBe('poll')
    clock.advance(L.watchPollMs)
    await settled()
    expect(native.subscribes).toBe(4)
    expect(c2.rescans).toEqual(['poll'])
    native.fail = null
    clock.advance(L.watchPollMs)
    await settled()
    expect(b.mode).toBe('live')
    expect(c2.rescans).toEqual(['poll', 'poll', 'start'])

    // a network volume never gets a stream
    const before = native.subscribes
    const n = w.worktree({ root: '/Volumes/share/w', gitDir: null, commonDir: null, network: true }, consumer())
    n.setActive(true)
    await settled()
    expect(n.mode).toBe('poll')
    expect(native.subscribes).toBe(before)
  })

  it.runIf(watching)('I-FT-5 · 50 switches of the visible session across more worktrees than L.watchWorktreesLru: never more followed than that, one stream each plus one per repository; events in one that is followed but not visible only mark it stale; a released one holds no stream', async () => {
    const rec = recording()
    const w = watcher({ native: rec.native })
    const { main, linked } = repoWithWorktrees(4)
    const plain = [tempDir(), tempDir()].map((root) => ({ root, gitDir: null, commonDir: null })) // two folders that are not repositories
    const reqs: Req[] = [main, ...linked, ...plain] // 7 worktrees, 1 repository
    expect(reqs.length).toBeGreaterThan(L.watchWorktreesLru)
    const sessions = reqs.map((req) => ({ req, c: consumer(), a: null as WorktreeWatch | null }))
    let visible: (typeof sessions)[number] | null = null
    const show = (s: (typeof sessions)[number]): void => {
      visible?.a?.setActive(false)
      if (!s.a || s.a.released) s.a = w.worktree(s.req, s.c)
      s.a.touch()
      s.a.setActive(true)
      visible = s
    }
    let seed = 7
    const rnd = (n: number): number => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
    for (let i = 0; i < 50; i++) {
      show(sessions[i < reqs.length ? i : rnd(reqs.length)] as (typeof sessions)[number])
      const k = w.counts as Record<string, number>
      expect(k.worktrees).toBeLessThanOrEqual(L.watchWorktreesLru)
      expect(k.commonDirs).toBeLessThanOrEqual(1)
      // once what the switch opened and closed has settled: exactly the followed roots and the one common dir
      await until('the streams to settle', () => w.followed().every((f) => f.mode === 'live') && w.streams === rec.open.length)
      const followed = w.followed()
      expect(rec.dirs()).toEqual([...followed.map((f) => f.root), ...(followed.some((f) => f.commonDir) ? [main.commonDir as string] : [])].sort())
      expect(w.streams).toBeLessThanOrEqual(L.watchWorktreesLru + 1)
    }
    expect(rec.peak).toBeLessThanOrEqual(L.watchWorktreesLru + 1 + 1) // one still closing while its successor opened
    expect(w.evictions).toBeGreaterThan(10)

    // settle on a known set: the last four shown are followed, the fourth of them visible
    for (const s of sessions.slice(0, 4)) show(s)
    await until('four live worktrees', () => w.followed().length === 4 && w.followed().every((f) => f.mode === 'live') && rec.open.length === 5)
    const [s0, s1, s2, s3] = sessions as [(typeof sessions)[number], (typeof sessions)[number], (typeof sessions)[number], (typeof sessions)[number]]
    for (const s of sessions.slice(0, 4)) show(s) // each seen once since its stream opened: none is stale
    expect(sessions.slice(0, 4).map((s) => s.a?.stale)).toEqual([false, false, false, false])
    for (const s of sessions) (s.c.changes.clear(), (s.c.rescans.length = 0))
    fs.writeFileSync(path.join(s3.req.root, 'seen.txt'), 'x')
    fs.writeFileSync(path.join(s1.req.root, 'unseen.txt'), 'x')
    await until('the visible worktree’s event', () => s3.c.changes.has('seen.txt'))
    await until('the hidden worktree to be marked stale', () => s1.a?.stale === true)
    expect(s1.c.changes.size + s1.c.rescans.length + s1.c.gits.length).toBe(0) // told nothing
    expect(s0.a?.stale).toBe(false)
    expect(s2.a?.stale).toBe(false)
    // shown again: no longer stale (its owner refreshes in full on activation)
    show(s1)
    expect(s1.a?.stale).toBe(false)

    // the released ones: told so, no stream on their roots
    const gone = sessions.filter((s) => s.a?.released)
    expect(gone.length).toBe(reqs.length - L.watchWorktreesLru)
    for (const s of gone) {
      expect(s.c.released).toBeGreaterThan(0)
      expect(rec.dirs()).not.toContain(s.req.root)
    }
    w.dispose()
    await until('every stream to close', () => rec.open.length === 0 && w.streams === 0)
  })

  it('I-FT-24 · with as many worktrees on screen as L.watchWorktreesLru, one more gets no stream: none is taken from a worktree somebody is looking at, nothing is opened or closed, and its consumer is told at once that it is not followed; when one of the followed is no longer on screen, asking again gets a stream, and that one gives its own up', async () => {
    const native = fakeNative()
    const clock = new ManualClock()
    const w = watcher({ native, clock })
    const reqs = Array.from({ length: L.watchWorktreesLru + 1 }, (_, i) => ({ root: `/w/r${i}`, gitDir: null, commonDir: null }))
    const extra = reqs[L.watchWorktreesLru] as (typeof reqs)[number]
    const held = reqs.slice(0, L.watchWorktreesLru).map((req) => {
      const c = consumer()
      const a = w.worktree(req, c)
      a.setActive(true)
      return { req, c, a }
    })
    await settled()
    const roots = held.map((h) => h.req.root)
    expect(native.open.map((s) => s.dir)).toEqual(roots)
    expect(held.map((h) => h.a.mode)).toEqual(roots.map(() => 'live'))

    // one more comes on screen while all of them are looked at
    const late = consumer()
    const a = w.worktree(extra, late)
    a.touch()
    a.setActive(true)
    await settled()
    expect([a.released, late.released], 'told at once: not followed').toEqual([true, 1])
    expect(held.map((h) => [h.a.released, h.c.released]), 'no stream was taken from a worktree on screen').toEqual(roots.map(() => [false, 0]))
    expect([w.evictions, native.unsubscribes, native.subscribes]).toEqual([0, 0, L.watchWorktreesLru])
    expect(native.open.map((s) => s.dir)).toEqual(roots)
    expect(w.followed().map((f) => f.root).sort()).toEqual(roots)
    expect(w.counts.worktrees).toBe(L.watchWorktreesLru)
    // the ones on screen still hear their changes
    native.emit(roots[0] as string, null, [{ path: `${roots[0]}/a.txt`, type: 'create' }])
    clock.advance(L.watchBatchMs)
    expect([...(held[0]?.c.changes ?? [])]).toEqual([['a.txt', 'create']])
    // asking again changes nothing while every followed worktree is on screen
    const again = w.worktree(extra, consumer())
    expect(again.released).toBe(true)
    expect(w.evictions).toBe(0)

    // one of them leaves the screen: the next ask is followed, at that one's cost and nobody else's
    held[1]?.a.setActive(false)
    const next = consumer()
    const b = w.worktree(extra, next)
    b.setActive(true)
    await settled()
    expect([b.released, next.released, b.mode]).toEqual([false, 0, 'live'])
    expect(held.map((h) => h.c.released)).toEqual(roots.map((_, i) => (i === 1 ? 1 : 0)))
    expect(w.evictions).toBe(1)
    expect(w.followed().map((f) => f.root).sort()).toEqual([...roots.filter((_, i) => i !== 1), extra.root].sort())
  })

  it('I-FT-21 · in a git work tree a candidate directory is excluded in the kernel only when git ignores it whole: the stream opens once git has answered, with `.git` and the ignored candidates and never more than the cap; when the answer may have changed (a `.gitignore`, `info/exclude`, the index, `HEAD`) it is asked again, a directory that is no longer ignored whole restarts the stream without it and everything is read again, one that became ignored changes nothing; an answer that does not come excludes `.git` alone', async () => {
    const native = fakeNative()
    const clock = new ManualClock()
    const w = watcher({ native, clock })
    const root = '/w/repo'
    const gitDir = `${root}/.git`
    const asked: (readonly string[])[] = []
    let answer: (names: readonly string[]) => Promise<readonly string[] | null> = async () => ['node_modules', 'dist']
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const ignored = async (names: readonly string[]): Promise<readonly string[] | null> => {
      asked.push(names)
      if (asked.length === 1) await gate
      return answer(names)
    }
    const passed = (): string[] => native.open.find((s) => s.dir === root)?.opts.ignorePaths ?? []
    /** Every promise of the chain from git's answer to a live stream. */
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) await settled()
    }
    /** The debounce before git is asked again (L.gitDebounceMs), and what follows from its answer. */
    const again = async (): Promise<void> => {
      await flush()
      clock.advance(L.gitDebounceMs)
      await flush()
    }
    const c = consumer()
    const a = w.worktree({ root, gitDir, commonDir: gitDir, ignored }, c)
    a.setActive(true)
    await flush()
    // asked for every candidate but `.git`; until git answers, no stream on the worktree and nothing claimed live
    expect(asked).toEqual([WORKTREE_EXCLUSIONS.filter((n) => n !== '.git')])
    expect(native.open.map((s) => s.dir)).toEqual([gitDir])
    expect(a.mode).toBe('starting')
    expect(c.rescans).toEqual([])
    release()
    await flush()
    expect(passed()).toEqual([`${root}/node_modules`, gitDir, `${root}/dist`])
    expect(a.mode).toBe('live')
    expect(c.rescans).toEqual(['start'])
    // what git does not ignore is heard, though its name is a candidate's: a tracked `build/`
    native.emit(root, null, [{ path: `${root}/build/second.sh`, type: 'create' }, { path: `${root}/src/a.ts`, type: 'update' }])
    clock.advance(L.watchBatchMs)
    expect([...c.changes.keys()].sort()).toEqual(['build/second.sh', 'src/a.ts'])

    // a `.gitignore` changed and `dist/` is no longer ignored whole: the stream is opened again without it
    const opened = (): number[] => [native.subscribes, native.unsubscribes]
    const before = opened()
    answer = async () => ['node_modules']
    native.emit(root, null, [{ path: `${root}/packages/app/.gitignore`, type: 'update' }])
    native.emit(root, null, [{ path: `${root}/.gitignore`, type: 'update' }])
    await flush()
    expect(asked, 'not before L.gitDebounceMs: a burst is one question').toHaveLength(1)
    await again()
    expect(asked).toHaveLength(2)
    expect(opened()).toEqual([(before[0] as number) + 1, (before[1] as number) + 1])
    expect(passed()).toEqual([`${root}/node_modules`, gitDir])
    expect(a.mode).toBe('live')
    expect(c.rescans).toEqual(['start', 'restart']) // what happened under `dist/` meanwhile is unknown
    expect(c.modes.slice(-2)).toEqual(['starting', 'live'])

    // a directory that became ignored is only a missed saving: asked, and the stream is left as it is
    answer = async () => ['node_modules', 'out', 'coverage']
    native.emit(root, null, [{ path: `${root}/.gitignore`, type: 'update' }])
    await again()
    expect(asked).toHaveLength(3)
    expect(opened()).toEqual([(before[0] as number) + 1, (before[1] as number) + 1])
    expect(passed()).toEqual([`${root}/node_modules`, gitDir])

    // the index, `HEAD` and `info/exclude` can each change the answer (a file added with `-f` under an ignored folder)
    for (const [i, file] of ['index', 'HEAD', 'info/exclude'].entries()) {
      native.emit(gitDir, null, [{ path: `${gitDir}/${file}`, type: 'update' }])
      await again()
      expect(asked, file).toHaveLength(4 + i)
    }
    answer = async () => []
    native.emit(gitDir, null, [{ path: `${gitDir}/index`, type: 'update' }])
    await again()
    expect(passed()).toEqual([gitDir])
    expect(c.rescans).toEqual(['start', 'restart', 'restart'])
    // with `.git` alone excluded, a change of the index cannot make anything heard that is not: git is not asked
    const calls = asked.length
    native.emit(gitDir, null, [{ path: `${gitDir}/index`, type: 'update' }])
    await again()
    expect(asked).toHaveLength(calls)
    // while nobody looks nothing is asked; it is asked when the session is shown again
    a.setActive(false)
    native.emit(root, null, [{ path: `${root}/.gitignore`, type: 'update' }])
    await again()
    expect(asked).toHaveLength(calls)
    answer = async () => WORKTREE_EXCLUSIONS.filter((n) => n !== '.git')
    a.setActive(true)
    await flush()
    expect(asked).toHaveLength(calls + 1)
    expect(passed(), 'only gains: left as it is').toEqual([gitDir])

    // Never more than the cap (macOS; Linux has none), however many git ignores; and git not answering excludes `.git` alone
    const all = w.worktree({ root: '/w/all', gitDir: '/w/all/.git', commonDir: '/w/all/.git', ignored: async (names) => names }, consumer())
    const unknown = w.worktree({ root: '/w/unknown', gitDir: '/w/unknown/.git', commonDir: '/w/unknown/.git', ignored: async () => null }, consumer())
    const failing = w.worktree({ root: '/w/failing', gitDir: '/w/failing/.git', commonDir: '/w/failing/.git', ignored: () => Promise.reject(new Error('git did not answer')) }, consumer())
    await flush()
    const of = (dir: string): string[] => native.open.find((s) => s.dir === dir)?.opts.ignorePaths ?? []
    expect(of('/w/all')).toEqual(WORKTREE_EXCLUSIONS.slice(0, cap).map((n) => `/w/all/${n}`))
    expect(of('/w/all')).toHaveLength(cap)
    expect(of('/w/unknown')).toEqual(['/w/unknown/.git'])
    expect(of('/w/failing')).toEqual(['/w/failing/.git'])
    expect([all.mode, unknown.mode, failing.mode]).toEqual(['live', 'live', 'live'])
    // an answer that never comes does not hold the stream back for good: after L.watchStartTimeoutMs, `.git` alone
    const never = w.worktree({ root: '/w/never', gitDir: '/w/never/.git', commonDir: '/w/never/.git', ignored: () => new Promise(() => undefined) }, consumer())
    await flush()
    expect(never.mode).toBe('starting')
    expect(native.open.some((s) => s.dir === '/w/never')).toBe(false)
    clock.advance(L.watchStartTimeoutMs)
    await flush()
    expect(of('/w/never')).toEqual(['/w/never/.git'])
    expect(never.mode).toBe('live')
  })

  it.runIf(watching)('I-FT-10 · a worktree with every candidate directory gets exactly the exclusion cap (every candidate on Linux, which has none), and nothing below an excluded directory is delivered; the kernel honours a list of that size and ignores a longer one (FSEvents)', async () => {
    const root = tempDir()
    for (const d of WORKTREE_EXCLUSIONS) fs.mkdirSync(path.join(root, d))
    fs.mkdirSync(path.join(root, 'src'))
    const rec = recording()
    const w = watcher({ native: rec.native })
    const c = consumer()
    const a = w.worktree({ root, gitDir: null, commonDir: null }, c)
    a.setActive(true)
    await until('the stream', () => a.mode === 'live')
    const passed = rec.open[0]?.opts.ignorePaths ?? []
    expect(passed).toHaveLength(cap) // 10 candidates: on macOS exactly 8, never 9 (which would switch all of them off); on Linux all 10
    expect(passed).toEqual(WORKTREE_EXCLUSIONS.slice(0, cap).map((d) => path.join(root, d)))
    for (const d of WORKTREE_EXCLUSIONS) for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, d, `f${i}`), 'x')
    fs.writeFileSync(path.join(root, 'src', 'last.txt'), 'x')
    await until('the event that was written last', () => c.changes.has('src/last.txt'))
    const tops = new Set([...c.changes.keys()].map((p) => p.split('/')[0]))
    expect([...tops].sort()).toEqual([...WORKTREE_EXCLUSIONS.slice(cap), 'src'].sort()) // macOS: the two past the cap are heard, the eight are not

    // The watcher also drops excluded paths in its own thread, so the above would pass with the kernel list switched
    // off. The kernel's part, seen alone: exclusions written so that only the kernel matches them (a trailing slash).
    // That list is FSEvents'; inotify has none: there an ignored directory is never walked or watched.
    if (coreOs.system !== 'darwin') return
    const real = loadNativeWatcher()
    const probe = async (count: number): Promise<number> => {
      const dir = tempDir('kea-watch-probe-')
      const names = Array.from({ length: count }, (_, i) => `x${i}`)
      for (const n of names) fs.mkdirSync(path.join(dir, n))
      let below = 0
      let done = false
      const fn: NativeCallback = (_err, events) => {
        for (const e of events) {
          if (e.path === path.join(dir, 'done')) done = true
          else if (path.dirname(e.path) !== dir) below++
        }
      }
      const opts = { ignorePaths: names.map((n) => `${path.join(dir, n)}/`) }
      await real.subscribe(dir, fn, opts)
      try {
        for (const n of names) for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, n, `f${i}`), 'x')
        fs.writeFileSync(path.join(dir, 'done'), 'x')
        await until('the probe’s last event', () => done)
      } finally {
        await real.unsubscribe(dir, fn, opts)
      }
      return below
    }
    expect(await probe(L.watchExclusionsMax)).toBe(0) // the kernel dropped every one
    expect(await probe(L.watchExclusionsMax + 1)).toBeGreaterThan(0) // one more and none is excluded
  })

  it.runIf(watching)('I-FT-11 · three worktrees of one repository share one common-dir stream, kept until the last of them is released; a commit in one reaches all three', async () => {
    const rec = recording()
    const w = watcher({ native: rec.native })
    const { main, linked } = repoWithWorktrees(3)
    const common = main.commonDir as string
    const three = linked.map((req) => ({ req, c: consumer(), a: null as WorktreeWatch | null }))
    for (const s of three) {
      s.a = w.worktree(s.req, s.c)
      s.a.setActive(true)
    }
    await until('three live worktrees', () => three.every((s) => s.a?.mode === 'live'))
    const commons = (): number => rec.open.filter((s) => s.dir === common).length
    expect(commons()).toBe(1)
    expect(rec.open).toHaveLength(4) // three roots and the common dir: a linked worktree's git dir lies inside it
    expect(w.counts).toMatchObject({ worktrees: 3, commonDirs: 1, streams: 4 })
    expect(rec.open.find((s) => s.dir === common)?.opts.ignorePaths).toEqual([path.join(common, 'objects'), path.join(common, 'logs'), path.join(common, 'modules'), path.join(common, 'lfs'), path.join(common, 'fsmonitor--daemon')])

    // a commit in the first: its own index and branch move, and the ref is news for all three
    for (const s of three) s.c.gits.length = 0
    fs.writeFileSync(path.join(three[0]!.req.root, 'new.txt'), 'x\n')
    git(three[0]!.req.root, 'add', 'new.txt')
    git(three[0]!.req.root, 'commit', '-q', '-m', 'one')
    await until('the commit to reach all three', () => three.every((s) => s.c.gits.some((g) => g.refs)))
    expect(three[0]!.c.gits.some((g) => g.index)).toBe(true)
    expect(three[1]!.c.gits.some((g) => g.index || g.head)).toBe(false) // another worktree's index is not theirs
    expect(three[2]!.c.gits.some((g) => g.index || g.head)).toBe(false)

    // released one at a time: the first by the LRU (nobody looks at it any more, and two more worktrees push it out
    // before the two that are still on screen), the others by their owners
    three[0]!.a?.setActive(false)
    const more = [tempDir(), tempDir()].map((root) => w.worktree({ root, gitDir: null, commonDir: null }, consumer()))
    expect(three[1]!.a?.released || three[2]!.a?.released).toBe(false)
    expect(three[0]!.a?.released).toBe(true)
    expect(three[0]!.c.released).toBe(1)
    await until('its stream to close', () => !rec.dirs().includes(three[0]!.req.root))
    expect(commons()).toBe(1)
    three[1]!.a?.dispose()
    await until('its stream to close', () => !rec.dirs().includes(three[1]!.req.root))
    expect(commons()).toBe(1)
    expect(w.counts.commonDirs).toBe(1)
    three[2]!.a?.dispose()
    await until('the common-dir stream to close with its last worktree', () => commons() === 0)
    expect(w.counts.commonDirs).toBe(0)
    for (const m of more) m.dispose()
    await until('every stream to close', () => rec.open.length === 0 && w.streams === 0)
  })
  it.runIf(watching)('I-FT-15 · a directory asked for before it exists is followed once it is made: outside any worktree from its nearest existing ancestor, inside a followed worktree on that worktree’s stream; entries added to it are reported, and nothing is opened for it beyond the service’s own watches', async () => {
    const rec = recording()
    const w = watcher({ native: rec.native })
    const seen = (dir: string): { calls: number; names: string[] | null; onChange(): void } => {
      const c = {
        calls: 0,
        names: null as string[] | null,
        onChange() {
          c.calls++
          try {
            c.names = fs.readdirSync(dir)
          } catch {
            c.names = null
          }
        },
      }
      return c
    }

    // outside any worktree: a session's worktree that is still being created
    const parent = tempDir()
    const wt = path.join(parent, 'project', 'wt-1')
    const out = seen(wt)
    const a = w.dir(wt, () => out.onChange())
    expect(w.counts).toMatchObject({ dirs: 1, streams: 0 })
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    await until('the directory, once made, to be reported', () => out.names?.includes('src') === true)
    fs.writeFileSync(path.join(wt, 'start.sh'), '#!/bin/sh\n')
    await until('an entry added to it to be reported', () => out.names?.includes('start.sh') === true)
    fs.rmSync(wt, { recursive: true })
    await until('its removal to be reported', () => out.calls > 0 && out.names === null)
    fs.mkdirSync(wt)
    fs.writeFileSync(path.join(wt, 'start.sh'), '#!/bin/sh\n')
    await until('its return to be reported', () => out.names?.includes('start.sh') === true)
    a.dispose()
    expect(w.counts.dirs).toBe(0)

    // inside a followed worktree: the stream says so, no watch of its own
    const root = tempDir()
    const c = consumer()
    const follow = w.worktree({ root, gitDir: null, commonDir: null }, c)
    follow.setActive(true)
    await until('the worktree to be live', () => follow.mode === 'live')
    const sub = path.join(root, 'scripts')
    const inside = seen(sub)
    const b = w.dir(sub, () => inside.onChange())
    expect(w.counts).toMatchObject({ dirs: 0, riders: 1 })
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, 'start.sh'), '#!/bin/sh\n')
    await until('the directory made inside the worktree, and its entry, to be reported', () => inside.names?.includes('start.sh') === true)
    b.dispose()
    follow.dispose()
    await until('every stream to close', () => rec.open.length === 0 && w.streams === 0)
  })
})
