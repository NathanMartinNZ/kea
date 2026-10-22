// The throwaway world an agent is recorded in (tools/mock-model README, "Running claude against it"): a fresh temp root
// holding the agent's HOME and config dir, a keychain stand-in, a network sinkhole and a `sandbox-exec` profile. The
// real user's home is write-protected and the agent's real config is unreadable, the network is local only (the mock
// model), and every attempt to go elsewhere is refused and counted.
//
// Two agents run in it. Claude Code gets its config dir, the mock model as its API and its telemetry and update
// switches. Command Code (`agent: 'commandcode'`, used by the static contract capture) keeps its files under HOME
// (`<home>/.commandcode`), so the world's HOME is all it needs; it runs local-only (no Command Code backend, no
// telemetry: its own switch), with updates off, and `seedCommandCode` gives it the mock model as a provider of its own.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** A dummy key: the mock model accepts anything; the CLI only needs one it has "approved". */
export const DUMMY_API_KEY = 'sk-ant-test-dummy-recorder-key'
/**
 * Command Code's stand-in for being signed in: its print mode and its mods start only with some key present (1.79.2
 * checks for one before anything else). Set only together with local-only, where the CLI refuses every call to its own
 * backend, so the key is never sent anywhere; it is no account's key.
 */
export const DUMMY_COMMAND_CODE_KEY = 'kea-recorder-dummy-key'

export interface World {
  root: string
  home: string
  config: string
  tmp: string
  /** Holder state and socket (kept short: socket paths are limited to 104 bytes). */
  run: string
  bin: string
  profile: string
  dispose(): void
}

/** SBPL string literal. */
const lit = (s: string) => JSON.stringify(s)
// the keychain, other apps and AppleScript
const DENIED_EXEC = ['/usr/bin/security', '/usr/bin/open', '/usr/bin/osascript'] // os-ok: contract capture stays macOS-only

/**
 * Network: only the two local ports the recorder opened (the mock model and the sinkhole proxy), and unix sockets
 * inside the world. Any other local listener (a forwarding proxy, an SSH tunnel) could carry a request out.
 */
export function sandboxProfile(o: { ports: readonly number[]; world: string }, userHome: string = homedir()): string {
  const h = realpathSync(userHome)
  for (const p of o.ports) if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`bad port ${p}`)
  return `(version 1)
(allow default)
(deny network-outbound)
${o.ports.map((p) => `(allow network-outbound (remote ip ${lit(`localhost:${p}`)}))`).join('\n')}
(allow network-outbound (remote unix-socket (subpath ${lit(o.world)})))
(deny file-write* (subpath ${lit(h)}))
(deny file-read* (subpath ${lit(`${h}/.claude`)}) (literal ${lit(`${h}/.claude.json`)}) (subpath ${lit(`${h}/.config/claude`)}) (subpath ${lit(`${h}/.commandcode`)}))
(deny process-exec ${DENIED_EXEC.map((p) => `(literal ${lit(p)})`).join(' ')})
`
}

