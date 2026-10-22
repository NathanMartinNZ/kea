// Leak cycles of Command Code sessions against the real app (tests/support/app.ts), measured with
// tests/support/app-leak.ts. The agent is tools/fake-agent as Command Code (the run's `cmd` shim, never the real one):
// at 1.79.2 it loads the built app's kea-mod.ts, whose events reach core through real `kea-helper hook` processes; at
// 1.78.0 it loads no mod, so the session launches named and Kea follows its terminal alone (tier 3). A cycle is
// a session's whole life: started from the composer, a turn held at its first tool call until the test opens a gate,
// Stop, Resume once, the resumed agent's own exit, Delete.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Page } from '@playwright/test'
import { L } from '@kea/protocol'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { harnessUserHome, processInfo, runAppProcesses, stillSame } from '../../tools/perf/src/launch.ts'
import { KeaRun, PROMPT, STEP_MS, until, type Kea } from '../support/app.ts'
import { expectBytesFlat, expectCountsFlat, RendererProbe, runCycles } from '../support/app-leak.ts'
import { AGENT_MARK, agentEvents, gate } from '../support/app-fake-agent.ts'
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
/** Two sets of cycles, each its own launch: about 15 s a cycle, twelve a set. */
const ROW_MS = 15 * 60_000
const FINISHED = ['idle', 'unread']

const frame = (...lines: string[]) => `frame: ${JSON.stringify([AGENT_MARK, '', '> {{prompt}}', '', ...lines])}`

/**
 * The turn: a batch of two calls queued, the first held until the gate opens (the person's answer), then both run. The
 * agent sleeps through the mod's permission wait before it waits at the gate: the gate's read blocks the agent's one
 * thread, and the mod's timer runs on that thread (armed at the first call, so it fires before the sleep, whose end is
 * later). Its output flows for twice tier 3's L.tier3WorkingAfterMs first: without its mod, that is all that starts a
 * turn.
 */
const turn = (answer: string) => `steps:
  - hook: run_start
  - hook: turn_start
  - ${frame('✶ Working…')}
  - loop:
      times: ${Math.ceil((2 * L.tier3WorkingAfterMs) / 100)}
      steps:
        - print: "."
        - sleep: 100
  - hook: { event: tool_queued, tool: shell_command, input: { command: "npm test", description: "Run the tests" } }
  - hook: { event: tool_queued, tool: read_file, input: { path: "README.md" } }
  - ${frame('shell_command(npm test)  Allow? (y/n)')}
  - sleep: ${L.ccPermissionQueuedMs}
  - ${answer}
  - hook: { event: tool_running, tool: shell_command }
  - hook: { event: tool_completed, tool: shell_command }
  - hook: { event: tool_running, tool: read_file }
  - hook: { event: tool_completed, tool: read_file }
  - hook: turn_end
  - hook: { event: run_end, fields: { result: { finalText: "Done." } } }
  - ${frame('⏺ Done.')}
`
/** The resumed agent: it draws its screen and exits by itself. */
const RESUMED = `afterSteps: exit
steps:
  - ${frame('RESUMED {{sessionId}}')}
  - sleep: 300
`

