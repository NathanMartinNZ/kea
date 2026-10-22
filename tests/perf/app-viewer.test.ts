// File viewer and diff budgets against the real app, a release build launched unfocused on a fresh KEA_HOME
// (tests/perf/app-harness.ts). A session of a repo-factory `tiny` repository runs the `shell` pseudo-agent; files are
// opened the way every caller opens them (`viewer.open`).
//
// Timings run from the call that opens a file (the click) to the start of the frame after the one that draws it, so
// the paint is in them (`__keaProbe.timeOpen`, app/renderer/src/features/viewer/resources.ts); the frame that draws it,
// paint excluded, is recorded beside it as information. A scenario runs once to warm up and then several times, and
// the median is compared. Memory is the renderer's physical footprint after garbage collection in the page and in the
// highlight worker (tests/support/app-viewer.ts `WorkerProbe`).

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import type { OpenRequest } from '@kea/protocol'
import { repoRoot } from '../../tools/perf/src/launch.ts'
import { footprint, until, type Kea, type KeaRun } from '../support/app.ts'
import { RendererProbe } from '../support/app-leak.ts'
import { addProject, agentTerminal, demoRepo, startSession, waitLive } from '../support/app-sessions.ts'
import { openFile } from '../support/app-tabs.ts'
import { closeViewer, commitAll, plainText, sampleSource, sessionWorktree, viewer, viewerRows, waitViewer, WorkerProbe, writeFiles } from '../support/app-viewer.ts'
import { budget, check, disposeRuns, dist, echoLatencies, frames, median, record, RUNS, startKea, WARMUPS } from './app-harness.ts'
import { textKey } from '../support/keys.ts'

const probes: { close(): Promise<void> }[] = [] // bounded: the probes of one test
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  await disposeRuns()
})

interface OpenMark {
  drawn: number
  painted: number
}
declare const __keaProbe: { timeOpen(req: OpenRequest, colours: boolean): Promise<{ text: OpenMark; coloured: OpenMark | null }> }

const MIB = 2 ** 20
/** Opens per timing scenario after the warm-up ones: enough for a steady median. */
const OPENS = 10
/** Footprint readings per measurement (their median, as the leak suite takes it). */
const READINGS = 3

/** Real TypeScript: this repository's own sources, end to end. */
const TS_LINES = ['tests/support/app.ts', 'app/core/src/core.ts', 'packages/kit/src/runProcess.ts', 'app/renderer/src/features/terminal/view.ts'].flatMap((f) => fs.readFileSync(path.join(repoRoot, f), 'utf8').split('\n'))

/** The budgets' TypeScript fixture: a 2 000-line source file, a different one for every `i`. */
function tsFixture(i: number): string {
  if (TS_LINES.length < 1999) throw new Error('the TypeScript fixture needs 2 000 lines of source')
  return [`// fixture ${i}`, ...TS_LINES.slice(0, 1999)].join('\n')
}

/** Kea with one session of a demo repository holding `files`; the session's Agent terminal is on screen. */
async function session(files: Record<string, string>): Promise<{ run: KeaRun; kea: Kea; id: string; worktree: string }> {
  const { run, kea } = await startKea()
  const repo = demoRepo(run)
  // `big/` holds what a test generates: ignored, so the session's git status has nothing to say about it
  writeFiles(repo.root, { '.gitignore': 'big/\n', ...files })
  commitAll(repo.root, 'Add files')
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'viewer')
  await waitLive(kea, id)
  return { run, kea, id, worktree: sessionWorktree(repo.root) }
}

/** Open a file or a diff and time its text and, with `colours`, its first colours. */
async function timedOpen(kea: Kea, req: OpenRequest, colours: boolean): Promise<{ text: OpenMark; coloured: OpenMark | null }> {
  return (await kea.page()).evaluate(([r, c]) => __keaProbe.timeOpen(r, c), [req, colours] as const)
}

