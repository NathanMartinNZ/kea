// The file panel's budgets, the window's half, against the real app, a release build launched unfocused on a fresh
// KEA_HOME (tests/perf/app-harness.ts). Sessions run the `shell` pseudo-agent in repositories from tools/repo-factory
// inside the run's home; core's half of the same budgets (the store delta the window draws from) is in
// tests/perf/core-files.test.ts.
//
// A row's frame is timed in the page (`__keaProbe.timeRow`, app/renderer/src/features/files/resources.ts) by the
// one-frame rule: to the frame that draws the row, its paint excluded; the start of the frame after it (the paint done)
// is recorded beside it. A save's time runs from just before the test writes the file to that frame, across the two
// processes' clocks (`Date.now()` in both, on one machine: a millisecond either way).
//
//   P-FT-1   two sessions, a folder open in each: ⌘1 / ⌘2 → the frame that draws the other session's tree
//   P-GS-1   (the window's half) medium repo: a file saved → its row's letter drawn, and the window's share of that
//   P-GS-3   (the window's half) medium repo: frames while 60 000 files are written under an ignored folder
//   P-FT-3   large repo, 99 902 rows loaded: frames while the tree is scrolled slowly, flung and jumped through
//   P-GS-2   large repo: a file saved → its row's letter drawn, with git's fsmonitor and without
//
// The two large-repo tests share one session (`large` is 300 000 files: its clone, the session's worktree and their
// removal are most of a minute each), started once for both and removed after the last.

import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import type { Page } from '@playwright/test'
import { fixtureGitEnv, LARGE_DATA_DIRS, LARGE_DATA_PER_DIR, LARGE_FILES, LARGE_FILES_PER_MODULE, LARGE_MODULES, largeDataFile, largeRepo, MEDIUM_FILES, mediumRepo, mediumSourceFile, type FixtureRepo } from '@kea-tools/repo-factory/src/index.ts'
import { until, type Kea, type KeaRun } from '../support/app.ts'
import { fsmonitorHint, fsmonitorProblem, fsmonitorRuns, gitConfig, panelModes, stopFsmonitorDaemon, tree, treeRow, waitTree } from '../support/app-files.ts'
import { addProject, demoRepo, paneSession, sessionIds, startSession, waitLive } from '../support/app-sessions.ts'
import { sessionWorktree } from '../support/app-viewer.ts'
import { budget, check, disposeRuns, dist, frames, measureFor, median, record, RUNS, startKea, WARMUPS } from './app-harness.ts'
import { sysKey } from '../support/keys.ts'
import { skipNote } from '../support/skip.ts'

interface RowMark {
  drawn: number
  painted: number
  sinceDelta: number
  drawnAtEpoch: number
}
declare const __keaProbe: { timeRow(o: { selector: string; from: 'key' | 'now'; timeoutMs?: number }): Promise<RowMark>; call(method: string, args: unknown): Promise<unknown> }
declare const __keaPerf: { resources(): Record<string, number> }

/** Saves per scenario after the warm-up one (as core's half, tests/perf/core-files.test.ts). */
const SAVES = 5
/** A session of a repository of tens of thousands of files: its worktree is checked out before it is live. */
const LIVE_MS = 120_000

/** A tree row of `sessionId`'s panel by its path, as `timeRow` looks for it. */
const rowOf = (sessionId: string, rel: string, more = ''): string => `.fp[data-session="${sessionId}"] [role=treeitem][data-path=${JSON.stringify(rel)}]${more}`

/** The window's resource rows, as the renderer reports them. */
const resources = (page: Page): Promise<Record<string, number>> => page.evaluate(() => __keaPerf.resources())

/** The file panel has nothing waiting: its state is saved (L.panelSaveMs after the last change). */
async function panelAtRest(page: Page): Promise<void> {
  await until('the panel at rest', async () => (await resources(page))['renderer.filePanelTimers'] === 0 || undefined)
}

/** How many rows the tree holds (drawn or not). */
const treeCount = (page: Page): Promise<number> => tree(page).evaluate((e) => Number(e.getAttribute('data-rows')))

/**
 * Arm `timeRow` for a row and resolve once it is armed in the page; the function returned resolves with its mark.
 * (Two steps, so whatever the test does next cannot come before the probe is listening.)
 */
