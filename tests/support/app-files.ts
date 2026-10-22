// The file panel in a running Kea, for the app-level suites: the tree, the Changes list, the header's diff stat and the
// finder as a person sees them, read from the DOM. The rows are virtualised, so a row is found by its path among
// the rows drawn; a test that needs one further down scrolls or uses the keyboard.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { L } from '@kea/protocol'
import { fixtureGitEnv } from '@kea-tools/repo-factory/src/index.ts'
import { harnessUserHome } from '../../tools/perf/src/launch.ts'
import { shq, STEP_MS, until, type Kea, type KeaRun } from './app.ts'

/** How long a test waits for the session's git status to list a change (through the status pipeline). */
export const GIT_MS = 45_000

export const panelRegion = (page: Page): Locator => page.getByRole('region', { name: 'File panel' })
export const tree = (page: Page): Locator => page.getByRole('tree', { name: 'Files' })
export const changesList = (page: Page): Locator => page.getByRole('listbox', { name: 'Changes' })
export const treeRow = (page: Page, path: string): Locator => tree(page).locator(`[role=treeitem][data-path=${JSON.stringify(path)}]`)
export const changeRow = (page: Page, path: string): Locator => changesList(page).locator(`[role=option][data-path=${JSON.stringify(path)}]`)
export const finder = (page: Page): Locator => page.getByRole('dialog', { name: 'Go to File' })

export interface TreeRowSeen {
  path: string
  label: string
  kind: string
  level: number
  expanded: boolean | null
  selected: boolean
  /** The status letter, `dot` for a folder with changes below it, null for none. */
  git: string | null
  ignored: boolean
}

/** The tree's rows as drawn, top to bottom. */
export async function treeRows(kea: Kea): Promise<TreeRowSeen[]> {
  return (await kea.page()).evaluate(() =>
    [...document.querySelectorAll('[role=tree][aria-label="Files"] [role=treeitem]')].map((e) => ({
      path: e.getAttribute('data-path') ?? '',
      label: e.querySelector('.ft-name')?.textContent ?? '',
      kind: e.getAttribute('data-kind') ?? '',
      level: Number(e.getAttribute('aria-level')),
      expanded: e.hasAttribute('aria-expanded') ? e.getAttribute('aria-expanded') === 'true' : null,
      selected: e.getAttribute('aria-selected') === 'true',
      git: e.getAttribute('data-git'),
      ignored: e.classList.contains('ignored'),
    })),
  )
}

/** The labels of the tree's rows as drawn, indented two spaces a level. */
export async function treeText(kea: Kea): Promise<string[]> {
  return (await treeRows(kea)).map((r) => `${'  '.repeat(r.level - 1)}${r.label}${r.git ? ` [${r.git}]` : ''}`)
}

export async function waitTree(kea: Kea, what: string, pred: (rows: TreeRowSeen[]) => boolean, ms = STEP_MS): Promise<TreeRowSeen[]> {
  let last: TreeRowSeen[] = []
  return until(
    `the file tree: ${what}`,
    async () => {
      last = await treeRows(kea)
      return pred(last) ? last : undefined
    },
    ms,
  ).catch((e: unknown) => {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n  tree: ${JSON.stringify(last.map((r) => `${r.path}${r.git ? `[${r.git}]` : ''}`))}`)
  })
}

export interface ChangeSeen {
  path: string
  letter: string
  name: string
  dir: string
  stat: string
  struck: boolean
  selected: boolean
}

/** The Changes list's rows as drawn, top to bottom. */
export async function changeRows(kea: Kea): Promise<ChangeSeen[]> {
  return (await kea.page()).evaluate(() =>
    [...document.querySelectorAll('[role=listbox][aria-label="Changes"] [role=option]')].map((e) => ({
      path: e.getAttribute('data-path') ?? '',
      letter: e.querySelector('.fp-letter')?.textContent ?? '',
      name: e.querySelector('.ch-name')?.textContent ?? '',
      dir: e.querySelector('.ch-dir')?.textContent ?? '',
      stat: (e.querySelector('.numstat')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      struck: e.querySelector('.ch-name')?.classList.contains('struck') ?? false,
      selected: e.getAttribute('aria-selected') === 'true',
    })),
  )
}

export async function waitChanges(kea: Kea, what: string, pred: (rows: ChangeSeen[]) => boolean, ms = GIT_MS): Promise<ChangeSeen[]> {
  let last: ChangeSeen[] = []
  return until(
    `the Changes list: ${what}`,
    async () => {
      last = await changeRows(kea)
      return pred(last) ? last : undefined
    },
    ms,
  ).catch((e: unknown) => {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n  changes: ${JSON.stringify(last.map((r) => `${r.letter} ${r.path}`))}`)
  })
}

