// Interaction budgets against the real app, a release build launched unfocused on a fresh KEA_HOME
// (tests/perf/app-harness.ts). Sessions run the `shell` pseudo-agent, the harness's default (tests/support/app.ts), in
// a repo-factory `tiny` repository inside the run's home. The sidebar's frame probes are `__keaPerf`'s
// (app/renderer/src/lib/perf.ts).

import { afterEach, describe, expect, it } from 'vitest'
import { STEP_MS, until } from '../support/app.ts'
import { addProject, demoRepo, startSession, waitLive } from '../support/app-sessions.ts'
import { budget, check, disposeRuns, dist, record, startKea } from './app-harness.ts'
import { sysKey } from '../support/keys.ts'

afterEach(disposeRuns)

declare const __keaProbe: {
  palette: {
    timeOpen(timeoutMs?: number): Promise<{ interactive: number; painted: number }>
    synthetic(n: { sessions: number; commands: number } | null): void
    keystrokes(record: boolean): number[]
  }
}

declare const __keaPerf: {
  armNewRow(ms?: number): void
  awaitNewRow(): Promise<{ drawn: number; painted: number }>
  framesStart(): void
  framesStop(): { fps: number; maxGapMs: number; frames: number; storeFlushes: number; maxStoreFlushes: number }
}

/** Resolves after `n` animation frames of the page. */
function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n
    const f = () => (--left > 0 ? requestAnimationFrame(f) : resolve())
    requestAnimationFrame(f)
  })
}