async function armRow(page: Page, selector: string, from: 'key' | 'now', timeoutMs = 20_000): Promise<() => Promise<RowMark>> {
  await page.evaluate(
    (o) => {
      const p = __keaProbe.timeRow(o)
      p.catch(() => undefined) // read below; never an unhandled rejection
      ;(window as unknown as { __rowMark?: Promise<RowMark> }).__rowMark = p
    },
    { selector, from, timeoutMs },
  )
  return () =>
    page.evaluate(() => {
      const w = window as unknown as { __rowMark?: Promise<RowMark> }
      const p = w.__rowMark
      delete w.__rowMark
      return p ?? Promise.reject(new Error('not armed'))
    })
}

/** Core's files rows of its resource report (`core.files`: status pipelines running and waiting among them). */
async function coreFiles(kea: Kea): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const walk = (prefix: string, v: unknown): void => {
    if (typeof v === 'number') out[prefix] = v
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}.${k}` : k, x)
  }
  walk('', await kea.debug('core', 'kit'))
  const files: Record<string, number> = {}
  for (const [k, v] of Object.entries(out)) if (k.startsWith('core.files.')) files[k.slice('core.files.'.length)] = v
  if (!('statusRunning' in files)) throw new Error(`core's report has no core.files rows: ${Object.keys(out).join(', ').slice(0, 400)}`)
  return files
}

/**
 * The quiet spell: no status pipeline has run or waited for L.gitDebounceMs, so the next trigger runs at once, which is
 * what the save budgets measure: a single save.
 */
async function quiet(kea: Kea, ms = 60_000): Promise<void> {
  let since: number | null = null
  await until(
    'core’s git scheduler to be quiet',
    async () => {
      const f = await coreFiles(kea)
      if (f.statusRunning !== 0 || f.statusPending !== 0) since = null
      else since ??= performance.now()
      return since !== null && performance.now() - since >= L.gitDebounceMs ? true : undefined
    },
    ms,
  )
}

interface FileSession {
  run: KeaRun
  kea: Kea
  page: Page
  id: string
  root: string
  worktree: string
}

/** Kea with one session of `make`'s repository (inside the run's home, so the run's cleanup removes it), its tree's root listed. */
async function sessionOf(make: (o: { parent: string }) => FixtureRepo, prompt: string, liveMs = LIVE_MS): Promise<FileSession> {
  // the panel hides ignored files here, as the budgets below were set for it
  const { run, kea } = await startKea({ settings: { files: { showIgnored: false } } })
  const page = await kea.page()
  const repo = make({ parent: run.home })
  await addProject(kea, repo.root)
  const id = await startSession(kea, prompt)
  await waitLive(kea, id, liveMs)
  await until(`session ${id} in the main pane`, async () => (await paneSession(page)) === id || undefined)
  await waitTree(kea, 'the root is listed', (rows) => rows.some((r) => r.path === 'README.md'), liveMs)
  return { run, kea, page, id, root: repo.root, worktree: sessionWorktree(repo.root) }
}

/** Open a folder with a click on its row (it must be drawn); resolves once the tree holds `more` rows more. */
async function clickOpen(s: FileSession, rel: string, more: number): Promise<void> {
  const before = await treeCount(s.page)
  await treeRow(s.page, rel).click()
  await until(`${rel} to be open`, async () => (await treeCount(s.page)) === before + more || undefined, LIVE_MS)
}

/**
 * A committed file of the session is appended to after a quiet spell; resolves with the time from just before the
 * write to the frame that draws its row with the letter `M`, the window's share of it, and the frames meanwhile.
 */
async function timedSave(s: FileSession, rel: string, note: string): Promise<{ ms: number; windowMs: number; paintedMs: number; maxGapMs: number; gaps: number[] }> {
  await quiet(s.kea)
  const f = await frameGaps(s.page, async () => {
    const mark = await armRow(s.page, rowOf(s.id, rel, '[data-git="M"]'), 'now')
    const t0 = Date.now()
    fs.appendFileSync(path.join(s.worktree, rel), `// saved: ${note}\n`)
    const m = await mark()
    return { ms: m.drawnAtEpoch - t0, windowMs: m.sinceDelta, paintedMs: m.drawnAtEpoch - t0 + (m.painted - m.drawn) }
  })
  return { ...f.result, maxGapMs: Math.max(0, ...f.gaps), gaps: f.gaps }
}

/** Another process writes `dirs` × `perDir` small files under `root/top` (as an install does), and exits (as core's half does). */
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

