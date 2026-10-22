// Open in editor: detection, the launch strategies (argv.ts), the terminal app, the pull request page
// (`session.createPR`) and the check of paths printed in a terminal (paths.ts). It serves `editorApi` and is core's
// `EditorLauncher` (open.ts).
//
// Everything it runs goes through `kit/runProcess` on the `other` pool, as argv, with a timeout. What it may run and
// where it may look is its `EditorHost` (host.ts): without one, nothing is installed and nothing is launched.
//
// Detection on macOS is one Spotlight query for every bundle id (`mdfind -attr`), then the applications folders by name
// for whatever Spotlight did not find (it may be off). On Linux an app is a command, found on the login PATH, in its
// known places and through its desktop entry (commands.ts); a terminal app there is started detached. The answer is
// kept for L.editorDetectCacheMs and dropped when a launch fails. A bundle id only ever finds a bundle: what is
// launched is the accepted bundle by its path (argv.ts).
//
// Where a bundle may be: Spotlight indexes app bundles wherever they lie, a cloned repository included, and what
// detection finds is run. So a bundle is used only from an application folder of the host (`appDirs`, at any depth),
// and never from inside a project's root or a session's working directory (`usableBundle`).

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { launchDetached, runProcess, systemClock, type Clock, type Logger, type ProcessResult } from '@kea/kit'
import {
  L,
  SETTINGS,
  type CreatePrFailure,
  type editorApi,
  type EditorList,
  type EditorOpenRequest,
  type EditorOpenResult,
  type EditorTarget,
  type Handlers,
  type LaunchResult,
  type TerminalAppChoice,
} from '@kea/protocol'
import type { Projects } from '../sessions/projects.ts'
import type { Sessions } from '../sessions/sessions.ts'
import type { Env } from '../terminal/shellEnv.ts'
import { CREATE_PR_ARGS, launchPlan, linuxLaunchPlan, linuxTerminalAppArgv, terminalAppArgv, type LaunchTarget } from './argv.ts'
import { defaultEditor, EDITOR_DEFS, editorDef, TERMINAL_APP_DEFS, terminalAppFor, type AppDef, type EditorDef, type EditorId, type LinuxTerminalAppDef, type TerminalAppDef } from './catalog.ts'
import { detectCommands } from './commands.ts'
import type { BundleHost, EditorHost } from './host.ts'
import type { EditorLauncher } from './open.ts'
import { insideDir, PathChecks } from './paths.ts'

const BUNDLE_ATTR = 'kMDItemCFBundleIdentifier'
const INITIAL_EDITOR = SETTINGS.find((d) => d.key === 'general.defaultEditor')?.default as EditorId

export interface EditorsOptions {
  log: Logger
  /** What may be looked at and run; null: nothing is installed (every core but the app's own, and its tests' stand-ins). */
  host: EditorHost | null
  /** The login shell's environment: what a launched tool gets. */
  env: () => Promise<Env>
  run?: typeof runProcess
  /** How a terminal app is started on Linux (a test records instead). */
  launch?: typeof launchDetached
  clock?: Clock
}

/** What `bind` hands over once core has built them. */
export interface EditorsDeps {
  sessions: Pick<Sessions, 'store'>
  projects: Pick<Projects, 'get' | 'list'>
  /** The `general.defaultEditor` setting. */
  configured: () => EditorId
  /** The `general.terminalApp` setting; Automatic when not given. */
  terminalApp?: () => TerminalAppChoice
}

/** One detection's answer. */
export interface Detected {
  at: number
  /** The installed editors, in the catalog's order, each with its app: the bundle (macOS) or the command-line tool (Linux). */
  editors: { def: EditorDef; app: string }[]
  /**
   * The installed terminal apps, in the catalog's order (the setting picks among them, `terminalAppFor`), each with
   * its app: the bundle (macOS) or the command (Linux).
   */
  terminalApps: { def: TerminalAppDef | LinuxTerminalAppDef; app: string }[]
}

