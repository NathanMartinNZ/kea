// What tests import from fake-agent: how to launch it, and the argv hash a test compares with the adapter's (E-SES-1).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Flavour } from './argv.ts'

export { argvHash, argvHashLine, type Flavour } from './argv.ts'
export { DEFAULT_SCENARIOS, parseScenario, type Scenario, ScenarioError, validateScenario } from './scenario.ts'
export { castSchedule, parseCast } from './cassette.ts'
export { FAKE_CLAUDE_VERSION, FLAVOURS } from './argv.ts'

/** Absolute path of the entry point (run with Node; types are stripped). */
export const FAKE_AGENT_MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))

export interface FakeAgentLaunch {
  scenario?: string
  fakeHome?: string
  log?: string
  /** Node binary; default `process.execPath` (in Electron, pass a real node). */
  node?: string
}

/**
 * argv for a fake-agent run: `{file: node, args: [main.ts, --as, flavour, …fake-agent options, …agentArgs]}`. The argv
 * hash the agent prints is over `agentArgs` only.
 */
export function fakeAgentCommand(flavour: Flavour, agentArgs: readonly string[], o: FakeAgentLaunch = {}): { file: string; args: string[] } {
  const opts: string[] = ['--as', flavour]
  if (o.scenario) opts.push('--scenario', o.scenario)
  if (o.fakeHome) opts.push('--fake-home', o.fakeHome)
  if (o.log) opts.push('--log', o.log)
  return { file: o.node ?? process.execPath, args: [FAKE_AGENT_MAIN, ...opts, ...agentArgs] }
}

/** `s` as one single-quoted sh word. */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/**
 * A stand-in CLI on PATH for the suites: `<dir>/<name>` (default `claude` / `cmd`), an executable sh script that runs
 * fake-agent with `--as <flavour>` and passes Kea's argv through untouched (`"$@"`), so detection, launch and resume
 * run against it exactly as against the real binary. `env` is exported first (fake-agent's own options have env forms:
 * FAKE_AGENT_SCENARIO, FAKE_AGENT_HOME, FAKE_AGENT_LOG, FAKE_AGENT_CLI_VERSION, FAKE_AGENT_LOGGED_IN). Returns the
 * script's path.
 */
export function writeAgentShim(dir: string, flavour: Flavour, o: { node?: string; name?: string; env?: Record<string, string> } = {}): string {
  const file = join(dir, o.name ?? (flavour === 'claude' ? 'claude' : 'cmd'))
  const exports = Object.entries(o.env ?? {}).map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`bad env name ${k}`)
    return `export ${k}=${shQuote(v)}\n`
  })
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, `#!/bin/sh\n${exports.join('')}exec ${shQuote(o.node ?? process.execPath)} ${shQuote(FAKE_AGENT_MAIN)} --as ${flavour} "$@"\n`, { mode: 0o755 })
  return file
}
