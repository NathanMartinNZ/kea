// What `pnpm kea:install` says before it replaces anything: what it found and what it will do, in plain words, and
// whether Kea is opened again afterwards. Pure: the looks are made elsewhere (running.ts, tools/install.ts) and handed
// in, so every sentence here can be tested.

import os from 'node:os'
import type { HolderGroup } from './running.ts'

export interface KeaFound {
  pid: number
  /** `--kea-home=` it runs with; null: the installed app's own home. */
  home: string | null
  window: boolean
  /** It is the app in front (it has the keyboard). */
  front: boolean
  /** Holders that are not detached: they end when this Kea quits. */
  held: number
}

export interface Findings {
  target: string
  /** `--install-to`: a test's folder. */
  test: boolean
  /** The version at the target now; null: nothing is installed there. */
  installedVersion: string | null
  newVersion: string
  /** What `recover` did about an interrupted install. */
  recovered: readonly string[]
  keas: readonly KeaFound[]
  /** Holders alive under each home that was looked at, by build. */
  holders: readonly { home: string; groups: readonly HolderGroup[] }[]
  /**
   * The installed build does not prune archived sessions' build folders (or cannot be read) and this one does:
   * its first launch prunes long-archived sessions' build folders.
   */
  firstPrune: boolean
  /** The default of the setting that prune follows, in days (for the notice). */
  pruneDays: number
  /** `--no-relaunch`. */
  noRelaunch: boolean
  /** How long Kea is given to quit, in seconds. */
  quitSeconds: number
}

export interface Relaunch {
  will: boolean
  /** Why not (or, when it will, what happens), as a sentence. */
  say: string
}

const tilde = (p: string) => (p === os.homedir() || p.startsWith(`${os.homedir()}/`) ? `~${p.slice(os.homedir().length)}` : p)
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * Kea is opened again only when that changes nothing for the person at the Mac: it was running from the target with
 * its own home, had a window, and was the app in front (so the new window takes the keyboard the old one had). In
 * every other case it is left closed and the summary says to open it: a Kea that sat in the menu bar or behind another
 * app would come back as a window in front, and nothing Kea has today starts it any other way.
 */
export function relaunchPlan(f: Pick<Findings, 'test' | 'keas' | 'firstPrune' | 'noRelaunch'>): Relaunch {
  if (f.keas.length === 0) return { will: false, say: 'Kea was not running, so it is not opened.' }
  if (f.test) return { will: false, say: 'Kea is not opened again: this is a test target.' }
  if (f.noRelaunch) return { will: false, say: 'Kea is not opened again (--no-relaunch): open it when you are ready.' }
  if (f.firstPrune) return { will: false, say: 'Kea is not opened again this time, so you can change that setting first: the prune runs when this build first opens.' }
  const own = f.keas.filter((k) => k.home === null)
  if (own.length !== 1 || f.keas.length !== 1) return { will: false, say: 'Kea is not opened again: more than one Kea runs from this app, or one with a home of its own. Open the ones you want.' }
  const k = own[0]!
  if (!k.window) return { will: false, say: 'Kea is not opened again: it had no window (it ran from the menu bar or the Dock), and opening it would put a window in front. Open Kea to get the menu-bar item and notifications back.' }
  if (!k.front) return { will: false, say: 'Kea is not opened again: it was not the app in front, and opening it would take the keyboard from the app you are in. Open Kea when you are ready.' }
  return { will: true, say: 'Kea is opened again and reattaches every session.' }
}

/**
 * The setting the prune of archived sessions' build folders follows. Older builds declared it before they
 * pruned, so audit.ts `firstPruneDue` looks for the prune itself.
 */
export const PRUNE_SETTING = 'general.pruneArchivedBuildDirsDays'

/** The text that turns the prune off in settings.json, which nests a key by its dots (a flat dotted key is ignored). */
const [PRUNE_GROUP, PRUNE_KEY] = PRUNE_SETTING.split('.') as [string, string]
const PRUNE_OFF = `{ "${PRUNE_GROUP}": { "${PRUNE_KEY}": 0 } }`

/**
 * The notice before the first launch that prunes. `days`: the setting's default (packages/protocol
 * `SETTINGS`).
 */
export function firstPruneNotice(days: number): string[] {
  return [
    'Before you open Kea: this build removes the build folders of archived sessions, and the one it replaces',
    `did not. The first time it opens, every session archived for more than ${days} days loses its rebuildable folders`,
    '(ignored node_modules, target, dist, build, .venv and the like, at any depth) for good; unarchiving such a',
    'session runs its setup again. To keep them, first',
    `set ${PRUNE_OFF} in ~/.kea/settings.json (beside what is there).`,
  ]
}

/** The lines printed before anything is replaced. */
export function describe(f: Findings): string[] {
  const lines: string[] = []
  const target = tilde(f.target)
  for (const r of f.recovered) lines.push(`Note: ${r}`)
  lines.push('What is there now')
  lines.push(f.installedVersion === null ? `  · Nothing is installed at ${target} yet.` : `  · ${target} is Kea ${f.installedVersion}. This build is Kea ${f.newVersion}.`)
  if (f.keas.length === 0) lines.push('  · Kea is not running from it.')
  for (const k of f.keas) {
    const where = k.window ? (k.front ? 'its window is open and in front' : 'its window is open, behind another app') : 'no window (menu bar or Dock)'
    lines.push(`  · Kea is running from it (pid ${k.pid}${k.home ? `, home ${tilde(k.home)}` : ''}): ${where}.`)
  }
  for (const h of f.holders) {
    const total = h.groups.reduce((n, g) => n + g.count, 0)
    if (total === 0) {
      lines.push(`  · No session's terminal is running under ${tilde(h.home)}.`)
      continue
    }
    lines.push(`  · ${count(total, 'terminal is', 'terminals are')} running in the background under ${tilde(h.home)}, started by ${count(h.groups.length, 'build')}:`)
    for (const g of h.groups) lines.push(`      ${g.build}: ${g.count}`)
    lines.push(`    Each runs from its own copy of kea-helper in ${tilde(h.home)}/bin, not from the app. None is touched.`)
  }
  const held = f.keas.reduce((n, k) => n + k.held, 0)
  lines.push('What happens next')
  if (held > 0) {
    lines.push(`  Nothing: ${count(held, 'terminal runs', 'terminals run')} as Kea's own ${held === 1 ? 'process' : 'processes'} (not detached), and would end when Kea quits.`)
    lines.push('  Quit Kea yourself if you want to go on without them, then run this again.')
    return lines
  }
  let n = 1
  lines.push(`  ${n++}. The new build is copied next to the app and its signature checked${f.keas.length ? ' (Kea keeps running)' : ''}.`)
  if (f.keas.length) lines.push(`  ${n++}. Kea is asked to quit completely, and given ${f.quitSeconds} s. Your sessions keep running without it. If it does not quit, nothing is replaced.`)
  if (f.installedVersion === null) lines.push(`  ${n++}. It is moved to ${target}.`)
  else lines.push(`  ${n++}. ${target} is replaced: same path, same signature, so macOS keeps its privacy grants and notification permission.`)
  lines.push(`  ${n++}. ${relaunchPlan(f).say}`)
  if (f.firstPrune) lines.push('', ...firstPruneNotice(f.pruneDays))
  return lines
}