/** `mdfind -attr kMDItemCFBundleIdentifier`'s lines: `<path>   kMDItemCFBundleIdentifier = <id>`. Bundle id → paths. */
export function parseMdfind(out: string): Map<string, string[]> {
  const found = new Map<string, string[]>() // bounded: one entry per bundle id asked for (the catalog)
  const mark = `   ${BUNDLE_ATTR} = `
  for (const line of out.split('\n')) {
    const i = line.lastIndexOf(mark)
    if (i <= 0) continue
    const p = line.slice(0, i)
    const id = line.slice(i + mark.length).trim()
    if (!path.isAbsolute(p) || !p.endsWith('.app')) continue
    const list = found.get(id)
    if (list) list.push(p)
    else found.set(id, [p])
  }
  return found
}

/** The Spotlight query for every bundle id of `defs` (ids are the catalog's own: letters, digits, dots and dashes). */
export function mdfindArgs(defs: readonly AppDef[]): string[] {
  return ['-attr', BUNDLE_ATTR, defs.map((d) => `${BUNDLE_ATTR} == '${d.bundleId}'`).join(' || ')]
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const within = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep)

/** Each folder's real path; one that is not there keeps its own (a worktree that was removed still names a place). */
function realDirs(dirs: Iterable<string>): Promise<string[]> {
  return Promise.all([...new Set(dirs)].filter((d) => path.isAbsolute(d)).map((d) => fsp.realpath(d).catch(() => path.resolve(d))))
}

/**
 * The app bundle at `bundle` as it may be used, or null when it may not. `appDirs` and `off` are real paths.
 *
 *   in an application folder    the place it was found at (its folders resolved), or its real path, is inside one of
 *                               `appDirs`, at any depth. A bundle the person linked into an application folder is
 *                               there (a package manager's store keeps the real one) and is used through that link;
 *                               one that a link elsewhere leads to is used by its real path (Homebrew's Caskroom
 *                               keeps a link to the bundle it put in `/Applications`)
 *   never in a repository       neither that place nor its real path is inside one of `off`: the projects' roots and
 *                               the sessions' working directories. This holds inside an application folder too (a
 *                               project kept under one; a link there that leads into a project)
 *
 * Null also for a bundle that is not there, or is no folder.
 */
export async function usableBundle(bundle: string, appDirs: readonly string[], off: readonly string[]): Promise<string | null> {
  let real: string
  let place: string
  try {
    real = await fsp.realpath(bundle)
    if (!(await fsp.stat(real)).isDirectory()) return null
    place = path.join(await fsp.realpath(path.dirname(bundle)), path.basename(bundle))
  } catch {
    return null
  }
  if (off.some((d) => within(d, place) || within(d, real))) return null
  const inside = (p: string): boolean => appDirs.some((d) => within(d, p) && p !== d)
  return inside(place) ? bundle : inside(real) ? real : null
}

function executable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The end of a tool's stderr (its last lines say what went wrong), or how it ended when it said nothing. */
export function failureText(r: ProcessResult): string {
  const text = r.stderr.trim()
  if (text) return text.length > L.editorErrorMaxChars ? `…${text.slice(-L.editorErrorMaxChars)}` : text
  if (r.timedOut) return 'It did not answer in time'
  return r.code === null ? `It was ended by ${r.signal ?? 'a signal'}` : `It exited with code ${r.code}`
}

export class Editors implements EditorLauncher {
  private readonly o: EditorsOptions
  private readonly run: typeof runProcess
  private readonly launch: typeof launchDetached
  private readonly clock: Clock
  private deps: EditorsDeps | null = null
  /** The last detection, trusted for L.editorDetectCacheMs. */
  private cache: Detected | null = null
  private detecting: Promise<Detected> | null = null
  private launches = 0
  private disposed = false
  /** The checks of paths printed in a terminal, capped and timed (paths.ts). */
  private readonly paths: PathChecks

