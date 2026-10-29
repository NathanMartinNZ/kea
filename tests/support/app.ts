// The real app for the chaos and leak suites: a dev build of Kea (dist/test-app-<tag>, built by the suites' global
// setup) launched with its own temporary KEA_HOME, its processes found and signalled only after an identity check, its
// shell tabs driven through the renderer, and everything it left behind removed.
//
// The leak suite's build compiles the renderer's Svelte without its dev mode, as the installed app has it
// (`SVELTE_ENV`): dev Svelte keeps an error stack for every signal written more than five times in one effect, and
// those stacks hold whatever their closures reach, closed sheets and panes included, until the signal is written
// again, so a leak row on dev Svelte counts views the app has let go. Only Svelte changes: NODE_ENV and Vite's mode, and
// what they guard (dev-only checks such as the listener-leak warning, the HUD), stay the dev build's, and the test
// probes are there as in every `--kea-perf` launch. The chaos suite and e2e keep the dev build.
//
// Rules this file enforces for every test:
// · Every launch passes `--kea-perf`: main creates the window non-focusable and opens it with `showInactive()`, so
//   typing in other apps never reaches a test shell, even if macOS activates Kea (as it may when the app in front
//   quits). `Kea.assertUnfocused` checks it after every launch, reload and fault.
// · A KEA_HOME is a fresh `kea-test-app-*` temp directory; ~/.kea and ~/.kea-dev are never named.
// · A signal goes only to a process this run started, after its pid, start time and executable were checked again.
// · Shells are zsh with a ZDOTDIR inside the KEA_HOME (prompt `kea$ `, history there too, no global compinit:
//   launch.ts `TEST_ZSHENV`), so neither the user's rc files nor their history are touched, and the screen is
//   predictable.
// · Git is hermetic: no system config, and a global config inside the KEA_HOME with a test identity and nothing else
//   (`GIT_CONFIG_GLOBAL`), so the user's identity, hooks or signing never reach a test repository (sessions' git and
//   "Initialise git…" run with the login shell's environment).
// · `KeaRun.dispose` kills what the run started (holders and their process trees, Electron processes), removes the
//   KEA_HOME, Electron's `Kea-dev-<hash>` data folder for it (in ~/Library/Application Support on macOS; inside the
//   KEA_HOME on Linux) and a fallback socket directory, and fails if anything of the run is still alive.
// · The memory watchdog must not trigger, since every trigger is a bug: `KeaRun.dispose` reads the run's
//   `main.log` and `resources.ndjson` before it removes them and fails the test for any trigger, soft limits included,
//   unless the run said it triggers the watchdog on purpose (`expectWatchdog`).
// · Kea is never the frontmost app. Its window cannot be key, but macOS can still give the front to the app (seen
//   when the display wakes). A test build then hides at once and says so in `main.log` (app/main/src/frontGuard.ts),
//   and `KeaRun.dispose` fails the test for that line (`frontSteps`): what a hidden window did counts for nothing.
// · Agents are never the real CLIs: the run's `settings.json` makes the `shell` pseudo-agent the default (the suites
//   type into shells), and every agent command (`claude`, Command Code's) is tools/fake-agent, first on PATH, with its
//   home and Claude's config dir (CLAUDE_CONFIG_DIR) inside the KEA_HOME, so neither a session nor detection ever runs
//   the user's `claude` or reads their ~/.claude. The ZDOTDIR's `.zprofile` and `.zshrc` put that folder first again
//   after path_helper, Kea runs with a HOME of the run's own (launch.ts `launchEnv`: core's fallback environment adds
//   `~/.local/bin`), and `create` and every launch check that the login shell Kea would run finds each agent command
//   as the run's fake, or not at all, and fail the run otherwise.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type ElectronApplication, type Page } from '@playwright/test'
import { agentCommands } from '@kea/adapters'
import { runDir, runProcess } from '@kea/kit'
import { childArgv, L, parseRingHeader, readRing } from '@kea/protocol'
import { zooCommand } from '@kea-tools/process-zoo/src/index.ts'
import { isSameHolder, userDataDir } from '../../tools/perf/src/holders.ts'
import { harnessOs } from '../../tools/perf/src/os/index.ts'
import { assertLoginShellAgents, cleanupRun, descendants, electronBinary, frontmostPid, harnessUserHome, launchEnv, launchKea, loginShellLookup, pathWithoutAgents, processInfo, processTable, repoRoot, runAppProcesses, signalKnown, stillSame, TEST_ZSHENV, writeAgentShims, type CleanupReport, type ProcInfo } from '../../tools/perf/src/launch.ts'
import { webglOn, webglState } from '../../app/main/src/platformLines.ts'
import { APP_TEST_HOME_PREFIX } from './helpers.ts'
import { sysKey } from './keys.ts'

export { pathWithoutAgents }

/**
 * Homes of app-level runs: still `kea-test-*`, told apart from the integration suite's homes, and tagged per Vitest
 * invocation (app-global.ts sets the tag), so one invocation's teardown never touches another's.
 */
export const APP_HOME_PREFIX = APP_TEST_HOME_PREFIX
export const RUN_TAG_ENV = 'KEA_TEST_APP_RUN'
/** The login shell of every run (`KeaRun.env`): the one the harness can check for agent commands (launch.ts `harnessLoginShell`). */
const RUN_SHELL = '/bin/zsh'
/**
 * Whether this harness can make a run here: it launches Kea's build with zsh as the login shell it checks. Every Mac has
 * it; on Linux it is a package of its own (`apt install zsh`), and a test of the harness itself is a named skip
 * without it. Kea draws on the harness's own Xvfb there (`harnessOs.display`).
 */
export const LAUNCHES_KEA = fs.existsSync(RUN_SHELL)
const runTag = () => process.env[RUN_TAG_ENV] ?? 'adhoc'
export function homePrefix(): string {
  return `${APP_HOME_PREFIX}${runTag()}-`
}
/**
 * A project's `env` (vitest.config.ts) sets it to `production` for the leak suite: its app's renderer compiles Svelte
 * without its dev mode (tools/build.ts `--svelte-production`), the chaos suite's and e2e's keep the dev build.
 */
export const SVELTE_ENV = 'KEA_TEST_APP_SVELTE'
/** Whether this suite's app compiles Svelte without its dev mode (`SVELTE_ENV`; app-global.ts reads the project's `env`). */
export function svelteProduction(env: Record<string, string | undefined> = process.env): boolean {
  return env[SVELTE_ENV] === 'production'
}
/**
 * The build the suites launch: dist/test-app-<tag> (dist/test-app-<tag>-svelte for the leak suite's), built by
 * app-global.ts once per Vitest invocation, so two invocations (or a `pnpm dev` rebuilding dist/app) never pull files
 * from under each other's running app.
 */
export function testAppDist(env: Record<string, string | undefined> = process.env): string {
  return path.join(repoRoot, 'dist', `test-app-${runTag()}${svelteProduction(env) ? '-svelte' : ''}`)
}
/** The prompt of every test shell (zdotdir below). */
export const PROMPT = 'kea$ '
/** How long one step of a test (a launch, a restart, a line appearing) may take before the test fails. */
export const STEP_MS = 20_000
const POLL_MS = 25

const ZSHRC = `# tests/support/app.ts: a predictable test shell (no user rc files, history kept in this directory)
PROMPT='${PROMPT}'
RPROMPT=''
unsetopt PROMPT_SP
HISTFILE="$ZDOTDIR/.zsh_history"
`

/**
 * The rc lines that put the run's fake-agent folder first on PATH, whether or not the inherited PATH holds it: macOS's
 * /etc/zprofile runs path_helper, which puts /etc/paths and /etc/paths.d (/usr/local/bin, /opt/homebrew/bin) ahead of
 * the inherited PATH, where a Homebrew or npm install of a real agent CLI would be found first. In `.zprofile` (login
 * shells, after /etc/zprofile) and `.zshrc`. Always, whatever the inherited PATH holds: a Kea typed into a shell of
 * another run's Kea inherits that run's PATH, with the other run's fake agents on it (I-HARN-9). A run with no agent
 * removes the shim's file, not the folder (E-AGT-1).
 */
