// Leak cycles of Antigravity CLI sessions against the real app (tests/support/app.ts), measured with
// tests/support/app-leak.ts. The agent is tools/fake-agent as Antigravity CLI (the run's `agy` shim, never the real
// one): each session receives `--settings=<json>` pointing `statusLine.command` at `kea-helper feed antigravity`, whose
// projected status-line snapshots reach core over `core.sock`. A cycle is a session's whole life: started from the
// composer, a turn driving a status-line feed burst (`working` → `tool_confirmation` → `tool_confirmation_clear` →
// `reviewing` → `title` / `meta` / `quota` → `/clear` → `working` → `idle`), Stop, Resume once (against the
// post-`/clear` conversation id), the resumed agent's own exit, Delete.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Page } from '@playwright/test'
import { processInfo, runAppProcesses, stillSame } from '../../tools/perf/src/launch.ts'
import { median } from '../../tools/perf/src/stats.ts'
import { footprint, KeaRun, PROMPT, until, type Kea } from '../support/app.ts'
import { expectBytesFlat, expectCountsFlat, RendererProbe, runCycles } from '../support/app-leak.ts'
import { AGENT_MARK, agentEvents, fakeAntigravity, gate } from '../support/app-fake-agent.ts'
import { runCommand } from '../support/app-server.ts'
import { addProject, demoRepo, promptBox, sessionIds, sessionMenu, sessionRow, waitLive, waitRow } from '../support/app-sessions.ts'
import { sysKey } from '../support/keys.ts'

const runs: KeaRun[] = []
const probes: RendererProbe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

const HEAPS = ['renderer.heap', 'core.heap', 'ptyhost.heap', 'main.heap']
/** Twelve cycles (two warm-up, ten measured) of full session launch, feed burst, stop, resume and delete. */
const ROW_MS = 15 * 60_000
const FINISHED = ['idle', 'unread']

const QUOTA = {
  'gemini-5h': { remaining_fraction: 0.75, reset_time: '2099-01-01T00:00:00Z', disabled: false },
  'gemini-weekly': { remaining_fraction: 0.5, reset_time: '2099-01-07T00:00:00Z', disabled: false },
}

const frame = (...lines: string[]) => `frame: ${JSON.stringify([AGENT_MARK, '', '> {{prompt}}', '', ...lines])}`

/**
 * The turn: starts working (creating the first conversation's transcript so core arms a transcript watcher), pauses at
 * tool confirmation until the first gate opens, clears confirmation and enters reviewing until the second gate opens,
 * emits title/meta/quota updates, rotates the conversation via `/clear` (switching the transcript path and conversation
 * id), runs a post-`/clear` working step, and finishes idle.
 */
const turn = (confirm: string, review: string) => `steps:
  - transcript: { record: user, text: "{{prompt}}" }
  - transcript: { record: running }
  - hook: working
  - ${frame('✶ Working…')}
  - hook: { event: tool_use, tool: run_command, input: { command: "npm test" } }
  - hook: tool_confirmation
  - ${frame('run_command(npm test)  Confirm? (y/n)')}
  - ${confirm}
  - hook: tool_confirmation_clear
  - hook: reviewing
  - ${frame('Review requested')}
  - ${review}
  - hook: { event: title, fields: { conversation_title: "Before clear" } }
  - hook: { event: meta, fields: { model: "claude-sonnet-4-6-high", cycle_mode: "auto", context_window: { used_percentage: 35 }, cost: { total_usd: 0.12 }, subagents: [{ status: "running" }, { status: "completed" }] } }
  - hook: clear
  - transcript: { record: user, text: "After clear: {{prompt}}" }
  - transcript: { record: running }
  - hook: { event: working, fields: { cycle_mode: "default", subagents: [{ status: "completed" }] } }
  - transcript: { record: assistant, text: "Done." }
  - hook: { event: idle, fields: { conversation_title: "Cycle done" } }
  - ${frame('⏺ Done.')}
`

/** The resumed agent: draws its screen with the resumed conversation id and exits by itself. */
const RESUMED = `afterSteps: exit
steps:
  - ${frame('RESUMED {{sessionId}}')}
  - sleep: 300
`