describe('interaction (app)', () => {
  it('P-UI-4 · ⌘↵ in the composer → the frame that draws the new session’s row within budget, median of 10 starts after 2 unmeasured ones', async () => {
    const STARTS = 10
    const WARMUP_STARTS = 2
    const { run, kea } = await startKea()
    const page = await kea.page()
    await addProject(kea, demoRepo(run).root)
    const drawn: number[] = []
    const painted: number[] = []
    for (let i = 0; i < WARMUP_STARTS + STARTS; i++) {
      const id = await startSession(kea, `row ${i + 1}`, { beforeStart: () => page.evaluate(() => __keaPerf.armNewRow()) })
      const ms = await page.evaluate(() => __keaPerf.awaitNewRow())
      if (i >= WARMUP_STARTS) {
        drawn.push(ms.drawn)
        painted.push(ms.painted)
      }
      await waitLive(kea, id) // its creation done before the next start
    }
    const d = dist(drawn)
    const p = dist(painted)
    const b = budget('P-UI-4')
    const e = record({
      id: 'P-UI-4',
      metric: b.metric,
      method: `⌘N, a prompt, ⌘↵ (a worktree session of a tiny repo); keydown → the frame that draws the row, its paint and scan-out excluded (__keaPerf.armNewRow: the row is a FrameStore flush, drawn by the frame it runs in, or by the next when it runs between frames); ${WARMUP_STARTS} unmeasured + ${STARTS} starts, each live before the next, median (p99 reported). Not asserted: paintedP50 and paintedP99, keydown → the start of the frame after the drawing one (its paint done)`,
      values: { ...d, paintedP50: p.p50, paintedP99: p.p99 },
      checks: [check('median', d.p50, b.max, 'max', b.unit)],
    })
    expect(e.pass, `P-UI-4: ${JSON.stringify(e.values)}`).toBe(true)
  })

  it('P-UI-7 · 20 sessions changing status at once (their agents’ holders killed together): at most one sessions-store flush per frame and no frame over budget', async () => {
    const SESSIONS = 20
    const ROUNDS = 3
    const SETTLE_FRAMES = 30
    const { run, kea } = await startKea()
    const page = await kea.page()
    await addProject(kea, demoRepo(run).root)
    const rounds: { maxGapMs: number; maxStoreFlushes: number; storeFlushes: number; frames: number; idleMaxGapMs: number }[] = []
    for (let r = 0; r < ROUNDS; r++) {
      const ids: string[] = []
      for (let i = 0; i < SESSIONS; i++) ids.push(await startSession(kea, `status ${r + 1} ${i + 1}`, { background: true, open: i === 0 }))
      for (const id of ids) await waitLive(kea, id)
      const agents = run.holders().filter((h) => ids.includes(h.sessionId) && run.holderAlive(h))
      expect(agents.length, 'one agent holder per session').toBe(SESSIONS)
      // the same window of frames with nothing happening, for comparison
      await page.evaluate(() => __keaPerf.framesStart())
      await page.evaluate(frames, SETTLE_FRAMES)
      const idle = await page.evaluate(() => __keaPerf.framesStop())
      await page.evaluate(() => __keaPerf.framesStart())
      run.killHolders(agents)
      await page.waitForFunction((xs) => xs.every((id) => document.querySelector(`[role=treeitem][data-session-id="${id}"]`)?.getAttribute('data-lifecycle') === 'detached'), ids, { polling: 'raf', timeout: STEP_MS })
      await page.evaluate(frames, SETTLE_FRAMES)
      const f = await page.evaluate(() => __keaPerf.framesStop())
      rounds.push({ maxGapMs: f.maxGapMs, maxStoreFlushes: f.maxStoreFlushes, storeFlushes: f.storeFlushes, frames: f.frames, idleMaxGapMs: idle.maxGapMs })
      await until('the composer still open', () => page.getByRole('region', { name: 'New session' }).isVisible().catch(() => false) || undefined)
    }
    const b = budget('P-UI-7')
    const maxGap = Math.max(...rounds.map((x) => x.maxGapMs))
    const maxFlushes = Math.max(...rounds.map((x) => x.maxStoreFlushes))
    const e = record({
      id: 'P-UI-7',
      metric: b.metric,
      method: `${SESSIONS} live sessions (the shell pseudo-agent); their agents' holders SIGKILLed together, so all ${SESSIONS} go detached at once; rAF frames from just before the kill until every row says detached plus ${SETTLE_FRAMES} frames: the longest frame and the most flushes of the sessions store between two frames (at most one); ${ROUNDS} rounds, each with ${SESSIONS} new sessions (the sidebar grows), the worst round`,
      values: { maxGapMs: maxGap, maxStoreFlushesPerFrame: maxFlushes, storeFlushes: Math.max(...rounds.map((x) => x.storeFlushes)), idleMaxGapMs: Math.max(...rounds.map((x) => x.idleMaxGapMs)) },
      checks: [check('maxGapMs', maxGap, b.max_frame_ms, 'max', b.unit), check('maxStoreFlushesPerFrame', maxFlushes, 1, 'max', 'count')],
    })
    expect(e.pass, `P-UI-7: ${JSON.stringify(rounds)}`).toBe(true)
  })

  it('P-UI-2 · ⌘⇧P → the palette interactive (its input holds the keyboard) within budget, median of 20 openings after 3 unmeasured ones', async () => {
    const OPENS = 20
    const WARMUP_OPENS = 3
    const { run, kea } = await startKea()
    const page = await kea.page()
    await addProject(kea, demoRepo(run).root)
    // a window with something in it: sessions for the palette to list, one of them on screen with the keyboard
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push(await startSession(kea, `palette ${i + 1}`))
    for (const id of ids) await waitLive(kea, id)
    await page.locator('.terminal-host.shown').click({ position: { x: 20, y: 20 } })
    const interactive: number[] = []
    const painted: number[] = []
    for (let i = 0; i < WARMUP_OPENS + OPENS; i++) {
      await page.evaluate(() => void ((window as unknown as { __paletteOpen: Promise<unknown> }).__paletteOpen = __keaProbe.palette.timeOpen()))
      await page.keyboard.press(sysKey('Meta+Shift+p'))
      const ms = await page.evaluate(() => (window as unknown as { __paletteOpen: Promise<{ interactive: number; painted: number }> }).__paletteOpen)
      expect(await page.evaluate(() => document.activeElement?.matches('.palette input') === true), 'the palette’s input has the keyboard').toBe(true)
      expect(await page.locator('.palette [role=option]').count(), 'and it lists its rows').toBeGreaterThan(0)
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('.palette'), undefined, { polling: 'raf', timeout: STEP_MS })
      if (i >= WARMUP_OPENS) {
        interactive.push(ms.interactive)
        painted.push(ms.painted)
      }
    }
    const d = dist(interactive)
    const p = dist(painted)
    const b = budget('P-UI-2')
    const e = record({
      id: 'P-UI-2',
      metric: b.metric,
      method: `3 live sessions, the keyboard in a terminal; ⌘⇧P keydown → the palette mounted with its rows and its input holding the keyboard, timed to the frame that draws it (__keaProbe.palette.timeOpen: the palette opens between frames, so the moment is the start of the next frame, its paint and scan-out excluded); ${WARMUP_OPENS} unmeasured + ${OPENS} openings, Esc between them, median (p99 reported). Not asserted: paintedP50 and paintedP99, keydown → the start of the frame after (its paint done)`,
      values: { ...d, paintedP50: p.p50, paintedP99: p.p99 },
      checks: [check('median', d.p50, b.max, 'max', b.unit)],
    })
    expect(e.pass, `P-UI-2: ${JSON.stringify(e.values)}`).toBe(true)
  })

  it('P-UI-3 · a palette keystroke with 500 sessions and 200 commands: keydown → the list drawn within budget, median over every key of six queries typed and deleted', async () => {
    const SESSIONS = 500
    const COMMANDS = 200
    const QUERIES = ['fix auth', 'server port 41', 'tgsb', '>the', 'worktree prune 127', 'zzzz']
    const { kea } = await startKea()
    const page = await kea.page()
    await page.evaluate(([sessions, commands]) => __keaProbe.palette.synthetic({ sessions: sessions as number, commands: commands as number }), [SESSIONS, COMMANDS])
    await page.keyboard.press(sysKey('Meta+Shift+p'))
    await page.waitForFunction(() => document.activeElement?.matches('.palette input') === true, undefined, { polling: 'raf', timeout: STEP_MS })
    // one query unmeasured (the matcher and the list warm up), then every key of the others
    await page.keyboard.type('warm up')
    for (let i = 0; i < 'warm up'.length; i++) await page.keyboard.press('Backspace')
    await page.evaluate(() => void __keaProbe.palette.keystrokes(true))
    let keys = 0
    let most = 0
    for (const q of QUERIES) {
      await page.keyboard.type(q)
      most = Math.max(most, await page.locator('.palette [role=option]').count())
      for (let i = 0; i < q.length; i++) await page.keyboard.press('Backspace')
      keys += q.length * 2
    }
    const times = await page.evaluate(() => __keaProbe.palette.keystrokes(false))
    await page.keyboard.press('Escape')
    await page.evaluate(() => __keaProbe.palette.synthetic(null))
    expect(times.length, 'every key was timed').toBe(keys)
    expect(most, 'the queries matched and the list was drawn').toBeGreaterThan(10)
    const d = dist(times)
    const b = budget('P-UI-3')
    const e = record({
      id: 'P-UI-3',
      metric: b.metric,
      method: `the palette open over a synthetic set (__keaProbe.palette.synthetic: ${SESSIONS} sessions with title, branch and project, ${COMMANDS} commands, 9 projects); each key's keydown → the end of the update that draws the list (matching all ${SESSIONS + COMMANDS} candidates, ranking, the rows shown and their DOM; the frame's paint excluded), ${QUERIES.length} queries typed and deleted a key at a time (${keys} keys) after one unmeasured query; median (p99 and max reported)`,
      values: { ...d, mostRows: most },
      checks: [check('median', d.p50, b.max, 'max', b.unit)],
    })
    expect(e.pass, `P-UI-3: ${JSON.stringify(e.values)}`).toBe(true)
  })
})