const shimFirst = (dir: string) => `# tests/support/app.ts: the run's fake agents first, after path_helper, on any inherited PATH
kea_shim=${shq(dir)}
path=("$kea_shim" \${path:#$kea_shim})
unset kea_shim
`

/** The adapters other than `id` (their fake-agent shims get an environment of their own, KeaRun). */
const agentIdsExcept = (id: string): string[] => agentCommands().map((a) => a.adapter).filter((a) => a !== id)

/** The identity of every app-level run's git (the KEA_HOME's own global config). */
export const GIT_IDENTITY = { name: 'Kea Test', email: 'test@kea.invalid' }

declare const __keaPerf: { ready(): boolean; attached(): Promise<void>; screen(): string; waitText(t: string, ms?: number): Promise<number>; armEcho(ch: string): void; awaitEcho(ms?: number): Promise<number>; awaitLineBack(text: string, ms?: number): Promise<void> }
/** One live terminal view, as the renderer's test probes report it (app/renderer/src/lib/testProbes.ts). */
export interface ViewProbe {
  ptyId: string
  shown: boolean
  visible: boolean
  /** The pane it is on screen in: `work`, `agent` (the split), or null. */
  slot: 'work' | 'agent' | null
  attached: boolean
  webgl: boolean
  instance: number
  atlas: { bytes: number; pages: number; clears: Record<string, number> }
  decorations: number
  findOpen: boolean
  cols: number
  rows: number
}
/** The renderer's test probes (installed with `--kea-perf`). */
/** The few parts of a view's xterm `Terminal` the harness reads. */
export type ProbeTerminal = {
  onRender(cb: (e: { start: number; end: number }) => void): { dispose(): void }
  rows: number
  cols: number
  buffer: { active: { length: number; viewportY: number; getLine(i: number): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined } }
}
export type KeaProbe = {
  classes: Record<'Terminal' | 'SearchAddon' | 'WebglAddon', { prototype: object }>
  views(): ViewProbe[]
  glCanvas(ptyId: string): HTMLCanvasElement | null
  terminal(ptyId: string): ProbeTerminal | undefined
  text(): string
  write(data: string): Promise<void>
  setTheme(theme: Record<string, string>): void
  /** The window's keyboard-focus stand-in (`isBeingViewed`): true / false, or null to follow the page. */
  focus?(v: boolean | null): void
  /** Run a command by id with an argument (tests/support/app-tabs.ts `openFile`); false when it is not available. */
  run(id: string, args?: unknown): boolean
  /** The persisted layout with what is drawn: `split` is the panes' widths in the split, null in one column. */
  layout(): { agentBeside: boolean; agentWidth: number | null; cellWidth: number | null; drawn: { sidebar: number; tree: number }; split: { agent: number; work: number } | null }
  /** Change the layout as the View menu or a divider would, persisted. */
  setLayout(patch: { agentBeside?: boolean; agentWidth?: number | null; sidebarHidden?: boolean; treeHidden?: boolean }): void
}
declare const __keaProbe: KeaProbe
type TestApi = {
  pids(): Record<'core' | 'ptyhost', number | null>
  debug(name: 'core' | 'ptyhost', op: string, arg?: string): Promise<unknown>
  restart(name: 'core' | 'ptyhost'): Promise<void>
  counts(): Record<string, number>
  gc(): void
  /** Main's stand-in for a Kea window having keyboard focus; null follows the real windows. */
  focus?(v: boolean | null): void
}
declare const __keaTest: TestApi

