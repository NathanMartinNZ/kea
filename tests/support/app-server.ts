// The dev server and open-in-editor in a running Kea, for the app-level suites: what a test puts in place before Kea
// starts, and how it reads what the window shows and what Kea asked the outside world to do. Nothing here opens a
// browser, an editor, a terminal app or Finder:
//
// · a dev server is the process zoo's `server` (loopback only, on the session's own `$PORT`), run as `start.sh`;
// · a link the window opens reaches main, which under `--kea-perf` records it instead of opening it
//   (`__keaTest.opened()`, app/main/src/external.ts);
// · editors, `open` and `gh` are the fake editor (tools/fake-editor), installed under the run's own HOME, the only
//   place a harness-launched core looks (app/core/src/editor/host.ts `sandboxEditorHost`).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { EDITOR_DEFS, LINUX_TERMINAL_APP_DEFS, TERMINAL_APP_DEFS, type EditorId } from '@kea/core/src/editor/catalog.ts'
import { installBundle, installTool, readCalls } from '@kea-tools/fake-editor/src/index.ts'
import { zooCommand } from '@kea-tools/process-zoo/src/index.ts'
import { fixtureGitEnv } from '@kea-tools/repo-factory/src/index.ts'
import { harnessUserHome } from '../../tools/perf/src/launch.ts'
import { harnessOs } from '../../tools/perf/src/os/index.ts'
import { shq, STEP_MS, until, type Kea, type KeaProbe, type KeaRun } from './app.ts'

// ── the repository ──────────────────────────────────────────────────────────────────────────────────

const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()

/** Write `files` into the repository at `root` and commit them, so every worktree made afterwards has them. */
export function commitFiles(root: string, files: Readonly<Record<string, string>>, o: { executable?: boolean } = {}): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text, { mode: o.executable ? 0o755 : 0o644 })
    if (o.executable) fs.chmodSync(path.join(root, rel), 0o755)
  }
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', `Add ${Object.keys(files).join(', ')}`)
}

/** The repository's worktrees other than `root` itself, by branch (`git worktree list`). */
export function worktreesOf(root: string): { branch: string; dir: string }[] {
  const out: { branch: string; dir: string }[] = []
  let dir = ''
  for (const line of git(root, 'worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) dir = fs.realpathSync(line.slice('worktree '.length))
    else if (line.startsWith('branch ') && dir !== fs.realpathSync(root)) out.push({ branch: line.slice('branch refs/heads/'.length), dir })
  }
  return out
}

// ── the dev server ──────────────────────────────────────────────────────────────────────────────────

/** A `start.sh` that is the zoo's stand-in dev server with `args` (tools/process-zoo/src/server.ts). */
export function serverScript(args: readonly string[] = []): string {
  const zoo = zooCommand('server', [...args])
  return `#!/bin/sh\nexec ${[zoo.file, ...zoo.args].map(shq).join(' ')}\n`
}

/** A project's "Run command" that is the zoo's stand-in dev server with `args`: one line of shell, as a person types `pnpm dev`. */
export function serverCommand(args: readonly string[] = []): string {
  const zoo = zooCommand('server', [...args])
  return `exec ${[zoo.file, ...zoo.args].map(shq).join(' ')}`
}

/** How long the watcher of `serverTreeScript` lives when nothing stops it: the stand-in server's own guard (its `--lifetime` default). */
const WATCHER_LIFETIME_S = 600

/**
 * A `start.sh` with a tree, as a dev script has one: the shell stays as the parent of the stand-in server and
 * starts a watcher beside it first (a `sleep` in the background: a script's shell has no job control, so the watcher
 * ignores the SIGINT a Stop begins with). The shell's pid and the watcher's are written to `pids` (`treePids` reads it).
 */
export function serverTreeScript(pids: string, args: readonly string[] = []): string {
  const zoo = zooCommand('server', [...args])
  return `#!/bin/sh\n/bin/sleep ${WATCHER_LIFETIME_S} &\necho "$$ $!" > ${shq(pids)}\n${[zoo.file, ...zoo.args].map(shq).join(' ')}\n`
}

/** The shell and the watcher of a running `serverTreeScript`; null until it has written them. */
export function treePids(pids: string): { shell: number; watcher: number } | null {
  if (!fs.existsSync(pids)) return null
  const m = /^(\d+) (\d+)\n$/.exec(fs.readFileSync(pids, 'utf8'))
  return m ? { shell: Number(m[1]), watcher: Number(m[2]) } : null
}

/** Whether a process with this pid exists (signal 0: nothing is sent). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The header's dev-server control: the group "Dev server". */
export function serverControl(page: Page): Locator {
  return page.getByRole('group', { name: 'Dev server' })
}

/** The state the control shows (`stopped`, `starting`, `running`, `stopping`, `crashed`); null while it is hidden. */
export async function serverState(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector('[role=group][aria-label="Dev server"]')?.getAttribute('data-server-state') ?? null)
}