/** The document on screen has every colour it will get and the worker is at rest. */
async function coloured(kea: Kea, p: string, ms = 60_000): Promise<void> {
  await waitViewer(kea, `${p} coloured`, (v) => v.ui.path === p && v.text !== null && v.highlighter.pending === 0 && (v.text.tokenised === v.text.lines || v.ui.notices.length > 0 || v.ui.language === 'Plain Text'), ms)
}

/** The renderer's footprint after garbage collection in the page and in its workers: the median of a few readings. */
async function rendererFootprint(kea: Kea, renderer: RendererProbe, workers: WorkerProbe): Promise<number> {
  const proc = await kea.pid('renderer')
  const xs: number[] = []
  for (let i = 0; i < READINGS; i++) {
    await renderer.settle()
    await workers.settle()
    xs.push(await footprint(proc))
  }
  return median(xs)
}

async function memoryProbes(kea: Kea): Promise<{ renderer: RendererProbe; workers: WorkerProbe }> {
  const renderer = await RendererProbe.open(kea)
  const workers = await WorkerProbe.open(kea)
  probes.push(renderer, workers)
  return { renderer, workers }
}

describe('file viewer (app)', () => {
  it('P-FV-1 · a 2 000-line TypeScript file opened → its text painted within budget: the median of 10 opens of different files after 2 unmeasured ones', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < WARMUPS + 1 + OPENS; i++) files[`src/fixture${i}.ts`] = tsFixture(i)
    const { kea, id } = await session(files)
    const painted: number[] = []
    const drawn: number[] = []
    for (let i = 0; i < WARMUPS + 1 + OPENS; i++) {
      const p = `src/fixture${i}.ts`
      const t = await timedOpen(kea, { sessionId: id, path: p, mode: 'file' }, false)
      await coloured(kea, p)
      await closeViewer(kea)
      if (i > WARMUPS) {
        painted.push(t.text.painted)
        drawn.push(t.text.drawn)
      }
    }
    const d = dist(painted)
    const b = budget('P-FV-1')
    const e = record({
      id: 'P-FV-1',
      metric: b.metric,
      method: `viewer.open of a 2 000-line TypeScript file (this repository's sources) not opened before, from the Agent terminal; the call → the start of the frame after the one that draws the document (its paint included); ${OPENS} opens after ${WARMUPS + 1} unmeasured ones, the median`,
      values: { ...d, drawnP50: dist(drawn).p50, drawnMax: Math.max(...drawn) },
      checks: [check('median', d.p50, b.max, 'max', b.unit)],
    })
    expect(e.pass, `P-FV-1: ${JSON.stringify(e.values)}`).toBe(true)
  })

  it('P-FV-2 · a 2 000-line TypeScript file opened → its visible lines coloured within budget: with the language loaded (the median of 10 opens), and on the language’s first use (the first open of a fresh window, the median of 3 launches after an unmeasured one)', async () => {
    const b = budget('P-FV-2')
    // first use: nothing of the highlighter exists yet — the worker, the engine and the grammar all start with this open
    const first: number[] = []
    const firstText: number[] = []
    let loaded: number[] = []
    for (let launch = 0; launch < WARMUPS + RUNS; launch++) {
      const files: Record<string, string> = {}
      for (let i = 0; i <= OPENS; i++) files[`src/fixture${i}.ts`] = tsFixture(i)
      const { kea, id } = await session(files)
      expect((await viewerRows(kea)).highlightWorkers, 'no highlight worker before the first file').toBe(0)
      const t = await timedOpen(kea, { sessionId: id, path: 'src/fixture0.ts', mode: 'file' }, true)
      await coloured(kea, 'src/fixture0.ts')
      await closeViewer(kea)
      if (launch >= WARMUPS) {
        first.push(t.coloured!.painted)
        firstText.push(t.text.painted)
      }
      // the language loaded: the opens that follow, in the last launch
      if (launch === WARMUPS + RUNS - 1) {
        loaded = []
        for (let i = 1; i <= OPENS; i++) {
          const p = `src/fixture${i}.ts`
          const next = await timedOpen(kea, { sessionId: id, path: p, mode: 'file' }, true)
          await coloured(kea, p)
          await closeViewer(kea)
          loaded.push(next.coloured!.painted)
        }
      }
      await disposeRuns() // every launch starts from the same state: a fresh home, nothing of the highlighter
    }
    const l = dist(loaded)
    const f = dist(first)
    const e = record({
      id: 'P-FV-2',
      metric: b.metric,
      method: `viewer.open of a 2 000-line TypeScript file not opened before → the start of the frame after the one that draws its first coloured tokens (the first chunk covers the window). Language loaded: ${OPENS} opens in a window that has coloured TypeScript, the median. First use: the first file a fresh window opens (worker, engine and grammar start with it), ${RUNS} launches after ${WARMUPS} unmeasured, the median`,
      values: { loadedP50: l.p50, loadedMax: l.max, firstUseP50: f.p50, firstUseMax: f.max, firstUseTextP50: dist(firstText).p50 },
      checks: [check('loaded', l.p50, b.max, 'max', b.unit), check('firstUse', f.p50, b.max_first_use, 'max', b.unit)],
    })
    expect(e.pass, `P-FV-2: ${JSON.stringify(e.values)}`).toBe(true)
  })

  it('P-DF-1 · the diff of a 2 000-line file opened → painted within budget: the median of 10 diffs of different files after 2 unmeasured ones', async () => {
    const N = WARMUPS + 1 + OPENS
    const files: Record<string, string> = {}
    for (let i = 0; i < N; i++) files[`src/fixture${i}.ts`] = tsFixture(i)
    const { kea, id, worktree } = await session(files)
    // the session's changes: three regions of every file
    const changed: Record<string, string> = {}
    for (const [p, text] of Object.entries(files)) {
      const lines = text.split('\n')
      lines[40] = '// changed here'
      lines.splice(900, 3, '// three lines became one')
      lines.splice(1700, 0, '// added', '// added too')
      changed[p] = lines.join('\n')
    }
    writeFiles(worktree, changed)
    const painted: number[] = []
    const drawn: number[] = []
    for (let i = 0; i < N; i++) {
      const p = `src/fixture${i}.ts`
      const t = await timedOpen(kea, { sessionId: id, path: p, mode: 'diff' }, false)
      const shown = await waitViewer(kea, `the diff of ${p}`, (v) => v.ui.path === p && v.ui.body.kind === 'diff' && v.highlighter.pending === 0)
      expect(shown.ui.changes).toBe(3)
      await closeViewer(kea)
      if (i > WARMUPS) {
        painted.push(t.text.painted)
        drawn.push(t.text.drawn)
      }
    }
    const d = dist(painted)
    const b = budget('P-DF-1')
    const e = record({
      id: 'P-DF-1',
      metric: b.metric,
      method: `viewer.open in diff mode of a 2 000-line TypeScript file with three changed regions, not opened before, from the Agent terminal (unified layout); the call → the start of the frame after the one that draws the diff; ${OPENS} opens after ${WARMUPS + 1} unmeasured ones, the median`,
      values: { ...d, drawnP50: dist(drawn).p50 },
      checks: [check('median', d.p50, b.max, 'max', b.unit)],
    })
    expect(e.pass, `P-DF-1: ${JSON.stringify(e.values)}`).toBe(true)
  })

  it('P-FV-3 · a 100 000-line file scrolled from top to bottom: frames per second and the longest frame within budget, the median of 3 runs after an unmeasured one', async () => {
    const LINES = 100_000
    const SCROLL_FRAMES = 300
    const { kea, id, worktree } = await session({})
    const page = await kea.page()
    writeFiles(worktree, { 'big/long.ts': sampleSource(1, LINES) })
    expect(await openFile(kea, { sessionId: id, path: 'big/long.ts', mode: 'file' })).toBe(true)
    await coloured(kea, 'big/long.ts')
    const shown = (await viewer(kea))!
    expect(shown.text!.lines).toBeGreaterThanOrEqual(LINES)
    const runs: { fps: number; maxGapMs: number }[] = []
    for (let r = 0; r < WARMUPS + RUNS; r++) {
      await page.locator('.viewer .cm-scroller').evaluate((s) => void (s.scrollTop = 0))
      await waitViewer(kea, 'the top of the file', (v) => v.text?.scroll.line === 1)
      const f = await frames(kea, () =>
        page.locator('.viewer .cm-scroller').evaluate(
          (s, n) =>
            new Promise<void>((resolve) => {
              // the whole file in `n` frames, a frame's worth further each frame, as a held scroll gesture goes
              const step = (s.scrollHeight - s.clientHeight) / n
              let left = n
              const tick = () => {
                s.scrollTop += step
                if (--left > 0) requestAnimationFrame(tick)
                else resolve()
              }
              requestAnimationFrame(tick)
            }),
          SCROLL_FRAMES,
        ),
      )
      await waitViewer(kea, 'the end of the file', (v) => (v.text?.scroll.line ?? 0) > LINES * 0.95)
      if (r >= WARMUPS) runs.push({ fps: f.fps, maxGapMs: f.maxGapMs })
    }
    const b = budget('P-FV-3')
    const fps = median(runs.map((x) => x.fps))
    const maxGap = median(runs.map((x) => x.maxGapMs))
    const e = record({
      id: 'P-FV-3',
      metric: b.metric,
      method: `a generated ${LINES}-line source file (${(shown.text!.chars / MIB).toFixed(1)} MiB${shown.ui.notices.length ? `; ${shown.ui.notices.join('; ')}` : ''}), its scroller moved from the first line to the last in ${SCROLL_FRAMES} animation frames; rAF frames while it moves (__keaPerf.frames); ${RUNS} runs after ${WARMUPS} unmeasured, the median of each`,
      values: { fps, maxGapMs: maxGap, worstGapMs: Math.max(...runs.map((x) => x.maxGapMs)), slowestFps: Math.min(...runs.map((x) => x.fps)) },
      checks: [check('fps', fps, b.min, 'min', b.unit), check('maxGapMs', maxGap, b.max_frame_ms, 'max', 'ms')],
    })
    expect(e.pass, `P-FV-3: ${JSON.stringify(runs)}`).toBe(true)
  })

  it('P-FV-4 · a 21 MB file (plain-text mode) opened → its text painted within budget, the median of 3 opens after an unmeasured one', async () => {
    const BYTES = 21 * MIB
    const { kea, id, worktree } = await session({})
    expect(BYTES).toBeGreaterThan(L.viewerPlainBytes)
    writeFiles(worktree, { 'big/huge.log': plainText(1, BYTES) })
    const painted: number[] = []
    const drawn: number[] = []
    for (let r = 0; r < WARMUPS + RUNS; r++) {
      const t = await timedOpen(kea, { sessionId: id, path: 'big/huge.log', mode: 'file' }, false)
      const shown = await waitViewer(kea, 'the file as plain text', (v) => v.ui.path === 'big/huge.log' && v.ui.body.kind === 'text')
      expect(shown.ui.notices).toEqual(['Large file · shown as plain text'])
      expect(shown.text!.chars, 'the whole file is the document').toBeGreaterThan(BYTES * 0.99)
      await closeViewer(kea)
      if (r >= WARMUPS) {
        painted.push(t.text.painted)
        drawn.push(t.text.drawn)
      }
    }
    const b = budget('P-FV-4')
    const m = median(painted)
    const e = record({
      id: 'P-FV-4',
      metric: b.metric,
      method: `viewer.open of a generated 21 MiB log (over the plain-text threshold) from the Agent terminal; the call → the start of the frame after the one that draws its text; ${RUNS} opens after ${WARMUPS} unmeasured, the median`,
      values: { median: m, max: Math.max(...painted), drawnMedian: median(drawn) },
      checks: [check('median', m, b.max, 'max', b.unit)],
    })
    expect(e.pass, `P-FV-4: ${JSON.stringify(painted)}`).toBe(true)
  })

  // This test cannot catch tokenising that slows input, so it does not count as a guard for it:
  //   · leaving the file's tab cancels its request there and then (the controller's `leave`): the worker sees
  //     the cancel at its next chunk boundary, at most L.highlightChunkLines lines on, and posts nothing more;
  //   · the first key is typed only after the tab's click, a poll of what is shown and a focus call have each gone to
  //     the window and come back, which is longer than that chunk;
  //   · tokenising runs in the worker and never on the window's main thread, where a key is drawn.
  // So every key measured meets a worker at rest, and the test passes or fails as the keystroke echo test does with a
  // file tab in the strip. The covers line says that: the echo budget's requirements, not the viewer's. What does hold
  // the viewer's: the engine's unit tests (chunks, and a cancelled request posts nothing:
  // app/renderer/src/features/viewer/worker/engine.test.ts), the viewer's e2e tests (no long frame while a 15 MB file
  // is coloured; text first, colours after: tests/e2e/viewer.spec.ts) and its leak test (a request for a document that
  // left the screen leaves nothing pending: tests/memory/app-viewer.test.ts).
  it(
    'P-FV-7 · keys typed in the Agent terminal straight after leaving a 5 MB file the worker was still colouring: keydown → glyph within P-TERM-1’s budget over 600 keys',
    async () => {
      // A file tab covers the terminal area, and a document that leaves the screen is no longer coloured, so
      // nobody types in a terminal while a file is tokenised: what can meet is the keys typed straight after — the
      // worker ending its chunk, the cancelled request's last chunks arriving for nothing — and that is measured
      const BATCHES = 20
      const KEYS_PER_BATCH = 30
      const BYTES = 5 * MIB
      const { kea, id, worktree } = await session({})
      const page = await kea.page()
      // a line of `sampleSource` is 19 bytes on average: just over 5 MiB, under the line limit for colours
      // (L.viewerPlainLines)
      const LINES = Math.ceil(BYTES / 19)
      expect(LINES).toBeLessThan(L.viewerPlainLines)
      writeFiles(worktree, { 'big/five.ts': sampleSource(1, LINES) })
      expect(fs.statSync(path.join(worktree, 'big/five.ts')).size).toBeGreaterThanOrEqual(BYTES)
      const agent = await agentTerminal(kea, id)
      await kea.enter('cat')
      const samples: number[] = []
      const tokenised: number[] = []
      for (let b = 0; b < BATCHES; b++) {
        expect(await openFile(kea, { sessionId: id, path: 'big/five.ts', mode: 'file' })).toBe(true)
        // the worker is at it: some lines coloured, most not
        const at = await waitViewer(kea, 'the worker colouring the file', (v) => v.ui.path === 'big/five.ts' && v.text !== null && v.text.tokenised > 0 && v.highlighter.pending === 1)
        tokenised.push(at.text!.tokenised / at.text!.lines)
        // back to the terminal by its tab, the file's tab still there; the keys follow at once
        await page.locator(`[role=tablist][aria-label="Terminals"] [role=tab][data-pty="${agent}"]`).click()
        await until('the Agent terminal on screen', async () => (await kea.shown()) === agent || undefined)
        await page.locator('.terminal-host.shown textarea').focus()
        samples.push(...(await echoLatencies(kea, KEYS_PER_BATCH, b === 0 ? 10 : 0)))
        await kea.press('Enter')
      }
      await kea.press('Control+c')
      expect(Math.max(...tokenised), 'the file was still being coloured each time it was left').toBeLessThan(1)
      const d = dist(samples)
      const bud = budget('P-FV-7')
      const e = record({
        id: 'P-FV-7',
        metric: bud.metric,
        method: `cat in the session's Agent terminal; ${BATCHES} times: a ${(BYTES / MIB).toFixed(0)} MiB TypeScript-like file is opened, and while the worker colours it (${(median(tokenised) * 100).toFixed(1)} % of its lines done, the median) the Agent tab is shown again and ${KEYS_PER_BATCH} keys are typed at once; tools/perf's echo probe (keydown → the xterm render with the typed character before the cursor); p50 and p99 over all ${samples.length} keys. A file tab covers the terminal and leaving it cancels its colouring, so keys cannot be typed in a terminal while a file is tokenised: these are the keys typed straight after`,
        values: { ...d, tokenisedWhenLeft: median(tokenised) },
        checks: [check('p50', d.p50, bud.p50, 'max', bud.unit), check('p99', d.p99, bud.p99, 'max', bud.unit)],
      })
      expect(e.pass, `P-FV-7: ${JSON.stringify(e.values)}`).toBe(true)
    },
    10 * 60_000,
  )

  it('P-MEM-6 · a 20 MB file open in the viewer: the renderer’s footprint over its baseline while the file is visible, and after it is closed, within budget; the median of 3 times after an unmeasured one', async () => {
    const BYTES = 20_000_000
    const FILE = 'big/large.log'
    const { kea, id, worktree } = await session({})
    const page = await kea.page()
    const { renderer, workers } = await memoryProbes(kea)
    expect(BYTES).toBeLessThan(L.viewerPlainBytes)
    writeFiles(worktree, { [FILE]: plainText(1, BYTES), 'big/small.log': plainText(2, 4096) })
    /** Open it and go through it; resolves with the footprint while it is visible, the file closed again. */
    const once = async (): Promise<number> => {
      expect(await openFile(kea, { sessionId: id, path: FILE, mode: 'file' })).toBe(true)
      const shown = await waitViewer(kea, 'the large file shown, its colouring over', (v) => v.ui.path === FILE && v.ui.body.kind === 'text' && v.highlighter.pending === 0, 60_000)
      await page.keyboard.press(textKey('Meta+ArrowDown'))
      await waitViewer(kea, 'the end of the file', (v) => (v.text?.scroll.line ?? 0) > shown.text!.lines * 0.9)
      await page.keyboard.press(textKey('Meta+ArrowUp'))
      await waitViewer(kea, 'the start of the file', (v) => v.text?.scroll.line === 1)
      const open = await rendererFootprint(kea, renderer, workers)
      await closeViewer(kea)
      return open
    }
    const fresh = await rendererFootprint(kea, renderer, workers)
    for (let w = 0; w < WARMUPS; w++) await once()
    // the baseline: no file tab open; the editor and the highlight worker (with this type's grammar) exist
    const baseline = await rendererFootprint(kea, renderer, workers)
    const open: number[] = []
    const closed: number[] = []
    for (let r = 0; r < RUNS; r++) {
      open.push(((await once()) - baseline) / MIB)
      closed.push(((await rendererFootprint(kea, renderer, workers)) - baseline) / MIB)
    }
    // information: what the window keeps of all that once the highlight worker has gone too (the worker's idle timeout,
    // with the window's timer moved forward: a small file arms it under the test's clock), over the window
    // before its first file
    await page.clock.install()
    expect(await openFile(kea, { sessionId: id, path: 'big/small.log', mode: 'file' })).toBe(true)
    await coloured(kea, 'big/small.log')
    await closeViewer(kea)
    await page.clock.fastForward(L.highlightIdleMs + 1000)
    await until('the worker ended', async () => ((await viewerRows(kea)).highlightWorkers === 0 && workers.count === 0) || undefined)
    const idle = await rendererFootprint(kea, renderer, workers)
    const b = budget('P-MEM-6')
    const e = record({
      id: 'P-MEM-6',
      metric: b.metric,
      method: `a generated ${BYTES}-byte log (just under the plain-text threshold: coloured for as long as its budget lasts), opened, scrolled to its end and back, closed; the renderer's physical footprint (kea-helper footprint) after garbage collection in the page and in the highlight worker, the median of ${READINGS} readings, over the baseline taken with no file tab open after ${WARMUPS} unmeasured time (the editor and the highlight worker exist from then on: freshMb is the window before its first file, workerEndedOverFreshMb what it keeps over that once the worker's idle timeout has ended it); ${RUNS} times, the median of each`,
      values: { openMb: median(open), closedMb: median(closed), openMaxMb: Math.max(...open), closedMaxMb: Math.max(...closed), baselineMb: baseline / MIB, freshMb: fresh / MIB, workerEndedOverFreshMb: (idle - fresh) / MIB },
      checks: [check('openMb', median(open), b.max, 'max', b.unit), check('closedMb', median(closed), b.max_after_close, 'max', b.unit)],
    })
    expect(e.pass, `P-MEM-6: open ${JSON.stringify(open)}, closed ${JSON.stringify(closed)}`).toBe(true)
  })

  it('P-MEM-7 · the highlight worker with 10 grammars loaded: what it adds to the renderer’s footprint within budget, and no worker after the idle timeout; the median of 3 workers after an unmeasured one', async () => {
    // ten languages whose grammars bring no other with them: ten grammars exactly
    const LANGS = ['ts', 'js', 'json', 'css', 'py', 'go', 'rs', 'sh', 'yml', 'toml']
    const files: Record<string, string> = { 'src/notes.txt': 'plain text\n' }
    LANGS.forEach((ext, i) => (files[`src/g${i}.${ext}`] = ext === 'ts' ? tsFixture(i) : sampleSource(i, 2000)))
    const { kea, id } = await session(files)
    const page = await kea.page()
    const { renderer, workers } = await memoryProbes(kea)
    // the window's own timer for the idle timeout, moved forward rather than waited for
    await page.clock.install()
    const held: number[] = []
    const ended: number[] = []
    for (let r = 0; r < WARMUPS + RUNS; r++) {
      for (let i = 0; i < LANGS.length; i++) {
        const p = `src/g${i}.${LANGS[i]}`
        expect(await openFile(kea, { sessionId: id, path: p, mode: 'file' })).toBe(true)
        await coloured(kea, p)
      }
      expect((await viewer(kea))!.highlighter).toMatchObject({ workers: 1, grammars: LANGS.length, pending: 0 })
      await closeViewer(kea)
      const withWorker = await rendererFootprint(kea, renderer, workers)
      await page.clock.fastForward(L.highlightIdleMs + 1000)
      await until('the worker ended', async () => ((await viewerRows(kea)).highlightWorkers === 0 && workers.count === 0) || undefined)
      const without = await rendererFootprint(kea, renderer, workers)
      if (r >= WARMUPS) {
        held.push((withWorker - without) / MIB)
        ended.push((await viewerRows(kea)).highlightWorkers as number)
      }
    }
    const b = budget('P-MEM-7')
    const e = record({
      id: 'P-MEM-7',
      metric: b.metric,
      method: `ten 2 000-line files in ten languages (${LANGS.join(', ')}; ten grammars) opened one after another and coloured to their ends, then no file tab; the renderer's physical footprint (kea-helper footprint) after garbage collection in the page and in the worker, the median of ${READINGS} readings, with the worker idle minus the same after the idle timeout ended it (the window's timer moved forward); ${RUNS} workers after ${WARMUPS} unmeasured, the median`,
      values: { workerMb: median(held), workerMaxMb: Math.max(...held), workersAfterIdle: Math.max(...ended) },
      checks: [check('workerMb', median(held), b.max, 'max', b.unit), check('workersAfterIdle', Math.max(...ended), 0, 'max', 'count')],
    })
    expect(e.pass, `P-MEM-7: ${JSON.stringify(held)}`).toBe(true)
  })
})