/** Resolve when `check` returns a value other than undefined/false; fail after `ms` with `what` and the last error. */
export async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = STEP_MS): Promise<T> {
  const deadline = Date.now() + ms
  let last: unknown = null
  for (;;) {
    try {
      const v = await check()
      if (v !== undefined && v !== false) return v
    } catch (e) {
      last = e
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}${last ? `: ${String((last as Error).message ?? last)}` : ''}`)
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

export interface HolderState {
  ptyId: string
  sessionId: string
  pid: number
  pidStartTime: number
  childPid: number
  exited: boolean
  refusals: number
  socket: string
}

export type KeaProcess = 'main' | 'core' | 'ptyhost' | 'renderer' | 'gpu' | 'network'

/** One KEA_HOME and everything started under it. */
export class KeaRun {
  readonly home: string
  /** Seconds since the epoch when the run began (identity checks: nothing of the run's started earlier). */
  readonly since: number
  readonly zdotdir: string
  /** The run's git global config (`GIT_CONFIG_GLOBAL`): GIT_IDENTITY and nothing else. */
  readonly gitConfig: string
  /** First on PATH: a `claude` that is tools/fake-agent (writeAgentShim); a test may rewrite it. */
  readonly agentBin: string
  /** The fake agent's home (FAKE_AGENT_HOME); `<agentHome>/.claude` is CLAUDE_CONFIG_DIR. */
  readonly agentHome: string
  private readonly instances = new Set<Kea>() // bounded: the app instances of one test (a handful)
  private disposed = false
  /** The run triggers the memory watchdog on purpose (`expectWatchdog`). */
  private watchdogExpected = false
  /** The shared fallback socket root (`/tmp/kea-<uid>`) when this run's sockets go there and it did not exist yet. */
  private readonly sharedRunRoot: string | null

  private constructor(home: string) {
    this.home = home
    this.since = Math.floor(Date.now() / 1000) - 1
    this.zdotdir = path.join(home, 'zdotdir')
    fs.mkdirSync(this.zdotdir, { mode: 0o700 })
    this.agentBin = path.join(home, 'agent-bin')
    fs.writeFileSync(path.join(this.zdotdir, '.zshenv'), TEST_ZSHENV)
    fs.writeFileSync(path.join(this.zdotdir, '.zprofile'), shimFirst(this.agentBin))
    fs.writeFileSync(path.join(this.zdotdir, '.zshrc'), `${ZSHRC}${shimFirst(this.agentBin)}`)
    this.gitConfig = path.join(home, 'gitconfig')
    fs.writeFileSync(this.gitConfig, `[user]\n\tname = ${GIT_IDENTITY.name}\n\temail = ${GIT_IDENTITY.email}\n`)
    // agents: the shell pseudo-agent by default; a fake `claude` first on PATH, its home and config dir in the KEA_HOME
    fs.writeFileSync(path.join(home, 'settings.json'), `${JSON.stringify({ general: { defaultAgent: 'shell' } }, null, 2)}\n`)
    this.agentHome = path.join(home, 'agent-home')
    fs.mkdirSync(path.join(this.agentHome, '.claude'), { recursive: true, mode: 0o700 })
    // every command of every adapter (launch.ts `writeAgentShims`): `claude`, and Command Code's four names, which npm
    // installs in /opt/homebrew/bin, a folder the login shell and core's fallback environment add by themselves. The
    // fake Command Code keeps its files where Kea's adapter looks: under the run's own HOME (it has no config-dir variable)
    writeAgentShims(this.agentBin, { only: ['claude'] })
    writeAgentShims(this.agentBin, { only: agentIdsExcept('claude'), env: { FAKE_AGENT_HOME: harnessUserHome(home) } })
    const dir = runDir(home)
    const root = path.dirname(dir)
    this.sharedRunRoot = dir !== path.join(home, 'run') && !fs.existsSync(root) ? root : null
  }

  /**
   * A fresh KEA_HOME. `longPath`: a home whose `run/<ptyId>.sock` would not fit a socket path, so sockets fall back to
   * `/tmp/kea-<uid>/` (C-RES-2). `home`: an empty directory made beforehand with `KeaRun.newHome()`, for a test
   * that mounts a small volume of its own there first (C-RES-1).
   */
  static create(o: { longPath?: boolean; home?: string } = {}): KeaRun {
    if (o.home !== undefined) {
      if (path.dirname(fs.realpathSync(o.home)) !== fs.realpathSync(os.tmpdir()) || !path.basename(o.home).startsWith(homePrefix()) || fs.readdirSync(o.home).some((f) => !f.startsWith('.')))
        throw new Error(`${o.home} is not an empty home made by KeaRun.newHome()`)
      return KeaRun.checked(new KeaRun(fs.realpathSync(o.home)), false)
    }
    return KeaRun.checked(new KeaRun(KeaRun.newHome(o)), true)
  }

  /**
   * The run's login shell, with the environment Kea gets, finds `claude` as the fake agent (`assertLoginShellAgents`),
   * or the run fails and leaves nothing behind (its files go, and the home itself when `create` made it; nothing of it
   * runs yet).
   */
  private static checked(run: KeaRun, ownHome: boolean): KeaRun {
    try {
      run.checkAgents()
      return run
    } catch (e) {
      for (const f of fs.readdirSync(run.home)) fs.rmSync(path.join(run.home, f), { recursive: true, force: true })
      if (ownHome) fs.rmdirSync(run.home)
      throw e
    }
  }

  /**
   * What the login shell Kea would run with finds for each agent command: the run's fake agent when its folder is on
   * the launch's PATH, otherwise nothing (E-AGT-1); anything else throws before Kea starts.
   */
  private checkAgents(extra: Record<string, string> = {}): void {
    const env = this.launchEnv(extra)
    assertLoginShellAgents(env, this.agentsOn(env))
  }

  /** The run's fake-agent folder when it is on `env`'s PATH (the launch's agents are then its fakes), else null (it must find none). */
  private agentsOn(env: Record<string, string>): string | null {
    return (env.PATH ?? '').split(':').includes(this.agentBin) ? this.agentBin : null
  }

  /** A fresh, empty directory for a KEA_HOME (what `create` uses), with the run's prefix, in the temp directory. */
  static newHome(o: { longPath?: boolean } = {}): string {
    const prefix = o.longPath ? `${homePrefix()}long-${'x'.repeat(64)}-` : homePrefix()
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  }

  /**
   * What every launch of this run adds so agents are never the real CLIs: the fake `claude` first on PATH (and no
   * directory holding a real one after it; the ZDOTDIR puts the folder first again after path_helper), its home and
   * config dir.
   */
  agentEnv(): Record<string, string> {
    return { PATH: `${this.agentBin}:${pathWithoutAgents()}`, FAKE_AGENT_HOME: this.agentHome, CLAUDE_CONFIG_DIR: path.join(this.agentHome, '.claude') }
  }

  /** What `launch` passes to `launchKea` as `env`: the run's shell, git identity and agents, then `extra`. */
  env(extra: Record<string, string> = {}): Record<string, string> {
    return { SHELL: RUN_SHELL, ZDOTDIR: this.zdotdir, GIT_CONFIG_GLOBAL: this.gitConfig, GIT_CONFIG_NOSYSTEM: '1', ...this.agentEnv(), ...extra }
  }

  /** The whole environment Kea starts with on this run (`launchEnv` over `env(extra)`). */
  launchEnv(extra: Record<string, string> = {}): Record<string, string> {
    return launchEnv({ home: this.home, env: this.env(extra) })
  }

  /**
   * For a Kea on this run's home that a test types into a shell of `parent`'s Kea (I-HLD-30, I-HLD-31) instead of
   * starting it with `launch`: the `VAR=value` words to type before the command, after the same check `launch` makes.
   * That Kea inherits the shell's environment (the parent's login shell's PATH, with the parent's fake agents) and gets
   * this run's ZDOTDIR and its own fake agents ahead of them; throws unless it would then find each agent command as
   * this run's fake or nowhere, in its login shell and in core's fallback environment (`assertLoginShellAgents`). Its
   * HOME is this run's own, as a launch's is: the harness keeps a run's stand-in for the person's home inside its
   * KEA_HOME, so with the parent's HOME it would write into the parent's home what a person's Kea keeps in theirs
   * (Electron's userData on Linux).
   */
  handStartWords(parent: KeaRun): string {
    const from = parent.launchEnv()
    const home = harnessUserHome(this.home)
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    const shellPath = loginShellLookup({ ...from, HOME: home }).path
    assertLoginShellAgents({ ...from, HOME: home, SHELL: RUN_SHELL, ZDOTDIR: this.zdotdir, PATH: [this.agentBin, ...shellPath].join(':') }, this.agentBin)
    return `HOME=${shq(home)} PATH=${shq(this.agentBin)}:"$PATH" SHELL=${RUN_SHELL} ZDOTDIR=${shq(this.zdotdir)}`
  }

  /**
   * This run triggers the memory watchdog on purpose, as the watchdog's own tests do: `dispose` does not fail for its
   * triggers. Every other run fails for one.
   */
  expectWatchdog(): void {
    this.watchdogExpected = true
  }

  /** Where this run's sockets live. */
  get runDir(): string {
    return runDir(this.home)
  }

  /**
   * Launch Kea on this home (unfocused); resolves once a terminal is attached, or with `ready: 'window'` once the window
   * is drawn (a relaunch onto a session with no terminal, such as a failed creation, attaches none). `env`: more variables.
   * `maxFiles`: the open-file limit, soft and hard, Kea and everything it starts run under (`ulimit -n`, C-RES-3).
   * `focused`: whether the window counts as having keyboard focus (`Kea.pretendFocused`); default false, as it really is.
   * `dist`: another build than the suites' (a build N+1 for C-UPD-5: a copy of `testAppDist()` with another version).
   */
  async launch(o: { args?: string[]; ready?: 'terminal' | 'window'; env?: Record<string, string>; maxFiles?: number; focused?: boolean; dist?: string } = {}): Promise<Kea> {
    if (this.disposed) throw new Error('run disposed')
    // every launch is checked again by `launchKea`, whatever its environment: `create` checked the run as it was then,
    // and a test may have changed its files since (a fake agent taken away, another put somewhere)
    const env = this.env(o.env)
    let executable: string | undefined
    if (o.maxFiles !== undefined) {
      executable = path.join(this.home, 'electron-limited.sh')
      fs.writeFileSync(executable, `#!/bin/sh\nulimit -S -H -n ${o.maxFiles} || exit 97\nexec ${shq(electronBinary())} "$@"\n`, { mode: 0o755 })
    }
    const app = await launchKea({ dist: o.dist ?? testAppDist(), home: this.home, args: o.args ?? [], env, agents: this.agentsOn(env), timeoutMs: STEP_MS, ...(executable ? { executable } : {}) })
    const pid = app.process().pid
    const main = pid ? processInfo(pid) : null
    if (!main) {
      await app.close().catch(() => undefined)
      throw new Error('Kea exited at launch')
    }
    const kea = new Kea(this, app, main)
    this.instances.add(kea)
    await kea.pretendFocused(o.focused ?? false, { page: false })
    if (o.ready === 'window') await kea.whenDrawn()
    else await kea.whenReady()
    return kea
  }

  /** Holders of this run from their state files, live or not. */
  holders(): HolderState[] {
    const out: HolderState[] = []
    const dir = path.join(this.home, 'sessions')
    if (!fs.existsSync(dir)) return out
    for (const s of fs.readdirSync(dir))
      for (const f of fs.readdirSync(path.join(dir, s))) {
        if (!f.endsWith('.json') || f.startsWith('.')) continue
        try {
          out.push(JSON.parse(fs.readFileSync(path.join(dir, s, f), 'utf8')) as HolderState)
        } catch {
          // being rewritten (atomic rename): the next read sees it
        }
      }
    return out
  }

  holder(ptyId: string): HolderState {
    const h = this.holders().find((x) => x.ptyId === ptyId)
    if (!h) throw new Error(`no holder state for ${ptyId}`)
    return h
  }

  /** The holder is the same live process its state file names (pid, start time, executable). */
  holderAlive(h: HolderState): boolean {
    return isSameHolder(h)
  }

  /** A holder's ring: its latest seq and the text from `from` (clamped to what it still holds). */
  ring(ptyId: string, from = 0): { latest: number; earliest: number; text: string } {
    const h = this.holder(ptyId)
    const file = path.join(this.home, 'sessions', h.sessionId, `${ptyId}.ring`)
    const r = readRing(new Uint8Array(fs.readFileSync(file)), from)
    if (!r) throw new Error(`ring of ${ptyId} unreadable`)
    return { latest: r.seq + r.data.byteLength, earliest: r.seq, text: Buffer.from(r.data).toString('latin1') }
  }

  /** A holder's latest seq, from its ring file's header alone (written after the data), cheap enough to poll. */
  ringLatest(ptyId: string): number {
    const h = this.holder(ptyId)
    const fd = fs.openSync(path.join(this.home, 'sessions', h.sessionId, `${ptyId}.ring`), 'r')
    try {
      const head = new Uint8Array(L.ringHeaderBytes)
      fs.readSync(fd, head, 0, head.length, 0)
      const r = parseRingHeader(head)
      if (!r) throw new Error(`ring header of ${ptyId} unreadable`)
      return r.latestSeq
    } finally {
      fs.closeSync(fd)
    }
  }

  /** Signal a holder only if it is still the process its state file names. */
  signalHolder(h: HolderState, sig: NodeJS.Signals): void {
    if (!isSameHolder(h)) throw new Error(`holder ${h.pid} is not the run's holder any more`)
    process.kill(h.pid, sig)
  }

  /** Signal a process of this run found earlier, after checking again that it is that process (pid, start, executable). */
  signalProcess(p: ProcInfo, sig: NodeJS.Signals): void {
    if (!signalKnown(p, sig)) throw new Error(`${p.pid} (${p.comm}) is not the process it was`)
  }

  /** SIGKILL a holder and everything below it (its shell and whatever that started), each identity-checked. */
  killHolderTree(h: HolderState): void {
    if (!isSameHolder(h)) throw new Error(`holder ${h.pid} is not the run's holder any more`)
    const tree = descendants([h.pid]).filter((p) => p.start >= this.since)
    process.kill(h.pid, 'SIGKILL')
    for (const p of tree) signalKnown(p, 'SIGKILL')
  }

  /**
   * SIGKILL several holders together (many sessions changing status at once, P-UI-7): every one is checked first (pid,
   * start time, executable), then all are killed in one go, so they die within the same moment. Their shells get the
   * PTY's hangup.
   */
  killHolders(hs: readonly HolderState[]): void {
    for (const h of hs) if (!isSameHolder(h)) throw new Error(`holder ${h.pid} is not the run's holder any more`)
    for (const h of hs) process.kill(h.pid, 'SIGKILL')
  }

  /** Processes of this run still alive: Electron processes and holders with their trees. */
  leftovers(): ProcInfo[] {
    const table = processTable()
    const holders = table.filter((p) => path.basename(p.comm) === 'kea-helper' && p.args.includes(` ${this.home}/sessions/`))
    const tree = descendants(
      holders.map((h) => h.pid),
      table,
    ).filter((p) => p.start >= this.since)
    return [...runAppProcesses(this.home, { table }), ...holders, ...tree]
  }

  /**
   * End everything of the run but leave its files: close every instance, kill each live holder with what runs under it
   * (identity-checked), and wait until nothing of the run is alive. A test whose home is a volume of its own does this
   * before the volume goes (C-RES-1); `dispose` afterwards removes what is left.
   */
  async closeAll(): Promise<void> {
    for (const k of this.instances) await k.close().catch(() => undefined)
    for (const h of this.holders()) if (this.holderAlive(h)) this.killHolderTree(h)
    await until('nothing of the run alive', () => this.leftovers().length === 0 || undefined)
  }

  /**
   * Close every instance, kill what is left of the run (identity-checked), remove its directories, and check that
   * nothing of it survived.
   */
  async dispose(): Promise<CleanupReport> {
    if (this.disposed) throw new Error('run disposed twice')
    this.disposed = true
    for (const k of this.instances) await k.close().catch(() => undefined)
    // KEA_TEST_LOGS=<dir>: keep each run's logs for diagnosis (the home itself is always removed)
    const keep = process.env.KEA_TEST_LOGS
    if (keep && fs.existsSync(path.join(this.home, 'logs'))) fs.cpSync(path.join(this.home, 'logs'), path.join(keep, path.basename(this.home)), { recursive: true })
    // watchdog triggers: read before the logs go, reported once everything of the run is cleaned up
    const triggers = this.watchdogExpected ? [] : watchdogTriggers(this.home)
    // the same for a Kea that was made the frontmost app and hid itself (frontGuard.ts)
    const fronts = frontSteps(this.home)
    // what runs under the run's holders goes first: an agent (tools/fake-agent) ends gracefully when its holder dies,
    // and its last hook would write into the home while it is being removed; a write that still lands mid-removal
    // (ENOTEMPTY) is met by another pass
    let report: CleanupReport | null = null
    for (let pass = 0; !report; pass++) {
      const table = processTable()
      const holders = table.filter((p) => path.basename(p.comm) === 'kea-helper' && p.args.includes(` ${this.home}/sessions/`))
      for (const p of descendants(
        holders.map((h) => h.pid),
        table,
      ).filter((p) => p.start >= this.since))
        signalKnown(p, 'SIGKILL')
      try {
        report = cleanupHome(this.home, this.since)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || pass >= 2) throw e
      }
    }
    const dirs = extraDirs(this.home)
    const left = await until('the run to leave nothing behind', () => this.leftovers().length === 0 || undefined, STEP_MS).catch(() => null)
    const still = this.leftovers()
    if (left === null && still.length) throw new Error(`still alive after cleanup: ${still.map((p) => `${p.pid} ${p.comm}`).join(', ')}`)
    for (const d of [this.home, ...dirs]) if (fs.existsSync(d)) throw new Error(`not removed: ${d}`)
    // the shared fallback root this run created, once empty (another run's directory in it keeps it)
    if (this.sharedRunRoot)
      try {
        fs.rmdirSync(this.sharedRunRoot)
      } catch (e) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e
      }
    if (triggers.length) throw new Error(`the memory watchdog triggered during this run (every trigger is a bug):\n  ${triggers.join('\n  ')}`)
    if (fronts.length) throw new Error(`Kea was made the frontmost app during this run and hid itself (each line says what woke last; \`caffeinate -d\` keeps the display awake for a run):\n  ${fronts.join('\n  ')}`)
    return report
  }
}

