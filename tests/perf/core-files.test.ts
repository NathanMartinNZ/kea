// The file tree's and git status's budgets, core's half: the files service in-process
// (tests/integration/core-files-support.ts) with the real native watcher and real git on repositories from
// tools/repo-factory. What is timed ends at the store delta the window would draw from; the window's own half (a frame,
// the rows) is in tests/perf/app-files.test.ts. Run them on the reference machine with nothing else heavy running. Each
// result is recorded in tools/perf/last.json.
//
//   P-FT-2    a root with 5 000 entries, never listed by Kea before: show the session → its root row
//   P-GS-1    medium repo: a file saved after a quiet spell → its entry in the git store
//   P-GS-3    medium repo: 60 000 files written under node_modules/ by another process → status runs, and how long
//             after the burst nothing runs or waits any more; the same under an ignored folder FSEvents does report
//   P-FIND-1  an index of 200 000 paths: one finder query per keystroke, typed one at a time
//   P-FD-1    22 sessions in two repositories shown in turn: FSEvents streams

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import { activeCount, setGitBinary } from '@kea/kit'
import { loadNativeWatcher, type NativeCallback, type NativeOptions, type NativeWatcher } from '@kea/core/src/platform/watch/native.ts'
import { gitKey, L, type GitEntry, type TreeDir } from '@kea/protocol'
import { FinderIndex } from '@kea/core/src/files/finder.ts'
import { MEDIUM_FILES, mediumRepo, mediumSourceFile, type FixtureRepo } from '@kea-tools/repo-factory/src/index.ts'
import { BUDGETS } from '../../tools/perf/src/generated/budgets.ts'
import { check, perfEnv, recordResult, type PerfResult } from '../../tools/perf/src/record.ts'
import { cleanup, gitEnv, gitIn, later, linkedWorktree, repo, startFiles, tempDir, type FilesUnderTest } from '../integration/core-files-support.ts'
import { until } from '../support/holders.ts'

const RUNS = 5
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)] as number
const fmt = (xs: number[]) => xs.map((x) => x.toFixed(0)).join(', ')

function record(r: PerfResult): boolean {
  return recordResult(r, { env: perfEnv(`in-process microbenchmark: Vitest on Node ${process.version}`) }).pass
}

let t: FilesUnderTest | null = null
afterEach(async () => {
  await t?.dispose()
  t = null
  cleanup()
})

/** The real binding, with the time of the last event it delivered. */
function timedNative(): { native: NativeWatcher; lastAt: number } {
  const real = loadNativeWatcher()
  // bounded: one wrapper per open subscription, removed when it ends
  const wrapped = new Map<NativeCallback, NativeCallback>()
  const tap = {
    lastAt: 0,
    native: {
      subscribe(dir: string, fn: NativeCallback, opts: NativeOptions) {
        const w: NativeCallback = (err, events) => {
          if (events?.length) tap.lastAt = performance.now()
          fn(err, events)
        }
        wrapped.set(fn, w)
        return real.subscribe(dir, w, opts)
      },
      async unsubscribe(dir: string, fn: NativeCallback, opts: NativeOptions) {
        const w = wrapped.get(fn) ?? fn
        wrapped.delete(fn)
        await real.unsubscribe(dir, w, opts)
      },
    },
  }
  return tap
}

/** The medium repository with one session's linked worktree, shown and read. */
async function mediumSession(native?: NativeWatcher): Promise<{ ft: FilesUnderTest; repo: FixtureRepo; wt: string; id: string }> {
  const r = mediumRepo()
  later(() => r.dispose())
  expect(gitIn(r.root, 'ls-files').split('\n').length, 'the medium shape').toBe(MEDIUM_FILES)
  const wt = linkedWorktree(r.root, 'perf')
  const ft = await startFiles(native ? { watcher: { native } } : {})
  t = ft
  ft.session('s1', wt, { baseBranch: 'main' })
  ft.show('s1')
  await ft.ready('s1')
  return { ft, repo: r, wt, id: 's1' }
}

/** Resolves with the time the git store first carries `rel`. */
function entryArrives(ft: FilesUnderTest, id: string, rel: string): Promise<number> {
  return new Promise((resolve) => {
    const off = ft.git(id).onDelta((d) => {
      if (!d.set || !(gitKey(rel) in d.set)) return
      off()
      resolve(performance.now())
    })
  })
}