export function makeWorld(opts: { repo: string; trusted: boolean; ports: readonly number[]; agentVersion?: string }): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kea-rec-')))
  const home = join(root, 'home')
  const config = join(home, '.claude')
  const tmp = join(root, 'tmp')
  const run = join(root, 'run')
  const bin = join(root, 'bin')
  for (const d of [home, config, tmp, run, bin]) mkdirSync(d, { recursive: true, mode: 0o700 })
  // the CLI runs `security` at start; it must never reach the real keychain
  writeFileSync(join(bin, 'security'), '#!/bin/sh\nexit 44\n', { mode: 0o755 })
  const profile = join(root, 'net.sb')
  writeFileSync(profile, sandboxProfile({ ports: opts.ports, world: root }))
  const v = opts.agentVersion ?? '0.0.0'
  const seed = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: v,
    lastReleaseNotesSeen: v,
    theme: 'dark',
    numStartups: 3,
    customApiKeyResponses: { approved: [DUMMY_API_KEY.slice(-20)], rejected: [] },
    projects: opts.trusted ? { [opts.repo]: { hasTrustDialogAccepted: true, allowedTools: [] } } : {},
  }
  writeFileSync(join(config, '.claude.json'), JSON.stringify(seed, null, 2))
  writeFileSync(join(home, '.claude.json'), JSON.stringify(seed, null, 2))
  return {
    root,
    home,
    config,
    tmp,
    run,
    bin,
    profile,
    dispose: () => {
      sweep(root)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/**
 * Keys a scenario's `env` may not set: everything the world sets, and anything that redirects traffic, picks a
 * backend or credentials, or loads code into the agent.
 */
export function forbiddenEnvKey(key: string, worldKeys: ReadonlySet<string>): string | null {
  if (worldKeys.has(key)) return 'set by the recorder'
  if (/proxy/i.test(key)) return 'proxy settings are the recorder’s'
  if (/^(ANTHROPIC|CLAUDE_CODE_USE|AWS|GOOGLE|CLOUD_ML|VERTEX|OPENAI|OPENROUTER)_/.test(key) || /^COMMAND_?CODE_API/.test(key)) return 'model backend and credentials are the recorder’s'
  if (/^(NODE_OPTIONS|NODE_PATH|DYLD_.*|LD_.*|BUN_.*)$/.test(key)) return 'would load code into the agent'
  return null
}

/** Which agent's switches the environment carries (default Claude Code's). */
export type WorldAgent = 'claude' | 'commandcode'

/**
 * The agent's environment: nothing inherited but PATH's tool directories; HOME and config inside the world.
 * `localOnly: false` (Command Code): without its local-only switch, for the static answers a person's own CLI gives
 * (`--list-models`, `status --json`); the sandbox still refuses every connection but the recorder's own ports.
 */
export function agentEnv(w: World, o: { mockUrl: string; proxyUrl: string; extra?: Record<string, string>; agent?: WorldAgent; localOnly?: boolean }): Record<string, string> {
  const base = worldEnv(w, o)
  const keys = new Set(Object.keys(base))
  for (const k of Object.keys(o.extra ?? {})) {
    const why = forbiddenEnvKey(k, keys)
    if (why) throw new Error(`scenario env may not set ${k}: ${why}`)
  }
  return { ...base, ...o.extra }
}

const NO_WORLD: World = { root: '', home: '', config: '', tmp: '', run: '', bin: '', profile: '', dispose() {} }

/** Claude Code's own switches for: no telemetry, no non-essential traffic, no update, no error report. */
const CLAUDE_QUIET_ENV = {
  DISABLE_TELEMETRY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
} as const

/** Command Code's own switches (1.79.2) for: no telemetry, no tracing, no update check. */
const COMMAND_CODE_QUIET_ENV = {
  DO_NOT_TRACK: '1',
  OTEL_SDK_DISABLED: 'true',
  COMMANDCODE_SKIP_UPDATES: '1',
} as const

/**
 * Both agents' quiet switches, for every harness that starts Kea (`appEnv`, tools/perf/src/launch.ts): no harness may
 * start a real agent CLI, and if one ever does through a path nobody guarded, it at least reports nothing and updates
 * nothing.
 */
export const QUIET_AGENT_ENV: Readonly<Record<string, string>> = { ...CLAUDE_QUIET_ENV, ...COMMAND_CODE_QUIET_ENV }

/** The keys agentEnv sets itself, for either agent (for validating a scenario before any world exists). */
export const WORLD_ENV_KEYS: ReadonlySet<string> = new Set(
  (['claude', 'commandcode'] as const).flatMap((agent) => Object.keys(worldEnv(NO_WORLD, { mockUrl: '', proxyUrl: '', agent }))),
)

/** Claude Code's part: its config dir, the mock model as its API, a dummy key, telemetry and updates off. */
function claudeEnv(w: World, o: { mockUrl: string }): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: w.config,
    ANTHROPIC_BASE_URL: o.mockUrl,
    ANTHROPIC_API_KEY: DUMMY_API_KEY,
    ...CLAUDE_QUIET_ENV,
  }
}