/** The message of main's log line for a test build that was made the frontmost app (app/main/src/frontGuard.ts `FRONT_LOG`). */
export const FRONT_LOG = 'perf: Kea became the frontmost app and stepped back'

/**
 * Every time a Kea of the run on `home` was made the frontmost app and stepped back, as main's error lines, rotated
 * files included. Empty: never, which is what every run must leave.
 */
export function frontSteps(home: string): string[] {
  const dir = path.join(home, 'logs')
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const f of fs.readdirSync(dir).sort()) {
    if (f !== 'main.log' && !f.startsWith('main.log.')) continue
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!l.includes('frontmost')) continue
      try {
        if ((JSON.parse(l) as { msg?: unknown }).msg === FRONT_LOG) out.push(`${f}: ${l}`)
      } catch {
        // not a log line
      }
    }
  }
  return out
}

/** The message of main's log line for a watchdog trigger (app/main/src/watchdog.ts). */
export const WATCHDOG_LOG = 'watchdog: limit exceeded'

/**
 * Every watchdog trigger a run on `home` left in its logs, as text: main's error lines, rotated files
 * included, and the `resources.ndjson` lines written for a trigger. Empty: none, which is what every run but the
 * watchdog's own must leave.
 */
export function watchdogTriggers(home: string): string[] {
  const dir = path.join(home, 'logs')
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const f of fs.readdirSync(dir).sort()) {
    const isMain = f === 'main.log' || f.startsWith('main.log.')
    const isResources = f === 'resources.ndjson' || f.startsWith('resources.ndjson.')
    if (!isMain && !isResources) continue
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!l.includes('watchdog')) continue
      let e: { msg?: unknown; trigger?: unknown; watchdog?: unknown }
      try {
        e = JSON.parse(l) as typeof e
      } catch {
        continue
      }
      if (isMain && e.msg === WATCHDOG_LOG) out.push(`${f}: ${l}`)
      else if (isResources && e.trigger === 'watchdog') out.push(`${f}: ${JSON.stringify(e.watchdog)}`)
    }
  }
  return out
}

