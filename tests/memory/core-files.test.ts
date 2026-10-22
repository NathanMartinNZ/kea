// Files and git in core under cycles and volume: directory caches, git snapshots, the finder's index and worker, the
// watcher's subscriptions and event queue, and git's child processes. The files service runs in-process
// (tests/integration/core-files-support.ts) with the real file watcher, real git and temp repositories.
//
//   L-FT-1  30 sessions visited in turn, 300 visits: caches, snapshots and finder indexes only for the
//           L.fileCacheSessions most recent sessions, watched worktrees within L.watchWorktreesLru, heap flat
//   L-FT-2  a git that prints without end is killed at the byte cap and the result says truncated; then 5 000 normal
//           status runs leave no zombie, no extra handle and no child behind
//   L-FT-3  1 000 worktree evictions: streams within P-FD-1 throughout, one shared common-dir stream per repository,
//           native growth per eviction within L.watchCycleLeakMaxBytes; then 1 000 000 file events: the event
//           queue never above L.watchRescanThreshold
//
// Counts are the smallest that cross every cap involved at least once.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { activeCount, queuedCount, setGitBinary } from '@kea/kit'
import { L } from '@kea/protocol'
import { loadNativeWatcher, type NativeCallback, type NativeEvent, type NativeOptions, type NativeWatcher } from '@kea/core/src/platform/watch/native.ts'
import { fixtureGitEnv } from '@kea-tools/repo-factory/src/index.ts'
import { helperBinary, until } from '../support/holders.ts'
import { cleanup, linkedWorktree, repo, startFiles, tempDir, write, type FilesUnderTest } from '../integration/core-files-support.ts'
import { fdCount, footprint, heapUsed, leakCycles, settle } from './ptyhost-leak.ts'

let t: FilesUnderTest | null = null
afterEach(async () => {
  await t?.dispose()
  t = null
  cleanup()
})

/** The whole process table as `ps` prints it: past Node's default 1 MiB for a child's output when busy (ENOBUFS). */
const PS_MAX_BYTES = 64 * 2 ** 20

/** The real binding, with every open subscription's callback at hand (to deliver events by hand). */
function tappedNative(): { native: NativeWatcher; open: { dir: string; fn: NativeCallback }[]; emit(dir: string, events: NativeEvent[]): void } {
  const real = loadNativeWatcher()
  const open: { dir: string; fn: NativeCallback }[] = []
  return {
    open,
    emit: (dir, events) => {
      for (const s of open.filter((x) => x.dir === dir)) s.fn(null, events)
    },
    native: {
      async subscribe(dir: string, fn: NativeCallback, opts: NativeOptions) {
        await real.subscribe(dir, fn, opts)
        open.push({ dir, fn })
      },
      async unsubscribe(dir: string, fn: NativeCallback, opts: NativeOptions) {
        const i = open.findIndex((s) => s.dir === dir && s.fn === fn)
        if (i >= 0) open.splice(i, 1)
        await real.unsubscribe(dir, fn, opts)
      },
    },
  }
}

