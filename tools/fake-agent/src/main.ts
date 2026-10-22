// fake-agent: a scriptable stand-in for an agent CLI. See README.md.
//
//   node tools/fake-agent/src/main.ts --as claude|commandcode [--scenario <file.yaml>] [--fake-home <dir>]
//        [--log <file.jsonl>] [agent flags…] [-- <prompt>]
//
// Exit codes: the scenario's (exit step, default 0); 1 for a bad agent flag or a failed step; 2 for a bad fake-agent
// option or scenario; 128+n after SIGTERM/SIGHUP/SIGINT (SessionEnd fires first).

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeAgent } from './agent.ts'
import { argvHash, ArgvError, FAKE_CLAUDE_VERSION, FAKE_COMMANDCODE_VERSION, type FakeOptions, parseArgv, type ParsedArgv, reportedPermissionMode } from './argv.ts'
import { ClaudeHooks, type HookSink, hooksDisabledBy, parseClaudeSettings, SettingsError } from './hooks.ts'
import { EventLog } from './log.ts'
import { ModHost } from './mods.ts'
import { defaultScenario, loadScenarioFile, type Scenario, ScenarioError } from './scenario.ts'
import { ProcessTerminal } from './term.ts'
import { statusFileLocation, StatusFileWriter } from './status.ts'
import { commandCodeSessionByName, transcriptLocation, TranscriptWriter } from './transcript.ts'

export const FAKE_AGENT_VERSION = '0.1.0'
/** How long the exit path waits for stdout to drain before exiting anyway (a PTY nobody reads). */
const EXIT_FLUSH_MS = 2000
/** Defaults per flavour: `--as claude` mimics Claude Code 2.1.296 (claude-opus-5-5 at medium effort). */
const DEFAULT_MODEL: Record<string, string> = { claude: 'claude-opus-5-5', commandcode: 'fake-model-1' }
const CLAUDE_DEFAULT_EFFORT = 'medium'

const USAGE = `fake-agent ${FAKE_AGENT_VERSION}: a scriptable stand-in for an agent CLI (tools/fake-agent/README.md)

usage: node tools/fake-agent/src/main.ts --as claude|commandcode [fake-agent options] [agent flags…] [-- <prompt>]

fake-agent options (each also from an env var):
  --as <flavour>        claude | commandcode                          FAKE_AGENT_AS
  --scenario <file>     YAML/JSON scenario (default: one short turn)  FAKE_AGENT_SCENARIO
  --fake-home <dir>     stands in for HOME for transcript paths       FAKE_AGENT_HOME
  --log <file>          JSONL event log for tests                     FAKE_AGENT_LOG

--as claude reads:      --session-id <uuid> --model <m> --effort <e> --permission-mode <p> --settings <json|file>
                        --resume <id>; other flags are kept as extra args; the prompt follows --
--as commandcode reads: -m <model> --effort <e> --permission-mode <p> --mod <file> --mod-option <name=value> (both
                        repeatable) -t/--trust -n <name> -r <id or name>; the prompt is the positional argument (or
                        follows --); --version, --help, --list-models and status --json answer as 1.79.2 does
`