export async function waitServer(kea: Kea, state: string | null, ms = STEP_MS): Promise<void> {
  const page = await kea.page()
  let last: string | null = null
  await until(`the dev-server control to show ${state ?? 'nothing'}`, async () => (last = await serverState(page)) === state || undefined, ms).catch((e: Error) => {
    throw new Error(`${e.message} (last: ${last})`)
  })
}

export interface ServerControlSeen {
  /** `data-server-state`, or `hidden`. */
  state: string
  /** What the control's own button reads in that state (`Run`, `Starting`, `Stop`, `Stopping…`, `Exited 1`). */
  label: string
}

/**
 * Start recording every state the control shows from now on (its `data-server-state` and its button's text, each
 * change once); `serverStatesSeen` reads them. The page records them, not the test's polls, so a state that lasts one
 * frame is seen. (A state shorter than one store tick never reaches the window at all.)
 */
export async function recordServerStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __keaServerStates: { state: string; label: string }[]; __keaServerObserver?: MutationObserver }
    const read = () => {
      const g = document.querySelector('[role=group][aria-label="Dev server"]')
      return { state: g?.getAttribute('data-server-state') ?? 'hidden', label: (g?.querySelector('button.quiet-button')?.textContent ?? '').replace('▶', '').trim() }
    }
    w.__keaServerObserver?.disconnect()
    w.__keaServerStates = [read()]
    w.__keaServerObserver = new MutationObserver(() => {
      const s = read()
      if (w.__keaServerStates.at(-1)?.state !== s.state) w.__keaServerStates.push(s)
    })
    w.__keaServerObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-server-state'] })
  })
}

export async function serverStatesSeen(page: Page): Promise<ServerControlSeen[]> {
  return page.evaluate(() => [...(window as unknown as { __keaServerStates: { state: string; label: string }[] }).__keaServerStates])
}

/** The URL chip (`:PORT ↗`); its `data-url` is the address a click opens. */
export function serverChip(page: Page): Locator {
  return serverControl(page).locator('.server-chip')
}

/** Wait for the chip and resolve with its URL and port. */
export async function serverAddress(kea: Kea): Promise<{ url: string; port: number; label: string }> {
  const chip = serverChip(await kea.page())
  await chip.waitFor({ timeout: STEP_MS })
  const url = (await chip.getAttribute('data-url')) ?? ''
  return { url, port: Number(new URL(url).port), label: ((await chip.textContent()) ?? '').trim() }
}

/** The links main was asked to open in the browser so far (recorded, never opened, under `--kea-perf`). */
export function opened(kea: Kea): Promise<string[]> {
  return kea.app.evaluate(() => (globalThis as unknown as { __keaTest: { opened(): string[] } }).__keaTest.opened())
}

/** Whether something accepts TCP connections on 127.0.0.1:port. */
export function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let connected = false
    const c = net.connect({ host: '127.0.0.1', port })
    c.once('connect', () => {
      connected = true
      c.destroy()
    })
    c.once('error', () => undefined)
    c.once('close', () => resolve(connected))
  })
}

/** What the stand-in server answers on `port`: `ok <pid> <port> PORT=<$PORT> FORCE_COLOR=<$FORCE_COLOR>`; '' when nothing does. */
export function serverAnswer(port: number): Promise<string> {
  return fetch(`http://127.0.0.1:${port}/`).then(
    (res) => res.text().then((t) => t.trim()),
    () => '',
  )
}

// ── commands ────────────────────────────────────────────────────────────────────────────────────────

