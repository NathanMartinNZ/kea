// Leak cycles of main's hand-offs to the browser on Linux, against the real app (tests/support/app.ts): a dev build
// that hands pages to the system for real (`--kea-perf-real-browser`), with a stand-in as the desktop's handler
// (tests/support/browser-stand-in.ts), so `xdg-open` runs and nothing opens. Bursts of Open in Browser requests and web
// links through the window's bridge, the window reloaded between bursts so its slots go with its connection.

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
/** Requests per burst, pages and links in turn: a newer one replaces an older one of its kind that has not started. */
const BURST = 12
/** The link the bursts open (the stand-in records it; the address is never looked up). */
const LINK = 'https://example.invalid/kea-burst'

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
  it('L-FV-8 · bursts of pages and links, each answered or dropped unstarted, reach the desktop’s handler; main’s hand-offs in flight, their timers and the window’s slots return to none', async (ctx) => {
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
        ({ p, url, n, base }) => {
          const kea = (window as unknown as { kea: { openPage(reqId: number, path: string): void; openLink(reqId: number, url: string): void } }).kea
          for (let i = 0; i < n; i++) {
            if (i % 2 === 0) kea.openPage(base + i, p)
            else kea.openLink(base + i, url)
          }
        },
        { p: file, url: LINK, n: BURST, base: 1_000_000 + cycle * BURST },
      )
      // the last page and the last link of the burst are never replaced: at least they are answered and handed over
      await until('the burst’s page and link answered', () => {
        const kinds = new Set(answersOf(kea).slice(answered).map((a) => a.kind))
        return (kinds.has('page') && kinds.has('link')) || undefined
      })
      await until('the stand-in reached by both', () => {
        const got = standIn.handed().slice(handed)
        return (got.includes(LINK) && got.some((h) => h !== LINK)) || undefined
      })
      const g = await until('no hand-off in flight', async () => {
        const now = await handoffs(kea)
        return now.inFlight === 0 && now.timers === 0 ? now : undefined
      })
      expect(g.slots, 'an answered request leaves its slot').toBe(0)
      const mine = answersOf(kea).slice(answered)
      expect(mine.length).toBeLessThanOrEqual(BURST)
      expect(mine.every((a) => a.answer === 'handed over'), JSON.stringify(mine)).toBe(true)
      expect(standIn.handed().slice(handed).every((h) => h === LINK || h === file || h === `file://${file}`), 'only the page and the link').toBe(true)
      await kea.reloadWindow()
    }
    expect(await handoffs(kea)).toEqual({ inFlight: 0, timers: 0, slots: 0 })
  })
})