describe('Antigravity CLI session cycles (app)', () => {
  it(
    'L-AGT-5 · Antigravity CLI sessions in cycles, each started from the composer, a turn driving a status-line feed burst (working → tool_confirmation → tool_confirmation_clear → reviewing → title/meta/quota → /clear → working → idle), stopped, resumed once against the post-/clear conversation id, exiting by itself and deleted, ×12: after each cycle core’s session and agent rows return to baseline (no live session, no signals instance, no transcript watcher, no timer or socket), and no holder, fake agent or `kea-helper` of the session is left; every count equal; heaps and core footprint within budget',
    async () => {
      const run = KeaRun.create()
      runs.push(run)
      fs.writeFileSync(
        path.join(run.home, 'settings.json'),
        `${JSON.stringify({ general: { defaultAgent: 'antigravity' }, notifications: { needsYou: false, finished: false, failed: false } }, null, 2)}\n`,
      )
      const confirm = gate(run, 'l-agt-5-confirm')
      const review = gate(run, 'l-agt-5-review')
      const log = path.join(run.home, 'l-agt-5.log')
      const shim = (name: string, scenario: string): void => {
        fakeAntigravity(run, name, scenario, { quota: QUOTA, env: { FAKE_AGENT_LOG: log } })
      }
      shim('turn', turn(confirm.step, review.step))
      const kea: Kea = await run.launch()
      await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
      await addProject(kea, demoRepo(run).root)
      const page = await kea.page()
      const renderer = await RendererProbe.open(kea)
      probes.push(renderer)
      const coreProc = await kea.pid('core')
      const median3 = async (f: () => Promise<number>): Promise<number> => median([await f(), await f(), await f()])
      const coreKit = async (): Promise<Record<string, Record<string, number>>> => await kea.debug<Record<string, Record<string, number>>>('core', 'kit')
      const agentsRows = async (): Promise<Record<string, number>> => (await coreKit())['core.agents'] ?? {}
      const sessionsRows = async (): Promise<Record<string, number>> => (await coreKit())['core.sessions'] ?? {}
      // What remains once a session has gone: the first shell's holder and what runs under it (Kea's own processes aside).
      const holderTrees = (): number[] => {
        const app = new Set(runAppProcesses(run.home).map((p) => p.pid))
        return run.leftovers().filter((p) => !app.has(p.pid)).map((p) => p.pid)
      }
      const rest = new Set(holderTrees())
      const beforeAgents = await agentsRows()
      const beforeSessions = await sessionsRows()
      expect(beforeAgents, 'no live agent session before the first cycle').toMatchObject({
        live: 0,
        pending: 0,
        watches: 0,
        transcriptWatches: 0,
        timers: 0,
        connections: 0,
        envelopeIds: 0,
      })
      expect(beforeSessions.sessions, 'no session before the first cycle').toBe(0)

      const cycle = async (i: number): Promise<void> => {
        shim('turn', turn(confirm.step, review.step))
        const id = await start(kea, page, `cycle ${i}`)
        await waitLive(kea, id)
        await waitRow(kea, id, 'needs you at tool confirmation', (r) => r.status === 'needsYou')
        const duringTurn = await agentsRows()
        expect([duringTurn.live, duringTurn.watches, duringTurn.transcriptWatches], 'live Antigravity signals and transcript watch during an active turn').toEqual([1, 1, 1])
        const holders = run.holders().filter((h) => h.sessionId === id)
        expect(holders.length, 'the session’s Agent terminal').toBeGreaterThan(0)

        await confirm.open()
        await kea.waitScreen('the reviewing prompt', (s) => s.includes('Review requested'))
        await waitRow(kea, id, 'needs you at reviewing', (r) => r.status === 'needsYou')

        shim('resumed', RESUMED)
        await review.open()
        await kea.waitScreen('the turn done', (s) => s.includes('Done.'))
        await waitRow(kea, id, 'finished after /clear', (r) => FINISHED.includes(r.status))

        // Stop, then Resume once: the resumed agent receives the post-/clear conversation id, draws its screen and exits.
        expect(await runCommand(kea, 'session.stop'), 'Stop Agent').toBe(true)
        await waitRow(kea, id, 'detached after Stop', (r) => r.lifecycle === 'detached')
        expect(await runCommand(kea, 'session.resume'), 'Resume').toBe(true)
        await kea.waitScreen('the resumed agent', (s) => s.includes('RESUMED'))
        await waitRow(kea, id, 'ended again: the resumed agent exited', (r) => r.lifecycle !== 'live')
        const starts = agentEvents(log).filter((e) => e.t === 'start').slice(-2) as unknown as { pid: number; sessionId: string; argv: string[] }[]
        expect(starts.map((s) => s.argv.some((a) => a.startsWith('--conversation='))), 'started, then resumed with --conversation').toEqual([false, true])
        expect(starts.every((s) => s.argv.some((a) => a.startsWith('--settings='))), 'session --settings passed on start and resume').toBe(true)
        expect(starts[1]!.sessionId, 'resumed the post-/clear conversation id').not.toBe(starts[0]!.sessionId)
        const agentProcs = starts.map((s) => processInfo(s.pid)).filter((p) => p !== null)

        // Delete the session: its worktree, its terminals and its per-session signal state go with it.
        await sessionMenu(kea, id, 'session.delete')
        await page.getByRole('alertdialog', { name: 'Delete session' }).getByRole('button', { name: 'Delete', exact: true }).click()
        await until('the deleted row gone', async () => (await sessionRow(page, id).count()) === 0 || undefined)
        await until('the session’s processes gone', () => (holderTrees().every((pid) => rest.has(pid)) && holders.every((h) => !run.holderAlive(h)) && agentProcs.every((p) => !stillSame(p))) || undefined)
        await until('core’s agent and session rows back where they were', async () => {
          const [a, s] = [await agentsRows(), await sessionsRows()]
          return (JSON.stringify(a) === JSON.stringify(beforeAgents) && JSON.stringify(s) === JSON.stringify(beforeSessions)) || undefined
        }).catch(async (e: Error) => {
          throw new Error(`${e.message}: agents=${JSON.stringify(await agentsRows())} (before ${JSON.stringify(beforeAgents)}), sessions=${JSON.stringify(await sessionsRows())} (before ${JSON.stringify(beforeSessions)})`)
        })
      }

      const leak = await runCycles({
        kea,
        renderer,
        batch: 1,
        snapshots: false,
        cycle,
        extra: async () => ({
          counts: {},
          bytes: { 'core.footprint': await median3(() => footprint(coreProc)) },
        }),
      })
      expect(leak.cycles.at(-1)).toBe(10)
      expectCountsFlat(leak, () => true)
      await expectBytesFlat(kea, renderer, leak, [...HEAPS, 'core.footprint'], 'L-AGT-5')
    },
    ROW_MS,
  )
})

/** ⌘N, wait for the composer to offer Antigravity CLI (detection has listed it), the prompt, ⌘↵; the new session's id. */
async function start(kea: Kea, page: Page, prompt: string): Promise<string> {
  const before = new Set(await sessionIds(page))
  await page.keyboard.press(sysKey('Meta+n'))
  const composer = page.getByRole('region', { name: 'New session' })
  await until('the composer offers Antigravity CLI', async () => (await composer.getByRole('group', { name: 'Agent options' }).getByRole('button').first().getAttribute('aria-label').catch(() => null)) === 'Agent: Antigravity CLI' || undefined)
  const box = promptBox(page)
  await until('the prompt holding the keyboard', () => box.evaluate((e) => e === document.activeElement).catch(() => false) || undefined)
  await page.keyboard.insertText(prompt)
  await until('Start enabled', () => page.getByRole('button', { name: 'Start', exact: true }).isEnabled().catch(() => false) || undefined)
  await page.keyboard.press(sysKey('Meta+Enter'))
  return until('the new session’s row', async () => (await sessionIds(page)).find((x) => !before.has(x)))
}
