// Interaction budgets of the composer and the agent start against the real app, a release build launched unfocused on a
// fresh KEA_HOME (tests/perf/app-harness.ts), with tools/fake-agent as its `claude` (tests/support/app.ts).
//
//   P-UI-1  ⌘N → the composer interactive: keydown → the frame that draws the composer with its prompt holding the
//           keyboard, by the one-frame rule (`__keaPerf.armNewRow` times the ⌘↵-to-row budget the same way): a
//           change made during a frame's animation callbacks is drawn by that frame, one made between frames by the
//           next. The agent selector reads core's cached `agents` store, so nothing waits on a detection.
//   P-UI-5  ⌘↵ → the agent process started, a worktree session of a `medium` repository: keydown → core spawning the
//           agent (its "agent launched" line), and → the agent's own first line (its startup included).

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mediumRepo } from '@kea-tools/repo-factory/src/index.ts'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { STEP_MS, until } from '../support/app.ts'
import { addProject, promptBox, startSession, waitLive } from '../support/app-sessions.ts'
import { budget, check, disposeRuns, dist, record, startKea } from './app-harness.ts'
import { pageKey, sysKey } from '../support/keys.ts'

afterEach(disposeRuns)

/** ⌘N and the composer's ⌘↵ as the page's keydown sees them here (Ctrl+Shift+N and Ctrl+Shift+Enter on Linux). */
const NEW_SESSION = pageKey('Meta+n')
const START = pageKey('Meta+Enter')

