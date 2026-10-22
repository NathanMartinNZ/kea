// A test build taken out of LaunchServices. macOS registers every app bundle it launches, by its path, under the bundle
// id: a packaged Kea a harness ran from a temp folder stays known as `dev.kea.app` after the folder is gone, and a
// notification click or `open -b dev.kea.app` may then pick it instead of the installed app. So a harness that launches
// a packaged test build unregisters that path before it deletes it (`lsregister -u <path>`, which also works once the
// path is gone).
//
// Only ever a path of the run's own: an app inside a folder the run made, itself inside a temp folder or
// `dist/test-app-*`. Never the installed app, under any spelling, and never the repo's own build (`dist/pack`): that
// one is the person's to unregister (README.md here). Nothing else of the tool is used: the database is never
// rebuilt, reset or collected.

import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { need } from '../../../packages/protocol/src/platform.ts'
import { packOs } from './os/index.ts'
import { applicationsFolderOf, resolveExisting } from './target.ts'

/** macOS's LaunchServices tool (no copy of it is on PATH); asked when needed, so the module also loads on Linux. */
export function lsregister(): string {
  return need(packOs.tools).path('lsregister')
}

export interface OwnPlaces {
  /** The temp folders a run makes its folders in, symlinks resolved. */
  tmp: string[]
  /** The repository: `dist/test-app-*` in it are the suites' builds. */
  repoRoot: string
  homedir: string
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

export function ownPlaces(): OwnPlaces {
  return { tmp: [...new Set([os.tmpdir(), '/tmp'].map(resolveExisting))], repoRoot: REPO_ROOT, homedir: os.homedir() }
}

const strictlyInside = (p: string, dir: string) => p !== dir && p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)

/**
 * Why a harness may not unregister `app`, or null. `made` is the folder the run itself made (its `mkdtemp`, or the
 * suites' `dist/test-app-<tag>`). Both are judged by where they lead (symlinks in the part that exists resolved,
 * `..` taken out), and a path that is gone is judged like one that is there.
 */
export function unregisterProblem(app: string, made: string, places: OwnPlaces = ownPlaces()): string | null {
  if (!path.isAbsolute(app) || !path.isAbsolute(made)) return 'both paths must be absolute'
  // `<run>/link/../Kea.app` is `<run>/Kea.app` as text and wherever the link leads to the OS, which reads the string
  // that is handed on: so a path counts only as it is written, with no `.`, `..`, doubled or trailing slash in it
  for (const p of [app, made]) if (p !== path.resolve(p)) return `${p} must be written out in full (no . or .., no doubled or trailing slash)`
  const [a, m] = [resolveExisting(app), resolveExisting(made)]
  if (!path.basename(a).endsWith('.app')) return 'it is not an app bundle'
  for (const p of [app, made]) {
    const apps = applicationsFolderOf(p, places.homedir)
    if (apps) return `it is in ${apps}: an installed app is never unregistered by a test`
  }
  // a folder of a run: directly or deeper inside a temp folder (never the temp folder itself), or dist/test-app-<tag>
  const dist = path.join(resolveExisting(places.repoRoot), 'dist')
  const inTemp = places.tmp.some((t) => strictlyInside(m, resolveExisting(t)))
  const testApp = path.dirname(m) === dist && /^test-app-./.test(path.basename(m))
  if (!inTemp && !testApp) return `${made} is not a folder a test run makes (inside a temp folder, or dist/test-app-*)`
  // dist/pack, dist/s7 and the like are the person's, also when the repository itself lies in a temp folder
  if (strictlyInside(a, dist) && !/^test-app-./.test(a.slice(dist.length + 1).split(path.sep)[0] as string)) return 'it is the repository’s own build: the person unregisters it'
  if (!strictlyInside(a, m)) return `it is not inside ${made}, the folder this run made`
  return null
}