/** One running Kea instance of a run. */
export class Kea {
  readonly run: KeaRun
  readonly app: ElectronApplication
  readonly main: ProcInfo
  private closed = false
  private current: Page | null = null
  private readonly crashed = new WeakSet<Page>()
  /** A second CDP connection, made once the renderer has crashed (see `page`). */
  private cdp: Browser | null = null
  /** What the window is said to have for keyboard focus (`pretendFocused`); every ready page is told again. */
  private focusStandIn: boolean | null = false

  constructor(run: KeaRun, app: ElectronApplication, main: ProcInfo) {
    this.run = run
    this.app = app
    this.main = main
  }

  /**
   * The window's page. Playwright never revives a page whose renderer crashed, although main reloads the same window in
   * a new renderer; after a crash the page is reached through a fresh CDP connection to the app (its port is in
   * the userData directory's DevToolsActivePort, as with any Chromium started with a remote-debugging port of 0).
   */
  async page(): Promise<Page> {
    if (this.current?.isClosed()) this.current = null // the window was closed: a reopened one is a new page
    const p = this.current ?? this.app.windows()[0] ?? (await this.app.firstWindow({ timeout: STEP_MS }))
    if (p !== this.current) {
      p.on('crash', () => this.crashed.add(p))
      this.current = p
    }
    if (!this.crashed.has(p)) return p
    await this.cdp?.close().catch(() => undefined)
    const [port, wsPath] = fs.readFileSync(path.join(userDataDir(this.run.home, false), 'DevToolsActivePort'), 'utf8').split('\n')
    this.cdp = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${wsPath}`, { timeout: STEP_MS })
    const fresh = await until('the reloaded window over CDP', () => this.cdp?.contexts().flatMap((c) => c.pages()).find((x) => x.url().startsWith('kea://')))
    fresh.on('crash', () => this.crashed.add(fresh))
    this.current = fresh
    return fresh
  }

  /**
   * A loaded window: a terminal attached (its stream comes from ptyhost), on screen and holding the page's keyboard
   * (TerminalArea focuses it once painted, a frame after the attach: keys typed sooner, as soon as the shell's prompt is
   * in its buffer, would reach nothing), the tab strip filled from core's terminals store (its RPC port arrives
   * separately), and no keyboard focus taken from other apps (the window is never key).
   */
  async whenReady(): Promise<void> {
    const page = await this.page()
    await page.waitForFunction(() => typeof __keaPerf !== 'undefined' && __keaPerf.ready(), null, { timeout: STEP_MS })
    await withDeadline('the active terminal to attach', page.evaluate(() => __keaPerf.attached())).catch(async (e: Error) => {
      throw new Error(`${e.message}\n${await this.diagnosis()}`)
    })
    await page
      .waitForFunction(
        () => {
          // one terminal on screen per pane: the one with the keyboard is any of them (the agent's, in the split)
          const a = document.activeElement
          return !!a && [...document.querySelectorAll('.terminal-host.shown')].some((h) => h.contains(a))
        },
        null,
        { timeout: STEP_MS },
      )
      .catch(async (e: Error) => {
        throw new Error(`the terminal on screen never took the page's keyboard: ${e.message}\n${await this.diagnosis()}`)
      })
    // a tab in the strip, or the agent pane beside a work pane that has none
    await page.waitForFunction(() => document.querySelector('[role=tab].tab:not(.add), .agent-pane[data-pty]') !== null, null, { timeout: STEP_MS })
    await this.tellPageFocus(page)
    await this.assertUnfocused()
  }

  /** The window drawn (its sidebar there) and the test probes installed, terminal or not; no keyboard focus taken. */
  async whenDrawn(): Promise<void> {
    const page = await this.page()
    await page.waitForFunction(() => typeof __keaPerf !== 'undefined' && document.querySelector('aside[aria-label=Sidebar]') !== null, null, { timeout: STEP_MS })
    await this.tellPageFocus(page)
    await this.assertUnfocused()
  }

  /**
   * Say the window has keyboard focus (true), has not (false), or follow the real window (null), on both sides: main
   * tells core the app's focus, and the window tells core what it views (`isBeingViewed`). A test window is
   * never key, but Playwright's page reports `document.hasFocus()` true, so every launch starts at false (`launch`'s
   * `focused`); a test that needs a focused window says so. A reloaded or reopened page is told again once ready.
   * `page: false`: main only (before the window is up).
   */
  async pretendFocused(v: boolean | null, o: { page?: boolean } = {}): Promise<void> {
    this.focusStandIn = v
    await this.app.evaluate((_e, x) => (globalThis as unknown as { __keaTest: TestApi }).__keaTest.focus?.(x), v)
    if (o.page !== false) await this.tellPageFocus(await this.page())
  }

  private async tellPageFocus(page: Page): Promise<void> {
    await page.evaluate((x) => (globalThis as unknown as { __keaProbe?: Partial<KeaProbe> }).__keaProbe?.focus?.(x), this.focusStandIn)
  }

  /** What a failed wait reports: the tabs, the views and the tail of each process's log. */
  async diagnosis(): Promise<string> {
    const page = await this.page()
    const ui = await page
      .evaluate(() => ({
        tabs: [...document.querySelectorAll('[role=tab].tab:not(.add)')].map((t) => t.textContent),
        hosts: [...document.querySelectorAll('.terminal-host')].map((h) => `${h.getAttribute('data-pty')} ${h.className}`),
        focus: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}.${document.activeElement.className}` : null,
        resources: typeof __keaPerf !== 'undefined' ? (__keaPerf as unknown as { resources(): unknown }).resources() : null,
      }))
      .catch((e: Error) => ({ error: e.message }))
    const tail = (p: 'main' | 'core' | 'ptyhost') => this.logLines(p).slice(-12).map((l) => `  ${p}: ${JSON.stringify(l)}`)
    return [`window: ${JSON.stringify(ui)}`, ...tail('main'), ...tail('core'), ...tail('ptyhost')].join('\n')
  }

  /**
   * The window is shown and not key, and no Kea process is the frontmost app: keystrokes meant for other apps cannot
   * reach a test shell (under `--kea-perf` main makes the window non-focusable and shows it inactive). Where
   * the run draws on a display of its own (Linux's Xvfb, `harnessOs.display`) nobody else types into it, and the X server,
   * with no window manager, may give the window its focus: nothing to check there.
   */
  async assertUnfocused(): Promise<void> {
    if (!harnessOs.display.shared) return
    const w = await this.app.evaluate(({ BrowserWindow }) => ({ focused: BrowserWindow.getFocusedWindow()?.id ?? null, visible: BrowserWindow.getAllWindows().map((x) => x.isVisible()) }))
    if (w.focused !== null) throw new Error('a Kea window took keyboard focus')
    const front = frontmostPid()
    if (front !== null && this.run.leftovers().some((p) => p.pid === front)) throw new Error(`Kea (pid ${front}) is the frontmost app`)
  }

  // ── processes ──────────────────────────────────────────────────────────────────────

  /**
   * The instance's processes, each checked to be below this main (main itself included): its children on macOS; on
   * Linux the GPU process and the renderer are Chromium's zygotes' children.
   */
  async processes(): Promise<Record<KeaProcess, ProcInfo | null>> {
    const r = await this.app.evaluate(({ app, BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const m = app.getAppMetrics()
      const k = (globalThis as unknown as { __keaTest: TestApi }).__keaTest.pids()
      return { renderer: w && !w.isDestroyed() ? w.webContents.getOSProcessId() : null, gpu: m.find((x) => x.type === 'GPU')?.pid ?? null, network: m.find((x) => x.serviceName === 'network.mojom.NetworkService')?.pid ?? null, ...k }
    })
    const table = processTable()
    const below = new Map(descendants([this.main.pid], table).map((p) => [p.pid, p]))
    const child = (pid: number | null) => {
      const p = pid ? below.get(pid) : undefined
      return p && p.start >= this.run.since ? p : null
    }
    return { main: stillSame(this.main) ? this.main : null, core: child(r.core), ptyhost: child(r.ptyhost), renderer: child(r.renderer), gpu: child(r.gpu), network: child(r.network) }
  }

  async pid(which: KeaProcess): Promise<ProcInfo> {
    const p = (await this.processes())[which]
    if (!p) throw new Error(`no ${which} process`)
    return p
  }

  /**
   * Send `sig` to one of this instance's processes (identity checked first); returns the process signalled. Killing
   * the renderer waits for its crash to reach Playwright, so no later call lands on the dead page.
   */
  async signal(which: KeaProcess, sig: NodeJS.Signals): Promise<ProcInfo> {
    const p = await this.pid(which)
    const crash = which === 'renderer' && sig === 'SIGKILL' ? (await this.page()).waitForEvent('crash', { timeout: STEP_MS }) : null
    if (!signalKnown(p, sig)) throw new Error(`${which} (${p.pid}) is not the process it was`)
    if (which === 'main' && sig === 'SIGKILL') this.closed = true
    await crash
    return p
  }

  /** Wait until `which` runs as a new process (another pid than `old`) that has reported ready. */
  async restarted(which: 'core' | 'ptyhost', old: ProcInfo): Promise<ProcInfo> {
    return until(`${which} to restart`, async () => {
      const p = (await this.processes())[which]
      if (!p || p.pid === old.pid) return undefined
      return (await this.started(which, p.pid)) ? p : undefined
    })
  }

  /** Has `which` with this pid written its `started` log line (core and ptyhost log it once ready to serve)? */
  started(which: 'core' | 'ptyhost', pid: number): boolean {
    return this.logLines(which).some((l) => l.msg === 'started' && l.pid === pid)
  }

  /** A process's log (`<KEA_HOME>/logs/<proc>.log`, one JSON object per line). */
  logLines(proc: 'main' | 'core' | 'ptyhost'): { t: string; msg: string; [k: string]: unknown }[] {
    const file = path.join(this.run.home, 'logs', `${proc}.log`)
    if (!fs.existsSync(file)) return []
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as { t: string; msg: string }]
        } catch {
          return []
        }
      })
  }

  // ── test hooks (app/main/src/testHooks.ts, tests/support/app-child-hooks.cjs) ─────────────

  debug<T = unknown>(name: 'core' | 'ptyhost', op: 'gc' | 'heap' | 'handles' | 'kit' | 'ports' | 'snapshot' | 'streams' | 'hold' | 'status' | 'lateReplies' | 'timers' | 'scan' | 'alloc' | 'children', arg?: string): Promise<T> {
    return withDeadline(
      `${name} ${op}`,
      this.app.evaluate((_e, a) => (globalThis as unknown as { __keaTest: TestApi }).__keaTest.debug(a.name, a.op, a.arg), { name, op, arg }) as Promise<T>,
    )
  }

  mainCounts(): Promise<Record<string, number>> {
    return this.app.evaluate(() => (globalThis as unknown as { __keaTest: TestApi }).__keaTest.counts())
  }

  gcMain(): Promise<void> {
    return this.app.evaluate(() => (globalThis as unknown as { __keaTest: TestApi }).__keaTest.gc())
  }

  supervisorRestart(name: 'core' | 'ptyhost'): Promise<void> {
    return this.app.evaluate((_e, n) => (globalThis as unknown as { __keaTest: TestApi }).__keaTest.restart(n), name)
  }

  /**
   * Start a stray copy of core or ptyhost for this KEA_HOME, as a utility process of this main with the arguments the
   * running one has; resolves with its exit code and the messages it sent before exiting (its stderr, if it
   * wrote any, as a last `{ stderr }` entry).
   */
  async forkStray(name: 'core' | 'ptyhost'): Promise<{ code: number; messages: unknown[] }> {
    // main's own arguments for its children (app/main/src/main.ts): this home, the version it logged, a dev build
    const version = this.logLines('main').find((l) => l.msg === 'starting')?.version
    if (typeof version !== 'string') throw new Error('main has not logged its version')
    const args = childArgv({ home: this.run.home, version, dev: true, helper: HELPER })
    const entry = path.join(testAppDist(), `${name}.cjs`)
    return withDeadline(
      `a stray ${name} to exit`,
      this.app.evaluate(
        ({ utilityProcess }, a) =>
          new Promise<{ code: number; messages: unknown[] }>((resolve) => {
            const messages: unknown[] = []
            const c = utilityProcess.fork(a.entry, a.args, { serviceName: `stray ${a.name}`, stdio: 'pipe' })
            let err = ''
            c.stderr?.on('data', (d: Buffer) => (err += d.toString()))
            c.on('message', (m: unknown) => messages.push(m))
            c.on('exit', (code: number) => resolve({ code, messages: [...messages, ...(err ? [{ stderr: err }] : [])] }))
          }),
        { entry, args, name },
      ),
    )
  }

  /**
   * Reload the window as a person does in a dev build: Developer › Reload Window (app/main/src/menu.ts), the menu
   * item's own click handler; resolves once the reloaded window is ready (`whenReady`).
   */
  async reloadWindow(): Promise<void> {
    const page = await this.page()
    const loaded = page.waitForEvent('load', { timeout: STEP_MS })
    const clicked = await this.app.evaluate(({ Menu }) => {
      type Item = { label: string; click(): void; submenu?: { items: Item[] } | null }
      const find = (items: Item[]): Item | null => {
        for (const it of items) {
          if (it.label === 'Reload Window') return it
          const sub = it.submenu ? find(it.submenu.items) : null
          if (sub) return sub
        }
        return null
      }
      const item = find((Menu.getApplicationMenu()?.items ?? []) as unknown as Item[])
      item?.click()
      return item !== null
    })
    if (!clicked) throw new Error('no Developer › Reload Window menu item (not a dev build?)')
    await loaded
    await this.whenReady()
  }

  /** Close the window as its close button does; resolves once its page is gone. Kea keeps running. */
  async closeWindow(): Promise<void> {
    const page = await this.page()
    const closed = page.waitForEvent('close', { timeout: STEP_MS })
    const n = await this.app.evaluate(({ BrowserWindow }) => {
      const ws = BrowserWindow.getAllWindows()
      for (const w of ws) w.close()
      return ws.length
    })
    if (n !== 1) throw new Error(`expected one window to close, found ${n}`)
    await closed
    this.current = null
  }

  /**
   * Reopen the window as clicking the Dock icon does (`activate`). Resolves once the new window is ready, with
   * the time from the click to its terminal being attached (the snapshot written), read on the renderer's clock.
   */
  async reopenWindow(): Promise<{ attachedMs: number }> {
    const next = this.app.waitForEvent('window', { timeout: STEP_MS })
    const clicked = Date.now()
    await this.app.evaluate(({ app }) => {
      app.emit('activate')
    })
    const page = await next
    this.current = null
    await page.waitForFunction(() => typeof __keaPerf !== 'undefined' && __keaPerf.ready(), null, { timeout: STEP_MS })
    const attachedAt = await withDeadline(
      'the reopened window’s terminal to attach',
      page.evaluate(() => __keaPerf.attached().then(() => performance.timeOrigin + performance.now())),
    )
    await this.whenReady()
    return { attachedMs: attachedAt - clicked }
  }

  /**
   * Quit Kea completely from the menu (`app.quit`, ⌥⌘Q): main asks core and ptyhost to shut down, waits for
   * them, then exits. Resolves with main's exit status once it has exited.
   */
  async quitFromMenu(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const proc = this.app.process()
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) resolve({ code: proc.exitCode, signal: proc.signalCode })
      else proc.once('exit', (code, signal) => resolve({ code, signal }))
    })
    await this.app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('app.quit')
      if (!item) throw new Error('no app.quit menu item')
      ;(item as unknown as { click(): void }).click()
    })
    this.closed = true
    await this.cdp?.close().catch(() => undefined)
    this.cdp = null
    return withDeadline('main to exit after Quit Kea Completely', exited)
  }

  /** `app.getAppMetrics()`: every process main knows as its own (Chromium helpers and utility processes, by name). */
  async appMetrics(): Promise<{ pid: number; type: string; name: string | null; serviceName: string | null }[]> {
    return this.app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name ?? null, serviceName: m.serviceName ?? null })))
  }

  /**
   * Why this run's terminals draw without WebGL, or null when Chromium has WebGL2 here (main's own reading): a
   * machine with no GPU driver, as a VM or a CI runner, or the harness's Xvfb on Linux. The tests of the WebGL renderer
   * (its contexts, its atlas) skip by name where it is not null.
   */
  async webglProblem(): Promise<string | null> {
    const features = await this.app.evaluate(({ app }) => app.getGPUFeatureStatus() as unknown as Record<string, string | undefined>)
    return webglOn(webglState(features)) ? null : `no WebGL2 here (${webglState(features) || 'unknown'}): the terminals draw with xterm's DOM renderer`
  }

  // ── tabs and the screen ─────────────────────────────────────────────────────────────

  async tabCount(): Promise<number> {
    return (await this.page()).locator('[role=tab].tab:not(.add)').count()
  }

  /**
   * The terminal on screen in `pane` (`work`, or `agent` in the split); with no pane named, the terminal with the
   * keyboard, else the active pane's (the one that last had it) on screen. In one column there is one pane, `work`.
   */
  async shown(pane?: 'work' | 'agent'): Promise<string | null> {
    return (await this.page()).evaluate((p) => {
      const inPane = (name: string) => document.querySelector(`.terminal-area[data-pane="${name}"] .terminal-host.shown`)?.getAttribute('data-pty') ?? null
      if (p) return inPane(p)
      const kb = document.activeElement?.closest('.terminal-host.shown')?.getAttribute('data-pty')
      if (kb) return kb
      const active = document.querySelector('[data-active-pane]')?.getAttribute('data-active-pane') ?? 'work'
      return inPane(active) ?? document.querySelector('.terminal-host.shown')?.getAttribute('data-pty') ?? null
    }, pane ?? null)
  }

  /** The terminal with the keyboard, or null when the keyboard is anywhere else. */
  async keyboard(): Promise<string | null> {
    return (await this.page()).evaluate(() => document.activeElement?.closest('.terminal-host.shown')?.getAttribute('data-pty') ?? null)
  }

  /** Every terminal on screen, one per pane. */
  async onScreen(): Promise<string[]> {
    return (await this.page()).evaluate(() => [...document.querySelectorAll('.terminal-host.shown')].map((h) => h.getAttribute('data-pty') ?? ''))
  }

  /** The window's layout as the renderer's probe reports it. */
  async layout(): Promise<ReturnType<KeaProbe['layout']>> {
    return (await this.page()).evaluate(() => __keaProbe.layout())
  }

  /** Change the window's layout (the split's toggle, the agent's width, a column hidden), as the View menu would. */
  async setLayout(patch: Parameters<KeaProbe['setLayout']>[0]): Promise<void> {
    await (await this.page()).evaluate((p) => __keaProbe.setLayout(p), patch)
  }

  /**
   * Show the agent as a tab (View ▸ Show Agent as a Tab), for a test of one column: the Agent tab first in the strip, one
   * terminal on screen. Resolves once the split is not drawn.
   */
  async oneColumn(): Promise<void> {
    await this.setLayout({ agentBeside: false })
    await until('one column', async () => ((await this.layout()).split === null ? true : undefined))
  }

  /** Size the window's content as a person dragging its edge would; resolves once the page has the new width. */
  async resize(width: number, height: number): Promise<void> {
    await this.app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height), { width, height })
    const page = await this.page()
    await until(`the window ${width} px wide`, () => page.evaluate((w) => window.innerWidth === w, width).then((ok) => ok || undefined))
  }

  /** Open a shell tab (⌘T); resolves with its ptyId once its prompt is on screen. */
  async newTab(): Promise<string> {
    const page = await this.page()
    const known = new Set(this.run.holders().map((h) => h.ptyId))
    await page.keyboard.press(sysKey('Meta+t'))
    // a new tab becomes the one on screen once the terminals store lists it (shell/TerminalPane.svelte); its ptyId is a new holder's
    const id = await until('a new tab on screen', async () => {
      const s = await this.shown()
      return s && !known.has(s) ? s : undefined
    })
    await this.waitScreen('the new shell prompt', (s) => s.includes(PROMPT))
    return id
  }

  /** Make `ptyId` the terminal on screen, stepping through the tabs (⌘⇧]); the tab order is the renderer's. */
  async select(ptyId: string): Promise<void> {
    const page = await this.page()
    // in the split the agent has a pane of its own, not a tab: its key gives that pane the keyboard
    if ((await this.shown('agent')) === ptyId) {
      await page.keyboard.press(sysKey('Meta+BracketRight'))
      await until(`${ptyId} with the keyboard`, async () => (await this.shown()) === ptyId || undefined)
      return
    }
    const n = await this.tabCount()
    for (let i = 0; i <= n; i++) {
      if ((await this.shown()) === ptyId) return
      const cur = await this.shown()
      await page.keyboard.press(sysKey('Meta+Shift+BracketRight'))
      await until('the next tab on screen', async () => (await this.shown()) !== cur || n === 1 || undefined)
    }
    throw new Error(`no tab shows ${ptyId}`)
  }

  /** Click the tab of `ptyId` (the way a person switches with the mouse); resolves once its terminal is on screen. */
  async clickTab(ptyId: string): Promise<void> {
    const page = await this.page()
    // in the split the agent has a pane of its own, not a tab: a click in it gives it the keyboard
    if ((await this.shown('agent')) === ptyId) await page.locator('.agent-pane .terminal-host.shown').click({ position: { x: 20, y: 20 }, timeout: STEP_MS })
    else await page.locator(`[role=tab][data-pty="${ptyId}"]`).click({ timeout: STEP_MS })
    await until(`${ptyId} on screen`, async () => (await this.shown()) === ptyId || undefined)
  }

  /** The ptyIds of the tabs, in the strip's order. */
  async tabIds(): Promise<string[]> {
    return (await this.page()).evaluate(() => [...document.querySelectorAll('[role=tab][data-pty]')].map((t) => t.getAttribute('data-pty') ?? ''))
  }

  /** The ptyIds of every tab (visits each one). */
  async tabPtys(): Promise<string[]> {
    const n = await this.tabCount()
    const page = await this.page()
    const seen: string[] = []
    for (let i = 0; i < n; i++) {
      const cur = await until('a terminal on screen', () => this.shown().then((s) => s ?? undefined))
      if (!seen.includes(cur)) seen.push(cur)
      if (i < n - 1) {
        await page.keyboard.press(sysKey('Meta+Shift+BracketRight'))
        await until('the next tab on screen', async () => (await this.shown()) !== cur || undefined)
      }
    }
    return seen
  }

  /** Every live terminal view (the renderer's test probes, app/renderer/src/lib/testProbes.ts). */
  async views(): Promise<ViewProbe[]> {
    return (await this.page()).evaluate(() => __keaProbe.views())
  }

  /**
   * The whole buffer of one live view (on screen or warm), scrollback included, one entry per logical line: a row
   * that continues the one above (a wrapped line) is joined to it, so a line reads as the program wrote it.
   */
  async terminalText(ptyId: string): Promise<string> {
    return (await this.page()).evaluate((id) => {
      const t = __keaProbe.terminal(id)
      if (!t) throw new Error(`no live view of ${id}`)
      const b = t.buffer.active
      const out: string[] = []
      for (let i = 0; i < b.length; i++) {
        const l = b.getLine(i)
        if (!l) continue
        const s = l.translateToString(true)
        if (l.isWrapped && out.length) out[out.length - 1] += s
        else out.push(s)
      }
      return out.join('\n')
    }, ptyId)
  }

  /** Visible text of the terminal on screen. */
  async screen(): Promise<string> {
    return (await this.page()).evaluate(() => __keaPerf.screen())
  }

  async waitScreen(what: string, pred: (screen: string) => boolean, ms = STEP_MS): Promise<string> {
    let last = ''
    try {
      return await until(
        what,
        async () => {
          last = await this.screen()
          return pred(last) ? last : undefined
        },
        ms,
      )
    } catch (e) {
      throw new Error(`${(e as Error).message}\n--- screen ---\n${last}\n--- state ---\n${await this.diagnosis()}`)
    }
  }

  async type(text: string): Promise<void> {
    await (await this.page()).keyboard.type(text)
  }

  async press(key: string): Promise<void> {
    await (await this.page()).keyboard.press(key)
  }

  /** Type a command line and Enter. */
  async enter(cmd: string): Promise<void> {
    await this.type(cmd)
    await this.press('Enter')
  }

  /**
   * Press one printable key in the terminal on screen and resolve with its echo latency (keydown → the glyph painted
   * before the cursor; tools/perf's P-TERM-1 probe). Meant for a terminal running `cat`.
   */
  async keyEcho(ch: string, ms = STEP_MS): Promise<number> {
    const page = await this.page()
    await page.evaluate((c) => __keaPerf.armEcho(c), ch)
    await page.keyboard.press(ch)
    return page.evaluate((m) => __keaPerf.awaitEcho(m), ms)
  }

  /** Press Enter in a terminal running `cat`, and wait until cat has written `line` back (tools/perf's probe). */
  async enterLineBack(line: string, ms = STEP_MS): Promise<void> {
    const page = await this.page()
    await page.keyboard.press('Enter')
    await page.evaluate(([t, m]) => __keaPerf.awaitLineBack(t, m), [line, ms] as [string, number])
  }

  /** Type `echo <tag>-$((40+2))` and wait until the shell's answer `<tag>-42` is on screen: typing round trip. */
  async echo(tag: string): Promise<void> {
    await this.enter(`echo ${tag}-$((40+2))`)
    await this.waitScreen(`the echo of ${tag}`, (s) => s.includes(`${tag}-42`))
  }

  /** Close the window's app gracefully (Kea quits; holders keep running). */
  async close(): Promise<void> {
    await this.cdp?.close().catch(() => undefined)
    this.cdp = null
    if (this.closed) return
    this.closed = true
    await this.app.close()
  }

  /** After a SIGKILL of main: wait until no Electron process of this instance is left. */
  async gone(): Promise<void> {
    this.closed = true
    await this.cdp?.close().catch(() => undefined)
    this.cdp = null
    await until('the app processes to exit', () => runAppProcesses(this.run.home).length === 0 || undefined)
  }
}