/** Command Code's recorded answers (`--help`, `--list-models`): the committed fixtures of the version this stands in for. */
function recorded(file: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/cli/commandcode', FAKE_COMMANDCODE_VERSION, file), 'utf8')
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(msg: string, code: number): never {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}

function scenarioFor(fake: FakeOptions, cwd: string): Scenario {
  try {
    return fake.scenario ? loadScenarioFile(fake.scenario, fake.as, cwd) : defaultScenario(fake.as, cwd)
  } catch (e) {
    if (e instanceof ScenarioError) fail(`fake-agent: ${e.message}`, 2)
    throw e
  }
}

async function main(): Promise<void> {
  let parsed: ParsedArgv
  try {
    parsed = parseArgv(process.argv.slice(2), process.env)
  } catch (e) {
    if (e instanceof ArgvError) fail(e.message, e.exitCode)
    throw e
  }
  const { fake, agent, agentArgv } = parsed
  if (agent.flavour === 'commandcode') {
    // detection's four questions, answered as Command Code 1.79.2 answers them: the version alone on a line, the
    // recorded help and model list, and `status --json` (exit 0 signed in, 1 not: `FAKE_AGENT_LOGGED_IN=0`)
    const version = process.env.FAKE_AGENT_CLI_VERSION || FAKE_COMMANDCODE_VERSION
    if (agent.version) return void process.stdout.write(`${version}\n`)
    if (agent.help) return void process.stdout.write(recorded('help.txt'))
    if (agent.listModels) return void process.stdout.write(recorded('list-models.txt'))
    if (agentArgv[0] === 'status' && agentArgv[1] === '--json' && agentArgv.length === 2) {
      const authenticated = process.env.FAKE_AGENT_LOGGED_IN !== '0'
      process.stdout.write(`${JSON.stringify({ authenticated, version })}\n`)
      process.exitCode = authenticated ? 0 : 1
      return
    }
  }
  if (agent.help) {
    process.stdout.write(USAGE)
    return
  }
  if (agent.version) {
    // Claude's own shape (`2.1.296 (Claude Code)`), so detection reads it like the real CLI's
    process.stdout.write(`${process.env.FAKE_AGENT_CLI_VERSION || FAKE_CLAUDE_VERSION} (Claude Code)\n`)
    return
  }
  // `claude auth status`: JSON with `loggedIn`, exit 0 when logged in and 1 when not (`FAKE_AGENT_LOGGED_IN=0`)
  if (agent.flavour === 'claude' && agentArgv[0] === 'auth' && agentArgv[1] === 'status' && agentArgv.length === 2) {
    const loggedIn = process.env.FAKE_AGENT_LOGGED_IN !== '0'
    process.stdout.write(`${JSON.stringify({ loggedIn, authMethod: loggedIn ? 'fake' : 'none' }, null, 2)}\n`)
    process.exitCode = loggedIn ? 0 : 1
    return
  }

  const cwd = process.cwd()
  const scenario = scenarioFor(fake, cwd)
  const fakeHome = fake.fakeHome ? resolve(cwd, fake.fakeHome) : null
  const place = (id: string) => transcriptLocation({ flavour: fake.as, cwd, sessionId: id, override: fakeHome, home: homedir(), realHome: userInfo().homedir })
  let sessionId = (agent.flavour === 'claude' ? (agent.sessionId ?? agent.resume) : null) ?? randomUUID()
  if (agent.flavour === 'commandcode' && agent.resume !== null) {
    // `--resume <id or name>`: an id as it is, a name looked up among this project's sessions (their meta files' titles)
    const byName = UUID.test(agent.resume) ? agent.resume : commandCodeSessionByName(dirname(place(sessionId).path), agent.resume)
    if (byName === null) fail(`No session found matching "${agent.resume}"`, 1)
    sessionId = byName
  }
  const model = agent.model ?? DEFAULT_MODEL[fake.as] ?? 'fake-model-1'
  const permissionMode = reportedPermissionMode(agent)
  const hash = argvHash(agentArgv)
  const loc = place(sessionId)
  const transcript = loc.writable ? new TranscriptWriter(loc.path, { sessionId, cwd, model, version: `${FAKE_AGENT_VERSION} (fake-agent)` }, undefined, fake.as) : null
  if (!loc.writable) process.stderr.write(`fake-agent: ${loc.reason}\n`)

  let hooks: HookSink
  let hooksOff: string | null = null
  /** Command Code's `--name`: the session's title from the start (its own generated one never comes). */
  let named: string | null = null
  if (agent.flavour === 'claude') {
    let config = {}
    try {
      if (agent.settings !== null) config = parseClaudeSettings(agent.settings)
    } catch (e) {
      fail(e instanceof SettingsError ? e.message : `Invalid --settings: ${(e as Error).message}`, 1)
    }
    // `disableAllHooks: true` in the user's or the project's settings: no hook runs, and Kea falls back to its other
    // status sources. The account's real ~/.claude is never read: fake-agent reads nothing there.
    const configDir = resolve(process.env.CLAUDE_CONFIG_DIR || resolve(fake.fakeHome ? resolve(cwd, fake.fakeHome) : homedir(), '.claude'))
    const real = resolve(userInfo().homedir)
    const own = !(configDir === real || configDir.startsWith(`${real}/.claude`))
    hooksOff = hooksDisabledBy({ configDir: own ? configDir : null, cwd, inline: agent.settings })
    if (hooksOff) config = {}
    hooks = new ClaudeHooks(config, { sessionId, transcriptPath: loc.path, cwd, permissionMode, model, effort: agent.effort ?? CLAUDE_DEFAULT_EFFORT, source: agent.resume ? 'resume' : 'startup' }, process.env)
  } else {
    // a mod runs in the agent's process and reads the agent's home (kea-mod.ts looks there for the session's file):
    // here that is the fake home, and never the account's real one (fake-agent reads nothing under ~/.commandcode)
    process.env.HOME = loc.writable ? (fakeHome ?? homedir()) : join(tmpdir(), `fake-agent-no-home-${process.pid}`)
    const host = new ModHost({ sessionId, cwd, permissionMode, model, source: agent.resume ? 'resume' : 'startup', modOptions: agent.modOptions }, process.env)
    try {
      await host.load(agent.mods, cwd)
    } catch (e) {
      fail(`fake-agent: ${(e as Error).message}`, 1)
    }
    if (transcript) host.onSessionId = (id) => transcript.setSession(id)
    hooks = host
    named = agent.name
  }

  // Claude's live status file, `<CLAUDE_CONFIG_DIR or home/.claude>/sessions/<pid>.json`
  let status: StatusFileWriter | null = null
  if (fake.as === 'claude' && scenario.statusFile !== 'off') {
    const sl = statusFileLocation({ pid: process.pid, configDir: process.env.CLAUDE_CONFIG_DIR, override: fake.fakeHome ? resolve(cwd, fake.fakeHome) : null, home: homedir(), realHome: userInfo().homedir, cwd })
    if (sl.writable) status = new StatusFileWriter(sl.path, { pid: process.pid, sessionId, cwd, version: process.env.FAKE_AGENT_CLI_VERSION || FAKE_CLAUDE_VERSION })
    else process.stderr.write(`fake-agent: ${sl.reason}\n`)
    if (status && hooks instanceof ClaudeHooks) {
      const st = status
      hooks.onSessionId = (id) => st.setSessionId(id)
    }
  }

  let fa: FakeAgent | null = null
  const term = new ProcessTerminal({
    onInputClosed: () => {
      if (process.stdin.isTTY) void fa?.end('other', 0) // the PTY closed
    },
    onOutputClosed: () => void fa?.end('other', 0),
    onResize: () => void fa?.resize(),
  })
  const log = new EventLog(fake.log ? resolve(cwd, fake.log) : null, () => term.now())
  log.event('start', {
    flavour: fake.as,
    pid: process.pid,
    argv: agentArgv,
    argvHash: hash,
    sessionId,
    cwd,
    model,
    permissionMode,
    prompt: agent.prompt,
    extra: agent.extra,
    transcriptPath: loc.path,
    transcriptWritable: loc.writable,
    hooksDisabledBy: hooksOff,
    scenario: scenario.name,
    tty: process.stdin.isTTY === true,
    size: term.size(),
  })

  if (named !== null) {
    // 1.79.2 with --name: the meta file says the person named it, and `session_titled` fires once the session started
    transcript?.setTitle(named, true)
    scenario.steps.unshift({ at: '--name', kind: 'hook', event: 'session_titled', tool: null, input: null, fields: { title: named } })
  }

  fa = new FakeAgent({
    io: term,
    scenario,
    flavour: fake.as,
    vars: { sessionId, cwd, model, prompt: agent.prompt, line: '', key: '', argvHash: hash, flavour: fake.as, permissionMode, transcriptPath: loc.path },
    hooks,
    transcript,
    transcriptRefusal: loc.writable ? null : loc.reason,
    status,
    log,
    restore: () => term.restore(),
    warn: (m) => process.stderr.write(`${m}\r\n`),
    exit: (code) => {
      const t = setTimeout(() => process.exit(code), EXIT_FLUSH_MS)
      process.stdout.write('', () => {
        clearTimeout(t)
        process.exit(code)
      })
    },
  })
  const agentRef = fa
  process.on('SIGTERM', () => void agentRef.end('other', 143))
  process.on('SIGHUP', () => void agentRef.end('other', 129))
  process.on('SIGINT', () => void agentRef.end('other', 130))
  await fa.run()
}

main().catch((e: unknown) => {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
  } catch {
    // the PTY is gone
  }
  process.stderr.write(`fake-agent: ${(e as Error)?.stack ?? String(e)}\n`)
  process.exit(1)
})