describe('files and git under cycles', () => {
  it('L-FT-1 · 30 sessions visited in turn, 300 visits: directory caches, git snapshots and finder indexes are held only for the L.fileCacheSessions most recent sessions, streams stay within L.watchWorktreesLru worktrees, the heap is flat', async () => {
    const r = repo()
    t = await startFiles()
    const ids = Array.from({ length: 30 }, (_, i) => `s${i}`)
    ids.forEach((id, i) => t!.session(id, linkedWorktree(r.root, `wt-${i}`), { baseBranch: 'main' }))
    const ft = t
    let worst = { cached: 0, finder: 0, workers: 0, worktrees: 0, sessions: 0 }
    const visit = async (i: number): Promise<void> => {
      const id = ids[i % ids.length] as string
      ft.show(id)
      await ft.ready(id)
      await ft.call('files.expand', { sessionId: id, path: 'src' })
      if (i % 3 !== 0) await ft.call('files.find', { sessionId: id, query: 'math' }) // an index (and its worker) for two of every three
      const c = ft.files.counts as Record<string, number>
      const w = ft.watcher?.counts as Record<string, number>
      worst = { cached: Math.max(worst.cached, c.cached as number), finder: Math.max(worst.finder, c.finderIndexes as number), workers: Math.max(worst.workers, c.finderWorkers as number), worktrees: Math.max(worst.worktrees, w.worktrees as number), sessions: Math.max(worst.sessions, c.sessions as number) }
      expect(c.cached).toBeLessThanOrEqual(L.fileCacheSessions)
      expect(c.finderIndexes).toBeLessThanOrEqual(L.fileCacheSessions)
      expect(c.sessions).toBeLessThanOrEqual(L.watchWorktreesLru + 1) // caches or a watch, plus the one being shown
      expect(w.worktrees).toBeLessThanOrEqual(L.watchWorktreesLru)
      expect(w.commonDirs).toBe(1)
    }
    const g = await leakCycles({ total: 300, cycle: visit, measure: heapUsed })
    expect(worst).toMatchObject({ cached: L.fileCacheSessions, worktrees: L.watchWorktreesLru }) // the caps were reached, and held
    expect(worst.finder).toBeGreaterThan(1)
    expect(g.ok, `heap grew ${Math.round(g.slope)} B per visit, ${Math.round(g.absolute / 1024)} KiB in all`).toBe(true)
    // everything hidden: the stores are gone, and what is held is the last few sessions' caches and watches, nothing per visit
    ft.show(null)
    expect(ft.stores.names()).toEqual([])
    const c = ft.files.counts as Record<string, number>
    expect(c).toMatchObject({ visible: 0, statusRunning: 0, statusPending: 0 })
    expect(c.sessions).toBeLessThanOrEqual(L.watchWorktreesLru)
    expect(c.cached).toBeLessThanOrEqual(L.fileCacheSessions)
    expect(ft.files.evictions).toBeGreaterThanOrEqual(300 - ids.length)
    // the finder's index goes with its session's caches; the one of a session merely hidden goes after its delay
    for (const id of ids) ft.files.session(id)?.dropFinder()
    expect(ft.files.counts).toMatchObject({ finderIndexes: 0, finderWorkers: 0, finderPaths: 0 })
  })

  it('L-FT-2 · a git that prints 200 MB is killed at the byte cap and the status says truncated; 5 000 status runs later there is no zombie, no extra handle, no child', async () => {
    const r = repo()
    const dir = tempDir()
    const flood = path.join(dir, 'flood')
    const real = execFileSync('/usr/bin/which', ['git'], { env: fixtureGitEnv() }).toString().trim() // os-ok: in /usr/bin on both systems
    // `status` prints header records without end (no entries, so L.gitStatusEntriesMax never ends the parse first)
    const stub = path.join(dir, 'git')
    // os-ok: in /usr/bin on both systems
    fs.writeFileSync(stub, `#!/bin/sh\nif [ "$1" = status ] && [ -e '${flood}' ]; then\n  /usr/bin/yes '# kea.filler 0123456789012345678901234567890123456789012345678901234567890123456789' | /usr/bin/tr '\\n' '\\0'\n  exit 0\nfi\nexec '${real}' "$@"\n`, { mode: 0o755 })
    setGitBinary(stub)
    t = await startFiles()
    t.session('s1', r.root)
    write(r.root, 'kept.txt')
    t.show('s1')
    await t.ready('s1')
    const helper = await helperBinary()
    const children = (): string[] =>
      execFileSync('/bin/ps', ['-axo', 'ppid=,stat=,command='], { maxBuffer: PS_MAX_BYTES }).toString().split('\n').filter((l) => l.trim().startsWith(`${process.pid} `) && !l.includes('/bin/ps'))
    const handles = (): number => process.getActiveResourcesInfo().filter((x) => x !== 'Timeout' && x !== 'Immediate').length
    // at rest first: a child of the session's first status that is still being let go is not part of the baseline
    await settle()
    const before = { fds: await fdCount(process.pid), handles: handles(), heap: await heapUsed() }

    // 200 MB and more, if nobody stopped it
    fs.writeFileSync(flood, '')
    let runs = t.statusRuns('s1')
    await t.call('files.refresh', { sessionId: 's1' })
    await until('the flooded status to end', () => t!.statusRuns('s1') > runs && t!.s('s1').scheduler.idle)
    expect(t.s('s1').statusCounters).toMatchObject({ truncated: 1, timeouts: 0 })
    expect(t.head('s1')).toMatchObject({ state: 'ok', truncated: true }) // what was read stands, marked
    await until('the flooding children to be gone', () => children().every((l) => !l.includes('yes') && !l.includes('/usr/bin/tr'))) // os-ok: in /usr/bin on both systems
    expect(execFileSync('/bin/ps', ['-axo', 'command='], { maxBuffer: PS_MAX_BYTES }).toString().split('\n').filter((l) => l.includes('kea.filler'))).toEqual([])
    fs.rmSync(flood)

    // 5 000 normal runs
    const ft = t
    const g = await leakCycles({
      total: 5_000,
      cycle: async () => {
        runs = ft.statusRuns('s1')
        ft.s('s1').scheduler.now()
        await until('the run', () => ft.statusRuns('s1') > runs && ft.s('s1').scheduler.idle, 30_000)
      },
      measure: heapUsed,
    })
    expect(t.head('s1')).toMatchObject({ state: 'ok', truncated: false })
    expect(t.codes('s1')).toEqual({ 'kept.txt': 'U' })
    expect(g.ok, `heap grew ${Math.round(g.slope)} B per run, ${Math.round(g.absolute / 1024)} KiB in all`).toBe(true)
    // no zombie (`ps` shows none in state Z), nothing still running, the pool empty
    await until('the pool to be empty', () => activeCount('git') === 0 && queuedCount('git') === 0)
    expect(children().filter((l) => /^\s*\d+\s+Z/.test(l))).toEqual([])
    expect(children()).toEqual([])
    // handle count equal (read at rest, as the baseline was)
    await settle()
    expect(handles()).toBeLessThanOrEqual(before.handles)
    expect(await fdCount(process.pid)).toBeLessThanOrEqual(before.fds)
    expect(await footprint(helper, process.pid)).toBeGreaterThan(0)
  })

  it('L-FT-3 · 1 000 worktree evictions keep the streams within P-FD-1 with one shared common-dir stream per repository, and cost no more native memory each than L.watchCycleLeakMaxBytes; 1 000 000 file events never queue past L.watchRescanThreshold', async () => {
    const r = repo()
    const other = repo('other')
    const tap = tappedNative()
    t = await startFiles({ watcher: { native: tap.native } })
    // six worktrees for a cap of four: five of one repository, one of another, shown in turn: every show evicts one
    const roots = [...Array.from({ length: 5 }, (_, i) => linkedWorktree(r.root, `wt-${i}`)), other.root]
    const ids = roots.map((root, i) => {
      t!.session(`s${i}`, root, i < 5 ? { baseBranch: 'main' } : {})
      return `s${i}`
    })
    expect(ids.length).toBeGreaterThan(L.watchWorktreesLru)
    const ft = t
    const helper = await helperBinary()
    let worstStreams = 0
    const cycle = async (i: number): Promise<void> => {
      const id = ids[i % ids.length] as string
      const evicted = ft.watcher?.evictions as number
      ft.show(id)
      await until(`session ${id} to be followed`, () => ft.files.session(id)?.watch?.mode === 'live')
      if (i >= ids.length) expect(ft.watcher?.evictions).toBe(evicted + 1) // one eviction per show, once the LRU is full
      const w = ft.watcher?.counts as Record<string, number>
      expect(w.worktrees).toBeLessThanOrEqual(L.watchWorktreesLru)
      expect(w.commonDirs).toBeLessThanOrEqual(2) // one per repository, however many of its worktrees are followed
      // P-FD-1: a stream per followed worktree and one per repository (the one just released may still be closing)
      await until('the released stream to close', () => (ft.watcher?.streams as number) <= (w.worktrees as number) + (w.commonDirs as number))
      worstStreams = Math.max(worstStreams, tap.open.length)
      expect(tap.open.length).toBeLessThanOrEqual(L.watchWorktreesLru + 2)
      expect(tap.open.filter((s) => s.dir === path.join(r.root, '.git')).length).toBeLessThanOrEqual(1)
    }
    // the process itself settles first (code caches, allocator arenas): the first few hundred cycles are not the leak
    for (let i = 0; i < 400; i++) await cycle(i)
    const g = await leakCycles({ total: 1_000 + ids.length, cycle: (i) => cycle(i + 400), measure: async () => (await settle(), footprint(helper, process.pid)), budget: { slopeBytesPerCycle: L.watchCycleLeakMaxBytes, absoluteBytes: 1_000 * L.watchCycleLeakMaxBytes } })
    expect(ft.watcher?.evictions).toBeGreaterThanOrEqual(1_000)
    expect(worstStreams).toBe(L.watchWorktreesLru + 2)
    expect(g.ok, `footprint grew ${Math.round(g.slope)} B per eviction, ${Math.round(g.absolute / 1024)} KiB in all (the cap is ${L.watchCycleLeakMaxBytes} B)`).toBe(true)
    const heap = await heapUsed()

    // 1 000 000 file events for the visible worktree, as fast as they can be delivered
    const id = ids[0] as string
    ft.show(id)
    await ft.ready(id)
    const root = fs.realpathSync(roots[0] as string)
    await until('its stream', () => tap.open.some((s) => s.dir === root))
    const rescans = ft.s(id).stats.rescans
    const runs = ft.statusRuns(id)
    const t0 = performance.now()
    for (let batch = 0; batch < 200; batch++) {
      const events: NativeEvent[] = Array.from({ length: 5_000 }, (_, i) => ({ path: path.join(root, 'gen', `d${batch}`, `f${i}.txt`), type: 'create' }))
      tap.emit(root, events)
      expect(ft.watcher?.counts.pendingEvents).toBeLessThanOrEqual(L.watchRescanThreshold)
      await new Promise<void>((done) => setImmediate(done))
    }
    await until('the queue to drain', () => ft.watcher?.counts.pendingEvents === 0 && ft.s(id).scheduler.idle)
    const seconds = (performance.now() - t0) / 1000
    expect(ft.watcher?.counts.peakPendingEvents).toBeLessThanOrEqual(L.watchRescanThreshold) // never above the threshold
    expect(ft.s(id).stats.rescans).toBeGreaterThan(rescans) // they collapsed into full refreshes
    // one status per debounce at most, however many events (and at least the one that shows the result)
    expect(ft.statusRuns(id) - runs).toBeGreaterThanOrEqual(1)
    expect(ft.statusRuns(id) - runs).toBeLessThanOrEqual(Math.ceil((seconds * 1000) / L.gitDebounceMs) + 3)
    expect((await heapUsed()) - heap).toBeLessThan(8 * 1024 * 1024) // nothing of the million is kept
    ft.show(null)
    expect(ft.files.counts).toMatchObject({ visible: 0, statusRunning: 0, statusPending: 0 })
  })
})
