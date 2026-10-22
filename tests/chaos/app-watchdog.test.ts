// The memory watchdog's four actions against the real app, without a byte being allocated: the test says what a process
// weighs in the watchdog's next footprint sample and how long the person has been idle (`__keaTest.watchdogFeed`,
// `watchdogIdle`; tests/support/app-watchdog.ts), and the watchdog does the rest as it would in the field: its triggers
// logged, its `resources.ndjson` line written with every process's report, then core or ptyhost restarted through the
// Supervisor, the window reloaded, WebGL reset. Real allocations past a hard limit are tested in
// tests/memory/app-watchdog.test.ts.
//
// The workload is one live session: its agent is tools/fake-agent as Claude Code, mid-turn at a gate the test opens; a
// shell tab runs `counter`; another is idle, for typing; its dev server answers on the session's port. Every action
// must leave all of it as it was: the holders and what runs under them, the counter's output without a gap at the
// seam, the agent's status, and the agent's next hooks reaching the session once the gate opens.

import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { counterCommand, counterNumbers, KeaRun, STEP_MS, until, type Kea } from '../support/app.ts'
import { holdersUnharmed, lastOnScreen, restartDelays, ringContinuity, seamContinuous, watchTerminals } from '../support/app-chaos.ts'
import { agentEvents, claudeByDefault, fakeAgentTerminal, gate, startFakeSession } from '../support/app-fake-agent.ts'
import { clipboard, commitFiles, recordClipboard, runCommand, serverAddress, serverAnswer, serverScript, waitServer } from '../support/app-server.ts'
import { addProject, demoRepo, selectSession, waitRow } from '../support/app-sessions.ts'
import { actionTimes, brief, loggedTriggers, watchdogFeed, watchdogIdle, watchdogLines, type Trigger } from '../support/app-watchdog.ts'
import { sysKey } from '../support/keys.ts'

/** Counter lines per second (tests/support/app-chaos.ts). */
const RATE = 4
const IDLE: number = L.watchdogIdleMs
/** A launch, a session with its tabs and its dev server, then each action and its recovery: more steps than the suite allows a test by default. */
const ROW_MS = 9 * STEP_MS
/** One byte over each hard limit: what the test says the process weighs. */
const OVER = { core: L.watchdogHardCoreBytes + 1, ptyhost: L.watchdogHardPtyhostBytes + 1, renderer: L.watchdogHardRendererBytes + 1, gpu: L.watchdogHardGpuBytes + 1 }

const runs: KeaRun[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose()
})

interface Workload {
  run: KeaRun
  kea: Kea
  /** The session. */
  id: string
  /** Its agent's event log, and the gate its turn waits at. */
  log: string
  finishTurn(): Promise<number>
  /** The shell tab running `counter`, and the idle one. */
  counter: string
  shell: string
  /** The dev server's port and what it answers (its pid is in the answer). */
  port: number
  answer: string
  /** With `other`: a second session, started first, its agent idle at its prompt. */
  other: string | null
}

/**
 * The session of this file's header, its counter tab left on screen. `other`: a second session started before it, so
 * its Agent terminal can be a warm one (the Agent terminals of the sessions viewed last keep a WebGL context).
 */
async function workload(name: string, o: { other?: boolean } = {}): Promise<Workload> {
  const run = KeaRun.create()
  runs.push(run)
  run.expectWatchdog()
  claudeByDefault(run)
  const repo = demoRepo(run)
  commitFiles(repo.root, { 'start.sh': serverScript() }, { executable: true })
  const kea = await run.launch()
  await addProject(kea, repo.root)
  const other = o.other ? (await startFakeSession(kea, `${name}-other`, 'wait beside it', `steps:\n  - frame: ["✻ fake-agent", "", "> "]\n  - wait: { answer: z }\n`)).id : null
  if (other) await fakeAgentTerminal(kea, other)
  const turn = gate(run, `${name}-turn`)
  const agent = await startFakeSession(
    kea,
    name,
    'work through the watchdog',
    `steps:
  - hook: UserPromptSubmit
  - hook: { event: PreToolUse, tool: Bash, input: { command: "make" } }
  - frame: ["✻ fake-agent", "", "✶ Running make…"]
  - ${turn.step}
  - hook: { event: PostToolUse, tool: Bash, input: { command: "make" } }
  - hook: { event: Stop, fields: { last_assistant_message: "Built." } }
  - frame: ["✻ fake-agent", "", "⏺ Built.", "", "> "]
  - wait: { answer: z }
`,
  )
  await fakeAgentTerminal(kea, agent.id)
  await waitRow(kea, agent.id, 'working', (r) => r.lifecycle === 'live' && r.status === 'working')
  await waitServer(kea, 'stopped')
  await kea.press(sysKey('Meta+r'))
  await waitServer(kea, 'running')
  const { port } = await serverAddress(kea)
  const answer = await until('the dev server answers', async () => (await serverAnswer(port)) || undefined)
  const shell = await kea.newTab()
  const counter = await kea.newTab()
  await kea.enter(counterCommand(RATE))
  await kea.waitScreen('counter output', (s) => counterNumbers(s).length >= 2)
  return { run, kea, id: agent.id, log: agent.log, finishTurn: turn.open, counter, shell, port, answer, other }
}