describe('Command Code session cycles (app)', () => {
  it(
    'L-AGT-4 · Command Code sessions in cycles, each started from the composer, a turn with a batch of two tool calls held past the mod’s permission wait and answered, stopped, resumed once, exiting by itself and deleted, ×12 with its mod (1.79.2), then ×12 without (1.78.0, the named fallback at tier 3): after each cycle core’s agent rows are back where they were (never a transcript watch for Command Code), one mod folder of one build, and no holder, fake agent or `kea-helper` of the session left; every count equal; heaps within budget',
    async () => {
      for (const set of [
        { version: '1.79.2', mods: true },
        { version: '1.78.0', mods: false },
      ]) {
        const run = KeaRun.create()
        runs.push(run)
        fs.writeFileSync(path.join(run.home, 'settings.json'), `${JSON.stringify({ general: { defaultAgent: 'commandcode' } }, null, 2)}\n`)
        const answer = gate(run, 'l-agt-4-answer')
        const log = path.join(run.home, 'l-agt-4.log')
        /** The run's `cmd` with `scenario` (fake-agent reads it at each start), its files under the run's own HOME. */
        const shim = (name: string, scenario: string): void => {
          const file = path.join(run.home, `${name}.yaml`)
          fs.writeFileSync(file, `version: 1\nname: ${name}\n${scenario.trimEnd()}\n`)
          writeAgentShim(run.agentBin, 'commandcode', { env: { FAKE_AGENT_HOME: harnessUserHome(run.home), FAKE_AGENT_SCENARIO: file, FAKE_AGENT_LOG: log, FAKE_AGENT_CLI_VERSION: set.version } })
        }
        shim('turn', turn(answer.step))
        const kea: Kea = await run.launch()
        await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
        await addProject(kea, demoRepo(run).root)
        const page = await kea.page()
        const renderer = await RendererProbe.open(kea)
        probes.push(renderer)
        const agentsRows = async (): Promise<Record<string, number>> => (await kea.debug<Record<string, Record<string, number>>>('core', 'kit'))['core.agents'] ?? {}
        const modFolders = (): string[] => {
          const dir = path.join(run.home, 'bin', 'agents')
          return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('commandcode-')) : []
        }
        // what is left once a session has gone: the first shell's holder and what runs under it (Kea's own processes aside)
        const holderTrees = (): number[] => {
          const app = new Set(runAppProcesses(run.home).map((p) => p.pid))
          return run.leftovers().filter((p) => !app.has(p.pid)).map((p) => p.pid)
        }
        const rest = new Set(holderTrees())
        const before = await agentsRows()
        const folders: number[] = []

        const cycle = async (i: number): Promise<void> => {
          shim('turn', turn(answer.step))
          const id = await start(kea, page, `cycle ${i} of ${set.version}`)
          await waitLive(kea, id)
          if (set.mods) {
            // the mod's turn, then the call queued with nothing run for its wait
            await waitRow(kea, id, 'working (the mod’s run_start)', (r) => r.status === 'working')
            await waitRow(kea, id, 'needs you after the mod’s permission wait', (r) => r.status === 'needsYou', L.ccPermissionQueuedMs * 3)
          } else {
            // tier 3: its screen drawn, then quiet; no event names the prompt, so it reads as a turn that ended
            await kea.waitScreen('its question', (s) => s.includes('Allow? (y/n)'))
            await waitRow(kea, id, 'quiet: finished, as far as the terminal says', (r) => FINISHED.includes(r.status), L.tier3ReadyAfterMs + STEP_MS)
          }
          const live = await agentsRows()
          expect([live.watches, live.transcriptWatches], 'watches for a Command Code session (none, ever)').toEqual([0, 0])
          const holders = run.holders().filter((h) => h.sessionId === id)
          expect(holders.length, 'the session’s Agent terminal').toBeGreaterThan(0)
          // answered: both calls run and the turn ends
          shim('resumed', RESUMED)
          await answer.open()
          await kea.waitScreen('the turn done', (s) => s.includes('Done.'))
          await waitRow(kea, id, 'finished', (r) => FINISHED.includes(r.status))
          // Stop, then Resume once: the resumed agent draws its screen and exits by itself
          expect(await runCommand(kea, 'session.stop'), 'Stop Agent').toBe(true)
          await waitRow(kea, id, 'detached after Stop', (r) => r.lifecycle === 'detached')
          expect(await runCommand(kea, 'session.resume'), 'Resume').toBe(true)
          await kea.waitScreen('the resumed agent', (s) => s.includes('RESUMED'))
          await waitRow(kea, id, 'ended again: the resumed agent exited', (r) => r.lifecycle !== 'live')
          const starts = agentEvents(log).filter((e) => e.t === 'start').slice(-2) as unknown as { pid: number; argv: string[] }[]
          expect(starts.map((s) => s.argv.includes('--resume')), 'started, then resumed').toEqual([false, true])
          expect(starts[0]!.argv.includes('--mod'), 'its mod passed (1.79.2) or the named fallback (1.78.0)').toBe(set.mods)
          const agentProcs = starts.map((s) => processInfo(s.pid)).filter((p) => p !== null)
          // the session goes: deleted, its worktree and its terminals with it
          await sessionMenu(kea, id, 'session.delete')
          await page.getByRole('alertdialog', { name: 'Delete session' }).getByRole('button', { name: 'Delete', exact: true }).click()
          await until('the deleted row gone', async () => (await sessionRow(page, id).count()) === 0 || undefined)
          // nothing of it left running: its holders, the fake agents it started, any `kea-helper` under them
          await until('the session’s processes gone', () => (holderTrees().every((pid) => rest.has(pid)) && holders.every((h) => !run.holderAlive(h)) && agentProcs.every((p) => !stillSame(p))) || undefined)
          // core's agent rows where they were before the first cycle
          await until('core’s agent rows back where they were', async () => JSON.stringify(await agentsRows()) === JSON.stringify(before) || undefined).catch(async (e: Error) => {
            throw new Error(`${e.message}: ${JSON.stringify(await agentsRows())}, before ${JSON.stringify(before)}`)
          })
          folders.push(modFolders().length)
        }

        const leak = await runCycles({
          kea,
          renderer,
          batch: 1,
          cycle,
        })
        expect(leak.cycles.at(-1)).toBe(10)
        expect(new Set(folders), `mod folders under bin/agents after each cycle: ${folders}`).toEqual(new Set([set.mods ? 1 : modFolders().length]))
        expect(modFolders().length, 'at most one mod folder').toBeLessThanOrEqual(1)
        expectCountsFlat(leak, () => true)
        await expectBytesFlat(kea, renderer, leak, HEAPS, `L-AGT-4 (${set.version})`)
        probes.splice(probes.indexOf(renderer), 1)
        await renderer.close()
        runs.splice(runs.indexOf(run), 1)
        await run.dispose()
      }
    },
    ROW_MS,
  )
})

/** ⌘N, wait for the composer to offer Command Code (detection has listed it), the prompt, ⌘↵; the new session's id. */
async function start(kea: Kea, page: Page, prompt: string): Promise<string> {
  const before = new Set(await sessionIds(page))
  await page.keyboard.press(sysKey('Meta+n'))
  const composer = page.getByRole('region', { name: 'New session' })
  await until('the composer offers Command Code', async () => (await composer.getByRole('group', { name: 'Agent options' }).getByRole('button').first().getAttribute('aria-label').catch(() => null)) === 'Agent: Command Code' || undefined)
  const box = promptBox(page)
  await until('the prompt holding the keyboard', () => box.evaluate((e) => e === document.activeElement).catch(() => false) || undefined)
  await page.keyboard.insertText(prompt)
  await until('Start enabled', () => page.getByRole('button', { name: 'Start', exact: true }).isEnabled().catch(() => false) || undefined)
  await page.keyboard.press(sysKey('Meta+Enter'))
  return until('the new session’s row', async () => (await sessionIds(page)).find((x) => !before.has(x)))
}
