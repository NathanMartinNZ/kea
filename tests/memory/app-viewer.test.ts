// Leak cycles of the file viewer and the diff view against the real app (tests/support/app.ts), measured with
// tests/support/app-leak.ts. A session of a demo repository; files are opened the way every caller opens them
// (`viewer.open`) and closed with Esc, so each cycle mounts and unmounts the viewer's component, attaches the window's
// one editor to it and lets it go. The highlight worker's idle timeout is the window's own timer under Playwright's
// clock, moved forward rather than waited for.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { BUDGETS } from '../../tools/perf/src/generated/budgets.ts'
import { median } from '../../tools/perf/src/stats.ts'
import { footprint, KeaRun, STEP_MS, until, type Kea } from '../support/app.ts'
import { expectBytesFlat, expectCountsFlat, RendererProbe, runCycles, WARMUP_CYCLES, type LeakRun } from '../support/app-leak.ts'
import { addProject, agentTerminal, demoRepo, selectSession, startSession, waitLive } from '../support/app-sessions.ts'
import { fileTabs, openFile } from '../support/app-tabs.ts'
import { closeViewer, commitAll, plainText, sampleSource, sessionWorktree, viewer, viewerRows, viewerText, waitBody, waitViewer, WorkerProbe, writeFiles } from '../support/app-viewer.ts'
import { MOD_CLICK, sysKey, textKey } from '../support/keys.ts'

const runs: KeaRun[] = []
const probes: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

const MIB = 2 ** 20
const HEAPS = ['renderer.heap', 'core.heap', 'main.heap']
/**
 * Twenty languages the viewer colours, by extension: each a grammar of its own that brings no other with it (Ruby's
 * brings 19), so the twenty stay under L.highlightGrammarsMax and L-FV-1 keeps one worker throughout.
 */
const LANGUAGES = ['ts', 'js', 'json', 'css', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cs', 'lua', 'sh', 'yml', 'toml', 'sql', 'dart', 'zig', 'scala']
/** More of them, for L-FV-3: with the twenty, more than L.highlightGrammarsMax, and fewer than twice it. */
const MORE_LANGUAGES = ['tsx', 'jsx', 'less', 'hs', 'ml', 'r', 'erl', 'clj', 'scss', 'html']
/** Footprint readings per checkpoint; their median counts, as at every leak checkpoint. */
const READINGS = 3
/** How long a test waits for the session's git status to list a change. */
const GIT_MS = 45_000

/**
 * Kea with one session of a demo repository holding `files`; the session's Agent terminal is on screen. In one column,
 * where a file tab covers the Agent tab and closing it shows the Agent again (the split's work pane is L-TERM-13's).
 */
async function start(files: Record<string, string>): Promise<{ run: KeaRun; kea: Kea; renderer: RendererProbe; id: string; worktree: string }> {
  const run = KeaRun.create()
  runs.push(run)
  const kea = await run.launch()
  await kea.oneColumn()
  const repo = demoRepo(run)
  // `big/` holds what a test writes while it runs: ignored, so the session's git status does not grow with it
  writeFiles(repo.root, { '.gitignore': 'big/\n', ...files })
  commitAll(repo.root, 'Add files')
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'viewer')
  await waitLive(kea, id)
  const renderer = await RendererProbe.open(kea, { classes: ['EditorView', 'MergeView'] })
  probes.push(renderer)
  return { run, kea, renderer, id, worktree: sessionWorktree(repo.root) }
}

/** A count's reading at each checkpoint (the baseline first). */
function seriesOf(run: LeakRun, key: string): number[] {
  return run.points.map((p) => p.counts[key] ?? NaN)
}

/**
 * Before a checkpoint: the editors alive are the ones the viewer counts. CodeMirror can keep an editor it has destroyed
 * for about a second, and a count taken in that second would be one editor's nodes and listeners high.
 */
function settled(kea: Kea, renderer: RendererProbe): () => Promise<void> {
  return async () => {
    let last = { alive: NaN, counted: NaN }
    await until('only the viewer’s own editors alive', async () => {
      last = { alive: await renderer.liveObjects('__keaProbe.classes.EditorView'), counted: (await viewerRows(kea)).viewerEditors as number }
      return last.alive === last.counted || undefined
    }).catch((e: Error) => {
      throw new Error(`${e.message} (live EditorView instances ${last.alive}, the viewer's own ${last.counted})`)
    })
  }
}