/** The session is as it was: its agent still mid-turn and shown as working, its dev server the same process, answering. */
async function sessionIntact(w: Workload, after: string): Promise<void> {
  await waitRow(w.kea, w.id, `working, after ${after}`, (r) => r.lifecycle === 'live' && r.status === 'working')
  expect(agentEvents(w.log).filter((e) => e.t === 'ending' || e.t === 'exit'), `the agent did not end (${after})`).toEqual([])
  expect(await until(`the dev server answers after ${after}`, async () => (await serverAnswer(w.port)) || undefined), 'the same dev server').toBe(w.answer)
}

const hard = (process: keyof typeof OVER, pid: number | undefined, action: string, why?: string): Trigger => ({
  process,
  pid: pid as number,
  bytes: OVER[process],
  limit: 'hard',
  limitBytes: OVER[process] - 1,
  action,
  ...(why ? { why } : {}),
})

describe('the memory watchdog (app)', () => {
  it(
    'C-RES-13 · core, then ptyhost, over the hard limit: while the person is at the Mac nothing acts and one line says the action waits; once idle, each is restarted through the Supervisor at once, without backoff, and the window follows as after a crash; a second trigger inside the cool-down restarts nothing; the session’s holders, counter, agent mid-turn and dev server are untouched and the agent’s next hooks reach the row; every trigger is an error in main.log, a `resources.ndjson` line with every process’s report from before the action, and in Copy diagnostics; core and ptyhost run with V8’s heap capped at their hard limits, the restarted ones too',
    async () => {
      const w = await workload('c-res-13')
      const { run, kea } = w
      const page = await kea.page()
      await recordClipboard(page)
      const holders = run.holders()
      const before = await kea.processes()
      const seen = await lastOnScreen(kea)

      // ── the V8 heap limits took effect in core and ptyhost (Electron takes them only in `--js-flags=`) ──
      const heapLimit = async (name: 'core' | 'ptyhost'): Promise<number> => (await kea.debug<{ heap_size_limit: number }>(name, 'heap')).heap_size_limit
      for (const [name, hardBytes] of [['core', L.watchdogHardCoreBytes], ['ptyhost', L.watchdogHardPtyhostBytes]] as const) {
        const limit = await heapLimit(name)
        expect(limit, `${name}: the heap ends at its hard limit plus the young generation`).toBeGreaterThanOrEqual(hardBytes)
        expect(limit, `${name}: far under V8’s own default`).toBeLessThan(2 * hardBytes)
      }

      // ── not idle: over the hard limit, and nothing acts ──
      await watchdogIdle(kea, IDLE - 1)
      // (one interval, one line: the sample lists the processes in Electron's order)
      const byName = (ts: Trigger[]): Trigger[] => [...ts].sort((a, b) => a.process.localeCompare(b.process))
      expect(byName(await watchdogFeed(kea, { core: OVER.core, ptyhost: OVER.ptyhost }))).toEqual([hard('core', before.core?.pid, 'deferred', 'not idle'), hard('ptyhost', before.ptyhost?.pid, 'deferred', 'not idle')])
      expect(await watchdogFeed(kea, { core: OVER.core, ptyhost: OVER.ptyhost }), 'said once per episode').toEqual([])
      const waiting = await kea.processes()
      expect([waiting.core?.pid, waiting.ptyhost?.pid, waiting.renderer?.pid], 'nothing restarted or reloaded').toEqual([before.core?.pid, before.ptyhost?.pid, before.renderer?.pid])
      expect(restartDelays(kea, 'core').concat(restartDelays(kea, 'ptyhost'))).toEqual([])
      // back under the limits: both episodes end
      expect(await watchdogFeed(kea, {})).toEqual([])

      // ── idle: core is restarted through the Supervisor ──
      await watchdogIdle(kea, IDLE)
      expect(await watchdogFeed(kea, { core: OVER.core })).toEqual([hard('core', before.core?.pid, 'restart')])
      const core = await kea.restarted('core', before.core!)
      expect(restartDelays(kea, 'core').map((d) => d.reason), 'the Supervisor’s own restart: one exit, asked for').toEqual(['restart'])
      expect(restartDelays(kea, 'core')[0]!.delayMs, 'no backoff before the new core').toBeLessThan(L.supervisorBackoffMinMs)
      // the line was collected before the restart: it holds the report of the core that went
      const coreLine = watchdogLines(run).at(-1)!
      expect(coreLine.watchdog).toEqual([hard('core', before.core?.pid, 'restart')])
      expect(Object.keys(coreLine.reports).sort(), 'every process’s report').toEqual(['core', 'main', 'ptyhost', 'renderer'])
      expect(coreLine.missing).toEqual({})
      expect(coreLine.reports.core?.['core.sessions'], 'core’s own rows').toMatchObject({ sessions: 1 })
      expect(coreLine.footprint).toMatchObject({ pids: { core: before.core?.pid }, bytes: { core: OVER.core } })
      await sessionIntact(w, 'core’s restart')

      // ── a second trigger inside the cool-down: the new core is left alone ──
      expect(await watchdogFeed(kea, { core: OVER.core })).toEqual([hard('core', core.pid, 'deferred', 'cool-down')])
      expect(await watchdogFeed(kea, { core: OVER.core })).toEqual([])
      expect((await kea.processes()).core?.pid, 'core not restarted again').toBe(core.pid)
      expect(restartDelays(kea, 'core')).toHaveLength(1)

      // ── ptyhost: restarted, the holders re-adopted, the window reattached ──
      expect(await watchdogFeed(kea, { ptyhost: OVER.ptyhost })).toEqual([hard('ptyhost', before.ptyhost?.pid, 'restart')])
      await kea.restarted('ptyhost', before.ptyhost!)
      expect(restartDelays(kea, 'ptyhost').map((d) => d.reason)).toEqual(['restart'])
      const ptyhostLine = watchdogLines(run).at(-1)!
      expect(ptyhostLine.watchdog).toEqual([hard('ptyhost', before.ptyhost?.pid, 'restart')])
      const ptys = ptyhostLine.reports.ptyhost?.['ptyhost.ptys'] as { awake: number; parked: number }
      expect(ptys.awake + ptys.parked, 'the report of the ptyhost that went: every PTY of the run').toBe(holders.length)
      const after = await kea.processes()
      expect([after.core?.pid, after.renderer?.pid, after.main?.pid], 'core, the renderer and main untouched by ptyhost’s restart').toEqual([core.pid, before.renderer?.pid, before.main?.pid])
      // the counter came through both restarts without a gap, and typing works through the new ptyhost
      await seamContinuous(run, kea, w.counter, { before: seen })
      await kea.select(w.shell)
      await kea.echo('cres13')
      await sessionIntact(w, 'ptyhost’s restart')
      holdersUnharmed(run, holders)
      ringContinuity(run, w.counter)

      // the restarted ones run under the same heap limits
      expect([await heapLimit('core'), await heapLimit('ptyhost')].map((b, i) => b < 2 * [L.watchdogHardCoreBytes, L.watchdogHardPtyhostBytes][i]!)).toEqual([true, true])

      // ── the agent goes on: its next hooks reach the session through the new core ──
      await w.finishTurn()
      await waitRow(kea, w.id, 'the turn finished', (r) => r.lifecycle === 'live' && r.status !== 'working')

      // ── every trigger is in main.log at error level, and Copy diagnostics shows them ──
      expect(brief(byName(loggedTriggers(kea).slice(0, 2))).concat(brief(loggedTriggers(kea).slice(2)))).toEqual(['core hard:deferred (not idle)', 'ptyhost hard:deferred (not idle)', 'core hard:restart', 'core hard:deferred (cool-down)', 'ptyhost hard:restart'])
      expect(watchdogLines(run).map((l) => brief(byName(l.watchdog)))).toEqual([['core hard:deferred (not idle)', 'ptyhost hard:deferred (not idle)'], ['core hard:restart'], ['core hard:deferred (cool-down)'], ['ptyhost hard:restart']])
      expect(actionTimes(kea).map((a) => [a.process, a.action])).toEqual([
        ['core', 'restart'],
        ['ptyhost', 'restart'],
      ])
      expect(await runCommand(kea, 'app.copyDiagnostics')).toBe(true)
      const copied = await until('the diagnostics text', async () => (await clipboard(page))[0])
      expect(copied).toMatch(/ main error watchdog: limit exceeded process="?core"? .*action="?restart"?/)
      expect(copied).toMatch(/ main error watchdog: limit exceeded process="?ptyhost"? .*action="?deferred"? why="?not idle"?/)
      await kea.assertUnfocused()
    },
    ROW_MS,
  )

  it(
    'C-RES-14 · a window’s renderer, then the GPU process, over the hard limit while idle: the window reloads and its terminals come back from ptyhost’s snapshots, the counter without a gap; every WebGL terminal’s atlas is cleared and its renderer made anew on a new context, no view rebuilt and no more contexts than before; a second trigger inside either cool-down does nothing; core, ptyhost, the holders, the agent mid-turn and the dev server are untouched; a soft limit is one line per episode and no action',
    async () => {
      const w = await workload('c-res-14', { other: true })
      const { run, kea } = w
      const holders = run.holders()
      const before = await kea.processes()
      const seen = await lastOnScreen(kea)
      await watchdogIdle(kea, IDLE)

      // ── a soft limit: one line for the episode, nothing done ──
      const soft: Trigger = { process: 'gpu', pid: before.gpu!.pid, bytes: L.watchdogSoftGpuBytes + 1, limit: 'soft', limitBytes: L.watchdogSoftGpuBytes, action: 'none' }
      expect(await watchdogFeed(kea, { gpu: soft.bytes })).toEqual([soft])
      expect(await watchdogFeed(kea, { gpu: soft.bytes + 1 }), 'the same episode').toEqual([])
      expect(await watchdogFeed(kea, {}), 'back under: the episode ends').toEqual([])
      expect(await watchdogFeed(kea, { gpu: soft.bytes })).toEqual([soft])
      expect(await watchdogFeed(kea, {})).toEqual([])
      expect(actionTimes(kea), 'a soft limit acts on nothing').toEqual([])

      // ── the renderer: the window reloads (a mark on the page tells a reload from none) ──
      const mark = async (): Promise<boolean> => (await kea.page()).evaluate(() => (window as unknown as { __cres14?: boolean }).__cres14 === true)
      const setMark = async (): Promise<void> => (await kea.page()).evaluate(() => void ((window as unknown as { __cres14?: boolean }).__cres14 = true))
      await setMark()
      expect(await watchdogFeed(kea, { renderer: OVER.renderer })).toEqual([hard('renderer', before.renderer?.pid, 'reload')])
      await kea.whenReady()
      expect(await mark(), 'the page is a new one').toBe(false)
      const reloadLine = watchdogLines(run).at(-1)!
      expect(reloadLine.watchdog).toEqual([hard('renderer', before.renderer?.pid, 'reload')])
      expect((reloadLine.reports.renderer?.['renderer.terminals'] as number) ?? 0, 'the report of the window before its reload').toBeGreaterThan(0)
      // its terminals are back from ptyhost's snapshots, as after any reload: the counter without a gap, typing works
      await seamContinuous(run, kea, w.counter, { before: seen })
      await kea.select(w.shell)
      await kea.echo('cres14a')
      const afterReload = await kea.processes()
      expect([afterReload.core?.pid, afterReload.ptyhost?.pid, afterReload.main?.pid], 'core, ptyhost and main untouched by the reload').toEqual([before.core?.pid, before.ptyhost?.pid, before.main?.pid])
      await sessionIntact(w, 'the reload')
      // inside the cool-down: still over, and no second reload; a new episode says it waits, and nothing reloads
      await setMark()
      const renderer = afterReload.renderer!.pid
      const again = await watchdogFeed(kea, { renderer: OVER.renderer })
      expect(again, 'the same process: nothing more; a new one: it waits').toEqual(renderer === before.renderer?.pid ? [] : [hard('renderer', renderer, 'deferred', 'cool-down')])
      expect(await watchdogFeed(kea, {})).toEqual([])
      expect(await watchdogFeed(kea, { renderer: OVER.renderer })).toEqual([hard('renderer', renderer, 'deferred', 'cool-down')])
      expect(await watchdogFeed(kea, {})).toEqual([])
      expect(await mark(), 'no reload inside the cool-down').toBe(true)

      // ── the GPU process: atlases cleared, WebGL renderers made anew; no view is rebuilt ──
      // the other session viewed, then this one again: its Agent terminal is a warm one, hidden with its WebGL context
      await selectSession(kea, w.other!)
      await fakeAgentTerminal(kea, w.other!)
      await selectSession(kea, w.id)
      await kea.select(w.counter)
      const page = await kea.page()
      const gl = (await kea.views()).filter((v) => v.webgl)
      expect(gl.map((v) => v.shown).sort(), 'WebGL on the terminal on screen and on a warm one').toEqual([false, true])
      const contexts = (): Promise<number> => page.evaluate(() => (window as unknown as { __keaPerf: { resources(): Record<string, number> } }).__keaPerf.resources()['renderer.webglContexts'] as number)
      const contextsBefore = await contexts()
      await page.evaluate((ids) => {
        const probe = (window as unknown as { __keaProbe: { glCanvas(id: string): HTMLCanvasElement | null } }).__keaProbe
        ;(window as unknown as { __cres14gl: Map<string, HTMLCanvasElement | null> }).__cres14gl = new Map(ids.map((id) => [id, probe.glCanvas(id)]))
      }, gl.map((v) => v.ptyId))
      const instances = (await kea.views()).map((v) => [v.ptyId, v.instance]).sort()
      const watch = await watchTerminals(kea)
      expect(await watchdogFeed(kea, { gpu: OVER.gpu })).toEqual([hard('gpu', before.gpu?.pid, 'resetWebgl')])
      await until('every WebGL terminal on a new context, its atlas cleared', async () => {
        const now = await kea.views()
        const fresh = await page.evaluate(() => {
          const probe = (window as unknown as { __keaProbe: { glCanvas(id: string): HTMLCanvasElement | null } }).__keaProbe
          return [...(window as unknown as { __cres14gl: Map<string, HTMLCanvasElement | null> }).__cres14gl].every(([id, old]) => {
            const c = probe.glCanvas(id)
            return c !== null && c !== old
          })
        })
        return (fresh && gl.every((g) => now.find((v) => v.ptyId === g.ptyId)?.webgl === true && now.find((v) => v.ptyId === g.ptyId)?.atlas.clears.watchdog === (g.atlas.clears.watchdog ?? 0) + 1)) || undefined
      })
      expect(await contexts(), 'as many WebGL contexts as before').toBe(contextsBefore)
      // it draws: the counter goes on on screen, through the new renderer
      const shown = await lastOnScreen(kea)
      await kea.waitScreen('the counter running on', (s) => counterNumbers(s).some((n) => n >= shown + 2))
      expect(await watch.stop(), 'no tab lost and no terminal view rebuilt').toEqual({ fewestTabs: await kea.tabCount(), rebuilt: [] })
      expect((await kea.views()).map((v) => [v.ptyId, v.instance]).sort(), 'the same views, each with the terminal it had').toEqual(instances)
      // inside the cool-down the same GPU process, still over, gets no second reset
      expect(await watchdogFeed(kea, { gpu: OVER.gpu })).toEqual([])
      expect((await kea.views()).filter((v) => v.webgl).map((v) => v.atlas.clears.watchdog), 'cleared once').toEqual(gl.map(() => 1))
      const after = await kea.processes()
      expect([after.core?.pid, after.ptyhost?.pid, after.renderer?.pid, after.gpu?.pid, after.main?.pid], 'no process restarted for the GPU').toEqual([before.core?.pid, before.ptyhost?.pid, renderer, before.gpu?.pid, before.main?.pid])
      expect(restartDelays(kea, 'core').concat(restartDelays(kea, 'ptyhost')), 'the Supervisor restarted nothing').toEqual([])
      await sessionIntact(w, 'the WebGL reset')
      holdersUnharmed(run, holders)
      ringContinuity(run, w.counter)

      // ── the agent goes on ──
      await w.finishTurn()
      await waitRow(kea, w.id, 'the turn finished', (r) => r.lifecycle === 'live' && r.status !== 'working')
      expect(actionTimes(kea).map((a) => [a.process, a.action])).toEqual([
        ['renderer', 'reload'],
        ['gpu', 'resetWebgl'],
      ])
      expect(brief(loggedTriggers(kea)).filter((t) => t.includes('hard:') && !t.includes('deferred'))).toEqual(['renderer hard:reload', 'gpu hard:resetWebgl'])
      await kea.assertUnfocused()
    },
    ROW_MS,
  )
})