type Probe = KeaProbe & { reason(id: string, args?: unknown): string | undefined }

/** Why a command is unavailable now, as a menu or the palette says it; null when it can run. */
export async function commandReason(kea: Kea, id: string, args?: unknown): Promise<string | null> {
  return (await kea.page()).evaluate(([c, a]) => (window as unknown as { __keaProbe: Probe }).__keaProbe.reason(c as string, a) ?? null, [id, args] as [string, unknown])
}

/** Run a command as a menu item would; false when it was not available. */
export async function runCommand(kea: Kea, id: string, args?: unknown): Promise<boolean> {
  return (await kea.page()).evaluate(([c, a]) => (window as unknown as { __keaProbe: Probe }).__keaProbe.run(c as string, a), [id, args] as [string, unknown])
}

/** From now on the page's clipboard writes are recorded, never sent to the person's clipboard; `clipboard` reads them. */
export async function recordClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __keaClipboard: string[] }
    w.__keaClipboard = []
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (t: string) => void w.__keaClipboard.push(t) })
  })
}

export function clipboard(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window as unknown as { __keaClipboard: string[] }).__keaClipboard])
}

/**
 * Where `text` last appears on the terminal on screen (the lowest row: below the command line that printed it), as a
 * point inside `.xterm-screen`, in the middle of the cell `offset` cells into it.
 */
export async function cellOf(kea: Kea, text: string, offset = 1): Promise<{ x: number; y: number }> {
  return (await kea.page()).evaluate(
    ([t, o]) => {
      type Core = { _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } } }
      const probe = (window as unknown as { __keaProbe: KeaProbe }).__keaProbe
      const id = document.querySelector('.terminal-host.shown')?.getAttribute('data-pty') ?? ''
      const term = probe.terminal(id)
      if (!term) throw new Error('no terminal on screen')
      const b = term.buffer.active
      const cell = (term as unknown as Core)._core._renderService.dimensions.css.cell
      for (let r = term.rows - 1; r >= 0; r--) {
        const c = (b.getLine(b.viewportY + r)?.translateToString(true) ?? '').indexOf(t as string)
        if (c >= 0) return { x: (c + (o as number) + 0.5) * cell.width, y: (r + 0.5) * cell.height }
      }
      throw new Error(`${t} is not on screen`)
    },
    [text, offset] as [string, number],
  )
}

// ── editors ─────────────────────────────────────────────────────────────────────────────────────────

/** One run of a stand-in, as a test compares it: what it stood for and its arguments. */
export interface Launch {
  tool: string
  argv: string[]
}

/** Whether the stand-ins take Linux's shape (commands and desktop entries) rather than macOS's app bundles. */
const COMMAND_EDITORS = harnessOs.system === 'linux'

/** The system's opener, as the stand-in records it: `open` on macOS, `xdg-open` on Linux. */
export const OPENER: string = COMMAND_EDITORS ? 'xdg-open' : 'open'

/**
 * The stand-ins a harness-launched Kea can find, in this system's shape (core's `sandboxEditorHost`, HOME being the
 * run's own empty folder). macOS: app bundles in `<HOME>/Applications`, `open` and `gh` in `<HOME>/bin`.
 * Linux: each editor's command and terminal app's command in `<HOME>/bin`, desktop entries in
 * `<HOME>/share/applications`, `xdg-open` and `gh` in `<HOME>/bin`. Made before or while Kea runs; every run of one
 * is a line in `log`, under the name the macOS CLI has (`code`, `cursor`, …), so a test reads the same on both.
 */
export class EditorWorld {
  readonly home: string
  /** Where the apps are: macOS's app bundles, or Linux's desktop entries. */
  readonly apps: string
  readonly bin: string
  readonly log: string

  constructor(run: KeaRun) {
    this.home = harnessUserHome(run.home)
    this.apps = COMMAND_EDITORS ? path.join(this.home, 'share', 'applications') : path.join(this.home, 'Applications')
    this.bin = path.join(this.home, 'bin')
    this.log = path.join(run.home, 'editor-calls.ndjson')
    fs.mkdirSync(this.apps, { recursive: true })
    fs.mkdirSync(this.bin, { recursive: true })
  }