  constructor(o: EditorsOptions) {
    this.o = o
    this.run = o.run ?? runProcess
    this.launch = o.launch ?? launchDetached
    this.clock = o.clock ?? systemClock
    this.paths = new PathChecks({ clock: this.clock })
  }

  /** Core's services, once they exist (core.ts builds the launcher before them). */
  bind(deps: EditorsDeps): void {
    this.deps = deps
  }

  handlers(open: EditorLauncher = this): Handlers<typeof editorApi> {
    return {
      'editor.open': (req) => open.open(req),
      'editor.list': ({ fresh }) => this.list(fresh === true),
      'editor.openTerminalApp': ({ target, id }) => this.openTerminalApp(target, id),
      'editor.createPR': ({ sessionId }) => this.createPR(sessionId),
      'editor.resolvePaths': async ({ sessionId, paths }) => {
        const v = this.deps?.sessions.store.get(sessionId)
        if (!v || v.worktreeMissing) return { paths: paths.map(() => null) }
        return { paths: await this.paths.resolveLinks(v.cwd, paths) }
      },
    }
  }

  /** The detection cache and what is under way (the resource report). */
  get resourceCounts(): { cached: number; detecting: number; launches: number; pathChecks: number; pathChecksWaiting: number; pathPlacesHung: number } {
    const paths = this.paths.counts
    return {
      cached: this.cache ? this.cache.editors.length + this.cache.terminalApps.length : 0,
      detecting: this.detecting ? 1 : 0,
      launches: this.launches,
      pathChecks: paths.inFlight,
      pathChecksWaiting: paths.waiting,
      pathPlacesHung: paths.hung,
    }
  }

  dispose(): void {
    this.disposed = true
    this.cache = null
    this.paths.dispose()
  }

  // ── detection ───────────────────────────────────────────────────────────────────────────────────

  /** What is installed: the cached answer while it is fresh, else a new look (one at a time). */
  detect(fresh = false): Promise<Detected> {
    const c = this.cache
    if (c && !fresh && this.clock.now() - c.at < L.editorDetectCacheMs) return Promise.resolve(c)
    if (this.detecting) return this.detecting
    const p = this.look().finally(() => {
      if (this.detecting === p) this.detecting = null
    })
    this.detecting = p
    return p
  }

  private async look(): Promise<Detected> {
    const host = this.o.host
    const none: Detected = { at: this.clock.now(), editors: [], terminalApps: [] }
    if (!host || this.disposed) return none
    if (host.kind === 'commands') {
      // never from a project's root or a session's working directory
      const [env, off] = await Promise.all([this.o.env(), realDirs(this.repositories())])
      const found: Detected = { at: this.clock.now(), ...(await detectCommands(host, env, off, this.o.log)) }
      if (!this.disposed) this.cache = found
      return found
    }
    return this.lookBundles(host)
  }

  private async lookBundles(host: BundleHost): Promise<Detected> {
    const defs: readonly AppDef[] = [...EDITOR_DEFS, ...TERMINAL_APP_DEFS]
    let spotlight = new Map<string, string[]>()
    if (host.mdfind) {
      try {
        const [file, args] = [host.mdfind, mdfindArgs(defs)]
        const r = await this.run(file, args, { pool: 'other', env: {}, timeoutMs: L.editorDetectTimeoutMs })
        if (r.code === 0 && r.stdout) spotlight = parseMdfind(r.stdout.toString('utf8'))
        else this.o.log.debug('editor lookup: Spotlight gave no answer', { code: r.code, timedOut: r.timedOut })
      } catch (e) {
        this.o.log.debug('editor lookup: Spotlight not asked', { error: String(e) })
      }
    }
    // only from an application folder, never from a project's root or a session's working directory
    const [appDirs, off] = await Promise.all([realDirs(host.appDirs), realDirs(this.repositories())])
    const locate = async (d: AppDef): Promise<string | null> => {
      // Spotlight's answer, an applications folder's own copy first; else the bundle by its name (Spotlight off)
      const hits = spotlight.get(d.bundleId) ?? []
      const candidates = [...hits.filter((h) => host.appDirs.includes(path.dirname(h))), ...hits, ...host.appDirs.map((dir) => path.join(dir, d.appName))]
      for (const candidate of new Set(candidates)) {
        const bundle = await usableBundle(candidate, appDirs, off)
        if (bundle !== null) return bundle
      }
      if (hits.length > 0) this.o.log.debug('editor lookup: no bundle in an application folder', { app: d.name, listed: hits.length })
      return null
    }
    const editors: Detected['editors'] = []
    for (const def of EDITOR_DEFS) {
      const bundle = await locate(def)
      if (bundle) editors.push({ def, app: bundle })
    }
    // every one found, not the first only: the setting may name any of them, and a change of it needs no new lookup
    const terminalApps: Detected['terminalApps'] = []
    for (const def of TERMINAL_APP_DEFS) {
      const bundle = await locate(def)
      if (bundle) terminalApps.push({ def, app: bundle })
    }
    const found: Detected = { at: this.clock.now(), editors, terminalApps }
    if (!this.disposed) this.cache = found
    return found
  }

