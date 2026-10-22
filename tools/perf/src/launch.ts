// Launching a dev build of Kea for a harness run (perf, the survival check, and the chaos and leak suites through
// tests/support/app.ts): its own temporary KEA_HOME and HOME, `--kea-perf` so the window opens without taking keyboard
// focus, no agent CLI the login shell could find but a harness's fake one, the processes the run starts told apart from
// everyone else's, and a cleanup that signals only those. Holder cleanup itself is holders.ts.
//
// A process belongs to the run when its command line names the run's KEA_HOME (main, core, ptyhost, holders) or its
// Chromium userData directory (the renderer, GPU and network helpers); both paths are unique to the run. On Linux
// Chromium's zygotes (and the set-uid sandbox's helper) name neither: they belong to the run as Electron processes
// descended from one that does. Before any signal the pid is looked up again and must still have the start time and
// executable it had when it was found, so a reused pid is never signalled.
//
// Where Kea draws is the OS layer's (os/: `harnessOs.display`): the person's own screen on macOS, never taking their
// keyboard (`--kea-perf`); on Linux an Xvfb of the harness's own, as an X11 client, with no session bus of the person's.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { _electron, type ElectronApplication } from '@playwright/test'
import { fallbackEnv } from '../../../app/core/src/terminal/shellEnv.ts'
import { findOnPath } from '../../../packages/adapters/src/kit/env.ts'
import { fnv1a64, runDir } from '../../../packages/kit/src/rundir.ts'
import { agentCommands } from '../../../packages/adapters/src/registry.ts'
import { FLAVOURS, writeAgentShim, type Flavour } from '../../fake-agent/src/index.ts'
import { QUIET_AGENT_ENV } from '../../recorder/src/world.ts'
import { packOs } from '../../pack/src/os/index.ts'
import { tableOf } from '../../pack/src/processes.ts'
import { isAvailable } from '../../../packages/protocol/src/platform.ts'
import { assertHarnessHome, killOwnHolders, userDataDirIfKnown, type KillReport } from './holders.ts'
import { harnessOs } from './os/index.ts'
import { procs } from './procs.ts'

export const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')

/** npm's Electron binary (the dev build runs on it). */
export function electronBinary(): string {
  return createRequire(path.join(repoRoot, 'tools/perf/package.json'))('electron') as string
}

export interface LaunchOptions {
  /** The built app directory (dist/app, or dist/test-app for the suites). */
  dist: string
  home: string
  /** More switches for Kea (`--kea-perf` is always passed). */
  args?: string[]
  env?: Record<string, string | undefined>
  timeoutMs?: number
  /** Run this instead of Electron (a wrapper that execs `electronBinary()` with its arguments, e.g. under a lower limit). */
  executable?: string
  /**
   * The folder of the run's fake agents (`writeAgentShims`), first on the launch's PATH. Absent or null: this Kea must
   * find no agent command at all. `launchKea` checks it before it starts anything (`assertLoginShellAgents`).
   */
  agents?: string | null
  /** Called once the checks are through, right before Electron is started: a measured launch takes its start time here. */
  onSpawn?: () => void
}

/**
 * Every name a shipped adapter's CLI is installed under (packages/adapters `agentCommands`: Claude Code's one, Command
 * Code's four), kept off every harness run's PATH or shadowed by the run's fake agent. Read from the registry, so a new
 * adapter is covered by registering it.
 */
const AGENT_COMMANDS: readonly string[] = agentCommands().flatMap((a) => a.names)

/**
 * A fake-agent shim (tools/fake-agent `writeAgentShim`) in `dir` for every command of every shipped adapter (or of
 * `only`), each running the fake agent as that adapter's flavour; `env` is exported by each. A real CLI under one of
 * these names in a folder the login shell or core's fallback environment adds by itself (/opt/homebrew/bin, where npm
 * puts Command Code's four) cannot be taken off a run's PATH: it is shadowed by these, first on PATH, instead.
 */
export function writeAgentShims(dir: string, o: { only?: readonly string[]; env?: Record<string, string> } = {}): void {
  for (const a of agentCommands()) {
    if (o.only && !o.only.includes(a.adapter)) continue
    if (!(FLAVOURS as readonly string[]).includes(a.adapter)) throw new Error(`tools/fake-agent has no flavour for the adapter "${a.adapter}": it needs one before a harness may launch Kea with that adapter registered`)
    for (const name of a.names) writeAgentShim(dir, a.adapter as Flavour, { name, ...(o.env ? { env: o.env } : {}) })
  }
}