/** The panel header's mode buttons as labelled (`Files`, `Changes 3`), and which is on. */
export async function panelModes(kea: Kea): Promise<{ label: string; on: boolean }[]> {
  return (await kea.page()).evaluate(() => [...document.querySelectorAll('.file-panel .segments .segment')].map((e) => ({ label: e.textContent ?? '', on: e.getAttribute('aria-pressed') === 'true' })))
}

/** Show Files (`files`) or Changes with a click on the header's toggle, as a person does. */
export async function showMode(kea: Kea, mode: 'Files' | 'Changes'): Promise<void> {
  const page = await kea.page()
  await panelRegion(page).getByRole('button', { name: new RegExp(`^${mode}`) }).click()
  await until(`the panel to show ${mode}`, async () => (await panelModes(kea)).some((m) => m.on && m.label.startsWith(mode)) || undefined)
}

// ── real clicks on rows (the lists are virtualised) ─────────────────────────────────────────────────

/**
 * Where a row of a virtualised list is: `in` the list's viewport, `out` of it by `dy` px (drawn in the overscan, or
 * cut by an edge), or `absent` (not drawn), with what a scroll towards it needs to know.
 */
type RowPlace = { at: 'in' } | { at: 'out'; dy: number } | { at: 'absent'; atEnd: boolean; page: number }

function rowPlace(list: Locator, rowSelector: string): Promise<RowPlace> {
  return list.evaluate((el, sel) => {
    const box = el.getBoundingClientRect()
    const row = el.querySelector(sel)
    if (!row) {
      const drawn = [...el.querySelectorAll('[data-index]')].map((r) => Number(r.getAttribute('data-index')))
      return { at: 'absent' as const, atEnd: Math.max(-1, ...drawn) >= Number(el.getAttribute('data-rows')) - 1, page: box.height }
    }
    const r = row.getBoundingClientRect()
    if (r.top >= box.top && r.bottom <= box.bottom) return { at: 'in' as const }
    return { at: 'out' as const, dy: r.top < box.top ? r.top - box.top : r.bottom - box.bottom }
  }, rowSelector)
}

/** The wheel over the middle of `list` (the tree, the Changes list); resolves once its scroll has come to rest (a wheel's scroll is animated). */
export async function wheel(page: Page, list: Locator, dy: number): Promise<void> {
  const box = await list.boundingBox()
  if (!box) return
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, dy)
  await list.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        let last = el.scrollTop
        let same = 0
        const look = () => {
          same = el.scrollTop === last ? same + 1 : 0
          last = el.scrollTop
          if (same >= 3) resolve()
          else requestAnimationFrame(look)
        }
        requestAnimationFrame(look)
      }),
  )
}

/**
 * Bring a row into its list's viewport with the wheel, as a person scrolls. A row is never clicked while it is drawn
 * outside the viewport: the rows are not keyed, so a scroll that a click started would put another row's content
 * under the pointer.
 */
