// A terminal's last mouse event and the session panes it has left, against the real app (tests/support/app.ts). xterm's
// link detection keeps the last `mousemove` over a terminal, to look for a link under the pointer again when the screen
// changes, and an event keeps the elements it went through (Kea's patch keeps a copy with no event path). A terminal
// moves between panes (docked when its session leaves the main pane, mounted in a new pane when it comes back), so
// without the patch it would keep the pane it left, and all it holds, until the mouse next moves over it.

import { afterEach, describe, expect, it } from 'vitest'
import { KeaRun, PROMPT, until, type Kea } from '../support/app.ts'
import { RendererProbe } from '../support/app-leak.ts'
import { addProject, demoRepo, selectSession, startSession, waitLive } from '../support/app-sessions.ts'

const runs: KeaRun[] = []
const probes: RendererProbe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

type Marks = { __moved?: boolean; __leftPane?: WeakRef<Element> }

describe('terminal events (app)', () => {
  it('L-TERM-12 · the mouse moved over a session’s terminal, then the session left the main pane and came back (its terminal docked, then mounted in a new pane), the mouse on the sidebar meanwhile: once garbage is collected, the pane the terminal left is gone', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea: Kea = await run.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    await addProject(kea, demoRepo(run).root)
    const page = await kea.page()
    const sessions: string[] = []
    for (const name of ['pointer one', 'pointer two']) {
      const id = await startSession(kea, name)
      await waitLive(kea, id)
      sessions.push(id)
    }
    const [one, two] = sessions as [string, string]
    await selectSession(kea, one)
    const pty = await until('a terminal of the session on screen', () => kea.shown())
    expect(await page.locator('.session-pane').count(), 'one session pane').toBe(1)

    // the mouse moves over the terminal, as on the way to its text: xterm's link detection keeps that event
    await page.evaluate((id) => {
      const marks = globalThis as unknown as Marks
      marks.__moved = false
      document.querySelector(`.terminal-host[data-pty="${id}"]`)?.addEventListener('mousemove', () => (marks.__moved = true), { once: true })
    }, pty)
    const box = await page.locator(`.terminal-host[data-pty="${pty}"]`).boundingBox()
    if (!box) throw new Error('the terminal has no box')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await until('the terminal saw the mouse move', () => page.evaluate(() => (globalThis as unknown as Marks).__moved) || undefined)
    await page.evaluate(() => {
      ;(globalThis as unknown as Marks).__leftPane = new WeakRef(document.querySelector('.session-pane') as Element)
    })

    // the other session, then this one again: each click on the sidebar, so the mouse never comes back over the terminal
    await selectSession(kea, two)
    await selectSession(kea, one)
    await until('the session’s terminal back on screen', async () => (await kea.shown()) === pty || undefined)

    const renderer = await RendererProbe.open(kea)
    probes.push(renderer)
    await renderer.settle()
    expect(await page.evaluate(() => (globalThis as unknown as Marks).__leftPane?.deref() === undefined), 'the pane the terminal left, collected').toBe(true)
  })
})