/**
 * zsh rc lines that put `dir` first on PATH after path_helper put /etc/paths ahead of everything, whether or not the
 * inherited PATH holds it (a Kea started from another run's shell inherits that run's PATH).
 */
export function shimFirstRc(dir: string): string {
  return `# tools/perf/src/launch.ts: the run's fake agents first, after path_helper, on any inherited PATH
kea_shim='${dir.replaceAll("'", `'\\''`)}'
path=("$kea_shim" \${path:#$kea_shim})
unset kea_shim
`
}

/** This process's PATH without the directories that hold an agent CLI: a harness run's PATH, after its fake agents. */
export function pathWithoutAgents(): string {
  const dirs = (process.env.PATH ?? '/usr/bin:/bin').split(':').filter(Boolean)
  return dirs.filter((d) => !AGENT_COMMANDS.some((c) => fs.existsSync(path.join(d, c)))).join(':')
}

export { QUIET_AGENT_ENV }

/**
 * The environment a harness starts Kea with: this process's, plus `extra`, without `ELECTRON_RUN_AS_NODE`, and with
 * `pathWithoutAgents()` as PATH unless `extra` sets one. A harness run from a tool built on Electron (an editor's
 * terminal) inherits that variable, and with it Electron starts as plain Node and refuses Chromium's switches. The PATH
 * keeps Kea's agent detection from running a real agent CLI: real CLIs run only in the contract suite, inside
 * the recorder's sandbox. The caller still owes a temporary ZDOTDIR, or core's login-shell probe sources the
 * user's zsh files and finds the CLI again; `launchKea` checks that before it starts Kea (`assertLoginShellAgents`),
 * and a harness that starts Kea any other way calls it itself. `launchEnv` adds the run's own HOME. `QUIET_AGENT_ENV`
 * is the second line: whatever such a Kea starts is told to send no telemetry and check for no update.
 */
export function appEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, PATH: pathWithoutAgents(), ...QUIET_AGENT_ENV, ...extra })) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  return env
}

/** How long the login-shell check below may take (zsh -l -i with a test ZDOTDIR, under the suites' load). */
const LOGIN_SHELL_TIMEOUT_MS = 20_000

/** The login shell of a Kea started with no SHELL (core's own default: app/core/src/terminal/shellEnv.ts). */
const DEFAULT_SHELL = '/bin/zsh'

/**
 * The shell core would run its environment probe and every agent through with `env` (`$SHELL`), if the check below can
 * read what it finds: a zsh, by an absolute path (the lookup is written for zsh, and a run steers its shell by ZDOTDIR,
 * which only zsh reads). Any other shell is refused: what it would find cannot be checked.
 */
export function harnessLoginShell(env: Record<string, string>): string {
  const shell = env.SHELL ?? DEFAULT_SHELL
  if (!path.isAbsolute(shell) || path.basename(shell) !== 'zsh') throw new Error(`SHELL is ${shell}: a harness can check only a zsh (by its absolute path) for the agent commands it finds, and Kea would run its probe and every agent through $SHELL; refusing to start`)
  return shell
}

/**
 * The PATH and each agent command of the login shell Kea would run with `env` (`$SHELL -l -i -c`, as core's environment
 * probe and every agent launched through the login shell do), stdin closed. `command -v` only looks the
 * name up; nothing is run. macOS's /etc/zprofile runs path_helper, which puts /etc/paths and /etc/paths.d
 * (/usr/local/bin, /opt/homebrew/bin) ahead of the inherited PATH, so a CLI installed there is found before anything a
 * harness put first, unless the run's ZDOTDIR puts it first again. Throws for a shell it cannot ask (`harnessLoginShell`).
 */
export function loginShellLookup(env: Record<string, string>): { path: string[]; agents: Record<string, string | null> } {
  const marks = AGENT_COMMANDS.map((c) => `print -r -- "kea-agent ${c} $(command -v ${c})"`).join('; ')
  const out = execFileSync(harnessLoginShell(env), ['-l', '-i', '-c', `print -r -- "kea-path $PATH"; ${marks}`], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: LOGIN_SHELL_TIMEOUT_MS })
  const lines = out.split('\n')
  const agents: Record<string, string | null> = {}
  for (const c of AGENT_COMMANDS) agents[c] = lines.findLast((l) => l.startsWith(`kea-agent ${c} `))?.slice(`kea-agent ${c} `.length).trim() || null
  return { path: (lines.findLast((l) => l.startsWith('kea-path ')) ?? 'kea-path ').slice('kea-path '.length).split(':').filter(Boolean), agents }
}

/**
 * Where core's fallback environment would find each agent command: when its login-shell probe fails, core takes the
 * environment it was started with and appends the usual tool folders (`fallbackEnv`: /opt/homebrew/bin,
 * /usr/local/bin, ~/.local/bin), whatever the run's ZDOTDIR says. Nothing is run: `findOnPath` only looks the name up.
 */
export function fallbackLookup(env: Record<string, string>): Record<string, string | null> {
  const p = fallbackEnv(env, env.HOME ?? os.homedir()).PATH
  return Object.fromEntries(AGENT_COMMANDS.map((c) => [c, findOnPath(c, p)]))
}

/**
 * Fail unless Kea, started with `env`, would find each agent command as the run's fake agent or not at all: in `shim`
 * (the run's fake-agent folder, KeaRun) for every command that folder holds, and nowhere for one it does not hold
 * (`shim` null: no agent at all). Checked for both environments core can end up with: the login shell's, and
 * the fallback one a failed probe leaves it with. The login shell asked is the one core would use (`$SHELL`); one that
 * cannot be asked is refused. `launchKea` checks this before every start, and a harness that starts Kea another way
 * (a packaged app, a command typed into a shell) calls it itself, so a real CLI anywhere either PATH reaches fails the
 * run instead of being run.
 */
export function assertLoginShellAgents(env: Record<string, string>, shim: string | null): void {
  const login = loginShellLookup(env).agents
  const fallback = fallbackLookup(env)
  for (const c of AGENT_COMMANDS) {
    const want = shim && findOnPath(c, shim) ? path.join(shim, c) : null
    for (const [where, got] of [
      ["the run's login shell", login[c] ?? null],
      ["core's fallback environment (a failed login-shell probe)", fallback[c] ?? null],
    ] as const) {
      if (got !== want) throw new Error(`${where} finds \`${c}\` at ${got ?? 'nothing'}, not ${want ?? 'nothing'}: Kea would run it (detection, and sessions); refusing to start`)
    }
  }
}