async function wheelToRow(page: Page, list: Locator, rowSelector: string, what: string): Promise<void> {
  let wrapped = false
  await until(`${what} in view`, async () => {
    const place = await rowPlace(list, rowSelector)
    if (place.at === 'in') return true
    if (place.at === 'out') await wheel(page, list, place.dy)
    else if (!place.atEnd) await wheel(page, list, place.page)
    else if (!wrapped) {
      // the end of the list, and the row is not there: once more from the top
      wrapped = true
      await wheel(page, list, -(await list.evaluate((el) => el.scrollHeight)))
    }
    return undefined
  })
}

const attr = (path: string): string => `[data-path=${JSON.stringify(path)}]`

/**
 * A file's or folder's row in Files, on screen: the folders above it are opened one by one with a click each (a chain
 * of single-child folders is one row and opens as one), and the tree is scrolled with the wheel until the row is in
 * view. Resolves with the row. Nothing here goes around the tree: a row core does not list is never found.
 */
export async function treeRowInView(kea: Kea, target: string): Promise<Locator> {
  const page = await kea.page()
  if (!(await panelModes(kea)).some((m) => m.on && m.label.startsWith('Files'))) await showMode(kea, 'Files')
  const list = tree(page)
  await list.waitFor({ timeout: STEP_MS })
  let clicked: string | null = null
  await until(`the tree row of ${target}`, async () => {
    if ((await treeRow(page, target).count()) > 0) return true
    const rows = await treeRows(kea)
    // the folder drawn that is nearest above it (a compact row carries the last folder of its chain)
    const above = rows.filter((r) => r.kind === 'dir' && target.startsWith(`${r.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]
    if (above && above.expanded === false) {
      // one click per closed folder: a second one while its entries are still on their way would close it again
      if (clicked === above.path) return undefined
      clicked = above.path
      await wheelToRow(page, list, `[role=treeitem]${attr(above.path)}`, `the folder ${above.path}`)
      await treeRow(page, above.path).click()
      return undefined
    }
    // its folder is open (or is itself out of the rows drawn): the row is further along the list
    const place = await rowPlace(list, `[role=treeitem]${attr(target)}`)
    if (place.at === 'absent' && rows.length > 0 && (await list.evaluate((el) => el.scrollHeight > el.clientHeight))) await wheel(page, list, place.atEnd ? -(await list.evaluate((el) => el.scrollHeight)) : place.page)
    return undefined
  })
  await wheelToRow(page, list, `[role=treeitem]${attr(target)}`, `the tree row of ${target}`)
  return treeRow(page, target)
}

/**
 * Click a file in Files, as a person does: the folders above it opened first, the row scrolled into view (the file view
 * opens, in the preview tab).
 */
export async function clickFile(kea: Kea, path: string): Promise<void> {
  await (await treeRowInView(kea, path)).click()
}

/**
 * A change's row in Changes, on screen: Changes is shown with a click on the panel's toggle when it is not, the row is
 * waited for (the status pipeline lists it) and scrolled into view with the wheel. Resolves with the row.
 */
export async function changeRowInView(kea: Kea, path: string, ms = GIT_MS): Promise<Locator> {
  const page = await kea.page()
  if (!(await panelModes(kea)).some((m) => m.on && m.label.startsWith('Changes'))) await showMode(kea, 'Changes')
  await waitChangesListed(kea, path, ms)
  await wheelToRow(page, changesList(page), `[role=option]${attr(path)}`, `the change ${path}`)
  return changeRow(page, path)
}

/** The Changes list holds `path` (drawn or not: the list knows its rows' count, a row further down is scrolled to). */
async function waitChangesListed(kea: Kea, path: string, ms: number): Promise<void> {
  const page = await kea.page()
  const list = changesList(page)
  await list.waitFor({ timeout: STEP_MS })
  await until(
    `the Changes list to hold ${path}`,
    async () => {
      const place = await rowPlace(list, `[role=option]${attr(path)}`)
      if (place.at !== 'absent') return true
      // a list longer than its viewport: look further down, then from the top again (it may have grown meanwhile)
      if (await list.evaluate((el) => el.scrollHeight > el.clientHeight)) await wheel(page, list, place.atEnd ? -(await list.evaluate((el) => el.scrollHeight)) : place.page)
      return undefined
    },
    ms,
  ).catch(async (e: unknown) => {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n  changes: ${JSON.stringify((await changeRows(kea)).map((r) => `${r.letter} ${r.path}`))}`)
  })
}

/** Click a change in Changes, as a person does (the diff view opens, in the preview tab). */
export async function clickChange(kea: Kea, path: string, ms = GIT_MS): Promise<void> {
  await (await changeRowInView(kea, path, ms)).click()
}

/** Click `Branch` or `Uncommitted` in the Changes header's scope switch (`group` "Compare with"), as a person does. */
export async function clickScope(kea: Kea, scope: 'Branch' | 'Uncommitted'): Promise<void> {
  const page = await kea.page()
  if (!(await panelModes(kea)).some((m) => m.on && m.label.startsWith('Changes'))) await showMode(kea, 'Changes')
  const button = panelRegion(page).getByRole('group', { name: 'Compare with' }).getByRole('button', { name: scope, exact: true })
  await button.click()
  await until(`the scope switch on ${scope}`, async () => (await button.getAttribute('aria-pressed')) === 'true' || undefined, GIT_MS)
}

/** The scope the Changes header shows as pressed (`Branch`, `Uncommitted`); null while Changes is not shown or has no status yet. */
export async function scopeShown(kea: Kea): Promise<string | null> {
  return (await kea.page()).evaluate(() => document.querySelector('.file-panel [role=group][aria-label="Compare with"] button[aria-pressed="true"]')?.textContent?.trim() ?? null)
}

/** The header's diff stat as written (`+182 −40`); null while none is shown. */
export async function diffStatText(kea: Kea): Promise<string | null> {
  return (await kea.page()).evaluate(() => {
    const b = document.querySelector('.main-header .diff-stat')
    return b ? (b.textContent ?? '').replace(/\s+/g, ' ').trim() : null
  })
}

/** The finder's rows as drawn (`path`, and whether it is the current one). */
export async function finderRows(kea: Kea): Promise<{ path: string; current: boolean; text: string; marked: string }[]> {
  return (await kea.page()).evaluate(() =>
    [...document.querySelectorAll('[role=dialog][aria-label="Go to File"] [role=option]')].map((e) => ({
      path: e.getAttribute('data-path') ?? '',
      current: e.getAttribute('aria-selected') === 'true',
      text: (e.textContent ?? '').replace(/\s+/g, ' ').trim(),
      marked: [...e.querySelectorAll('mark')].map((m) => m.textContent ?? '').join(''),
    })),
  )
}

// ── the Trash (Discard Changes…) ────────────────────────────────────────────────────────────────────

/**
 * The run's own `trash` tool, the only one a harness-launched core runs (app/core/src/files/discard.ts
 * `trashToolFor`: `<HOME>/bin/trash`, HOME being the run's empty folder): it moves what it is given into a folder of
 * the run's, so no test reaches the system's Trash. It takes either system's arguments (macOS `-s <file>`, Linux
 * `trash -- <file>`). `moved()` lists that folder.
 */
export class TrashWorld {
  readonly dir: string

  constructor(run: KeaRun) {
    const bin = path.join(harnessUserHome(run.home), 'bin')
    this.dir = path.join(run.home, 'moved-to-trash')
    fs.mkdirSync(bin, { recursive: true })
    fs.mkdirSync(this.dir, { recursive: true })
    const tool = path.join(bin, 'trash')
    fs.writeFileSync(tool, `#!/bin/sh\n[ "$1" = "-s" ] && shift\n[ "$1" = "trash" ] && shift\n[ "$1" = "--" ] && shift\nexec /bin/mv -- "$@" ${shq(`${this.dir}/`)}\n`, { mode: 0o755 })
    fs.chmodSync(tool, 0o755)
  }

  moved(): string[] {
    return fs.readdirSync(this.dir).sort()
  }
}

// ── git's fsmonitor ─────────────────────────────────────────────────────────────────────────────────

/** The slow-status hint in the panel ("Git status is slow in this repository." with its two buttons). */
export const fsmonitorHint = (page: Page): Locator => panelRegion(page).getByRole('status').filter({ hasText: 'Git status is slow' })

/**
 * A `git` first on the run's PATH (beside its fake agents) that is the real one, taking longer than L.fsmonitorHintMs
 * over each `status` while `slow(true)`: the hint needs a status that slow, and a test repository is never that big.
 * Made before Kea is launched (core looks git up once, at its start).
 */
export class SlowGit {
  private readonly flag: string

  constructor(run: KeaRun) {
    const real = execFileSync('/usr/bin/which', ['git'], { env: fixtureGitEnv(), encoding: 'utf8' }).trim() // os-ok: in /usr/bin on both systems
    this.flag = path.join(run.home, 'git-is-slow')
    const seconds = ((L.fsmonitorHintMs + SLOW_GIT_MARGIN_MS) / 1000).toFixed(1)
    const script = `#!/bin/sh\nif [ -e ${shq(this.flag)} ]; then\n  for a in "$@"; do\n    if [ "$a" = status ]; then /bin/sleep ${seconds}; break; fi\n  done\nfi\nexec ${shq(real)} "$@"\n`
    fs.writeFileSync(path.join(run.agentBin, 'git'), script, { mode: 0o755 })
  }

  slow(on: boolean): void {
    if (on) fs.writeFileSync(this.flag, '')
    else fs.rmSync(this.flag, { force: true })
  }
}
/** How much longer than L.fsmonitorHintMs the slow git's status takes. */
const SLOW_GIT_MARGIN_MS = 300

function gitExit(dir: string, ...args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim() }
  } catch (e) {
    const x = e as { status?: number | null; stderr?: string }
    return { code: x.status ?? 1, out: String(x.stderr ?? '').trim() }
  }
}

