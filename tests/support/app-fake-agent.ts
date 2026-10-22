// tools/fake-agent as Claude Code in the app-level suites: `KeaRun` already puts the fake agent's `claude` shim first
// on PATH, with its home and CLAUDE_CONFIG_DIR inside the KEA_HOME; these helpers make it the default agent, give each
// session its own scenario and event log, and hold an agent at a gate the test opens. The real CLI is never run.
//
// A gate is a FIFO the scenario reads as a cassette (`cassette: { file: <gate>, speed: 0 }`): the agent blocks until the
// test writes an empty asciicast into it, then goes on. fake-agent has no step that waits on the outside world, and a
// session not on screen gets no keys.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { until, type Kea, type KeaRun } from './app.ts'
import { paneSession, selectSession, startSession, tabOf, waitLive } from './app-sessions.ts'

/** What every scenario these helpers write draws first (`frame` lines start with it): how a test finds the agent on screen. */
export const AGENT_MARK = '✻ fake-agent'

/** A gate's content: an asciicast with nothing to replay (the `cassette` step reads it whole, then goes on). */
const GATE_CAST = '{"version": 2, "width": 80, "height": 24}\n'

export interface FakeClaude {
  /** The scenario file. */
  file: string
  /** The agent's event log (tools/fake-agent README "Event log"). */
  log: string
}

/** Make Claude Code (the fake agent) the composer's default agent: before Kea launches, which reads it then. */
export function claudeByDefault(run: KeaRun): void {
  fs.writeFileSync(path.join(run.home, 'settings.json'), `${JSON.stringify({ general: { defaultAgent: 'claude' } }, null, 2)}\n`)
}

/**
 * Give the fake-agent `claude` sessions started from now on `scenario` (YAML after `version: 1`: `steps:` and the other
 * top-level keys) and an event log of their own (`claudeByDefault` before the launch makes Claude Code the default). The
 * shim is read at each launch, so a later call gives the next sessions another scenario. `hooksOff`: the agent's user
 * settings say `disableAllHooks: true` (a config dir of its own; the run's, where Kea looks for its status file, is left
 * alone).
 */
export function fakeClaude(run: KeaRun, name: string, scenario: string, o: { hooksOff?: boolean } = {}): FakeClaude {
  const file = path.join(run.home, `${name}.yaml`)
  fs.writeFileSync(file, `version: 1\nname: ${name}\n${scenario.trimEnd()}\n`)
  const log = path.join(run.home, `${name}.log`)
  const env: Record<string, string> = { FAKE_AGENT_SCENARIO: file, FAKE_AGENT_LOG: log }
  if (o.hooksOff) {
    const config = path.join(run.home, `${name}-config`)
    fs.mkdirSync(config, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(config, 'settings.json'), `${JSON.stringify({ disableAllHooks: true })}\n`)
    env.CLAUDE_CONFIG_DIR = config
  }
  writeAgentShim(run.agentBin, 'claude', { env })
  return { file, log }
}

/** Every event the fake agents logged to `log` so far. */
export function agentEvents(log: string): ({ t: string } & Record<string, unknown>)[] {
  if (!fs.existsSync(log)) return []
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { t: string } & Record<string, unknown>)
}

/** The hook events the agents of `log` ran hooks for so far, in order (an event with no hook configured is left out). */
export function agentHooks(log: string): string[] {
  return agentEvents(log)
    .filter((e) => e.t === 'hook' && Array.isArray(e.runs) && e.runs.length > 0)
    .map((e) => String(e.event))
}

/**
 * Start one session from the composer (`startSession`) whose agent runs `scenario`, and wait until it is live and its
 * agent has read the scenario (so the next call may change the shim).
 */
export async function startFakeSession(
  kea: Kea,
  name: string,
  prompt: string,
  scenario: string,
  o: { background?: boolean; open?: boolean; hooksOff?: boolean } = {},
): Promise<{ id: string } & FakeClaude> {
  const agent = fakeClaude(kea.run, name, scenario, { hooksOff: o.hooksOff })
  const id = await startSession(kea, prompt, { background: o.background, open: o.open })
  await waitLive(kea, id)
  await until(`the fake agent of ${name} started`, () => agentEvents(agent.log).some((e) => e.t === 'start') || undefined)
  return { id, ...agent }
}

/**
 * A gate in the run's home (a FIFO): the scenario line that waits at it, and `open()`, which lets the agent on once it
 * waits there and resolves with the wall time (ms) the gate opened. A scenario may wait at the same gate again (each
 * `cassette` step opens the FIFO afresh).
 */
export function gate(run: KeaRun, name: string): { step: string; open(): Promise<number> } {
  const file = path.join(run.home, `${name}.gate`)
  execFileSync('mkfifo', [file])
  const open = async (): Promise<number> => {
    // until the agent waits at the gate, a non-blocking open fails (ENXIO); then one write lets it on
    const fd = await until(`the agent waiting at ${name}`, () => {
      try {
        return fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENXIO') return undefined
        throw e
      }
    })
    try {
      const at = Date.now()
      fs.writeSync(fd, GATE_CAST)
      return at
    } finally {
      fs.closeSync(fd)
    }
  }
  return { step: `cassette: { file: ${JSON.stringify(file)}, speed: 0 }`, open }
}

/** Show a session and wait until its Agent tab is on screen with the fake agent drawn; resolves with its ptyId. */
export async function fakeAgentTerminal(kea: Kea, id: string): Promise<string> {
  if ((await paneSession(await kea.page())) !== id) await selectSession(kea, id)
  const pty = await tabOf(kea, 'agent')
  await until('the Agent terminal on screen', async () => (await kea.shown()) === pty || undefined)
  await kea.waitScreen('the fake agent', (s) => s.includes(AGENT_MARK))
  return pty
}