/**
 * Variables that would put a folder Kea, Chromium or a tool Kea starts makes per user in the person's own folders
 * rather than under the run's HOME: the XDG base folders. On Linux Electron's userData is `$XDG_CONFIG_HOME/<name>` and
 * a discarded file goes to `$XDG_DATA_HOME`'s Trash; git reads `$XDG_CONFIG_HOME/git/config` on either system. Unset,
 * each follows the run's HOME.
 */
const PERSONAL_FOLDER_VARS = ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']

/** The HOME of every harness launch on KEA_HOME `home`: an empty folder of the run's own (`launchEnv`). */
export function harnessUserHome(home: string): string {
  return path.join(home, 'user-home')
}

/**
 * The whole environment `launchKea` hands to Electron for a run on `home`: `appEnv(env)` with HOME the run's own empty
 * folder (`harnessUserHome`), made here. Core's fallback environment, used when its login-shell probe fails, appends
 * `~/.local/bin`, where the real Claude CLI lives, and Node's `os.homedir()` is HOME: with the user's own HOME
 * a failed probe would put the real `claude` on PATH for detection. Electron's userData follows the account's
 * home folder on macOS, not HOME, and HOME on Linux (`userDataDir`). The XDG base folders are left out unless
 * the caller sets one (`PERSONAL_FOLDER_VARS`). The user's own HOME is refused.
 */
export function launchEnv(o: Pick<LaunchOptions, 'home' | 'env'>): Record<string, string> {
  const userHome = harnessUserHome(o.home)
  fs.mkdirSync(userHome, { recursive: true, mode: 0o700 })
  const env = appEnv({ HOME: userHome, ...Object.fromEntries(PERSONAL_FOLDER_VARS.map((k) => [k, undefined])), ...o.env })
  const owners = new Set([os.userInfo().homedir, process.env.HOME].filter((h): h is string => !!h).map((h) => path.resolve(h)))
  if (!env.HOME || owners.has(path.resolve(env.HOME))) throw new Error(`refusing to launch Kea with the owner's HOME (${env.HOME ?? 'unset'}): a harness launch runs with its own (harnessUserHome)`)
  return env
}