/** A git config value as `dir` sees it (`--worktree`, `--local` … before the key); '' when unset. */
export const gitConfig = (dir: string, ...args: string[]): string => {
  const r = gitExit(dir, 'config', ...args)
  return r.code === 0 ? r.out : ''
}

/**
 * Why git here cannot run its fsmonitor daemon, so Kea offers no slow-status hint (Linux's git has none); null
 * when it can. Asked as core asks (`git version --build-options`, app/core/src/files/fsmonitor.ts).
 */
export function fsmonitorProblem(): string | null {
  const r = gitExit(os.tmpdir(), 'version', '--build-options')
  return r.code === 0 && /^feature: fsmonitor--daemon$/m.test(r.out) ? null : 'git here has no fsmonitor daemon, so Kea offers no slow-status hint'
}

/** git's fsmonitor daemon of this worktree is running (`fsmonitor--daemon status` exits 0). */
export const fsmonitorRuns = (worktree: string): boolean => gitExit(worktree, 'fsmonitor--daemon', 'status').code === 0

/**
 * Stop the fsmonitor daemon git started for `worktree`, if one runs: a run's cleanup removes the worktree's files but
 * knows nothing of git's own daemon. Only this worktree's: the daemon is asked through its own socket in the
 * worktree's git dir; no process is looked for or signalled. Throws when it is still running afterwards.
 */
export function stopFsmonitorDaemon(worktree: string): void {
  if (!fs.existsSync(worktree)) return
  if (fsmonitorRuns(worktree)) gitExit(worktree, 'fsmonitor--daemon', 'stop')
  if (fsmonitorRuns(worktree)) throw new Error(`git's fsmonitor daemon of ${worktree} is still running`)
}