/** The release kea-helper the dev build runs (and whose `footprint` subcommand measures processes). */
const HELPER = path.join(repoRoot, 'native', 'kea-helper', 'target', 'release', 'kea-helper')

/**
 * A process's physical footprint in bytes (`kea-helper footprint`: `ri_phys_footprint` on macOS, the number Activity
 * Monitor shows; `RssAnon + VmSwap` on Linux), after checking it is still the process found earlier.
 */
export async function footprint(p: ProcInfo): Promise<number> {
  if (!stillSame(p)) throw new Error(`${p.pid} (${p.comm}) is not the process it was`)
  const r = await runProcess(HELPER, ['footprint', String(p.pid)], { pool: 'other', timeoutMs: STEP_MS })
  const m = /^\d+ (\d+)$/m.exec(r.stdout?.toString('utf8') ?? '')
  if (!m) throw new Error(`no footprint for ${p.pid}`)
  return Number(m[1])
}

/** A fallback socket directory, when the home has one. */
function extraDirs(home: string): string[] {
  const dir = runDir(home)
  return dir === path.join(home, 'run') ? [] : [dir]
}

/** Kill and remove everything of a run on `home` (launch.ts `cleanupRun`, plus its fallback socket directory). */
export function cleanupHome(home: string, since?: number): CleanupReport {
  return cleanupRun(home, { dirs: extraDirs(home), ...(since !== undefined ? { since } : {}) })
}