/**
 * Start Kea through Playwright's Electron support. `--kea-perf` makes main open the window with `showInactive()`, so
 * typing elsewhere never lands in a test terminal; `assertUnfocused` checks it. On Linux Kea draws on the harness's own
 * Xvfb (`harnessOs.display`), where nobody else types.
 *
 * Before anything is started, and at every call (a run's files may have changed since the last one): the environment
 * is the run's own (`launchEnv`), its login shell and core's fallback environment find each agent command in
 * `o.agents` or nowhere (`assertLoginShellAgents`), and Chromium's sandbox can start. A launch that fails any
 * of them throws here, synchronously, with nothing started; `onSpawn` is called once the display is ready.
 */
export function launchKea(o: LaunchOptions): Promise<ElectronApplication> {
  const env = launchEnv(o)
  assertLoginShellAgents(env, o.agents ?? null)
  // Kea never runs without Chromium's sandbox, so a machine where it cannot start says how to fix it here,
  // rather than Electron exiting with Playwright's "Process failed to launch!"
  const sandbox = packOs.devDesktop.sandboxProblem(electronBinary())
  if (sandbox) throw new Error(sandbox)
  return startKea(o, env)
}

/** `launchKea` past its checks: the run's display (the person's own screen on macOS; Xvfb on Linux), then Electron. */
async function startKea(o: LaunchOptions, env: Record<string, string>): Promise<ElectronApplication> {
  const display = await harnessOs.display.launch()
  const launchEnvironment: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...env, ...display.env })) if (v !== undefined) launchEnvironment[k] = v
  o.onSpawn?.()
  return _electron.launch({
    executablePath: o.executable ?? electronBinary(),
    args: [o.dist, `--kea-home=${o.home}`, '--kea-perf', ...display.args, ...(o.args ?? [])],
    env: launchEnvironment,
    // Kea never runs without Chromium's sandbox; Playwright adds --no-sandbox on Linux unless told not to
    chromiumSandbox: true,
    ...(o.timeoutMs ? { timeout: o.timeoutMs } : {}),
  })
}

export interface ProcInfo {
  pid: number
  ppid: number
  /** Start time, whole seconds since the epoch. */
  start: number
  /** The path it was started by (`argv[0]`, what `ps -o comm` printed), else its executable file, in full. */
  comm: string
  /** The command line, its words joined by spaces. */
  args: string
  /** The executable file, or null when it cannot be read (Linux: a set-uid or sandboxed process). */
  exe: string | null
}

/** Every process of this user, from `kea-helper procs --args` (procs.ts): a run's own are all a harness looks for. */
export function processTable(): ProcInfo[] {
  return tableOf(procs([], { args: true }))
}

export function processInfo(pid: number): ProcInfo | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  return tableOf(procs([pid], { args: true })).find((p) => p.pid === pid) ?? null
}

/** The same process as `known`: same pid, start time and executable. */
export function stillSame(known: Pick<ProcInfo, 'pid' | 'start' | 'comm'>): boolean {
  const now = processInfo(known.pid)
  return !!now && now.start === known.start && now.comm === known.comm
}

/** Signal `known` only if it is still that process (pid, start time, executable); false if it is gone or not it. */
export function signalKnown(known: Pick<ProcInfo, 'pid' | 'start' | 'comm'>, signal: NodeJS.Signals): boolean {
  if (!stillSame(known)) return false
  try {
    process.kill(known.pid, signal)
    return true
  } catch {
    return false
  }
}

/** Electron's programs, by file name: macOS's app and helpers (npm's and a packaged Kea's), Linux's one binary (npm's `electron`; a package's). */
const ELECTRON_NAMES = /^(?:Electron|Electron Helper(?: \([A-Za-z]+\))?|Kea|Kea Helper(?: \([A-Za-z]+\))?|electron|kea|kea-app)$/
/** Chromium's set-uid sandbox helper on Linux: it starts the sandboxed zygote and stays its parent. */
const SANDBOX_HELPER = 'chrome-sandbox'

/**
 * The file name of the program a process runs: its executable where that can be read, else the path it was started
 * by. Linux's Chromium rewrites each process's command line into one title (`…/electron --type=zygote`), so that path
 * is the title up to its first switch.
 */
export function programName(p: Pick<ProcInfo, 'comm' | 'exe'>): string {
  return path.basename(p.exe ?? p.comm.split(' --')[0]!)
}

/** One of Chromium's zygotes, or the set-uid helper that starts the sandboxed one (Linux: role `zygote`). */
export function isZygote(p: Pick<ProcInfo, 'args'>): boolean {
  return `${p.args} `.includes(' --type=zygote ')
}