/** Every gap between two animation frames of the page while `during` runs (ms). */
async function frameGaps<T>(page: Page, during: () => Promise<T>): Promise<{ gaps: number[]; result: T }> {
  type Rec = { on: boolean; last: number; gaps: number[] }
  await page.evaluate(() => {
    // bounded: one gap per frame of one measurement (a few hundred), dropped when it is read
    const rec: Rec = { on: true, last: 0, gaps: [] }
    ;(window as unknown as { __frameGaps?: Rec }).__frameGaps = rec
    const tick = (t: number): void => {
      if (!rec.on) return
      if (rec.last) rec.gaps.push(t - rec.last)
      rec.last = t
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const stop = (): Promise<number[]> =>
    page.evaluate(() => {
      const w = window as unknown as { __frameGaps?: Rec }
      const rec = w.__frameGaps
      delete w.__frameGaps
      if (!rec) return []
      rec.on = false
      return rec.gaps
    })
  let result: T
  try {
    result = await during()
  } catch (e) {
    await stop().catch(() => undefined)
    throw e
  }
  return { gaps: await stop(), result }
}

/** From this many display intervals on, a gap between two frames has a frame missing in it (between one interval and two). */
const MISSED_FRAME_INTERVALS = 1.5

/**
 * What the gaps between a measurement's frames say of dropped frames: the display's interval as measured (the median
 * gap: the window draws little during a save, so nearly every frame comes one interval after the last) and its refresh
 * rate, the longest gap, and how many gaps had a frame missing (longer than one and a half intervals).
 */
function gapStats(gaps: readonly number[]): { intervalMs: number; hz: number; maxGapMs: number; missed: number; frames: number } {
  if (gaps.length === 0) throw new Error('no animation frame was seen during the measurement')
  const intervalMs = median(gaps)
  return { intervalMs, hz: 1000 / intervalMs, maxGapMs: Math.max(...gaps), missed: gaps.filter((g) => g > MISSED_FRAME_INTERVALS * intervalMs).length, frames: gaps.length }
}

describe('file panel (app)', () => {
  afterEach(disposeRuns)

  it('P-FT-1 · switching to a session whose tree core has cached: keydown → the frame that draws its rows (by the one-frame rule) within budget, median of 20 switches after 4 unmeasured ones', async () => {
    const SWITCHES = 20
    const WARMUP_SWITCHES = 4
    const { run, kea } = await startKea()
    const page = await kea.page()
    await addProject(kea, demoRepo(run).root)
    // two sessions of the demo repository, `src` open in each: both stay in core's caches (L.fileCacheSessions)
    const ids: string[] = []
    for (const name of ['tree a', 'tree b']) {
      const id = await startSession(kea, name)
      await waitLive(kea, id)
      await until(`session ${id} in the main pane`, async () => (await paneSession(page)) === id || undefined)
      await waitTree(kea, 'the root is listed', (rows) => rows.some((r) => r.path === 'README.md'))
      await treeRow(page, 'src').click()
      await waitTree(kea, 'src is open', (rows) => rows.some((r) => r.path === 'src/index.js'))
      await panelAtRest(page)
      ids.push(id)
    }
    // ⌘1…⌘9 select by the sidebar's order
    const order = await sessionIds(page)
    expect([...order].sort()).toEqual([...ids].sort())
    const drawn: number[] = []
    const painted: number[] = []
    const sinceDelta: number[] = []
    let on = ids[1] as string
    for (let i = 0; i < WARMUP_SWITCHES + SWITCHES; i++) {
      const to = on === ids[0] ? (ids[1] as string) : (ids[0] as string)
      const mark = await armRow(page, rowOf(to, 'src/index.js'), 'key')
      await kea.press(sysKey(`Meta+${order.indexOf(to) + 1}`))
      const m = await mark()
      on = to
      await until(`session ${to} in the main pane`, async () => (await paneSession(page)) === to || undefined)
      // the session left behind: its panel state saved, nothing of the switch still under way
      await panelAtRest(page)
      if (i >= WARMUP_SWITCHES) {
        drawn.push(m.drawn)
        painted.push(m.painted)
        sinceDelta.push(m.sinceDelta)
      }
    }
    // what came back is the session's own tree, as it was left: `src` open
    await waitTree(kea, 'the tree as it was left', (rows) => rows.some((r) => r.path === 'src' && r.expanded === true) && rows.some((r) => r.path === 'src/index.js'))
    const d = dist(drawn)
    const p = dist(painted)
    const b = budget('P-FT-1')
    const e = record({
      id: 'P-FT-1',
      metric: b.metric,
      method: `two sessions of a tiny repository (worktrees), \`src\` open in each, both within core's caches (L.fileCacheSessions); ⌘1 / ⌘2 alternately; keydown → the frame that draws a row of the other session's open folder in the file panel, its paint excluded (the one-frame rule; __keaProbe.timeRow). In it: the window telling core what it shows (visible.set), the two store snapshots and files.open coming back, and the panel's one update a frame. ${WARMUP_SWITCHES} unmeasured + ${SWITCHES} switches, median (p99 reported). Not asserted: paintedP50 (keydown → the start of the frame after the drawing one) and sinceDeltaP50 (the last store message → the drawing frame: the window's own share)`,
      values: { ...d, paintedP50: p.p50, paintedP99: p.p99, sinceDeltaP50: dist(sinceDelta).p50 },
      checks: [check('median', d.p50, b.max, 'max', b.unit)],
    })
    expect(e.pass, `P-FT-1: ${JSON.stringify(e.values)} ${JSON.stringify(drawn.map((x) => Math.round(x)))}`).toBe(true)
  })

  it('P-GS-1 · the window’s half: in the medium repo a file saved after a quiet spell has its letter drawn in the tree within budget, median of 5 saves after an unmeasured one', async () => {
    const s = await sessionOf(mediumRepo, 'save')
    // the files that are saved are on screen: `src/m000` is the tree's first folder
    const module0 = path.dirname(mediumSourceFile(0, 0))
    await clickOpen(s, 'src', 156)
    await clickOpen(s, module0, 100)
    await panelAtRest(s.page)
    const saves: Awaited<ReturnType<typeof timedSave>>[] = []
    for (let i = 0; i <= SAVES; i++) {
      const r = await timedSave(s, mediumSourceFile(0, i), `run ${i}`)
      if (i > 0) saves.push(r) // the first is the warm-up
    }
    expect((await panelModes(s.kea)).map((m) => m.label)).toContain(`Changes ${SAVES + 1}`)
    const b = budget('P-GS-1')
    const ms = median(saves.map((x) => x.ms))
    const e = record({
      id: 'P-GS-1 (window)',
      metric: b.metric,
      method: `repo-factory medium (${MEDIUM_FILES} files), a session's worktree on screen with the saved files' folder open in the tree; a committed file is appended to once core's scheduler has been quiet for L.gitDebounceMs, and the time from just before the write to the frame that draws its row with the letter M is taken (FSEvents, the batch window, git's status and branch diff, the store delta, the panel's one update a frame; that frame's paint excluded), ${SAVES}× on different files after one warm-up, median. windowMedianMs is the window's share (the last store message → the drawing frame); paintedMedianMs ends at the start of the frame after. Core's half alone is P-GS-1`,
      values: { medianMs: ms, maxMs: Math.max(...saves.map((x) => x.ms)), windowMedianMs: median(saves.map((x) => x.windowMs)), windowMaxMs: Math.max(...saves.map((x) => x.windowMs)), paintedMedianMs: median(saves.map((x) => x.paintedMs)), maxGapMs: Math.max(...saves.map((x) => x.maxGapMs)) },
      checks: [check('medianMs', ms, b.max, 'max', b.unit)],
    })
    expect(e.pass, `P-GS-1 (window): ${JSON.stringify(saves.map((x) => Math.round(x.ms)))}`).toBe(true)
  })

  it('P-GS-3 · the window’s half: while 60 000 files are written under an ignored folder of the medium repo, and for the budget’s idle time after, the window’s frames stay within budget (p99), under node_modules/ and under an ignored folder FSEvents does report', async () => {
    const s = await sessionOf(mediumRepo, 'install')
    const b = budget('P-GS-3')
    await panelAtRest(s.page)
    const measure = async (top: string): Promise<{ p50: number; p99: number; max: number; n: number; burstMs: number }> => {
      await quiet(s.kea)
      const f = await frameGaps(s.page, async () => {
        const t0 = performance.now()
        await burst(s.worktree, top, 600, 100)
        const burstMs = performance.now() - t0
        // the budget's own window: core is to be idle again within it, and the frames until then count
        await measureFor(b.max_idle_after_ms)
        return burstMs
      })
      expect(fs.readdirSync(path.join(s.worktree, top, '.store')).length).toBe(600)
      // none of it is a change, and the tree does not list it (ignored entries are hidden)
      await quiet(s.kea)
      await waitTree(s.kea, `${top} is not listed`, (rows) => rows.some((r) => r.path === 'README.md') && !rows.some((r) => r.path === top))
      expect((await panelModes(s.kea)).map((m) => m.label)).toEqual(['Files', 'Changes'])
      const d = dist(f.gaps)
      return { p50: d.p50, p99: d.p99, max: d.max, n: d.n, burstMs: f.result }
    }
    // the install itself: node_modules/ is ignored by the repository and left out of the stream by the kernel
    const a = await measure('node_modules')
    // the same under an ignored folder FSEvents does report: every event reaches core, which drops them
    fs.appendFileSync(path.join(s.root, '.git', 'info', 'exclude'), 'vendor-cache/\n')
    const v = await measure('vendor-cache')
    const e = record({
      id: 'P-GS-3 (window)',
      metric: b.metric,
      method: `repo-factory medium (${MEDIUM_FILES} files), a session's worktree on screen, its root listed in the tree; another process writes 60 000 files in 600 folders under node_modules/ (ignored; left out of the stream by the kernel), then the same under vendor-cache/ (ignored through info/exclude, so every event reaches core); every gap between two animation frames of the window from the burst's start until ${b.max_idle_after_ms} ms after its end, p99 of each. The status runs and core's idle time are P-GS-3 (core's half)`,
      values: { p99Ms: a.p99, p50Ms: a.p50, maxMs: a.max, frames: a.n, burstMs: a.burstMs, reportedP99Ms: v.p99, reportedP50Ms: v.p50, reportedMaxMs: v.max, reportedFrames: v.n, reportedBurstMs: v.burstMs },
      checks: [check('p99 (node_modules)', a.p99, b.p99, 'max', b.unit), check('p99 (ignored folder outside the kernel exclusions)', v.p99, b.p99, 'max', b.unit)],
    })
    expect(e.pass, `P-GS-3 (window): ${JSON.stringify(e.values)}`).toBe(true)
  })
})

// ── the large repository ──────────────────────────────────────────────────────────────────────────────

/** The large session's worktree is 300 000 files: the clone, `git worktree add`, the first status. */
const LARGE_LIVE_MS = 240_000
const LARGE_SETUP_MS = 280_000
/** Removing the run's home: the clone and the worktree, 600 000 files. */
const LARGE_TEARDOWN_MS = 280_000
/** `data/d000` … `data/d048` and `src/m992` … `src/m999` open: as many rows as one session's directory cache holds. */
const DATA_DIRS_OPEN = 49
const MODULES_OPEN = 8
const ROOT_ROWS = 6
/** How long a typed name may take to put the keyboard on its row before it is typed again. */
const TYPED_MS = 3000
/** The last module is short by the repository's top-level files (tools/repo-factory large.ts). */
const LAST_MODULE_FILES = LARGE_FILES - (ROOT_ROWS - 2) - LARGE_DATA_DIRS * LARGE_DATA_PER_DIR - (LARGE_MODULES - 1) * LARGE_FILES_PER_MODULE
const ROWS_LOADED = ROOT_ROWS + LARGE_DATA_DIRS + DATA_DIRS_OPEN * LARGE_DATA_PER_DIR + LARGE_MODULES + (MODULES_OPEN - 1) * LARGE_FILES_PER_MODULE + LAST_MODULE_FILES

/** A plain `git status` in the worktree, as an agent runs it (it may write the index); true when it worked. */
function agentGitStatus(worktree: string): boolean {
  try {
    execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { env: fixtureGitEnv(), stdio: ['ignore', 'ignore', 'pipe'] })
    return true
  } catch {
    return false
  }
}

/** The row the keyboard is on (`aria-activedescendant`), if it is drawn. */
const keyboardRow = (page: Page): Promise<string | null> =>
  tree(page).evaluate((e) => {
    const id = e.getAttribute('aria-activedescendant')
    return (id ? document.getElementById(id) : null)?.getAttribute('data-path') ?? null
  })

/**
 * Open a folder anywhere in the tree with the keyboard, as a person does in a long list: its name typed (type-ahead
 * finds the row and scrolls to it), then →. The tree has the keyboard. Resolves once the tree holds `more` rows more.
 */
async function typeOpen(s: FileSession, name: string, rel: string, more: number): Promise<void> {
  const before = await treeCount(s.page)
  for (let attempt = 0; ; attempt++) {
    await s.page.keyboard.type(name)
    // the row is scrolled to and drawn a frame or two after the last key
    const reached = await until(`the keyboard on ${rel}`, async () => (await keyboardRow(s.page)) === rel || undefined, TYPED_MS).catch(() => false)
    if (reached) break
    if (attempt >= 2) throw new Error(`typing ${name} did not reach ${rel} (the keyboard is on ${await keyboardRow(s.page)})`)
    // keys that came further apart than the type-ahead's pause are separate prefixes: start again from the top
    await s.page.keyboard.press('Home')
  }
  await s.page.keyboard.press('ArrowRight')
  await until(`${rel} to be open`, async () => (await treeCount(s.page)) === before + more || undefined, LIVE_MS)
}

describe('file panel, large repository (app)', () => {
  let s: FileSession | null = null
  let failed: unknown = null

  beforeAll(async () => {
    try {
      s = await sessionOf(largeRepo, 'large', LARGE_LIVE_MS)
      expect(await treeCount(s.page), 'the root: data, src and four files').toBe(ROOT_ROWS)
    } catch (e) {
      failed = e
    }
  }, LARGE_SETUP_MS)

  afterAll(async () => {
    try {
      if (s) stopFsmonitorDaemon(s.worktree)
    } finally {
      await disposeRuns()
    }
  }, LARGE_TEARDOWN_MS)

  const session = (): FileSession => {
    if (!s) throw new Error(`the large session did not start: ${failed instanceof Error ? (failed.stack ?? failed.message) : String(failed)}`)
    return s
  }

  it('P-FT-3 · the large repo’s tree with 99 902 rows loaded, scrolled slowly, flung to its end and jumped through: frames per second and the longest frame within budget, the median of 3 runs after an unmeasured one; the rows drawn stay the viewport’s', async () => {
    const s = session()
    const page = s.page
    expect(ROWS_LOADED).toBeLessThanOrEqual(L.dirCacheEntriesMax)
    // `data` and `src` are on screen; the folders inside them are found by typing their names
    await clickOpen(s, 'data', LARGE_DATA_DIRS)
    for (let d = 0; d < DATA_DIRS_OPEN; d++) {
      const dir = path.dirname(largeDataFile(d, 0))
      await typeOpen(s, path.basename(dir), dir, LARGE_DATA_PER_DIR)
    }
    await typeOpen(s, 'src', 'src', LARGE_MODULES)
    for (let m = LARGE_MODULES - MODULES_OPEN; m < LARGE_MODULES; m++) await typeOpen(s, `m${m}`, `src/m${m}`, m === LARGE_MODULES - 1 ? LAST_MODULE_FILES : LARGE_FILES_PER_MODULE)
    expect(await treeCount(page)).toBe(ROWS_LOADED)
    await panelAtRest(page)

    // what is drawn is the viewport and the overscan, whatever the tree holds
    const rowPx = await treeRow(page, await keyboardRow(page).then((p) => p ?? 'src')).evaluate((e) => e.getBoundingClientRect().height)
    const viewportRows = Math.ceil((await tree(page).evaluate((e) => e.clientHeight)) / rowPx)
    const drawnMax = viewportRows + 1 + 2 * L.treeOverscanRows
    const drawnNow = async (): Promise<number> => (await resources(page))['renderer.fileRowsDrawn'] as number
    expect(await drawnNow()).toBeLessThanOrEqual(drawnMax)

    const SLOW_FRAMES = 120
    const FLING_FRAMES = 120
    const JUMP_FRAMES = 60
    const runs: { fps: number; maxGapMs: number; drawn: number }[] = []
    for (let r = 0; r < WARMUPS + RUNS; r++) {
      await tree(page).evaluate((e) => void (e.scrollTop = 0))
      await waitTree(s.kea, 'the top of the tree', (rows) => rows[0]?.path === 'data')
      const f = await frames(s.kea, () =>
        tree(page).evaluate(
          (el, o) =>
            new Promise<void>((resolve) => {
              const max = el.scrollHeight - el.clientHeight
              let frame = 0
              let flingStep = 0
              const tick = (): void => {
                if (frame < o.slow) {
                  // a wheel: a row and a quarter each frame
                  el.scrollTop += o.rowPx * 1.25
                } else if (frame < o.slow + o.fling) {
                  // a fling: the rest of the list, a screenful or more further each frame
                  if (frame === o.slow) flingStep = (max - el.scrollTop) / o.fling
                  el.scrollTop += flingStep
                } else {
                  // the scroll bar dragged: far jumps, forwards and back (the golden ratio's sequence)
                  el.scrollTop = max * (((frame - o.slow - o.fling + 1) * 0.618_033_988_75) % 1)
                }
                if (++frame < o.slow + o.fling + o.jumps) requestAnimationFrame(tick)
                else resolve()
              }
              requestAnimationFrame(tick)
            }),
          { slow: SLOW_FRAMES, fling: FLING_FRAMES, jumps: JUMP_FRAMES, rowPx },
        ),
      )
      const drawn = await drawnNow()
      if (r >= WARMUPS) runs.push({ fps: f.fps, maxGapMs: f.maxGapMs, drawn })
    }
    // the end of the list is the root's last file
    await tree(page).evaluate((e) => void (e.scrollTop = e.scrollHeight))
    await waitTree(s.kea, 'the end of the tree', (rows) => rows.at(-1)?.path === 'README.md')
    expect(Math.max(...runs.map((x) => x.drawn)), 'the rows drawn after each run (the viewport and the overscan)').toBeLessThanOrEqual(drawnMax)

    const b = budget('P-FT-3')
    const fps = median(runs.map((x) => x.fps))
    const maxGap = median(runs.map((x) => x.maxGapMs))
    const e = record({
      id: 'P-FT-3',
      metric: b.metric,
      method: `repo-factory large (${LARGE_FILES} files), a session's worktree: \`data\` and ${DATA_DIRS_OPEN} of its folders (${LARGE_DATA_PER_DIR} files each), \`src\` and ${MODULES_OPEN} of its modules open, ${ROWS_LOADED} rows in the tree (a session's directory cache holds ${L.dirCacheEntriesMax} entries); the tree's scroller moved for ${SLOW_FRAMES} frames by a row and a quarter (a wheel), for ${FLING_FRAMES} frames through the rest of the list to its end (a fling), and for ${JUMP_FRAMES} frames to far positions forwards and back (the scroll bar dragged); rAF frames meanwhile (__keaPerf.frames); ${RUNS} runs after ${WARMUPS} unmeasured, the median of each. rowsDrawn: the row elements in the document after a run (the viewport and the overscan; at most ${drawnMax} here)`,
      values: { fps, maxGapMs: maxGap, worstGapMs: Math.max(...runs.map((x) => x.maxGapMs)), slowestFps: Math.min(...runs.map((x) => x.fps)), rowsLoaded: ROWS_LOADED, rowsDrawn: Math.max(...runs.map((x) => x.drawn)) },
      checks: [check('fps', fps, b.min, 'min', b.unit), check('maxGapMs', maxGap, b.max_frame_ms, 'max', 'ms')],
    })
    expect(e.pass, `P-FT-3: ${JSON.stringify(runs)}`).toBe(true)
  })

  it('P-GS-2 · in the large repo a file saved after a quiet spell has its letter drawn in the tree within budget, and no gap between two frames meanwhile is longer than P-FT-3’s longest frame: as the repository comes, and with git’s fsmonitor turned on for the project (from the panel’s hint when a slow status brought it up); the same once a git command of the agent’s has written the index is recorded beside them; median of 5 saves each after an unmeasured one. Recorded and not checked: the display’s refresh rate as measured, the longest gap, and how many gaps had a frame missing (over one and a half display intervals)', async () => {
    const s = session()
    const page = s.page
    // the files that are saved are on screen: `data/d000` is the tree's first folder (open since the scroll test)
    await tree(page).evaluate((e) => void (e.scrollTop = 0))
    await waitTree(s.kea, 'the top of the tree', (rows) => rows[0]?.path === 'data')
    const dir0 = path.dirname(largeDataFile(0, 0))
    if ((await treeRow(page, dir0).count()) === 0) await clickOpen(s, 'data', LARGE_DATA_DIRS)
    if ((await treeRow(page, largeDataFile(0, 0)).count()) === 0) await clickOpen(s, dir0, LARGE_DATA_PER_DIR)
    await panelAtRest(page)

    type Save = Awaited<ReturnType<typeof timedSave>>
    let next = 0
    const series = async (note: string): Promise<Save[]> => {
      const out: Save[] = []
      for (let i = 0; i <= SAVES; i++) {
        const r = await timedSave(s, largeDataFile(0, next++), `${note} ${i}`)
        if (i > 0) out.push(r) // the first is the warm-up
      }
      return out
    }

    // as the repository comes: no fsmonitor (it is never set by itself)
    expect(gitConfig(s.worktree, '--get', 'core.fsmonitor')).toBe('')
    const plain = await series('plain')

    // The panel's hint when a status was slow, else the project's setting itself (what the hint's button changes).
    // Where git has no fsmonitor daemon (as on Linux) there is no setting to turn on and the hint never shows: the
    // plain half is measured and checked, the other two left out with the reason recorded
    const hint = fsmonitorHint(page)
    const hinted = (await hint.count()) > 0
    const noDaemon = fsmonitorProblem()
    let set: Save[] = []
    let primed: Save[] = []
    if (noDaemon !== null) expect(hinted, 'no fsmonitor hint where git has no daemon').toBe(false)
    else {
      if (hinted) await hint.getByRole('button', { name: 'Use git fsmonitor' }).click()
      else {
        // the run's one project (its sidebar row carries the id)
        const projectId = await page.evaluate(() => document.querySelector('[role=treeitem][data-project-id]')?.getAttribute('data-project-id') ?? null)
        if (!projectId) throw new Error('the session’s project was not found')
        await page.evaluate((id) => __keaProbe.call('projects.updateSettings', { id, set: { useFsmonitor: true } }), projectId)
      }
      await until('core.fsmonitor to be set in the worktree’s own config', () => gitConfig(s.worktree, '--worktree', '--get', 'core.fsmonitor') === 'true' || undefined)
      expect(gitConfig(s.root, '--local', '--get', 'core.fsmonitor'), 'not in the repository’s own config').toBe('')
      await until('the hint to go', async () => (await hint.count()) === 0 || undefined)
      set = await series('fsmonitor')
      expect(fsmonitorRuns(s.worktree), 'git’s fsmonitor daemon runs for the worktree').toBe(true)

      // Kea's own git calls never write the index (GIT_OPTIONAL_LOCKS=0), and git keeps what the daemon told it in the
      // index: the daemon saves git work only from the first index a command of the agent's (or the person's) writes.
      // One such command, as an agent runs it:
      await quiet(s.kea)
      expect(agentGitStatus(s.worktree)).toBe(true)
      primed = await series('index written')
    }

    const b = budget('P-GS-2')
    const frame = budget('P-FT-3').max_frame_ms
    const med = (xs: Save[]): number => median(xs.map((x) => x.ms))
    const worst = (xs: Save[]): number => Math.max(...xs.map((x) => x.ms))
    // every gap between two frames during any of the saves: the bound checked is the scroll budget's longest frame
    // (P-FT-3), which is two intervals of a 60 Hz display and nearly four of a 120 Hz one, so a gap with one frame
    // missing passes it. What was missed is therefore counted and recorded beside it, for the display the run was on.
    const g = gapStats([...plain, ...set, ...primed].flatMap((x) => x.gaps))
    const gap = g.maxGapMs
    const e = record({
      id: 'P-GS-2',
      metric: b.metric,
      method: `repo-factory large (${LARGE_FILES} files), a session's worktree on screen with the saved files' folder open in the tree (${await treeCount(page)} rows loaded); a committed file is appended to once core's scheduler has been quiet for L.gitDebounceMs, and the time from just before the write to the frame that draws its row with the letter M is taken (that frame's paint excluded), ${SAVES}× on different files after one warm-up, median. Three times: as the repository comes (medianMs); with the project's "Use git fsmonitor" on (fsmonitorMedianMs: ${hinted ? 'turned on from the panel’s hint, which a slow status had brought up' : 'set through projects.updateSettings, no status having been slow enough for the hint'}); and, not checked, once one \`git status\` run in the worktree as an agent runs it has written the index (indexWrittenMedianMs: Kea's own calls never write it, and until a command does the daemon saves git nothing). Frames: every gap between two animation frames of the window during any of the saves (${g.frames} gaps); checked is the longest (maxGapMs) against P-FT-3's longest frame (${frame} ms), which is not "zero dropped frames": on this display (displayHz, 1000 / the median gap frameIntervalMs) a gap of more than ${MISSED_FRAME_INTERVALS} intervals has a frame missing, and how many there were is recorded, not checked (gapsWithAMissedFrame)`,
      values: {
        medianMs: med(plain),
        maxMs: worst(plain),
        ...(noDaemon === null ? { fsmonitorMedianMs: med(set), fsmonitorMaxMs: worst(set), indexWrittenMedianMs: med(primed), indexWrittenMaxMs: worst(primed) } : {}),
        windowMedianMs: median([...plain, ...set, ...primed].map((x) => x.windowMs)),
        maxGapMs: gap,
        displayHz: g.hz,
        frameIntervalMs: g.intervalMs,
        gapsWithAMissedFrame: g.missed,
        gapsMeasured: g.frames,
        hintShown: hinted ? 1 : 0,
      },
      checks: [check('medianMs', med(plain), b.max, 'max', b.unit), ...(noDaemon === null ? [check('fsmonitorMedianMs', med(set), b.max, 'max', b.unit)] : []), check('maxGapMs (P-FT-3’s longest frame)', gap, frame, 'max', 'ms')],
      notes: noDaemon === null ? [] : [`${skipNote(noDaemon)}: the fsmonitor and index-written halves are left out`],
    })
    expect(e.pass, `P-GS-2: ${JSON.stringify(e.values)}`).toBe(true)
  })
})