/**
 * For an app a harness was handed and did not make itself (the survival check's `--app`): the run folder it lies in, or
 * null. That is the folder directly inside a temp folder, or `dist/test-app-<tag>`; an app anywhere else (dist/pack,
 * dist/s7, an Applications folder) lies in none, and stays registered until the person unregisters it.
 */
export function runFolderOf(app: string, places: OwnPlaces = ownPlaces()): string | null {
  if (!path.isAbsolute(app)) return null
  const a = resolveExisting(app)
  const roots = [...places.tmp.map(resolveExisting), path.join(resolveExisting(places.repoRoot), 'dist')]
  for (const root of roots) {
    if (!strictlyInside(a, root)) continue
    const made = path.join(root, a.slice(root.length + 1).split(path.sep)[0] as string)
    if (unregisterProblem(app, made, places) === null) return made
  }
  return null
}

export type UnregisterResult = { done: true; app: string } | { done: false; app: string; why: string }

const run = (file: string, args: string[]): string => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })

/**
 * `lsregister -u <app>` for an app of this run (`unregisterProblem`), before the run deletes it. Never throws: a
 * clean-up goes on, and the caller says what was not done.
 */
export function unregisterOwnApp(app: string, made: string, o: { exec?: (file: string, args: string[]) => string; places?: OwnPlaces } = {}): UnregisterResult {
  const why = unregisterProblem(app, made, o.places)
  if (why) return { done: false, app, why }
  try {
    ;(o.exec ?? run)(lsregister(), ['-u', app])
    return { done: true, app }
  } catch (e) {
    return { done: false, app, why: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * For a harness that was handed its builds (the survival check's `--app`, `--next-app`): macOS registered each one it
 * launched, by its path, as Kea. One in a run folder is unregistered here, before whoever made it deletes it; any other
 * (`dist/s7`, `dist/pack`) is the person's, and its line says how. One line per app, for the run's output; none for an
 * installed app, which is meant to be registered.
 */
export function unregisterGiven(apps: readonly (string | null)[], o: { exec?: (file: string, args: string[]) => string; places?: OwnPlaces } = {}): string[] {
  const lines: string[] = []
  for (const app of apps) {
    // an installed app is meant to be registered: nothing to do, nothing to say
    if (!app || applicationsFolderOf(app, (o.places ?? ownPlaces()).homedir)) continue
    const made = runFolderOf(app, o.places)
    const r = made === null ? null : unregisterOwnApp(app, made, o)
    if (r?.done) lines.push(`LaunchServices: ${app} unregistered (a test build is not left known to macOS as Kea)`)
    else lines.push(`LaunchServices: ${app} stays registered with macOS as Kea${r ? ` (${r.why})` : ''}. Once you have deleted it: ${lsregister()} -u ${app}`)
  }
  return lines
}

export interface RegisteredApp {
  path: string
  /** LaunchServices itself says nothing is at the path any more. */
  missing: boolean
}

/** The bundles a LaunchServices dump (`lsregister -dump`) lists under exactly `bundleId`, in the dump's order. */
export function registeredApps(dump: string, bundleId: string): RegisteredApp[] {
  const out: RegisteredApp[] = []
  for (const rec of dump.split(/\n-{40,}\n/)) {
    const field = (name: string) => new RegExp(`^${name}:[ \\t]+(.*)$`, 'm').exec(rec)?.[1]?.trim()
    if (field('bundle id') === undefined || field('identifier') !== bundleId) continue
    const p = field('path')?.replace(/ \(0x[0-9a-f]+\)$/, '')
    if (p) out.push({ path: p, missing: /^Bundle node not found on disk/m.test(rec) })
  }
  return out
}

/** What LaunchServices has registered under `bundleId` now (read-only: `lsregister -dump`). */
export function registeredNow(bundleId: string): RegisteredApp[] {
  return registeredApps(execFileSync(lsregister(), ['-dump'], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] }), bundleId)
}
