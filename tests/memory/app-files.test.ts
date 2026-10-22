// Leak cycles of the file panel against the real app (tests/support/app.ts), measured with tests/support/app-leak.ts.
// Two sessions of a demo repository, each with folders open and changes of its own; a cycle is one click on the other
// session's row, waited for until the panel shows its tree. Hidden means free: the panel's model
// (app/renderer/src/features/files/model.ts) follows `tree:` and `git:` of the session on screen only, and the
// dev-server state one `server:` store, as the renderer's resource report shows.

import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { KeaRun, STEP_MS, until, type Kea } from '../support/app.ts'
import { GIT_MS, panelModes, treeRow, treeRows, waitTree } from '../support/app-files.ts'
import { expectBytesFlat, expectCountsFlat, RendererProbe, runCycles, type LeakRun } from '../support/app-leak.ts'
import { addProject, demoRepo, selectSession, startSession, waitLive } from '../support/app-sessions.ts'
import { commitAll, gitIn, sessionWorktree, writeFiles } from '../support/app-viewer.ts'

const runs: KeaRun[] = []
const probes: RendererProbe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

const HEAPS = ['renderer.heap', 'core.heap', 'main.heap']
/** Switches per checkpoint; ten checkpoints make 500 switches. Even, so every checkpoint is on the same session. */
const SWITCHES_PER_CHECKPOINT = 50
/** Files under `lib/`, more than a panel's height of rows, so the tree draws a window of them. */
const LIB_FILES = 120

/** A count's reading at each checkpoint (the baseline first). */
const seriesOf = (run: LeakRun, key: string): number[] => run.points.map((p) => p.counts[key] ?? NaN)

/** The session whose rows the panel shows (`.fp[data-session]`), if any. */
const panelSession = (kea: Kea): Promise<string | null> => kea.page().then((page) => page.evaluate(() => document.querySelector('.file-panel .fp')?.getAttribute('data-session') ?? null))

describe('file panel leaks (app)', () => {
  it(
    'L-MEM-2 · switch between two sessions 500 times, each with folders open and changes of its own: the window follows `tree` and `git` of the session on screen only and at most one `server` store, holds the same rows, folders and row elements at every checkpoint, and DOM nodes, listeners, store subscriptions and every other count are equal; heaps within budget',
    async () => {
      const run = KeaRun.create()
      runs.push(run)
      const kea = await run.launch({ focused: true })
      const page = await kea.page()
      const repo = demoRepo(run)
      const files: Record<string, string> = { 'docs/guide/intro.md': '# Intro\n', 'docs/guide/usage.md': '# Usage\n' }
      for (let i = 0; i < LIB_FILES; i++) files[`lib/m${String(i).padStart(3, '0')}.js`] = `export const m${i} = ${i}\n`
      writeFiles(repo.root, files)
      commitAll(repo.root, 'Add files')
      await addProject(kea, repo.root)

      // two sessions, each a worktree of its own; the second is on screen when both are live
      const a = await startSession(kea, 'files a')
      await waitLive(kea, a)
      const wtA = sessionWorktree(repo.root)
      const b = await startSession(kea, 'files b')
      await waitLive(kea, b)
      const real = [repo.root, wtA].map((d) => fs.realpathSync(d))
      const wtB = gitIn(repo.root, 'worktree', 'list', '--porcelain')
        .split('\n\n')
        .map((block) => /^worktree (.+)$/m.exec(block)?.[1] ?? '')
        .find((d) => d !== '' && !real.includes(fs.realpathSync(d)))
      if (!wtB) throw new Error('the second session has no worktree of its own')

      // session A: `lib` open (a windowed list) and one changed file; session B: `docs/guide` open and two changes
      writeFiles(wtA, { 'lib/m000.js': 'export const m0 = "changed"\n' })
      writeFiles(wtB, { 'docs/guide/intro.md': '# Intro\n\nMore.\n', 'notes.txt': 'new\n' })
      const shows = async (id: string, row: string): Promise<void> => {
        await until(`the panel shows session ${id}`, async () => ((await panelSession(kea)) === id && (await treeRows(kea)).some((r) => r.path === row)) || undefined)
      }
      await selectSession(kea, a)
      await shows(a, 'README.md')
      await treeRow(page, 'lib').click()
      await waitTree(kea, 'lib is open in A', (rows) => rows.some((r) => r.path === 'lib/m000.js'))
      await until('A’s change counted', async () => (await panelModes(kea)).some((m) => m.label === 'Changes 1') || undefined, GIT_MS)
      await selectSession(kea, b)
      await shows(b, 'README.md')
      await treeRow(page, 'docs').click()
      await waitTree(kea, 'docs/guide is open in B', (rows) => rows.some((r) => r.path === 'docs/guide/intro.md'))
      await until('B’s changes counted', async () => (await panelModes(kea)).some((m) => m.label === 'Changes 2') || undefined, GIT_MS)

      const renderer = await RendererProbe.open(kea)
      probes.push(renderer)
      // B is on screen: an odd switch shows A (its `lib` open, as it was left), an even one B (each comes back as it was)
      let on = b
      const result = await runCycles({
        kea,
        renderer,
        batch: SWITCHES_PER_CHECKPOINT,
        cycle: async () => {
          on = on === a ? b : a
          await selectSession(kea, on)
          await shows(on, on === a ? 'lib/m000.js' : 'docs/guide/intro.md')
        },
        // the panel's own state saved (L.panelSaveMs after the last change) and the count of the session on screen back
        quiesce: async () => {
          await until('the panel at rest', async () => ((await page.evaluate(() => (window as unknown as { __keaPerf: { resources(): Record<string, number> } }).__keaPerf.resources()['renderer.filePanelTimers'])) === 0 ? true : undefined), STEP_MS)
          await until('the session’s changes counted', async () => (await panelModes(kea)).some((m) => m.label === `Changes ${on === a ? 1 : 2}`) || undefined, GIT_MS)
        },
      })
      expect(result.cycles.at(-1)).toBe(500)
      expect(on, 'every checkpoint is on the same session').toBe(b)

      // hidden means free in the window too: the stores of one session, whatever was shown before
      const points = result.points.length
      expect(seriesOf(result, 'renderer.fileStores'), '`tree:` and `git:` of the session on screen').toEqual(Array(points).fill(2))
      for (const v of seriesOf(result, 'renderer.serverStores')) expect(v, '`server:` stores followed').toBeLessThanOrEqual(1)
      // … and of that one, what it shows: B's rows, folders and changes, none of A's 120 files
      const rows = seriesOf(result, 'renderer.fileTreeRows')
      expect(rows[0], 'B’s tree: the root, docs/guide and its two files').toBeGreaterThan(0)
      expect(rows[0], 'none of A’s rows').toBeLessThan(LIB_FILES)
      expect(seriesOf(result, 'renderer.fileGitEntries')).toEqual(Array(points).fill(2))
      expect(seriesOf(result, 'renderer.fileLayers')).toEqual(Array(points).fill(0))
      // every count, the panel's and everyone else's, as at the baseline: rows, folders, row elements, subscriptions,
      // listeners, DOM nodes; core's caches and watchers for the two sessions (both within L.fileCacheSessions)
      expectCountsFlat(result, () => true)
      await expectBytesFlat(kea, renderer, result, HEAPS, 'L-MEM-2')
    },
    15 * 60_000,
  )
})