function withDeadline<T>(what: string, p: Promise<T>, ms = STEP_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer))
}

// ── the counter workload (tools/process-zoo) ────────────────────────────────────────

/** Lines `kc <n>`: easy to find on a screen full of prompts and commands. */
export const COUNTER_FORMAT = 'kc {n}\n'
const COUNTER_LINE = /^kc (\d+)$/

/** A word for a test shell's command line, single-quoted. */
export const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** The command line that runs `counter` forever at `rate` lines per second in a test shell (`start`: its first number). */
export function counterCommand(rate: number, o: { start?: number } = {}): string {
  return zooShellCommand('counter', ['--forever', '--rate', String(rate), '--format', COUNTER_FORMAT.replace('\n', '\\n'), ...(o.start !== undefined ? ['--start', String(o.start)] : [])])
}

/** A process-zoo program as a command line for a test shell (every word quoted). */
export function zooShellCommand(name: 'counter' | 'flood', args: string[]): string {
  const { file, args: argv } = zooCommand(name, args)
  return [file, ...argv].map(shq).join(' ')
}

/**
 * The counter numbers on a screen, top to bottom, for waiting on progress only: other lines are skipped. Continuity
 * checks use `counterRun`, which skips nothing.
 */
export function counterNumbers(screen: string): number[] {
  return screen.split('\n').flatMap((l) => {
    const m = COUNTER_LINE.exec(l.trimEnd())
    return m ? [Number(m[1])] : []
  })
}