  /** Where repositories are: every project's root and every session's working directory (no bundle there is ever used). */
  private repositories(): string[] {
    if (!this.deps) return []
    const dirs = this.deps.projects.list().map((p) => p.rootPath)
    for (const v of this.deps.sessions.store.values()) dirs.push(v.cwd)
    return dirs
  }

  async list(fresh: boolean): Promise<EditorList> {
    const d = await this.detect(fresh)
    const configured = this.deps?.configured() ?? INITIAL_EDITOR
    const installed = d.editors.map((e) => e.def.id)
    const env = this.o.host ? await this.o.env() : {}
    const terminalApp = this.terminalApp(d)
    return {
      editors: d.editors.map((e) => ({ id: e.def.id, name: e.def.name })),
      default: defaultEditor(configured, installed, INITIAL_EDITOR),
      configured: { id: configured, name: editorDef(configured)?.name ?? configured },
      terminalApp: terminalApp ? { name: terminalApp.def.name } : null,
      gh: !!this.o.host?.gh(env),
    }
  }

  // ── launching ───────────────────────────────────────────────────────────────────────────────────

  /** The folder a request is about (a session's working directory, an in-place session's project root). */
  private dirOf(target: EditorTarget, id: string): string | null {
    const dir = target === 'session' ? this.deps?.sessions.store.get(id)?.cwd : this.deps?.projects.get(id)?.rootPath
    return dir && path.isAbsolute(dir) && isDir(dir) ? dir : null
  }

  /** One attempt: null when it worked, else why not. */
  private async attempt(a: { file: string; args: readonly string[] }, cwd: string, timeoutMs: number): Promise<string | null> {
    this.launches++
    try {
      const r = await this.run(a.file, [...a.args], { pool: 'other', cwd, env: await this.o.env(), timeoutMs })
      return r.code === 0 && !r.timedOut ? null : failureText(r)
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    } finally {
      this.launches--
    }
  }

  /**
   * An app that stays in front of the person until its window closes (a terminal app on Linux), started in its
   * own session and let go: null when it started, else why not. It is never waited for, so it cannot fail later here.
   */
  private async detached(a: { file: string; args: readonly string[] }, cwd: string): Promise<string | null> {
    this.launches++
    try {
      await this.launch(a.file, [...a.args], { pool: 'other', cwd, env: await this.o.env() })
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    } finally {
      this.launches--
    }
  }

