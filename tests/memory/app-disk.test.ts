// Leak cycles of sessions with worktrees and of Settings › Disk against the real app (tests/support/app.ts), measured
// with tests/support/app-leak.ts. The demo repository has a teardown script (`.kea/teardown.sh`), so each archive and
// delete runs it in a terminal of its own, whose `kv` mark (`teardown:<ptyId>`) goes with it; sessions run
// tools/fake-agent as Claude Code, idle, never the real CLI. A cycle is a session's whole life, through the Disk view;
// a second set closes the view with a walk and a branch question still out, core held meanwhile (as L-MEM-18 does). The
// test measures the worktrees with the view's own rule (allocated blocks, every entry counted in full), so a size on
// screen that matches what was just written was walked again.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Locator, Page } from '@playwright/test'
import { formatBytes } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { signalKnown } from '../../tools/perf/src/launch.ts'
import { KeaRun, STEP_MS, until, type Kea } from '../support/app.ts'
import { AGENT_MARK, agentEvents, claudeByDefault, fakeClaude } from '../support/app-fake-agent.ts'
import { expectBytesFlat, expectCountsFlat, RendererProbe, runCycles } from '../support/app-leak.ts'
import { chooseMenuItem } from '../support/app-palette.ts'
import { commitFiles } from '../support/app-server.ts'
import { addProject, demoRepo, paneSession, projectRow, rowState, selectSession, sessionMenu, sessionRow, startSession, waitLive, waitRow } from '../support/app-sessions.ts'

const runs: KeaRun[] = []
const probes: RendererProbe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

const HEAPS = ['renderer.heap', 'core.heap', 'ptyhost.heap', 'main.heap']
/** A session's life is about ten seconds; twelve of them, then twelve closes of the view. */
const ROW_MS = 10 * 60_000
/** What a session's build folder holds, and what is written in it once it is archived. */
const BLOB = 1_000_000
const NOTE = 100_000
/** An agent that draws its prompt and waits: the session stays live and writes nothing. */
const IDLE = `steps:
  - frame: ${JSON.stringify([AGENT_MARK, '', '> '])}
  - wait: { answer: z }
`

/**
 * A folder's size as the Disk view counts it: the allocated blocks of everything in it, links not followed, nothing
 * deduplicated.
 */
function allocated(p: string): number {
  const st = fs.lstatSync(p)
  let n = st.blocks * 512
  if (st.isDirectory()) for (const name of fs.readdirSync(p)) n += allocated(path.join(p, name))
  return n
}

/** `bytes` of data in a file of the worktree, on disk when this returns. */
function fill(cwd: string, rel: string, bytes: number): void {
  const file = path.join(cwd, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61), { flush: true })
}

/** What a row says of its size: `4.2 MB · 1.0 MB rebuildable`. */
function sizeOf(cwd: string): string {
  const rebuildable = fs.existsSync(path.join(cwd, 'node_modules')) ? allocated(path.join(cwd, 'node_modules')) : 0
  return `${formatBytes(allocated(cwd))} · ${rebuildable ? `${formatBytes(rebuildable)} rebuildable` : 'nothing rebuildable'}`
}

type Probe = { rpcPending(): number }
const pending = (page: Page): Promise<number> => page.evaluate(() => (globalThis as unknown as { __keaProbe: Probe }).__keaProbe.rpcPending())
const atRest = (page: Page) => until('no call of the window waiting on core', async () => (await pending(page)) === 0 || undefined)

const sheet = (page: Page): Locator => page.getByRole('dialog', { name: /^Settings: / })
const diskView = (page: Page): Locator => page.getByRole('dialog', { name: 'Settings: Disk', exact: true })
const diskRow = (page: Page, id: string): Locator => page.locator(`[data-disk-row="${id}"]`)
const rowIds = (page: Page): Promise<string[]> => page.locator('[data-disk-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-disk-row') ?? ''))