/** What `counterRun` found: the first and last counter numbers, how many lines it read, and every problem. */
export interface CounterRun {
  first: number
  last: number
  lines: number
  /** Each line between the first and the last counter line that is not exactly the next counter line (capped). */
  problems: string[]
}
const RUN_PROBLEMS_KEPT = 10

/**
 * The counter in a terminal's text, strictly: from the first `kc <n>` line to the last, every line must be exactly the
 * next counter line. A blank line, a repeated or skipped number, a partial or doubled line, any other text between
 * them is a problem: a seam that drops or repeats a chunk shows up here, where a check that skips lines it cannot parse
 * would see one unbroken run.
 */
export function counterRun(text: string): CounterRun {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  const a = lines.findIndex((l) => COUNTER_LINE.test(l))
  const b = lines.findLastIndex((l) => COUNTER_LINE.test(l))
  if (a < 0) return { first: NaN, last: NaN, lines: 0, problems: ['no counter line'] }
  const problems: string[] = []
  const problem = (p: string) => void (problems.length < RUN_PROBLEMS_KEPT && problems.push(p))
  let prev: number | null = null
  for (let i = a; i <= b; i++) {
    const l = lines[i] as string
    const m = COUNTER_LINE.exec(l)
    if (!m) {
      problem(`line ${i - a}: ${JSON.stringify(l.slice(0, 60))} where kc ${prev === null ? '?' : prev + 1} belongs`)
      continue
    }
    const n = Number(m[1])
    if (prev !== null && n !== prev + 1) problem(`line ${i - a}: kc ${n} after kc ${prev}`)
    prev = n
  }
  return { first: Number(COUNTER_LINE.exec(lines[a] as string)![1]), last: Number(COUNTER_LINE.exec(lines[b] as string)![1]), lines: b - a + 1, problems }
}

/** The highest counter number whose whole line (`kc <n>\r\n`) is in `ptyId`'s ring now. */
export function ringMax(run: KeaRun, ptyId: string): number {
  let max = 0
  for (const m of run.ring(ptyId).text.matchAll(/(?:^|\n)kc (\d+)\r\n/g)) max = Math.max(max, Number(m[1]))
  return max
}

/**
 * Write `data` to a FIFO that a test shell reads (`read x < fifo`), without ever blocking the test's event loop: until
 * the shell has opened its end, a non-blocking open fails (ENXIO) and is retried.
 */
export async function writeFifo(file: string, data: string): Promise<void> {
  const fd = await until(`a reader on ${path.basename(file)}`, () => {
    try {
      return fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENXIO') return undefined
      throw e
    }
  })
  try {
    fs.writeSync(fd, data)
  } finally {
    fs.closeSync(fd)
  }
}

/** The counter text of a ring from its first `kc 1` line (a PTY turns each `\n` into `\r\n`). */
export function ringCounterText(ringText: string): string {
  const i = ringText.indexOf('kc 1\r\n')
  return i >= 0 ? ringText.slice(i) : ''
}