/** Another process writes `dirs` × `perDir` small files under `root/top` (as an install does), and exits. */
function burst(root: string, top: string, dirs: number, perDir: number): Promise<void> {
  const script = `
    const fs = require('node:fs'), path = require('node:path')
    const [root, top, dirs, perDir] = process.argv.slice(1)
    for (let d = 0; d < Number(dirs); d++) {
      const dir = path.join(root, top, '.store', 'pkg-' + d, 'lib')
      fs.mkdirSync(dir, { recursive: true })
      for (let i = 0; i < Number(perDir); i++) fs.writeFileSync(path.join(dir, 'f' + i + '.js'), 'module.exports = ' + i + '\\n')
    }`
  return new Promise((resolve, reject) => execFile(process.execPath, ['-e', script, root, top, String(dirs), String(perDir)], (err) => (err ? reject(err) : resolve())))
}

describe('files and git budgets (core)', () => {
  it('P-FT-2 · a root of 5 000 entries Kea has never listed is in the tree store within budget of the session being shown', async () => {
    const ENTRIES = 5000
    const r = repo()
    const have = fs.readdirSync(r.root).filter((n) => n !== '.git').length
    const dirs = 1000
    for (let i = 0; i < dirs; i++) fs.mkdirSync(path.join(r.root, `dir-${String(i).padStart(4, '0')}`))
    for (let i = 0; i < ENTRIES - have - dirs; i++) fs.writeFileSync(path.join(r.root, `file-${String(i).padStart(4, '0')}.txt`), `${i}\n`)
    expect(fs.readdirSync(r.root).filter((n) => n !== '.git').length).toBe(ENTRIES)
    const ft = await startFiles()
    t = ft
    const times: number[] = []
    for (let i = 0; i <= RUNS; i++) {
      const id = `s${i}` // a session of its own each time: nothing of it is cached
      ft.session(id, r.root)
      const t0 = performance.now()
      ft.show(id)
      const ms = await new Promise<number>((resolve) => {
        const off = ft.tree(id).onDelta((d) => {
          if (!d.set || !('/' in d.set)) return
          off()
          resolve(performance.now() - t0)
        })
      })
      const root = ft.dir(id) as TreeDir
      expect(root.total, 'every entry is listed').toBe(ENTRIES)
      expect(root.entries.length).toBe(ENTRIES)
      if (i > 0) times.push(ms) // the first is the warm-up
      await ft.ready(id)
      ft.show(null)
    }
    const b = BUDGETS['P-FT-2']
    const ms = median(times)
    console.log(`P-FT-2 cold root listing: median ${ms.toFixed(1)} ms (${fmt(times)})`)
    const pass = record({
      id: 'P-FT-2',
      metric: b.metric,
      method: `a repository root holding ${ENTRIES} entries (${dirs} folders, the rest files); a session never shown before is shown and the time to its root row in tree:<sid> is taken (listing, kinds, sorting, the delta; the window's own frame is not in it), ${RUNS}× with a new session each after one warm-up, median. The file system's own cache is warm: only Kea's is cold`,
      values: { medianMs: ms, maxMs: Math.max(...times) },
      checks: [check('medianMs', ms, b.max, 'max', b.unit)],
    })
    expect(ms).toBeLessThanOrEqual(b.max)
    expect(pass).toBe(true)
  }, 120_000)

  it('P-GS-1 · in the medium repo a file saved after a quiet spell has its entry in the git store within budget', async () => {
    const { ft, wt, id } = await mediumSession()
    const times: number[] = []
    /** Of which: the status pipeline itself (git's status and diff, side by side). */
    const inGit: number[] = []
    for (let i = 0; i <= RUNS; i++) {
      const rel = mediumSourceFile(i * 11 + 3, i * 7 + 1)
      await until('the scheduler to be quiet', () => ft.s(id).scheduler.quiet)
      const arrives = entryArrives(ft, id, rel)
      const t0 = performance.now()
      fs.appendFileSync(path.join(wt, rel), `// saved in run ${i}\n`)
      const ms = (await arrives) - t0
      expect((ft.entries(id)[rel] as GitEntry).code).toBe('M')
      if (i > 0) {
        times.push(ms)
        inGit.push(ft.s(id).stats.statusMs)
      }
    }
    const b = BUDGETS['P-GS-1']
    const ms = median(times)
    console.log(`P-GS-1 save → git store (medium): median ${ms.toFixed(0)} ms (${fmt(times)}); in git ${fmt(inGit)}`)
    const pass = record({
      id: 'P-GS-1',
      metric: b.metric,
      method: `repo-factory medium (${MEDIUM_FILES} files), a session's linked worktree on screen; a committed file is appended to once the scheduler is quiet, and the time to its entry in git:<sid> is taken (FSEvents latency, the batch window, git's status and branch diff side by side, the delta; the window's own frame is not in it), ${RUNS}× on different files after one warm-up, median. gitMedianMs is the part spent in git, which is what a busy machine stretches`,
      values: { medianMs: ms, maxMs: Math.max(...times), gitMedianMs: median(inGit) },
      checks: [check('medianMs', ms, b.max, 'max', b.unit)],
    })
    expect(ms).toBeLessThanOrEqual(b.max)
    expect(pass).toBe(true)
  }, 180_000)

  it('P-GS-3 · 60 000 files written under an ignored folder of the medium repo cause at most the budget’s status runs, and core has nothing left to do within budget of the burst ending', async () => {
    const tap = timedNative()
    const { ft, repo: r, wt, id } = await mediumSession(tap.native)
    const b = BUDGETS['P-GS-3']
    const idle = () => ft.s(id).scheduler.idle && (ft.watcher?.counts.pendingEvents ?? 0) === 0 && activeCount('git') === 0
    const measure = async (top: string): Promise<{ runs: number; idleMs: number; burstMs: number; peak: number; ignored: number; rescans: number }> => {
      await until('the scheduler to be quiet', () => ft.s(id).scheduler.quiet && idle())
      const runs0 = ft.statusRuns(id)
      const stats0 = { ...ft.s(id).stats }
      const t0 = performance.now()
      await burst(wt, top, 600, 100)
      const ended = performance.now()
      // nothing left to do: no status running or waiting, no event pending, no git child, and the stream has been
      // silent for as long as the scheduler calls quiet (an event still on its way would start work again)
      let lastBusy = ended
      await until(
        'core to have nothing left to do',
        () => {
          if (!idle()) lastBusy = performance.now()
          return idle() && performance.now() - Math.max(tap.lastAt, lastBusy) >= L.gitDebounceMs
        },
        60_000,
      )
      const idleMs = Math.max(0, Math.max(tap.lastAt, lastBusy) - ended)
      // the files are on disk, none of them is a change, and the tree does not list what is inside
      expect(fs.readdirSync(path.join(wt, top, '.store')).length).toBe(600)
      expect(Object.keys(ft.entries(id)).filter((p) => p.startsWith(`${top}/`))).toEqual([])
      const s = ft.s(id).stats
      return { runs: ft.statusRuns(id) - runs0, idleMs, burstMs: ended - t0, peak: ft.watcher?.counts.peakPendingEvents ?? 0, ignored: s.ignoredEvents - stats0.ignoredEvents, rescans: s.rescans - stats0.rescans }
    }

    // the install itself: node_modules/ is ignored by the repository and left out of the stream by the kernel
    const a = await measure('node_modules')
    console.log(`P-GS-3 node_modules burst: ${a.runs} status runs, idle ${a.idleMs.toFixed(0)} ms after a ${a.burstMs.toFixed(0)} ms burst`)
    const pass = record({
      id: 'P-GS-3',
      metric: b.metric,
      method: `repo-factory medium (${MEDIUM_FILES} files), a session's linked worktree on screen; another process writes 60 000 files in 600 folders under node_modules/ (ignored; a kernel-side exclusion of the stream); counted: status pipelines from the burst's start until core has no status running or waiting, no watcher event pending and no git child, and the time from the burst's end to the last moment core was busy or FSEvents delivered an event. The UI-frame half of the budget is measured with the tree UI`,
      values: { statusRuns: a.runs, idleAfterMs: a.idleMs, burstMs: a.burstMs },
      checks: [check('max_status_runs', a.runs, b.max_status_runs, 'max', 'runs'), check('max_idle_after_ms', a.idleMs, b.max_idle_after_ms, 'max', 'ms')],
    })
    expect(a.runs).toBeLessThanOrEqual(b.max_status_runs)
    expect(a.idleMs).toBeLessThanOrEqual(b.max_idle_after_ms)
    expect(pass).toBe(true)

    // the same under an ignored folder FSEvents does report (no kernel exclusion carries its name): the watch batcher
    // and the ignore index carry it
    fs.appendFileSync(path.join(r.root, '.git', 'info', 'exclude'), 'vendor-cache/\n')
    const v = await measure('vendor-cache')
    console.log(`P-GS-3 reported ignored folder: ${v.runs} status runs, idle ${v.idleMs.toFixed(0)} ms after a ${v.burstMs.toFixed(0)} ms burst; ${v.ignored} events dropped as ignored, ${v.rescans} rescans, queue peak ${v.peak}`)
    const passV = record({
      id: 'P-GS-3 (ignored folder outside the kernel exclusions)',
      metric: b.metric,
      method: `as P-GS-3, with the 60 000 files under vendor-cache/ (ignored through info/exclude, not among the stream's exclusions), so every event reaches core: the batcher and the ignore index drop them`,
      values: { statusRuns: v.runs, idleAfterMs: v.idleMs, burstMs: v.burstMs, eventsDroppedAsIgnored: v.ignored, rescans: v.rescans, queuePeak: v.peak },
      checks: [check('max_status_runs', v.runs, b.max_status_runs, 'max', 'runs'), check('max_idle_after_ms', v.idleMs, b.max_idle_after_ms, 'max', 'ms')],
    })
    expect(v.peak, 'the queue never passes its threshold').toBeLessThanOrEqual(L.watchRescanThreshold)
    expect(v.runs).toBeLessThanOrEqual(b.max_status_runs)
    expect(v.idleMs).toBeLessThanOrEqual(b.max_idle_after_ms)
    expect(passV).toBe(true)
  }, 300_000)

  it('P-FIND-1 · with 200 000 paths indexed, the finder answers each keystroke within budget', async () => {
    const PATHS = 200_000
    const areas = ['web', 'api', 'cli', 'core', 'docs', 'tools', 'infra', 'mobile']
    const kinds = ['components', 'hooks', 'routes', 'util', 'models', 'services', 'views', 'store', 'cfg', 'tests']
    const names = ['button', 'date', 'index', 'session', 'layout', 'parser', 'status', 'worker', 'theme', 'socket']
    const paths: string[] = ['README.md', 'package.json']
    for (let i = 0; paths.length < PATHS; i++) {
      const a = areas[i % areas.length] as string
      const k = kinds[Math.floor(i / areas.length) % kinds.length] as string
      const n = names[Math.floor(i / (areas.length * kinds.length)) % names.length] as string
      paths.push(`packages/${a}/src/${k}/m${String(Math.floor(i / 800) % 250).padStart(3, '0')}/${n}-${String(i).padStart(6, '0')}.${i % 9 === 0 ? 'test.ts' : i % 5 === 0 ? 'tsx' : 'ts'}`)
    }
    const dir = tempDir('kea-finder-perf-')
    const list = path.join(dir, 'paths')
    fs.writeFileSync(list, `${paths.join('\0')}\0`)
    const stub = path.join(dir, 'git')
    fs.writeFileSync(stub, `#!/bin/sh\nexec /bin/cat '${list}'\n`, { mode: 0o755 }) // `git ls-files -z` for a tree of this size
    setGitBinary(stub)
    const index = new FinderIndex({ root: dir, git: true, env: async () => gitEnv() })
    later(() => index.dispose())
    const none = new Set<string>()
    const t0 = performance.now()
    const first = await index.query('', none, [])
    const buildMs = performance.now() - t0
    expect(index.paths, 'every path is indexed').toBe(PATHS)
    expect(first.total).toBe(PATHS)
    const typed = ['button', 'src/util/date', 'README', 'webhooksindex', 'session-000243.test', 'cfg/m123', 'apiroutesparser', 'thm']
    const times: number[] = []
    const worker: number[] = []
    for (let round = 0; round <= 2; round++) {
      for (const word of typed) {
        for (let n = 1; n <= word.length; n++) {
          const k0 = performance.now()
          const answer = await index.query(word.slice(0, n), none, [])
          const ms = performance.now() - k0
          expect(answer.superseded).toBe(false)
          expect(answer.hits.length).toBeLessThanOrEqual(L.finderResults)
          if (n === word.length && word !== 'thm') expect(answer.hits.length, `"${word}" finds something`).toBeGreaterThan(0)
          if (round > 0) {
            times.push(ms) // the first round is the warm-up
            worker.push(index.lastMs)
          }
        }
      }
    }
    const b = BUDGETS['P-FIND-1']
    const p95 = quantile(times, 0.95)
    console.log(`P-FIND-1 keystroke → results: p95 ${p95.toFixed(1)} ms, median ${median(times).toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms over ${times.length} keystrokes (in the worker: p95 ${quantile(worker, 0.95).toFixed(1)} ms); index built in ${buildMs.toFixed(0)} ms`)
    const pass = record({
      id: 'P-FIND-1',
      metric: b.metric,
      method: `an index of ${PATHS} paths (a monorepo's shape, fed through the finder's own \`git ls-files -z\` reader from a stand-in git); ${typed.length} queries typed one character at a time, each keystroke's query awaited (core's call into the worker thread and back, fuzzysort on prepared targets, ranking, top ${L.finderResults}); ${times.length} keystrokes over two rounds after one warm-up round, p95. The palette's own frame is not in it`,
      values: { p95Ms: p95, medianMs: median(times), maxMs: Math.max(...times), workerP95Ms: quantile(worker, 0.95), indexBuildMs: buildMs },
      checks: [check('p95', p95, b.p95, 'max', b.unit)],
    })
    expect(p95).toBeLessThanOrEqual(b.p95)
    expect(pass).toBe(true)
  }, 120_000)

  it('P-FD-1 · 22 sessions in two repositories shown in turn never hold more worktree streams than the budget, plus one common-dir stream per repository', async () => {
    const repos = [repo('one'), repo('two')]
    const ft = await startFiles()
    t = ft
    const ids: string[] = []
    repos.forEach((r, ri) => {
      ft.session(`main${ri}`, r.root) // the repository's own checkout: its git dir is the common dir
      ids.push(`main${ri}`)
      for (let i = 0; i < 10; i++) {
        ft.session(`r${ri}s${i}`, linkedWorktree(r.root, `wt-${ri}-${i}`), { baseBranch: 'main' })
        ids.push(`r${ri}s${i}`)
      }
    })
    const w = ft.watcher as NonNullable<FilesUnderTest['watcher']>
    let worktrees = 0
    let streams = 0
    let commons = 0
    for (let round = 0; round < 2; round++) {
      for (const id of round === 0 ? ids : [...ids].reverse()) {
        ft.show(id)
        await ft.ready(id)
        await until('every followed worktree’s stream to be open', () => w.followed().every((f) => f.mode === 'live') && w.streams >= (w.counts.worktrees as number))
        worktrees = Math.max(worktrees, w.counts.worktrees as number)
        streams = Math.max(streams, w.streams)
        commons = Math.max(commons, w.counts.commonDirs as number)
      }
    }
    const b = BUDGETS['P-FD-1']
    console.log(`P-FD-1 streams: ${worktrees} worktree streams at most, ${streams} streams in all (${commons} common dirs), ${ids.length} sessions`)
    const pass = record({
      id: 'P-FD-1',
      metric: b.metric,
      method: `${ids.length} sessions (two repositories: each one's own checkout and 10 linked worktrees) shown one after another, twice; the most worktree streams the watch service held at once, and the most FSEvents streams in all (a linked worktree's git dir lies inside the common dir and rides that stream)`,
      values: { worktreeStreams: worktrees, streams, commonDirStreams: commons, sessions: ids.length },
      checks: [check('max', worktrees, b.max, 'max', b.unit), check('streams in all (cap + one per repository)', streams, b.max + repos.length, 'max', b.unit)],
    })
    expect(worktrees).toBeLessThanOrEqual(b.max)
    expect(streams).toBeLessThanOrEqual(b.max + repos.length)
    expect(pass).toBe(true)
  }, 120_000)
})