/**
 * Command Code's part (its own switches, 1.79.2): local-only (no Command Code backend at all, no telemetry) with a
 * dummy key so it counts as signed in, telemetry
 * and tracing off again by their own names, no update check, and its per-session scratchpad (by default under
 * /tmp/commandcode-<uid>, outside the world) inside the world's temp folder. `NODE_USE_ENV_PROXY` makes Node's own
 * fetch use the proxies below, so an attempt to leave goes to the sinkhole and is counted, not only refused by the
 * sandbox.
 */
function commandCodeEnv(w: World, o: { localOnly?: boolean }): Record<string, string> {
  return {
    ...(o.localOnly === false ? {} : { CMD_LOCAL_ONLY: '1', COMMAND_CODE_API_KEY: DUMMY_COMMAND_CODE_KEY }),
    ...COMMAND_CODE_QUIET_ENV,
    COMMANDCODE_SCRATCHPAD_BASE: `${w.tmp}/scratchpad`,
    NODE_USE_ENV_PROXY: '1',
  }
}

function worldEnv(w: World, o: { mockUrl: string; proxyUrl: string; agent?: WorldAgent; localOnly?: boolean }): Record<string, string> {
  return {
    PATH: [w.bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: w.home,
    USER: 'demo',
    LOGNAME: 'demo',
    SHELL: '/bin/zsh',
    TMPDIR: `${w.tmp}/`,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    ...(o.agent === 'commandcode' ? commandCodeEnv(w, o) : claudeEnv(w, o)),
    HTTPS_PROXY: o.proxyUrl,
    HTTP_PROXY: o.proxyUrl,
    https_proxy: o.proxyUrl,
    http_proxy: o.proxyUrl,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Kea Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Kea Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
}

/**
 * Command Code's files in the world's HOME (`<home>/.commandcode`): local-only written into its config too (the
 * environment's switch again, for a child that drops it), and, with `mockUrl`, the mock model as a provider of the
 * world's own (`mock`, Anthropic's wire, no key), whose models are then `mock/<id>`. The real `~/.commandcode` is never
 * read: the sandbox profile denies it, and HOME is the world's.
 */
export function seedCommandCode(w: World, o: { mockUrl?: string; models?: readonly string[] } = {}): { dir: string; models: string[] } {
  const dir = join(w.home, '.commandcode')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ localOnly: true }, null, 2)}\n`)
  const ids = [...(o.models ?? ['mock-model'])]
  if (o.mockUrl) {
    // the Anthropic wire posts to `<baseURL>/messages`; the mock model serves `/v1/messages`
    const provider = { name: 'Kea mock model', api: 'anthropic-messages', baseURL: `${o.mockUrl.replace(/\/+$/, '')}/v1`, apiKey: false, models: Object.fromEntries(ids.map((id) => [id, { contextWindow: 200_000, maxOutput: 8192 }])) }
    writeFileSync(join(dir, 'providers.json'), `${JSON.stringify({ provider: { mock: provider } }, null, 2)}\n`)
  }
  return { dir, models: ids.map((id) => `mock/${id}`) }
}

export interface Sinkhole {
  url: string
  /** Every refused attempt to reach a non-local host. */
  hits: string[]
  close(): Promise<void>
}

/** An HTTP(S) proxy that refuses everything and remembers what was tried. */
export async function startSinkhole(): Promise<Sinkhole> {
  const hits: string[] = [] // bounded: one recording
  const server = createServer((req, res) => {
    if (hits.length < 1000) hits.push(`HTTP ${req.method} ${req.url}`)
    res.writeHead(403).end()
  })
  server.on('connect', (req, socket) => {
    if (hits.length < 1000) hits.push(`CONNECT ${req.url}`)
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r())
        server.closeAllConnections()
      }),
  }
}

/** SIGKILL every process of this user whose command line or environment names `root`; returns what was found. */
export function sweep(root: string): string[] {
  const ps = execFileSync('/bin/ps', ['-Eww', '-o', 'pid=,command=', '-U', String(process.getuid?.() ?? 0)], { maxBuffer: 64 << 20 }).toString()
  const found: string[] = []
  for (const line of ps.split('\n')) {
    if (!line.includes(root)) continue
    const pid = Number(line.trim().split(/\s+/)[0])
    if (!pid || pid === process.pid) continue
    found.push(line.trim().slice(0, 160))
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  return found
}