describe('worktree and Disk view leaks (app)', () => {
  it(
    'L-WT-1 · sessions with worktrees in cycles through Settings › Disk, beside one session kept throughout: created and shown, given a build folder, measured on the walk thread, its build folders removed from its row, then off screen: archived from its row (teardown run) and measured again, unarchived, deleted from the view, restored from Recently deleted and deleted for good (teardown run each time), ×12; then the view closed while a walk and a branch question are still out (core held meanwhile), ×12: core’s disk service back at its baseline with no walk, thread or work left, no `kv` mark of a gone session (`disk:`) or of a teardown’s terminal (`teardown:`), the renderer’s disk rows at 0 once closed; every count equal; heaps within budget',
    async () => {
      const run = KeaRun.create()
      runs.push(run)
      claudeByDefault(run)
      const agent = fakeClaude(run, 'l-wt-1', IDLE)
      const repo = demoRepo(run)
      commitFiles(repo.root, { '.kea/teardown.sh': '#!/bin/sh\nexit 0\n' }, { executable: true })
      // the session kept throughout is of a repository of its own: the cycles' git work in theirs never reaches its watch
      const other = demoRepo(run, 'kept')
      const kea: Kea = await run.launch()
      await addProject(kea, repo.root)
      await addProject(kea, other.root)
      const page = await kea.page()
      const projectId = (name: string): Promise<string> => projectRow(page, name).getAttribute('data-project-id').then((v) => v ?? '')
      const [cycles, keptProject] = [await projectId(path.basename(repo.root)), await projectId(path.basename(other.root))]
      /** The composer for `project` (`session.new` with its id, as a project row's + does), then the prompt and ⌘↵. */
      const newSession = async (project: string, prompt: string): Promise<string> => {
        expect(await page.evaluate((a) => (globalThis as unknown as { __keaProbe: { run(id: string, args: unknown): boolean } }).__keaProbe.run('session.new', a), { projectId: project }), 'New Session').toBe(true)
        return startSession(kea, prompt, { open: false })
      }
      const renderer = await RendererProbe.open(kea)
      probes.push(renderer)

      const starts = (): { cwd: string }[] => agentEvents(agent.log).filter((e) => e.t === 'start') as unknown as { cwd: string }[]
      /** core's `core.disk` row: rows, queue, the walk, its thread, the timer, work in flight, retries. */
      const disk = async (): Promise<Record<string, number>> => (await kea.debug<Record<string, Record<string, number>>>('core', 'kit'))['core.disk'] ?? {}
      const diskAtRest = (rows: number) =>
        until(`core’s disk service at rest with ${rows} rows`, async () => {
          const d = await disk()
          return (d.rows === rows && d.queued === 0 && d.walking === 0 && d.workers === 0 && d.work === 0 && d.retries === 0) || undefined
        }).catch(async (e: Error) => {
          throw new Error(`${e.message}: ${JSON.stringify(await disk())}`)
        })
      /** The `kv` marks this test checks, and a session's size as core wrote it (the database, read only). */
      const db = <T>(read: (d: DatabaseSync) => T): T => {
        const d = new DatabaseSync(path.join(run.home, 'kea.db'), { readOnly: true })
        try {
          return read(d)
        } finally {
          d.close()
        }
      }
      const marks = (): string[] => db((d) => (d.prepare("SELECT key FROM kv WHERE key LIKE 'disk:%' OR key LIKE 'teardown:%' ORDER BY key").all() as { key: string }[]).map((r) => r.key))
      const measuredAt = (id: string): number => db((d) => Number((d.prepare('SELECT disk_at AS at FROM sessions WHERE id = ?').get(id) as { at: number | null } | undefined)?.at ?? 0))
      const diskRows = async (): Promise<Record<string, number>> => {
        const r = await page.evaluate(() => (globalThis as unknown as { __keaPerf: { resources(): Record<string, number> } }).__keaPerf.resources())
        return Object.fromEntries(Object.entries(r).filter(([k]) => /(?:^|\.)(?:disk[A-Z]\w*|diagnosticsAsks)$/.test(k)))
      }

      const openView = async (): Promise<void> => {
        expect(await chooseMenuItem(kea, 'app.showDisk'), 'Show Disk Usage').toBe(true)
        await diskView(page).waitFor({ timeout: STEP_MS })
      }
      const closeView = async (): Promise<void> => {
        await page.keyboard.press('Escape')
        await sheet(page).waitFor({ state: 'detached', timeout: STEP_MS })
        expect(Object.values(await diskRows()).every((n) => n === 0), `the Disk view’s rows once closed: ${JSON.stringify(await diskRows())}`).toBe(true)
      }
      const refresh = () => diskView(page).getByRole('button', { name: 'Refresh' }).click()
      /** The row's size as the walk found it, equal to what the disk holds now; then its branch, asked of git. */
      const measured = async (id: string, cwd: string, what: string): Promise<void> => {
        const size = diskRow(page, id).locator('[data-disk-size]')
        await until(`${what}: the size walked`, async () => ((await size.textContent().catch(() => '')) === sizeOf(cwd) ? true : undefined)).catch(async (e: Error) => {
          throw new Error(`${e.message}: the row says ${JSON.stringify(await size.textContent().catch(() => null))}, the disk ${JSON.stringify(sizeOf(cwd))}`)
        })
        await until(`${what}: its branch asked of git`, async () => !/checking/.test((await diskRow(page, id).locator('[data-disk-branch]').textContent().catch(() => 'checking')) ?? 'checking') || undefined)
      }
      /** After an Archive: until `done`, pressing the archive sheet's own Archive if Kea asks first. */
      const archived = async (done: () => Promise<boolean>): Promise<void> => {
        const ask = page.getByRole('alertdialog', { name: 'Archive session' })
        const asked = await until('the session archived, or the question', async () => ((await done()) ? 'done' : (await ask.isVisible()) ? 'asked' : undefined))
        if (asked === 'done') return
        await ask.getByRole('button', { name: 'Archive', exact: true }).click()
        await until('the session archived', async () => (await done()) || undefined)
      }
      const deleteFromView = async (id: string, title: string): Promise<void> => {
        await diskRow(page, id).getByRole('button', { name: `Delete ${title}…` }).click()
        const del = page.getByRole('alertdialog', { name: 'Delete session' })
        await del.waitFor({ timeout: STEP_MS })
        await del.getByRole('button', { name: 'Delete', exact: true }).click()
        await diskView(page).waitFor({ timeout: STEP_MS })
        await until('its row gone from the view', async () => !(await rowIds(page)).includes(id) || undefined)
      }

      // a session kept throughout, in its own project, on screen whenever a cycle's session is not: a session archived,
      // deleted or restored while it is on screen takes its pane and file panel through states that last as long as the
      // race between them and core (the file panel's "Live updates unavailable." for a worktree going away, the pane's
      // "No shell is open" once its session went), each drawn for the first time in whichever cycle loses that race
      // (Svelte builds that branch's template once, so the count would read 4 to 7 DOM nodes more from then on)
      const n0 = starts().length
      const kept = await newSession(keptProject, 'l-wt-1 kept')
      await waitLive(kea, kept)
      const keptCwd = await until('its agent started, in its worktree', () => starts()[n0]?.cwd)
      fill(keptCwd, 'node_modules/pkg/blob.bin', BLOB)
      await openView()
      await refresh()
      await measured(kept, keptCwd, 'the session kept')
      await closeView()
      const showKept = async (): Promise<void> => {
        await selectSession(kea, kept)
        await until('the kept session’s files drawn', async () => (await page.locator(`.fp[data-session="${kept}"]`).count()) > 0 || undefined)
      }

      // the canonical state: the kept session on screen, Settings closed, no call waiting, no toast; core's disk service
      // at rest over the sessions there are, and its file service with no git status of the kept session due (the
      // cycles' git work in the one repository reaches its watch: a status is asked again a moment later)
      const rows = 1
      const quiesce = async (): Promise<void> => {
        expect(await paneSession(page), 'the kept session on screen').toBe(kept)
        expect(await sheet(page).count(), 'Settings closed').toBe(0)
        await atRest(page)
        await diskAtRest(rows)
        await until('no toast', async () => (await page.locator('.toast').count()) === 0 || undefined)
        await until('the file panel and core’s file service at rest', async () => {
          const files = (await kea.debug<Record<string, Record<string, number>>>('core', 'kit'))['core.files'] ?? {}
          const panel = (await page.evaluate(() => (window as unknown as { __keaPerf: { resources(): Record<string, number> } }).__keaPerf.resources()))['renderer.filePanelTimers']
          return (files.statusPending === 0 && files.timers === 0 && panel === 0) || undefined
        })
        expect(marks().filter((k) => k.startsWith('teardown:')), 'no teardown terminal’s mark left').toEqual([])
      }

      // the window's one tooltip builds its markup the first time a tip shows (6 DOM nodes, more for a tip with a key),
      // and a cycle shows one only when a step is slow: Settings reopened under the pointer that clicked Refresh shows
      // that button's tip once the pointer has rested there for the tooltip delay. So a tip with a key shows once here,
      // before the baseline, and goes when the pointer moves onto the terminal (`renderer.tooltips` is judged at every
      // checkpoint: none on screen)
      await showKept()
      await page.locator('button[data-command="session.new"]:visible').first().hover()
      await page.locator('.kea-tooltip kbd').waitFor({ timeout: STEP_MS })
      const term = await page.locator('.terminal-host.shown').boundingBox()
      if (!term) throw new Error('no terminal on screen')
      await page.mouse.move(term.x + term.width / 2, term.y + term.height / 2)
      await page.locator('.kea-tooltip').waitFor({ state: 'detached', timeout: STEP_MS })

      // ── a session's whole life ──
      const gone: string[] = []
      const cycle = async (i: number): Promise<void> => {
        const n = starts().length
        const id = await newSession(cycles, `l-wt-1 cycle ${i}`)
        await waitLive(kea, id)
        const cwd = await until('its agent started, in its worktree', () => starts()[n]?.cwd)
        const title = (await waitRow(kea, id, 'listed', () => true)).title
        await until('shown in the main pane', async () => (await paneSession(page)) === id || undefined)
        fill(cwd, 'node_modules/pkg/blob.bin', BLOB)
        // measured on the walk thread (Refresh walks again a worktree measured less than L.diskMeasureIntervalMs ago)
        await openView()
        await refresh()
        await measured(id, cwd, 'with its build folder')
        expect(sizeOf(cwd)).toMatch(/ rebuildable$/)
        expect(sizeOf(cwd)).not.toMatch(/nothing rebuildable/)
        // its build folders removed from its row: at once
        await diskRow(page, id).getByRole('button', { name: /^Remove build folders/ }).click()
        await until('node_modules removed', () => !fs.existsSync(path.join(cwd, 'node_modules')) || undefined)
        await measured(id, cwd, 'without it')
        await closeView()
        // from here on it is not on screen (its `disk:` mark is written as it leaves)
        await showKept()
        // archived from its row (its teardown runs), then measured again with what is written in it since
        await openView()
        await diskRow(page, id).getByRole('button', { name: `Archive ${title}` }).click()
        await archived(async () => ((await diskRow(page, id).textContent().catch(() => '')) ?? '').includes('archived'))
        await diskView(page).waitFor({ timeout: STEP_MS })
        fill(cwd, 'notes/archived.txt', NOTE)
        await refresh()
        await measured(id, cwd, 'archived')
        await closeView()
        // unarchived from its row's menu (its project's Archived group opened for it)
        if ((await sessionRow(page, id).count()) === 0) await page.getByRole('treeitem', { name: /^Archived \(/ }).click()
        await waitRow(kea, id, 'archived, listed', (r) => r.lifecycle === 'archived')
        await sessionMenu(kea, id, 'session.unarchive')
        await waitRow(kea, id, 'detached after Unarchive', (r) => r.lifecycle === 'detached')
        // deleted from the view (its teardown runs), restored from Recently deleted, deleted for good
        await openView()
        await deleteFromView(id, title)
        await until('its worktree gone', () => !fs.existsSync(cwd) || undefined)
        const deleted = diskView(page).locator(`[data-disk-deleted="${id}"]`)
        await deleted.getByRole('button', { name: `Restore ${title}` }).click({ timeout: STEP_MS })
        await until('restored: its row back in the view', async () => (await rowIds(page)).includes(id) || undefined)
        expect(fs.statSync(path.join(cwd, 'notes/archived.txt')).size, 'its untracked file back with it').toBe(NOTE)
        await waitRow(kea, id, 'detached after Restore', (r) => r.lifecycle === 'detached')
        expect(await paneSession(page), 'the kept session still on screen').toBe(kept)
        await deleteFromView(id, title)
        await until('its worktree gone again', () => !fs.existsSync(cwd) || undefined)
        await closeView()
        await until('its row gone from the list', async () => (await rowState(page, id)) === null || undefined)
        gone.push(id)
        // nothing of it is left in core's disk service, its marks or its terminals
        await diskAtRest(rows)
        await until('no mark of a gone session or of a teardown’s terminal', () => marks().every((k) => !k.startsWith('teardown:') && !gone.some((g) => k === `disk:${g}`)) || undefined).catch((e: Error) => {
          throw new Error(`${e.message}: ${JSON.stringify(marks())}`)
        })
        expect(run.holders().filter((h) => h.sessionId === id && run.holderAlive(h)), 'no terminal of it left').toEqual([])
      }

      const lives = await runCycles({
        kea,
        renderer,
        batch: 1,
        quiesce,
        cycle,
      })
      expect(lives.cycles.at(-1)).toBe(10)
      expectCountsFlat(lives, () => true)
      await expectBytesFlat(kea, renderer, lives, HEAPS, 'L-WT-1')

      // ── the view closed with a walk and a branch question out ──
      const core = await kea.pid('core')
      const hold = (sig: 'SIGSTOP' | 'SIGCONT'): void => {
        if (!signalKnown(core, sig)) throw new Error(`core (${core.pid}) is not the process it was`)
      }
      const closedEarly = await runCycles({
        kea,
        renderer,
        batch: 1,
        quiesce,
        cycle: async () => {
          await openView()
          await measured(kept, keptCwd, 'the session kept')
          await atRest(page)
          const before = measuredAt(kept)
          let resumed = 0
          hold('SIGSTOP')
          try {
            // Refresh: every worktree walked again, the branch of each row on screen asked again
            await refresh()
            await until('the walk and the branch question waiting on core', async () => (await pending(page)) >= 2 || undefined)
            await closeView()
            expect(await pending(page), 'still out once the view has closed').toBeGreaterThanOrEqual(2)
            resumed = Date.now()
          } finally {
            hold('SIGCONT')
          }
          // the answers arrive now, for nothing on screen, and the walk runs with no view to tell
          await atRest(page)
          await diskAtRest(rows)
          expect([before < resumed, measuredAt(kept) >= resumed], 'walked before the hold, and again once core went on (the view closed)').toEqual([true, true])
        },
      })
      expect(closedEarly.cycles.at(-1)).toBe(10)
      expect((await kea.pid('core')).pid, 'the same core throughout').toBe(core.pid)
      await waitRow(kea, kept, 'still live', (r) => r.lifecycle === 'live')
      expect(marks().filter((k) => k.startsWith('disk:') && k !== `disk:${kept}`), 'no mark but the kept session’s').toEqual([])
      expectCountsFlat(closedEarly, () => true)
      await expectBytesFlat(kea, renderer, closedEarly, HEAPS, 'L-WT-1 (closed with a walk out)')
    },
    ROW_MS,
  )
})