  async open(req: EditorOpenRequest): Promise<EditorOpenResult> {
    const d = await this.detect()
    const configured = this.deps?.configured() ?? INITIAL_EDITOR
    const id = req.editor ?? defaultEditor(configured, d.editors.map((e) => e.def.id), INITIAL_EDITOR)
    const found = d.editors.find((e) => e.def.id === id)
    // A predictable state, not an error: the editor asked for (or the default) is not installed
    if (!this.o.host || !found) return { ok: false, editor: id ?? configured, reason: 'unavailable', message: null }
    const fail = (message: string): EditorOpenResult => ({ ok: false, editor: found.def.id, reason: 'failed', message })
    const dir = this.dirOf(req.target, req.id)
    if (!dir) return fail('The folder is not there any more')
    const target: LaunchTarget = { dir, file: null, line: null, col: null }
    if (req.path !== undefined) {
      const at = await insideDir(dir, req.path)
      if (!at.ok) return fail(at.why === 'outside' ? `${req.path} leads outside the folder` : `${req.path} is not there`)
      if (at.kind === 'dir') target.dir = at.abs
      else {
        target.file = at.abs
        target.line = req.line ?? null
        target.col = req.line === undefined ? null : (req.col ?? null)
      }
    }
    let plan
    if (this.o.host.kind === 'commands') {
      // The command-line tool detection accepted, then the editor's URL through `xdg-open`
      plan = linuxLaunchPlan(found.def, { cli: found.app, open: this.o.host.open }, target)
    } else {
      const cli = path.join(found.app, found.def.cli)
      // every strategy names the app by the accepted bundle's path, never by its id or its URL scheme
      plan = launchPlan(found.def, { bundle: found.app, cli: executable(cli) ? cli : null, open: this.o.host.open }, target)
    }
    let last = ''
    for (const a of plan) {
      const why = await this.attempt(a, dir, L.editorLaunchTimeoutMs)
      if (why === null) {
        this.o.log.info('opened in editor', { editor: found.def.id, strategy: a.strategy, file: target.file !== null })
        return { ok: true, editor: found.def.id, reason: null, message: null }
      }
      last = why
      this.o.log.warn('editor launch attempt failed', { editor: found.def.id, strategy: a.strategy, why })
    }
    // what was found may be gone (moved, uninstalled): the next request looks again
    this.cache = null
    return fail(last || 'No way to launch it was found')
  }

  /** The terminal app the setting names, of the ones found; Automatic is the first found. */
  private terminalApp(d: Detected): Detected['terminalApps'][number] | null {
    return terminalAppFor(this.deps?.terminalApp?.() ?? 'auto', d.terminalApps)
  }

  /** The folder in the terminal app. */
  async openTerminalApp(target: EditorTarget, id: string): Promise<LaunchResult> {
    const app = this.terminalApp(await this.detect())
    if (!this.o.host || !app) return { ok: false, reason: 'unavailable', message: null }
    const dir = this.dirOf(target, id)
    if (!dir) return { ok: false, reason: 'failed', message: 'The folder is not there any more' }
    const why =
      this.o.host.kind === 'commands' && 'dirArgs' in app.def
        ? await this.detached(linuxTerminalAppArgv(app.app, app.def, dir), dir)
        : await this.attempt(terminalAppArgv(this.o.host.open, app.app, dir), dir, L.editorLaunchTimeoutMs)
    if (why === null) return { ok: true, reason: null, message: null }
    this.cache = null
    return { ok: false, reason: 'failed', message: why }
  }

  /** `session.createPR`: `gh pr create --web` in the session's worktree. */
  async createPR(sessionId: string): Promise<{ ok: boolean; reason: CreatePrFailure | null; message: string | null }> {
    const v = this.deps?.sessions.store.get(sessionId)
    if (!v?.branch) return { ok: false, reason: 'noBranch', message: null }
    const env = await this.o.env()
    const gh = this.o.host?.gh(env) ?? null
    if (!gh) return { ok: false, reason: 'noGh', message: null }
    const dir = this.dirOf('session', sessionId)
    if (!dir) return { ok: false, reason: 'failed', message: 'The worktree is not there any more' }
    const why = await this.attempt({ file: gh, args: CREATE_PR_ARGS }, dir, L.createPrTimeoutMs)
    return why === null ? { ok: true, reason: null, message: null } : { ok: false, reason: 'failed', message: why }
  }
}