describe('composer and agent start (app)', () => {
  it('P-UI-1 · ⌘N → the composer drawn with its prompt holding the keyboard (by the one-frame rule), median of 10 opens after 2 unmeasured ones', async () => {
    const OPENS = 10
    const WARMUP = 2
    const { run, kea } = await startKea({ settings: { general: { defaultAgent: 'claude' } } })
    const page = await kea.page()
    const repo = mediumRepo({ parent: run.home })
    await addProject(kea, repo.root)
    // a session in the main pane, so each ⌘N opens the composer afresh
    const id = await startSession(kea, 'the pane under the composer', { open: false })
    await waitLive(kea, id)
    const drawn: number[] = []
    for (let i = 0; i < WARMUP + OPENS; i++) {
      await until('the composer closed', async () => (await page.getByRole('region', { name: 'New session' }).count()) === 0 || undefined)
      // the session's terminal back on screen and holding the keyboard (it takes it a frame after it is shown)
      await until('the terminal holding the keyboard', () => page.evaluate(() => !!document.querySelector('.terminal-host.shown')?.contains(document.activeElement)) || undefined)
      // armed first (as __keaPerf.armNewRow is), then the key, then the result
      await page.evaluate(({ timeoutMs, k }) => {
        const w = window as unknown as { __puiOpen?: Promise<number> }
        w.__puiOpen = new Promise<number>((resolve, reject) => {
            let down: number | null = null
            let inFrame = false
            let ticking = true
            const tick = () => {
              if (!ticking) return
              inFrame = true
              setTimeout(() => {
                inFrame = false
              }, 0)
              requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
            const ready = () => {
              const p = document.querySelector('[role=region][aria-label="New session"] textarea[aria-label=Prompt]')
              return !!p && document.activeElement === p
            }
            const done = (v: number | Error) => {
              ticking = false
              clearTimeout(timer)
              watch.disconnect()
              window.removeEventListener('keydown', onKey, true)
              document.removeEventListener('focusin', check, true)
              if (v instanceof Error) reject(v)
              else resolve(v)
            }
            const check = () => {
              if (down === null || !ready()) return
              const at = down
              down = null
              if (inFrame) done(performance.now() - at)
              else requestAnimationFrame((t) => done(t - at))
            }
            const onKey = (e: KeyboardEvent) => {
              if (down !== null || e.metaKey !== k.meta || e.ctrlKey !== k.ctrl || e.altKey !== k.alt || e.shiftKey !== k.shift || e.key.toLowerCase() !== k.key) return
              down = e.timeStamp
              // the router's listener (registered first) may already have opened and focused the composer synchronously
              check()
            }
            const watch = new MutationObserver(check)
            const timer = setTimeout(() => {
              const region = document.querySelector('[role=region][aria-label="New session"]')
              done(new Error(`the composer never became interactive (keydown ${down !== null}, composer ${!!region}, focus ${document.activeElement?.tagName}.${document.activeElement?.getAttribute('aria-label')})`))
            }, timeoutMs)
            window.addEventListener('keydown', onKey, true)
            document.addEventListener('focusin', check, true)
            watch.observe(document.body, { childList: true, subtree: true })
          })
        w.__puiOpen.catch(() => undefined)
      }, { timeoutMs: STEP_MS, k: NEW_SESSION })
      await page.keyboard.press(sysKey('Meta+n'))
      const v = await page.evaluate(() => (window as unknown as { __puiOpen: Promise<number> }).__puiOpen)
      if (i >= WARMUP) drawn.push(v)
      // the agent row is there (cached detection): Claude Code, ready
      await until('the agent selector', async () => (await page.getByRole('button', { name: 'Agent: Claude Code' }).count()) === 1 || undefined)
      await page.keyboard.press('Escape')
    }
    const d = dist(drawn)
    const b = budget('P-UI-1')
    const e = record({
      id: 'P-UI-1',
      metric: b.metric,
      method: `a session shown, ⌘N; keydown → the frame that draws the composer with its prompt focused (the one-frame rule, timed in the page as __keaPerf.armNewRow times P-UI-4); ${WARMUP} unmeasured + ${OPENS} opens, each closed with Esc, median (p99 reported)`,
      values: { ...d },
      checks: [check('median', d.p50, b.max, 'max', b.unit)],
    })
    expect(e.pass, `P-UI-1: ${JSON.stringify(e.values)}`).toBe(true)
    await kea.assertUnfocused()
  })

  it('P-UI-5 · ⌘↵ → the agent process started, a worktree session of a medium repository: within budget to core’s spawn, and within the budget with the agent’s own startup to its first line; median of 5 starts after 1 unmeasured one', async () => {
    const STARTS = 5
    const WARMUP = 1
    const { run, kea } = await startKea({ settings: { general: { defaultAgent: 'claude' } } })
    const page = await kea.page()
    const log = path.join(run.home, 'fake-agent.log')
    writeAgentShim(run.agentBin, 'claude', { env: { FAKE_AGENT_LOG: log } })
    const repo = mediumRepo({ parent: run.home })
    await addProject(kea, repo.root)
    const toSpawn: number[] = []
    const toAgent: number[] = []
    for (let i = 0; i < WARMUP + STARTS; i++) {
      const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('"t":"start"')).length : 0)
      const agentsBefore = starts()
      let firstLine = 0
      let downWall = 0
      const id = await startSession(kea, `start ${i + 1}`, {
        open: i > 0,
        beforeStart: () =>
          page.evaluate((k) => {
            const w = window as unknown as { __puiDown?: number }
            w.__puiDown = undefined
            // the modifiers' keydowns come first: only ⌘↵ (this system's) is taken, once
            const onKey = (e: KeyboardEvent) => {
              if (e.metaKey !== k.meta || e.ctrlKey !== k.ctrl || e.altKey !== k.alt || e.shiftKey !== k.shift || e.key.toLowerCase() !== k.key) return
              w.__puiDown = performance.timeOrigin + e.timeStamp
              window.removeEventListener('keydown', onKey, true)
            }
            window.addEventListener('keydown', onKey, true)
          }, START),
      })
      await until('the agent’s first line', () => {
        if (starts() > agentsBefore) firstLine = Date.now()
        return firstLine || undefined
      })
      downWall = await page.evaluate(() => (window as unknown as { __puiDown: number }).__puiDown)
      await waitLive(kea, id)
      const launched = kea.logLines('core').filter((l) => l.msg === 'agent launched' && l.sessionId === id).at(-1)
      expect(launched, 'core logged the agent launch').toBeDefined()
      if (i >= WARMUP) {
        toSpawn.push(Date.parse(launched!.t) - downWall)
        toAgent.push(firstLine - downWall)
      }
      expect(await promptBox(page).count(), 'the composer closed on the start').toBe(0)
    }
    const s = dist(toSpawn)
    const a = dist(toAgent)
    const b = budget('P-UI-5')
    const e = record({
      id: 'P-UI-5',
      metric: b.metric,
      method: `a medium repository (repo factory), worktree sessions started with ⌘↵, the base the default branch (no remote: nothing to fetch); keydown (performance.timeOrigin + timeStamp) → core's "agent launched" log line (the spawn), and → the fake agent's first log line (its node startup included, read by polling every 25 ms); ${WARMUP} unmeasured + ${STARTS} starts, median`,
      values: { spawnP50: s.p50, spawnMax: s.max, agentP50: a.p50, agentMax: a.max },
      checks: [check('spawn median', s.p50, b.max, 'max', b.unit), check('agent median', a.p50, b.max_with_agent, 'max', b.unit)],
    })
    expect(e.pass, `P-UI-5: ${JSON.stringify(e.values)}`).toBe(true)
    await kea.assertUnfocused()
  })
})