/**
 * The run's Electron processes: main, helpers and utility processes, alive now (holders are not included). On Linux
 * also the zygotes and the sandbox's helper, which carry no path of the run: Electron's processes below one that does.
 */
export function runAppProcesses(home: string, o: { packaged?: boolean; table?: ProcInfo[] } = {}): ProcInfo[] {
  const ud = userDataDirIfKnown(home, !!o.packaged)
  const table = o.table ?? processTable()
  // whole switches only: one run's home is never a prefix of another's
  const named = table.filter((p) => p.pid !== process.pid && ELECTRON_NAMES.test(programName(p)) && (`${p.args} `.includes(` --kea-home=${home} `) || (ud !== null && `${p.args} `.includes(` --user-data-dir=${ud} `))))
  const seen = new Set(named.map((p) => p.pid))
  const below = descendants([...seen], table).filter((p) => !seen.has(p.pid) && p.pid !== process.pid && (ELECTRON_NAMES.test(programName(p)) || programName(p) === SANDBOX_HELPER))
  return [...named, ...below.filter((p, i) => below.findIndex((q) => q.pid === p.pid) === i)]
}

/** Every descendant of `pids` in one process table (children, grandchildren, …). */
export function descendants(pids: number[], table: ProcInfo[] = processTable()): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>()
  for (const p of table) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p])
  const out: ProcInfo[] = []
  const queue = [...pids]
  while (queue.length) {
    for (const c of byParent.get(queue.shift() as number) ?? []) {
      out.push(c)
      queue.push(c.pid)
    }
  }
  return out
}

export type CleanupReport = { holders: KillReport; descendants: number[]; app: number[]; removed: string[] }

/**
 * End everything a run left behind: its holders' process trees (the children of a holder are the run's shells and
 * whatever they started), its Electron processes, its KEA_HOME, its userData directory, the folder its sockets were in
 * when the home was too long for them (`/tmp/kea-<uid>/<hash of the home>`, which a killed holder leaves its
 * socket's name in; found here from the home, so no caller can forget it) and `dirs`. Only processes identified as the
 * run's are signalled, each after a fresh identity check; a holder's descendants count only if they started at or
 * after `since` (seconds since the epoch).
 */
export function cleanupRun(home: string, o: { packaged?: boolean; since?: number; dirs?: string[] } = {}): CleanupReport {
  assertHarnessHome(home)
  const table = processTable()
  const since = o.since ?? 0
  const app = runAppProcesses(home, { ...o, table })
  for (const p of app) signalKnown(p, 'SIGKILL')
  // a holder's descendants (shells, counter, a second Kea started from a shell) go with it
  const holders = table.filter((p) => path.basename(p.comm) === 'kea-helper' && p.args.includes(` ${home}/sessions/`))
  const tree = descendants(
    holders.map((h) => h.pid),
    table,
  ).filter((p) => p.start >= since)
  const report: CleanupReport = { holders: killOwnHolders(home), descendants: [], app: app.map((p) => p.pid), removed: [] }
  for (const p of tree) if (signalKnown(p, 'SIGKILL')) report.descendants.push(p.pid)
  for (const dir of new Set([home, userDataDirIfKnown(home, !!o.packaged), ...socketDirOutside(home), ...(o.dirs ?? [])])) {
    if (dir === null) continue
    if (!fs.existsSync(dir)) continue
    fs.rmSync(dir, { recursive: true, force: true })
    report.removed.push(dir)
  }
  return report
}

/**
 * The run's own socket folder when its sockets are not in `<home>/run`: `/tmp/kea-<uid>/<hash>`, or
 * `<runtime>/kea/<hash>` where the system gives the user a runtime folder (Linux's `$XDG_RUNTIME_DIR`). Its name
 * is the hash of this one home, a harness's (`assertHarnessHome`): never the shared folder itself, never another home's.
 */
function socketDirOutside(home: string): string[] {
  const dir = runDir(home)
  return dir !== path.join(home, 'run') && path.basename(dir) === fnv1a64(home) && /\/kea(?:-\d+)?$/.test(path.dirname(dir)) ? [dir] : []
}

/**
 * The pid of the frontmost app (macOS: `lsappinfo`, read-only: it activates nothing), or null if it cannot be told or
 * the system has no app in front (Linux, where a run draws on a display of its own).
 */
export function frontmostPid(): number | null {
  return isAvailable(harnessOs.front) ? harnessOs.front.pid() : null
}
