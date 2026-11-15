// Leak cycles of main's hand-offs to the browser on Linux, against the real app (tests/support/app.ts): a dev build
// that hands pages to the system for real (`--kea-perf-real-browser`), with a stand-in as the desktop's handler
// (tests/support/browser-stand-in.ts), so `xdg-open` runs and nothing opens. Bursts of Open in Browser requests through
// the window's bridge, the window reloaded between bursts so its slot goes with its connection.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { harnessOs } from '../../tools/perf/src/os/index.ts'
import { KeaRun, until, type Kea } from '../support/app.ts'
import { addProject, demoRepo, startSession, waitLive } from '../support/app-sessions.ts'
import { commitAll, sessionWorktree, writeFiles } from '../support/app-viewer.ts'
import { browserStandIn } from '../support/browser-stand-in.ts'
import { skipWhere } from '../support/skip.ts'

const runs: KeaRun[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose()
})

/** Bursts, each followed by a reload of the window. */
const CYCLES = 5
/** Requests per burst: a newer one replaces an older one that has not started, so most never start. */
const BURST = 12

/** Main's `main.browserHandoffs` row. */
function handoffs(kea: Kea): Promise<{ inFlight: number; timers: number; slots: number }> {
  return kea.app.evaluate(() => {
    const reg = (globalThis as unknown as Record<symbol, { report(): Record<string, unknown> }>)[Symbol.for('kea.kit.resources')]
    return reg?.report()['main.browserHandoffs'] as { inFlight: number; timers: number; slots: number }
  })
}

/** Main's log line for each answer it gave. */
function answersOf(kea: Kea): Record<string, unknown>[] {
  return kea.logLines('main').filter((l) => l.msg === 'browser hand-off')
}

describe('browser hand-offs', () => {
  it('L-FV-8 · bursts of pages, each answered or dropped unstarted, reach the desktop’s handler; main’s hand-offs in flight, their timers and the window’s slot return to none', async (ctx) => {
    skipWhere(ctx, harnessOs.system === 'linux' ? null : 'the stand-in is a Linux desktop handler; macOS opens a page with the default browser by name')
    const run = KeaRun.create()
    runs.push(run)
    const standIn = browserStandIn(run.home)
    const kea = await run.launch({ args: ['--kea-perf-real-browser'], env: standIn.env })
    const repo = demoRepo(run)
    writeFiles(repo.root, { 'site/index.html': '<!doctype html>\n<title>Demo</title>\n<p>Hello</p>\n' })
    commitAll(repo.root, 'Add a page')
    await addProject(kea, repo.root)
    const id = await startSession(kea, 'pages')
    await waitLive(kea, id)
    const file = path.join(fs.realpathSync(sessionWorktree(repo.root)), 'site/index.html')

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const answered = answersOf(kea).length
      const handed = standIn.handed().length
      const page = await kea.page()
      await page.evaluate(
        ({ p, n, base }) => {
          const kea = (window as unknown as { kea: { openPage(reqId: number, path: string): void } }).kea
          for (let i = 0; i < n; i++) kea.openPage(base + i, p)
        },
        { p: file, n: BURST, base: 1_000_000 + cycle * BURST },
      )
      // the last request of the burst is never replaced: at least it is answered, and handed to the stand-in
      await until('the burst answered', () => answersOf(kea).length > answered || undefined)
      await until('the stand-in reached', () => standIn.handed().length > handed || undefined)
      const g = await until('no hand-off in flight', async () => {
        const now = await handoffs(kea)
        return now.inFlight === 0 && now.timers === 0 ? now : undefined
      })
      expect(g.slots, 'an answered page leaves its slot').toBe(0)
      const mine = answersOf(kea).slice(answered)
      expect(mine.length).toBeLessThanOrEqual(BURST)
      expect(mine.every((a) => a.kind === 'page' && a.answer === 'handed over'), JSON.stringify(mine)).toBe(true)
      expect(standIn.handed().slice(handed).every((h) => h === file || h === `file://${file}`), 'only the page').toBe(true)
      await kea.reloadWindow()
    }
    expect(await handoffs(kea)).toEqual({ inFlight: 0, timers: 0, slots: 0 })
  })
})