  /**
   * An editor with its CLI (recorded under the macOS CLI's file name); `cli: false`: the app alone (macOS: the bundle;
   * Linux: a desktop entry whose program has no CLI beside it). Returns the bundle, or on Linux the command.
   */
  editor(id: EditorId, o: { cli?: boolean; exit?: number; stderr?: string } = {}): string {
    const def = EDITOR_DEFS.find((d) => d.id === id)
    if (!def) throw new Error(`no editor ${id}`)
    const tool = { log: this.log, ...(o.exit !== undefined ? { exit: o.exit } : {}), ...(o.stderr !== undefined ? { stderr: o.stderr } : {}) }
    if (!COMMAND_EDITORS) return installBundle(this.apps, { appName: def.appName, bundleId: def.bundleId, ...(o.cli === false ? {} : { cli: def.cli }) }, tool)
    if (o.cli !== false) return installTool(path.join(this.bin, def.linux.commands[0] as string), { ...tool, as: path.basename(def.cli) })
    const program = installTool(path.join(this.home, 'opt', def.id, 'app'), { ...tool, as: `${def.id}-app` })
    fs.writeFileSync(path.join(this.apps, `${def.linux.desktopIds[0]}.desktop`), `[Desktop Entry]\nType=Application\nName=${def.name}\nExec=${program} %U\n`)
    return program
  }

  /** A terminal app, by the name its menu item would carry: macOS's bundle, or Linux's command. */
  terminalApp(name: string): string {
    if (COMMAND_EDITORS) {
      const def = LINUX_TERMINAL_APP_DEFS.find((d) => d.name === name)
      if (!def) throw new Error(`no Linux terminal app ${name}`)
      return installTool(path.join(this.bin, def.commands[0] as string), { as: def.commands[0] as string, log: this.log })
    }
    const def = TERMINAL_APP_DEFS.find((d) => d.name === name)
    if (!def) throw new Error(`no terminal app ${name}`)
    return installBundle(this.apps, { appName: def.appName, bundleId: def.bundleId }, { log: this.log })
  }

  /** The stand-in `open` (Linux: `xdg-open`); `exit` and `stderr` make it the one that fails. */
  open(o: { exit?: number; stderr?: string } = {}): string {
    return installTool(path.join(this.bin, OPENER), { as: OPENER, log: this.log, ...o })
  }

  /** The stand-in GitHub CLI. */
  gh(o: { exit?: number; stderr?: string } = {}): string {
    return installTool(path.join(this.bin, 'gh'), { as: 'gh', log: this.log, ...o })
  }

  /** Every stand-in run so far, oldest first. */
  launches(): Launch[] {
    return readCalls(this.log).map((c) => ({ tool: c.tool, argv: c.argv }))
  }

  /** The working directory of every stand-in run so far. */
  cwds(): string[] {
    return readCalls(this.log).map((c) => c.cwd)
  }

  /** Wait until `n` stand-in runs are recorded; resolves with all of them. */
  async waitLaunches(n: number): Promise<Launch[]> {
    let last: Launch[] = []
    await until(`${n} recorded launches`, () => (last = this.launches()).length >= n || undefined).catch((e: Error) => {
      throw new Error(`${e.message} (recorded: ${JSON.stringify(last)})`)
    })
    return last
  }
}

/**
 * The header's open-in-editor split button: the group "Open in editor"; `data-editor` is the default editor ('' for
 * none).
 */
export function editorButton(page: Page): Locator {
  return page.getByRole('group', { name: 'Open in editor' })
}

/**
 * Open the split button's menu (the caret, or the single `Open in…` button shown when the default editor is not
 * installed); resolves with the menu. What it lists follows a fresh look at what is installed, so its
 * items can change just after it opens: poll `menuLabels`.
 */
export async function openEditorMenu(page: Page): Promise<Locator> {
  const group = editorButton(page)
  await group.locator('button[aria-haspopup=menu]').click({ timeout: STEP_MS })
  const menu = page.getByRole('menu', { name: 'Open in' })
  await menu.waitFor({ timeout: STEP_MS })
  return menu
}

export async function menuLabels(menu: Locator): Promise<string[]> {
  return menu.locator('[role=menuitem]').evaluateAll((els) => els.map((e) => (e.querySelector('.kea-menu-label')?.textContent ?? '').trim()))
}