/** Open `p` and wait until its text is on screen and coloured as far as it will be (no request left with the worker). */
async function openText(kea: Kea, id: string, p: string): Promise<void> {
  expect(await openFile(kea, { sessionId: id, path: p, mode: 'file' }), `viewer.open ${p}`).toBe(true)
  await waitViewer(kea, `${p} shown and coloured`, (v) => v.ui.path === p && v.ui.body.kind === 'text' && v.text !== null && (v.ui.language === 'Plain Text' || v.text.tokenised === v.text.lines) && v.highlighter.pending === 0)
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

describe('file viewer leaks (app)', () => {
  it('L-FV-1 · 60 different files in 20 languages opened, each in a tab of its own, and closed — by Esc, or by the ninth pin — a third of them too large to keep together: one EditorView at every checkpoint, the document cache within its two caps (L.viewerDocCache, L.viewerDocCacheBytes) and both reached, nothing kept for a closed tab, DOM nodes and every other count equal, heaps within budget', async () => {
    // a cycle of six, each file pinned: three source files (the third closed with Esc), two plain files that together
    // pass the cache's byte cap, one source file. The ninth pinned tab closes the least recently viewed one, so every
    // file is closed again, and four small documents in a row pass the cache's count cap
    const SLOTS = 6
    const BIG = new Set([3, 4])
    const ESC = 2
    const BIG_BYTES = Math.ceil(L.viewerDocCacheBytes * 0.6)
    const WARMUP = 30 // 20 of them source files: every language's grammar is loaded before the baseline
    const CHECKPOINTS = 10
    const TOTAL = WARMUP + CHECKPOINTS * SLOTS
    const paths: string[] = []
    const files: Record<string, string> = {}
    for (let i = 0, small = 0; i < TOTAL; i++) {
      if (BIG.has(i % SLOTS)) paths.push(`big/b${i}.txt`)
      else {
        const p = `fv/f${i}.${LANGUAGES[small++ % LANGUAGES.length]}`
        paths.push(p)
        files[p] = sampleSource(i)
      }
    }
    const { kea, renderer, id, worktree } = await start(files)
    const page = await kea.page()
    const agent = await agentTerminal(kea, id)
    let maxDocs = 0
    let maxBytes = 0
    let atDocsCap = 0
    let maxTabs = 0
    const run = await runCycles({
      kea,
      renderer,
      warmup: WARMUP,
      batch: SLOTS,
      checkpoints: CHECKPOINTS,
      // the canonical state: the Agent terminal on screen, the last files' tabs still in the strip
      quiesce: async () => {
        await page.locator(`[role=tablist][aria-label="Terminals"] [role=tab][data-pty="${agent}"]`).click()
        await page.waitForFunction(() => document.querySelector('.viewer-mount') === null, undefined, { polling: 'raf', timeout: STEP_MS })
        await settled(kea, renderer)()
      },
      cycle: async (i) => {
        const p = paths[i] as string
        if (BIG.has(i % SLOTS)) writeFiles(worktree, { [p]: plainText(i, BIG_BYTES) })
        expect(await openFile(kea, { sessionId: id, path: p, mode: 'file', pin: true }), `viewer.open ${p}`).toBe(true)
        const shown = await waitViewer(kea, `${p} shown and coloured`, (v) => v.ui.path === p && v.ui.body.kind === 'text' && v.text !== null && (v.ui.language === 'Plain Text' || v.text.tokenised === v.text.lines) && v.highlighter.pending === 0)
        expect(shown.resources.viewerEditors, `editors while ${p} shows`).toBe(1)
        const before = shown.resources.viewerCachedDocs as number
        maxDocs = Math.max(maxDocs, before)
        maxBytes = Math.max(maxBytes, shown.resources.viewerCachedBytes ?? NaN)
        if (before === L.viewerDocCache) atDocsCap++
        maxTabs = Math.max(maxTabs, (await fileTabs(kea)).length)
        if (i % SLOTS === ESC) {
          // closed: its document is not among the recently viewed ones
          await closeViewer(kea)
          const rows = await viewerRows(kea)
          expect([rows.viewerDocBytes, rows.viewerCachedDocs], `characters on screen and documents kept after closing ${p}`).toEqual([0, before])
        }
      },
    })
    expect(run.cycles.at(-1)).toBe(CHECKPOINTS * SLOTS)
    expect(new Set(paths).size, 'every file a different one').toBe(TOTAL)
    expect(maxTabs, 'file tabs at any time (the pinned ones)').toBe(L.viewerPinnedTabsMax)
    // one editor, however many files
    expect(seriesOf(run, 'renderer.liveEditorView').every((n) => n === 1), `live EditorView instances: ${seriesOf(run, 'renderer.liveEditorView')}`).toBe(true)
    expect(seriesOf(run, 'renderer.liveMergeView').every((n) => n === 0), `live MergeView instances: ${seriesOf(run, 'renderer.liveMergeView')}`).toBe(true)
    // the document cache's two caps: never passed, and both reached (four small documents in a row; two large
    // ones that do not fit together)
    expect(maxDocs, 'documents kept').toBe(L.viewerDocCache)
    expect(atDocsCap).toBeGreaterThan(CHECKPOINTS)
    expect(maxBytes, 'bytes kept').toBeLessThanOrEqual(L.viewerDocCacheBytes)
    expect(2 * BIG_BYTES, 'the two large documents together pass the byte cap').toBeGreaterThan(L.viewerDocCacheBytes)
    expect(seriesOf(run, 'renderer.viewerCachedDocs').every((n) => n === 2), `documents kept at each checkpoint (the second large one and the file after it): ${seriesOf(run, 'renderer.viewerCachedDocs')}`).toBe(true)
    expect(seriesOf(run, 'renderer.fileTabs').every((n) => n === L.viewerPinnedTabsMax), `file tabs at each checkpoint: ${seriesOf(run, 'renderer.fileTabs')}`).toBe(true)
    // the worker and its grammars are the same ones throughout (L-FV-3 checks the grammar limit)
    expect(seriesOf(run, 'renderer.highlightWorkers').every((n) => n === 1), `highlight workers: ${seriesOf(run, 'renderer.highlightWorkers')}`).toBe(true)
    expect(seriesOf(run, 'renderer.highlightGrammars').every((n) => n === LANGUAGES.length), `grammars loaded: ${seriesOf(run, 'renderer.highlightGrammars')}`).toBe(true)
    // exact counts: DOM nodes, listeners and every resource row (the kept bytes follow which source file was last)
    expectCountsFlat(run, (key) => key !== 'renderer.viewerCachedBytes')
    await expectBytesFlat(kea, renderer, run, HEAPS, 'L-FV-1')
  })

  it('L-FV-2 · 20 diffs opened, switched to the other layout and closed, so unified and side by side alternate: never more than one MergeView, none left after a close, every count equal, heaps within budget', async () => {
    // the smallest counts that give ten checkpoints: an exact count catches a leak within a few cycles
    const FILES = 4
    const CHECKPOINTS = 10
    const BATCH = 2 // an even number: every checkpoint finds the layout it started with
    const base: Record<string, string> = {}
    for (let i = 0; i < FILES; i++) base[`df/d${i}.ts`] = sampleSource(i, 120)
    const { kea, renderer, id, worktree } = await start(base)
    const page = await kea.page()
    // the session's changes: two regions of every file
    const changed: Record<string, string> = {}
    for (const [p, text] of Object.entries(base)) {
      const lines = text.split('\n')
      lines[10] = '  // changed'
      lines.splice(90, 2, '  const added = 1', '  const more = 2', '  const third = 3')
      changed[p] = lines.join('\n')
    }
    writeFiles(worktree, changed)
    const names = Object.keys(base)
    // the canonical state has the session's changes listed: whatever the window draws of them (the file panel's
    // rows, the header's counts) is there before the baseline, not some time after it
    expect(await openFile(kea, { sessionId: id, path: names[0] as string, mode: 'diff' })).toBe(true)
    await waitViewer(kea, 'the changed files listed', (v) => v.git.changed === FILES && v.ui.entry !== null, GIT_MS)
    await closeViewer(kea)
    let maxMerges = 0
    const run = await runCycles({
      kea,
      renderer,
      warmup: FILES,
      batch: BATCH,
      checkpoints: CHECKPOINTS,
      quiesce: settled(kea, renderer),
      cycle: async (i) => {
        const p = names[i % FILES] as string
        expect(await openFile(kea, { sessionId: id, path: p, mode: 'diff' })).toBe(true)
        const shown = await waitViewer(kea, `the diff of ${p}`, (v) => v.ui.path === p && v.ui.body.kind === 'diff' && v.ui.changes === 2 && v.highlighter.pending === 0)
        maxMerges = Math.max(maxMerges, shown.resources.viewerMerges ?? NaN)
        const other = shown.ui.layout === 'unified' ? 'split' : 'unified'
        await page.keyboard.press(sysKey('Meta+Shift+Backslash'))
        const flipped = await waitViewer(kea, `the ${other} layout`, (v) => v.ui.layout === other && v.ui.body.kind === 'diff' && v.resources.viewerMerges === (other === 'split' ? 1 : 0) && v.highlighter.pending === 0)
        maxMerges = Math.max(maxMerges, flipped.resources.viewerMerges ?? NaN)
        await closeViewer(kea)
        expect((await viewerRows(kea)).viewerMerges, `merge views after closing ${p}`).toBe(0)
      },
    })
    expect(run.cycles.at(-1)).toBe(CHECKPOINTS * BATCH)
    expect(maxMerges, 'merge views at any time').toBe(1)
    expect(seriesOf(run, 'renderer.liveMergeView').every((n) => n === 0), `live MergeView instances with no diff tab open: ${seriesOf(run, 'renderer.liveMergeView')}`).toBe(true)
    expectCountsFlat(run, () => true)
    await expectBytesFlat(kea, renderer, run, HEAPS, 'L-FV-2')
  })

  it('L-FV-3 · files in more languages than L.highlightGrammarsMax: the worker is recycled once, when its grammars pass the limit; requests for documents that left the screen leave nothing pending; with no file tab visible past the idle timeout there is no worker and its memory is back', async () => {
    const all = [...LANGUAGES, ...MORE_LANGUAGES]
    const files: Record<string, string> = {}
    all.forEach((ext, i) => (files[`fv/l${i}.${ext}`] = sampleSource(i)))
    // documents that take the worker a while (coloured within a budget), to leave the screen mid-way
    for (let i = 0; i < 4; i++) files[`fv/slow${i}.ts`] = sampleSource(100 + i, 40_000)
    files['fv/notes.txt'] = 'plain text\n'
    const { kea, renderer, id } = await start(files)
    const page = await kea.page()
    const workers = await WorkerProbe.open(kea)
    probes.push(workers)
    // the canonical state: the editor exists, no worker yet (a plain file needs none)
    await openText(kea, id, 'fv/notes.txt')
    await closeViewer(kea)
    expect((await viewerRows(kea)).highlightWorkers).toBe(0)
    const before = await rendererFootprint(kea, renderer, workers)

    // 1. one language after another, in the preview tab: recycled once, on passing the limit
    const starts: number[] = []
    let top = 0
    for (let i = 0; i < all.length; i++) {
      await openText(kea, id, `fv/l${i}.${all[i]}`)
      const h = (await viewer(kea))!.highlighter
      starts.push(h.starts)
      // a recycle shows as no worker (it ended with the document that passed the limit) or as a fresh one
      if (h.starts === 1 && h.workers === 1) top = Math.max(top, h.grammars)
    }
    const last = (await viewer(kea))!.highlighter
    expect(all.length, 'more languages than the limit').toBeGreaterThan(L.highlightGrammarsMax)
    expect(Math.max(...starts), `worker starts while ${all.length} languages were opened: ${starts.join(' ')}`).toBe(2)
    expect(top, 'grammars the first worker reached before it was recycled').toBeLessThanOrEqual(L.highlightGrammarsMax)
    expect(last.grammars, 'the fresh worker holds only what was opened since').toBeLessThanOrEqual(L.highlightGrammarsMax)
    expect(workers.count, 'workers alive').toBeLessThanOrEqual(1)

    // 2. documents that leave the screen while the worker is at them: nothing stays pending
    for (let i = 0; i < 4; i++) {
      expect(await openFile(kea, { sessionId: id, path: `fv/slow${i}.ts`, mode: 'file' })).toBe(true)
      await waitBody(kea, `fv/slow${i}.ts`, 'text')
    }
    await openText(kea, id, 'fv/l0.ts')
    expect((await viewer(kea))!.highlighter.pending).toBe(0)

    // 3. no file tab visible past the idle timeout (the window's own timer, moved forward): the worker ends and what
    // it held comes back. Measured as a cycle, since the window itself is not what it was before its first file: with
    // no file tab and no worker, the footprint after every further worker is the one after the first
    await page.clock.install()
    const ROUNDS = 3
    const held: number[] = [] // the footprint with the worker idle, no file tab visible
    const ended: number[] = [] // and after its idle timeout
    for (let r = 0; r < ROUNDS; r++) {
      // a worker with a dozen grammars, as after an afternoon in a project
      for (let i = 0; i < 12; i++) await openText(kea, id, `fv/l${i}.${all[i]}`)
      expect((await viewer(kea))!.highlighter).toMatchObject({ workers: 1, pending: 0, starts: 2 + r })
      await closeViewer(kea)
      const idle = await viewerRows(kea)
      expect([idle.highlightWorkers, idle.highlightPending], 'still there while the timeout runs').toEqual([1, 0])
      held.push(await rendererFootprint(kea, renderer, workers))
      await page.clock.fastForward(L.highlightIdleMs - 1000)
      expect((await viewerRows(kea)).highlightWorkers, 'a second before the timeout').toBe(1)
      await page.clock.fastForward(2000)
      await until('the worker ended', async () => ((await viewerRows(kea)).highlightWorkers === 0 && workers.count === 0) || undefined)
      ended.push(await rendererFootprint(kea, renderer, workers))
    }
    const mb = (xs: number[]) => xs.map((x) => (x / MIB).toFixed(1)).join(', ')
    console.info(`L-FV-3 · renderer footprint: ${(before / MIB).toFixed(1)} MB before any file; with an idle worker ${mb(held)} MB; after its idle timeout ${mb(ended)} MB; worker starts ${starts.join(' ')}`)
    const cost = held.map((h, r) => h - (ended[r] as number))
    expect(Math.min(...cost) / MIB, `what each worker held (MB): ${mb(cost)}`).toBeGreaterThan(5)
    // returned every time: no worker's end leaves the window above where the first one's left it (P-MEM-6's
    // `max_after_close`, the suite's measure of a footprint that came back)
    expect((Math.max(...ended) - (ended[0] as number)) / MIB, `after each idle timeout (MB): ${mb(ended)}`).toBeLessThanOrEqual(BUDGETS['P-MEM-6'].max_after_close)

    // and the next file starts a fresh one
    await openText(kea, id, 'fv/l1.js')
    expect((await viewer(kea))!.highlighter).toMatchObject({ starts: 2 + ROUNDS, workers: 1, pending: 0 })
  })

  it('L-FV-4 · a 20 MB file opened, scrolled through and closed, three times after two warm-up times: nothing of it is kept once closed, and the renderer’s footprint stays within P-MEM-6 while it is open and comes back to within P-MEM-6’s allowance each time it is closed', async () => {
    const ROUNDS = 3
    const b = BUDGETS['P-MEM-6']
    const { kea, renderer, id, worktree } = await start({})
    const page = await kea.page()
    const workers = await WorkerProbe.open(kea)
    probes.push(workers)
    // 20 MB: just under L.viewerPlainBytes, so it is shown with everything a file of its size gets: a log, which the
    // worker colours for as long as L.viewerHighlightBudgetMs lasts
    const BYTES = 20_000_000
    const FILE = 'big/large.log'
    expect(BYTES).toBeLessThan(L.viewerPlainBytes)
    writeFiles(worktree, { [FILE]: plainText(1, BYTES) })
    /** One time: open it, go through it (the end, a way back up, the start), close it. Resolves with the footprint while it was open. */
    const once = async (): Promise<number> => {
      expect(await openFile(kea, { sessionId: id, path: FILE, mode: 'file' })).toBe(true)
      const shown = await waitViewer(kea, 'the large file shown, its colouring over', (v) => v.ui.path === FILE && v.ui.body.kind === 'text' && v.highlighter.pending === 0, 60_000)
      expect(shown.text!.chars).toBeGreaterThan(BYTES * 0.99)
      expect(shown.ui.notices.join(), 'coloured as far as the budget went').toMatch(/^Highlighting stopped at line \d+$/)
      await page.keyboard.press(textKey('Meta+ArrowDown'))
      await waitViewer(kea, 'the end of the file', (v) => (v.text?.scroll.line ?? 0) > shown.text!.lines * 0.9)
      for (let k = 0; k < 20; k++) await page.keyboard.press('PageUp')
      await page.keyboard.press(textKey('Meta+ArrowUp'))
      await waitViewer(kea, 'the start of the file', (v) => v.text?.scroll.line === 1)
      const open = await rendererFootprint(kea, renderer, workers)
      await closeViewer(kea)
      const rows = await viewerRows(kea)
      expect([rows.viewerDocBytes, rows.viewerCachedDocs, rows.highlightPending], 'characters on screen, documents kept and requests left once it is closed').toEqual([0, 0, 0])
      return open
    }
    // two warm-up cycles (the editor, the worker and its grammar exist; allocators and the JIT have seen a file of
    // this size), then the baseline with no file tab open
    const fresh = await rendererFootprint(kea, renderer, workers)
    for (let w = 0; w < WARMUP_CYCLES; w++) await once()
    const baseline = await rendererFootprint(kea, renderer, workers)
    const open: number[] = []
    const closed: number[] = []
    for (let r = 0; r < ROUNDS; r++) {
      open.push((await once()) - baseline)
      closed.push((await rendererFootprint(kea, renderer, workers)) - baseline)
    }
    const mb = (xs: number[]) => xs.map((x) => (x / MIB).toFixed(1)).join(', ')
    console.info(`L-FV-4 · renderer footprint: ${(fresh / MIB).toFixed(1)} MB before any file, ${(baseline / MIB).toFixed(1)} MB after ${WARMUP_CYCLES} warm-up times (the baseline); over it: open ${mb(open)} MB; closed ${mb(closed)} MB`)
    // P-MEM-6 judged as the perf suite judges a budget, on the median of the runs (while open, every run is far inside
    // it anyway)
    expect(Math.max(...open) / MIB, `while open (MB): ${mb(open)}`).toBeLessThanOrEqual(b.max)
    expect(median(closed) / MIB, `after close, the median of (MB): ${mb(closed)}`).toBeLessThanOrEqual(b.max_after_close)
    // and no time leaves anything like a document behind
    expect(Math.max(...closed), `after close (MB): ${mb(closed)}`).toBeLessThan(BYTES / 2)
  })

  it('L-FV-5 · the open file rewritten 100 times, as an agent editing it does (one rewrite in two adds a line): the view follows every time, one editor and one document’s text held throughout, every count equal, heaps within budget', async () => {
    const LINES = 600
    const FILE = 'fv/live.ts'
    const lines = sampleSource(0, LINES).split('\n')
    const { kea, renderer, id, worktree } = await start({ [FILE]: lines.join('\n') })
    await openText(kea, id, FILE)
    const chars = lines.join('\n').length
    /**
     * The file after its `i`th rewrite: three lines changed, always to the same length. An odd rewrite makes the first of
     * them two lines, so every reload is one transaction whose changes differ in line count, and the lines between them
     * keep their colours only if each change is placed by its own line count.
     */
    const rewrite = (i: number): string => {
      const next = [...lines]
      const n = String(i).padStart(6, '0')
      for (const at of [7, 301, 595]) next[at] = `  // rewrite ${n}`
      if (i % 2 === 1) next[7] = `  // r ${n}\n  //x`
      return next.join('\n')
    }
    expect(rewrite(1).length).toBe(rewrite(123456).length)
    expect(rewrite(1).split('\n').length).toBe(rewrite(2).split('\n').length + 1)
    // the canonical state: the file already differs from the commit and the status pipeline has said so, so the
    // gutter's markers and whatever lists the change are drawn before the baseline
    fs.writeFileSync(path.join(worktree, FILE), rewrite(999_999))
    await waitViewer(kea, 'the change listed', (v) => v.git.changed === 1 && v.ui.entry !== null, GIT_MS)
    const run = await runCycles({
      kea,
      renderer,
      batch: 10,
      quiesce: settled(kea, renderer),
      cycle: async (i) => {
        const text = rewrite(i)
        fs.writeFileSync(path.join(worktree, FILE), text)
        // reloads are throttled; every rewrite is waited for, so each one is taken
        await until(`rewrite ${i} on screen`, async () => (await viewerText(kea)) === text || undefined)
        await waitViewer(kea, `rewrite ${i} coloured`, (v) => v.text?.tokenised === v.text?.lines && v.highlighter.pending === 0)
      },
    })
    expect(run.cycles.at(-1)).toBe(100)
    expect(seriesOf(run, 'renderer.liveEditorView').every((n) => n === 1), `live EditorView instances: ${seriesOf(run, 'renderer.liveEditorView')}`).toBe(true)
    // one document: the editor holds this file's text and nothing else is kept
    expect(seriesOf(run, 'renderer.viewerDocBytes').every((n) => n === rewrite(0).length), `characters held: ${seriesOf(run, 'renderer.viewerDocBytes')} (the file: ${chars})`).toBe(true)
    expect(seriesOf(run, 'renderer.viewerCachedDocs').every((n) => n === 0)).toBe(true)
    expectCountsFlat(run, () => true)
    await expectBytesFlat(kea, renderer, run, HEAPS, 'L-FV-5')
  })

  it('L-FV-6 · editable files typed into, left for another session and shown again, then saved (⌘S) or let go (⌘W, Don’t Save) and closed, in turn; a Replace All over a file near L.viewerFullBytes and typing at many cursors in the same run: one editor, no unsaved document, save in flight, cached document, journal entry or new file of a save left at any checkpoint, every count equal, heaps within budget', async () => {
    // all in the ignored `big/`, so a save never changes what the session's git status lists
    const SMALL = 'big/edit.ts'
    const LARGE = 'big/large.txt'
    const FIRST = '// rev 000000' // the small file's first line, retyped at the same length every time
    const small = `${FIRST}\n${sampleSource(7, 120)}`
    // `value` once in every six lines: about one replacement in every 120 bytes
    const large = sampleSource(9, Math.floor((L.viewerFullBytes * 0.95) / 19))
    const CURSORS = 20 // the small file's `value`s, every one of them a cursor
    const { run, kea, renderer, id, worktree } = await start({})
    writeFiles(worktree, { [SMALL]: small, [LARGE]: large })
    expect(Buffer.byteLength(large), 'the large file is near the full-feature size, and within it').toBeLessThanOrEqual(L.viewerFullBytes)
    expect(Buffer.byteLength(large)).toBeGreaterThan(L.viewerFullBytes * 0.9)
    expect(small.split('"value ').length - 1, 'the small file’s values').toBe(CURSORS)
    const page = await kea.page()
    const agent = await agentTerminal(kea, id)
    // another session to leave for and come back from
    const other = await startSession(kea, 'other')
    await waitLive(kea, other)
    await selectSession(kea, id)
    const journal = path.join(run.home, 'save-journal.json')
    /** Saves the journal lists now (none while the file is not there). */
    const journalEntries = (): number => {
      try {
        return (JSON.parse(fs.readFileSync(journal, 'utf8')) as unknown[]).length
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0
        throw e
      }
    }
    /** A save's new files anywhere in the worktree. */
    const newFiles = (): string[] => (fs.readdirSync(worktree, { recursive: true }) as string[]).filter((f) => path.basename(f).startsWith('.kea-save-'))
    const onDisk: Record<string, string> = { [SMALL]: small, [LARGE]: large }
    let maxUnsaved = 0
    let maxUnsavedBytes = 0

    /** Open `p` in a preview tab, editable, and put the keyboard in its text at its first line. */
    const open = async (p: string): Promise<void> => {
      expect(await openFile(kea, { sessionId: id, path: p, mode: 'file' }), `viewer.open ${p}`).toBe(true)
      const shown = await waitViewer(kea, `${p} shown, editable and coloured`, (v) => v.ui.path === p && v.ui.body.kind === 'text' && v.text !== null && v.ui.editable && (v.ui.language === 'Plain Text' || v.text.tokenised === v.text.lines) && v.highlighter.pending === 0, 60_000)
      expect(shown.ui.unsaved, `${p} opens with nothing unsaved`).toBe(false)
      await page.locator('.viewer .cm-content').focus()
      await page.keyboard.press(textKey('Meta+ArrowUp'))
    }
    /** To the other session and back: the unsaved document waits in the registry, then is on screen again as it was. */
    const awayAndBack = async (p: string): Promise<void> => {
      await selectSession(kea, other)
      const away = await viewerRows(kea)
      expect([away.viewerUnsaved, away.viewerDocBytes], `${p} unsaved while its session is not shown, and not on screen`).toEqual([1, 0])
      maxUnsaved = Math.max(maxUnsaved, away.viewerUnsaved as number)
      maxUnsavedBytes = Math.max(maxUnsavedBytes, away.viewerUnsavedBytes as number)
      await selectSession(kea, id)
      await waitViewer(kea, `${p} on screen again, unsaved`, (v) => v.ui.path === p && v.ui.body.kind === 'text' && v.ui.unsaved && v.ui.editable)
      await page.locator('.viewer .cm-content').focus()
    }
    /** ⌘S: saved, then closed with Esc (it is clean). */
    const save = async (p: string, text: string): Promise<void> => {
      await page.keyboard.press(sysKey('Meta+s'))
      await waitViewer(kea, `${p} saved`, (v) => v.ui.path === p && !v.ui.unsaved && v.resources.viewerSaving === 0 && v.ui.editNotice === null, 60_000)
      expect(fs.readFileSync(path.join(worktree, p), 'utf8') === text, `${p} on disk is the text saved`).toBe(true)
      onDisk[p] = text
      await closeViewer(kea)
    }
    /** ⌘W, then Don't Save in the warning: the tab closes and the file stays as it was on disk. */
    const dontSave = async (p: string): Promise<void> => {
      await page.keyboard.press(sysKey('Meta+w'))
      const sheet = page.getByRole('alertdialog')
      await sheet.getByRole('button', { name: 'Don’t Save' }).click({ timeout: STEP_MS })
      await page.waitForFunction(() => document.querySelector('.viewer-mount') === null, undefined, { polling: 'raf', timeout: STEP_MS })
      await sheet.waitFor({ state: 'detached', timeout: STEP_MS })
      expect(fs.readFileSync(path.join(worktree, p), 'utf8') === onDisk[p], `${p} on disk as it was`).toBe(true)
    }
    /** The small file's first line typed again, key by key, as no earlier cycle typed it. */
    const retype = async (i: number): Promise<string> => {
      const line = `// rev ${String(i + 1).padStart(6, '0')}`
      await page.keyboard.press('Shift+End')
      await page.keyboard.type(line)
      const text = `${line}\n${small.slice(FIRST.length + 1)}`
      await until('the line typed', async () => (await viewerText(kea)) === text || undefined)
      return text
    }

    const leak = await runCycles({
      kea,
      renderer,
      // two of each kind before the baseline: the window's heap rises over the first few dozen cycles (the editor's
      // and the find bar's code warming up) and stays level after
      warmup: 8,
      batch: 4,
      quiesce: async () => {
        await page.locator(`[role=tablist][aria-label="Terminals"] [role=tab][data-pty="${agent}"]`).click()
        await page.waitForFunction(() => document.querySelector('.viewer-mount') === null, undefined, { polling: 'raf', timeout: STEP_MS })
        await settled(kea, renderer)()
      },
      // the journal and the worktree, judged with the counts
      extra: async () => ({ counts: { 'disk.saveJournalEntries': journalEntries(), 'disk.newFilesOfSaves': newFiles().length }, bytes: {} }),
      cycle: async (i) => {
        switch (i % 4) {
          case 0: {
            // typed, away and back, saved
            await open(SMALL)
            const text = await retype(i)
            await awayAndBack(SMALL)
            await save(SMALL, text)
            break
          }
          case 1: {
            // typed, away and back, let go
            await open(SMALL)
            await retype(i)
            await awayAndBack(SMALL)
            await dontSave(SMALL)
            break
          }
          case 2: {
            // Replace All over the large file (every `value` one way, then back the next time), away and back, saved
            await open(LARGE)
            const was = onDisk[LARGE] as string
            const [from, to] = was.includes('"value ') ? ['value', 'VALUE'] : ['VALUE', 'value']
            await page.keyboard.press(sysKey('Alt+Meta+f'))
            await page.locator('.viewer .kea-find input[aria-label="Find in file"]').fill(from)
            await page.locator('.viewer .kea-replace-input').fill(to)
            await page.locator('.viewer').getByRole('button', { name: 'Replace all', exact: true }).click()
            await waitViewer(kea, 'every match replaced', (v) => v.ui.unsaved)
            await page.keyboard.press('Escape')
            await waitViewer(kea, 'the find bar closed', (v) => v.text?.findOpen === false)
            await awayAndBack(LARGE)
            await save(LARGE, was.replaceAll(`"${from} `, `"${to} `))
            break
          }
          case 3: {
            // a cursor at every `value` of the small file, typed at all of them, away and back, let go
            await open(SMALL)
            await page.keyboard.press(sysKey('Control+g'))
            // the first `value`: line 4 (the first line, then the source's), after `  const text = "`
            await page.locator('.viewer .kea-goto .kea-bar-input').fill('4:17')
            await page.keyboard.press('Enter')
            await page.locator('.viewer .kea-goto').waitFor({ state: 'detached' })
            // CodeMirror's Mod (⌘ on macOS, Ctrl elsewhere, the click modifier's key): the word, then each next one
            for (let k = 0; k < CURSORS; k++) await page.keyboard.press(`${MOD_CLICK}+d`)
            await page.keyboard.type('key')
            await waitViewer(kea, `typed at ${CURSORS} cursors`, (v) => v.ui.unsaved && v.text?.chars === small.length + CURSORS * ('key'.length - 'value'.length))
            // Esc: one cursor again
            await page.keyboard.press('Escape')
            await awayAndBack(SMALL)
            await dontSave(SMALL)
            break
          }
        }
      },
    })
    expect(leak.cycles.at(-1)).toBe(40)
    expect(seriesOf(leak, 'renderer.liveEditorView').every((n) => n === 1), `live EditorView instances: ${seriesOf(leak, 'renderer.liveEditorView')}`).toBe(true)
    // the registry held each document while its session was away, the large one included, and nothing at a checkpoint
    expect(maxUnsaved, 'unsaved documents at most').toBe(1)
    expect(maxUnsavedBytes, 'the largest unsaved document counted its text and its last saved text').toBeGreaterThan(2 * large.length)
    for (const key of ['renderer.viewerUnsaved', 'renderer.viewerUnsavedBytes', 'renderer.viewerSaving', 'renderer.viewerCachedDocs', 'renderer.viewerCachedBytes', 'renderer.viewerDocBytes', 'core.kit.core.viewer.saves', 'core.kit.core.viewer.journal', 'disk.saveJournalEntries', 'disk.newFilesOfSaves'])
      expect(seriesOf(leak, key).every((n) => n === 0), `${key} at each checkpoint: ${seriesOf(leak, key)}`).toBe(true)
    expect(fs.readFileSync(path.join(worktree, SMALL), 'utf8') === onDisk[SMALL] && fs.readFileSync(path.join(worktree, LARGE), 'utf8') === onDisk[LARGE], 'both files as last saved').toBe(true)
    expectCountsFlat(leak, () => true)
    await expectBytesFlat(kea, renderer, leak, HEAPS, 'L-FV-6')
  })
})
