// The design-system journeys: the first run, and the accessibility checks a person with a screen reader or a keyboard
// alone depends on. Kea is launched through tests/e2e/fixtures.ts (unfocused, a temp KEA_HOME, hermetic git) with
// tools/fake-agent as Claude Code; the real CLI is never run. Accessible names are read from Chromium's own
// accessibility tree (CDP), so a name is what assistive technology is given, not what the markup seems to say. Nothing
// here touches the clipboard.

import type { CDPSession, Page } from '@playwright/test'
import { tinyRepo } from '@kea-tools/repo-factory/src/index.ts'
import type { AgentEvent } from '@kea/protocol'
import { STEP_MS, until, type Kea } from '../support/app.ts'
import { claudeByDefault, fakeAgentTerminal, startFakeSession } from '../support/app-fake-agent.ts'
import { clickChange, clickFile, GIT_MS, showMode, waitChanges, waitTree } from '../support/app-files.ts'
import { focusIn, openPalette, palette } from '../support/app-palette.ts'
import { commitFiles, runCommand, serverChip, serverScript, waitServer } from '../support/app-server.ts'
import { addProject, projectRow, promptBox, selectSession, sessionMenu, sessionRow, startSession, waitLive, waitRow } from '../support/app-sessions.ts'
import { ingest } from '../support/app-status.ts'
import { sessionWorktree, waitBody, writeFiles } from '../support/app-viewer.ts'
import { expect, test } from './fixtures.ts'
import { sysKey, sysLabel } from '../support/keys.ts'

/** An agent that draws its prompt and waits, firing no hook of its own after its start: its status is the test's to give. */
const QUIET = `steps:
  - frame: ["✻ fake-agent", "", "> {{prompt}}", ""]
  - wait: { answer: "~" }
`

/** Put a session into a status, as its agent's hooks would, and wait for its row to say so. */
async function status(kea: Kea, id: string, glyph: string, ...events: AgentEvent[]): Promise<void> {
  await ingest(kea, id, 'hook', ...events)
  await waitRow(kea, id, glyph, (r) => r.status === glyph)
}

/** What the window logged as an error from here on (a page error, or `console.error`). */
function errorsOf(page: Page): string[] {
  const seen: string[] = [] // bounded: one test's errors (none, when it passes)
  page.on('pageerror', (e) => seen.push(String(e)))
  page.on('console', (m) => void (m.type() === 'error' && seen.push(m.text())))
  return seen
}

test('E-PRJ-1 · first run: an empty home shows one line and “Add project… ⌘O” in the sidebar; ⌘O adds the folder picked, its row appears and the composer is there with the keyboard in its prompt; a prompt typed starts a session, and nothing reported an error', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const errors = errorsOf(page)
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  // no projects: one line of text and one quiet button, nothing else in the list
  const empty = sidebar.locator('.sidebar-empty')
  await expect(empty.locator('p')).toHaveText('Add a project to get started.', { timeout: STEP_MS })
  const add = empty.getByRole('button')
  await expect(add).toHaveText(`Add project… ${sysLabel('⌘O')}`)
  expect(await add.evaluate((b) => b.classList.contains('primary')), 'a quiet button, not the accent one').toBe(false)
  await expect(sidebar.getByRole('treeitem')).toHaveCount(0)
  // the line starts where the sidebar's content does (empty states are aligned top-left with the content)
  const edges = await empty.evaluate((e) => {
    const p = e.querySelector('p')!.getBoundingClientRect()
    const b = e.querySelector('button')!
    return { text: p.left, label: b.getBoundingClientRect().left + parseFloat(getComputedStyle(b).paddingLeft), top: p.top, sidebar: e.closest('aside')!.getBoundingClientRect().top }
  })
  expect(Math.abs(edges.text - edges.label), 'the button’s label starts under the line’s first letter').toBeLessThan(1)
  // no project yet: no composer, and no error on screen
  await expect(page.getByRole('region', { name: 'New session' })).toHaveCount(0)
  await expect(page.locator('.toast')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Banners' }).getByRole('status')).toHaveCount(0)

  // ⌘O with the folder the picker would return
  const root = tinyRepo({ name: 'atlas-web', parent: run.home }).root
  await addProject(kea, root, 'atlas-web')
  await expect(empty).toHaveCount(0)
  await expect(projectRow(page, 'atlas-web')).toBeVisible()
  // a project with no sessions: the composer, already focused
  const composer = page.getByRole('region', { name: 'New session' })
  await expect(composer).toBeVisible({ timeout: STEP_MS })
  await expect(promptBox(page)).toBeFocused({ timeout: STEP_MS })
  // it is interactive: what is typed lands in the prompt, Start answers, and ⌘↵ starts the session
  const id = await startSession(kea, 'Fix auth redirect', { open: false })
  await waitLive(kea, id)
  await expect(sessionRow(page, id)).toHaveAttribute('aria-label', 'Fix auth redirect')
  // the same folder again makes no second project: the keyboard goes to the one there is
  await kea.app.evaluate((_e, p) => (globalThis as unknown as { __keaTest: { queueFolder(p: string): void } }).__keaTest.queueFolder(p), root)
  await page.keyboard.press(sysKey('Meta+o'))
  await expect(projectRow(page, 'atlas-web')).toBeFocused({ timeout: STEP_MS })
  await expect(sidebar.locator('[role=treeitem][aria-level="1"]')).toHaveCount(1)
  await expect(page.locator('.toast')).toHaveCount(0)
  expect(errors, 'nothing in the window reported an error').toEqual([])
  await kea.assertUnfocused()
})

/** What a row's glyph tells assistive technology: its role, its name, and the row's own description. */
async function glyphSays(page: Page, id: string): Promise<{ role: string | null; name: string | null; described: string | null; kind: string | null }> {
  return page.evaluate((sid) => {
    const row = document.querySelector(`[role=treeitem][data-session-id="${sid}"]`)
    const g = row?.querySelector('.kea-glyph')
    return { role: g?.getAttribute('role') ?? null, name: g?.getAttribute('aria-label') ?? null, described: row?.getAttribute('aria-description') ?? null, kind: g?.getAttribute('data-glyph') ?? null }
  }, id)
}

test('A-4 · status glyphs expose text: each status a row can show is an image named in words (Working, Needs permission, Needs an answer, Finished, unread, Idle, Failed, the account condition), the row is described by the same words, and the palette’s rows carry them too', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  await addProject(kea, tinyRepo({ name: 'atlas-web', parent: run.home }).root, 'atlas-web')
  const names = ['working', 'permission', 'question', 'unread', 'idle', 'failed', 'limited'] as const
  const ids = {} as Record<(typeof names)[number], string>
  for (const n of names) ids[n] = (await startFakeSession(kea, `a4-${n}`, `session ${n}`, QUIET, { background: true })).id
  const turn: AgentEvent = { t: 'turn.started' }
  await status(kea, ids.working, 'working', turn)
  await status(kea, ids.permission, 'needsYou', turn, { t: 'attention.permission', key: 'Bash: pnpm add stripe', tool: 'Bash', summary: 'pnpm add stripe' })
  await status(kea, ids.question, 'needsYou', turn, { t: 'attention.question', key: 'Which database?', summary: 'Which database?' })
  await status(kea, ids.unread, 'unread', turn, { t: 'turn.finished', lastMessage: 'Done.', backgroundWork: false })
  await status(kea, ids.failed, 'failed', turn, { t: 'turn.failed', error: 'the API answered 500', kind: 'other' })
  // a turn that finishes while its session is on screen and the window counts as focused was seen: idle
  await selectSession(kea, ids.idle)
  await kea.pretendFocused(true)
  await status(kea, ids.idle, 'idle', turn, { t: 'turn.finished', lastMessage: 'Done.', backgroundWork: false })
  await kea.pretendFocused(false)
  // the account condition last: a turn finishing after it would end it
  await status(kea, ids.limited, 'limited', turn, { t: 'turn.failed', error: 'usage limit reached', kind: 'rate_limit', resetsAt: Date.now() + 3_600_000 })

  const want: Record<(typeof names)[number], { kind: string; says: string }> = {
    working: { kind: 'working', says: 'Working' },
    permission: { kind: 'needsYou', says: 'Needs permission' },
    question: { kind: 'needsYou', says: 'Needs an answer' },
    unread: { kind: 'unread', says: 'Finished, unread' },
    idle: { kind: 'idle', says: 'Idle' },
    failed: { kind: 'failed', says: 'Failed' },
    limited: { kind: 'limited', says: 'Waiting on a usage limit' },
  }
  const said = new Set<string>()
  for (const n of names) {
    const g = await glyphSays(page, ids[n])
    expect(g.kind, n).toBe(want[n].kind)
    expect(g.role, `${n}: the glyph is an image to assistive technology`).toBe('img')
    expect(g.name, `${n}: named in words`).toBe(want[n].says)
    expect(g.described, `${n}: the row is described by its status`).toBe(g.name)
    said.add(g.name ?? '')
  }
  // never the same words for two statuses (two shapes share a glyph, never a name)
  expect(said.size).toBe(names.length)

  // the palette's session rows carry the glyph, named
  await openPalette(kea)
  await page.keyboard.type('session permission')
  const row = palette(page).locator(`[role=option][data-id="${ids.permission}"]`)
  await expect(row.locator('.kea-glyph')).toHaveAttribute('aria-label', /\S/, { timeout: STEP_MS })
  await expect(row.locator('.kea-glyph')).toHaveAttribute('role', 'img')
  await page.keyboard.press('Escape')
  await kea.assertUnfocused()
})

/** Roles a person operates or lands in: each must tell assistive technology what it is. */
const OPERATED = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem'])
/** Composite widgets and landmarks the keyboard moves between. */
const CONTAINERS = new Set(['tree', 'listbox', 'menu', 'tablist', 'dialog', 'alertdialog', 'toolbar', 'grid', 'radiogroup', 'search', 'region', 'complementary', 'main', 'navigation', 'group'])

interface AxNode {
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  backendDOMNodeId?: number
  properties?: { name: string; value: { value?: unknown } }[]
}

/** Accessible names as Chromium computes them (its accessibility tree over CDP), screen by screen. */
class Names {
  private readonly cdp: CDPSession
  /** Every exposed element with nothing to say for itself, as `where: <markup>`. */
  readonly unnamed: string[] = [] // bounded: one test's findings (none, when it passes)
  /** Elements checked, by screen. */
  readonly checked = new Map<string, number>() // bounded: one entry per screen of the journey

  private constructor(cdp: CDPSession) {
    this.cdp = cdp
  }

  static async of(page: Page): Promise<Names> {
    return new Names(await page.context().newCDPSession(page))
  }

  /**
   * Check the screen as it is now: every element a person operates (a control by its role, or anything else the Tab
   * key stops at) and every container the keyboard moves between says what it is. `min`: at least this many operated
   * elements must be there, so the check can fail.
   */
  async scan(where: string, min = 1): Promise<void> {
    const { nodes } = (await this.cdp.send('Accessibility.getFullAXTree')) as { nodes: AxNode[] }
    let operated = 0
    for (const n of nodes) {
      if (n.ignored) continue
      const role = n.role?.value ?? ''
      let isOperated = OPERATED.has(role)
      if (!isOperated && role !== 'RootWebArea' && n.properties?.some((p) => p.name === 'focusable' && p.value.value === true)) {
        // focusable by script alone (tabindex -1: a scroller, xterm's screen rows) is not a stop of the keyboard
        isOperated = (await this.attributes(n.backendDOMNodeId)).tabindex !== '-1'
      }
      if (isOperated) operated++
      if (!isOperated && !CONTAINERS.has(role)) continue
      if ((n.name?.value ?? '').trim() !== '') continue
      this.unnamed.push(`${where}: ${role} ${await this.markup(n.backendDOMNodeId)}`)
    }
    this.checked.set(where, operated)
    if (operated < min) this.unnamed.push(`${where}: only ${operated} operated elements were exposed (expected at least ${min})`)
  }

  /** The names of every exposed element of `role` on the screen now. */
  async named(role: string): Promise<string[]> {
    const { nodes } = (await this.cdp.send('Accessibility.getFullAXTree')) as { nodes: AxNode[] }
    return nodes.filter((n) => !n.ignored && n.role?.value === role).map((n) => n.name?.value ?? '')
  }

  private async attributes(backendNodeId: number | undefined): Promise<Record<string, string> & { nodeName?: string }> {
    if (backendNodeId === undefined) return {}
    try {
      const { node } = (await this.cdp.send('DOM.describeNode', { backendNodeId })) as { node: { nodeName: string; attributes?: string[] } }
      const out: Record<string, string> = { nodeName: node.nodeName.toLowerCase() }
      for (let i = 0; i + 1 < (node.attributes?.length ?? 0); i += 2) out[node.attributes![i]!] = node.attributes![i + 1]!
      return out
    } catch {
      return {}
    }
  }

  private async markup(backendNodeId: number | undefined): Promise<string> {
    const { nodeName, ...attrs } = await this.attributes(backendNodeId)
    if (!nodeName) return '(no element)'
    return `<${nodeName} ${Object.entries(attrs).map(([k, v]) => `${k}="${v.slice(0, 60)}"`).join(' ')}>`
  }

  async dispose(): Promise<void> {
    await this.cdp.detach().catch(() => undefined)
  }
}

const SETTINGS_PAGES = ['general', 'terminal', 'agents', 'notifications', 'files', 'keyboard', 'projects', 'disk', 'advanced', 'about'] as const

/** What each terminal on the page says of itself, the one on screen first. */
function terminalsSeen(page: Page): Promise<{ pty: string; shown: boolean; copy: boolean; name: string | null; role: string | null; input: string | null }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.terminal-host[data-pty]')]
      .map((h) => {
        const t = h.querySelector('.kea-terminal')
        return {
          pty: h.dataset.pty ?? '',
          shown: h.classList.contains('shown'),
          // xterm's screen-reader copy of the screen (its accessibility tree)
          copy: h.querySelector('.xterm-accessibility') !== null,
          name: t?.getAttribute('aria-label') ?? null,
          role: t?.getAttribute('role') ?? null,
          input: h.querySelector('.xterm-helper-textarea')?.getAttribute('aria-label') ?? null,
        }
      })
      .sort((a, b) => Number(b.shown) - Number(a.shown)),
  )
}

const screenReader = (kea: Kea, on: boolean): Promise<void> => kea.app.evaluate((_e, v) => (globalThis as unknown as { __keaTest: { screenReader(on: boolean): void } }).__keaTest.screenReader(v), on)

test('A-2 · every interactive element has an accessible name, icon-only buttons included: the first run, the composer and its menus, a session’s window with its rows’ hover actions, menus, popovers, the find bars, a file and a diff tab, the palette, the finder, the sheets and every Settings page; and with a screen reader running the terminal on screen, and no other, keeps xterm’s screen-reader copy and says its session and tab', async ({ run, launch }) => {
  test.setTimeout(240_000)
  claudeByDefault(run)
  const kea = await launch()
  await kea.oneColumn()
  const page = await kea.page()
  const names = await Names.of(page)
  try {
    // ── first run ──
    await expect(page.locator('.sidebar-empty')).toBeVisible({ timeout: STEP_MS })
    await names.scan('first run', 3)

    // ── the composer and each of its menus ──
    const root = tinyRepo({ name: 'atlas-web', parent: run.home }).root
    commitFiles(root, { 'start.sh': serverScript() }, { executable: true })
    await addProject(kea, root, 'atlas-web')
    const composer = page.getByRole('region', { name: 'New session' })
    await expect(promptBox(page)).toBeFocused({ timeout: STEP_MS })
    await expect(composer.getByRole('button', { name: 'Start', exact: true })).toBeEnabled({ timeout: STEP_MS })
    await names.scan('composer', 8)
    for (const [key, menu] of [[sysKey('Meta+1'), 'Agent'], [sysKey('Meta+2'), 'Model'], [sysKey('Meta+3'), 'Effort'], [sysKey('Meta+4'), 'Permission mode']] as const) {
      await page.keyboard.press(key)
      await page.getByRole('menu', { name: menu }).waitFor({ timeout: STEP_MS })
      await names.scan(`composer, ${menu} menu`, 8)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu', { name: menu })).toHaveCount(0)
    }
    await composer.getByRole('button', { name: /^Base branch/ }).click()
    await page.getByRole('menu', { name: 'Base branch' }).waitFor({ timeout: STEP_MS })
    await names.scan('composer, Base branch menu', 8)
    await page.keyboard.press('Escape')
    // a problem line with its ways out
    await composer.getByRole('textbox', { name: 'Branch name' }).fill('main')
    await expect(composer.getByRole('list', { name: 'Problems' })).toBeVisible({ timeout: STEP_MS })
    await names.scan('composer, a problem', 8)
    await composer.getByRole('textbox', { name: 'Branch name' }).fill('')
    await promptBox(page).focus()

    // ── a session's window ──
    const { id } = await startFakeSession(kea, 'a2', 'Fix auth redirect', QUIET, { open: false })
    await selectSession(kea, id)
    await waitTree(kea, 'the worktree listed', (rows) => rows.length > 0)
    const wt = sessionWorktree(root)
    writeFiles(wt, { 'src/auth/login.js': 'export const login = () => "/signin"\n', 'README.md': '# Atlas\n\nA small service.\n' })
    await expect(page.locator('.diff-stat')).toBeVisible({ timeout: GIT_MS })
    await page.mouse.move(900, 600)
    await names.scan('session', 15)
    // a row under the pointer shows its actions (Archive; New Session in …)
    await sessionRow(page, id).hover()
    await names.scan('session row under the pointer', 15)
    await projectRow(page, 'atlas-web').hover()
    await names.scan('project row under the pointer', 15)
    await page.mouse.move(900, 600)
    await showMode(kea, 'Changes')
    await waitChanges(kea, 'the changes', (rows) => rows.length >= 2)
    await names.scan('Changes', 15)

    // menus and popovers
    await sessionRow(page, id).click({ button: 'right' })
    await page.getByRole('menu', { name: 'Session menu' }).waitFor({ timeout: STEP_MS })
    await names.scan('session menu', 15)
    await page.keyboard.press('Escape')
    await projectRow(page, 'atlas-web').click({ button: 'right' })
    await page.getByRole('menu').waitFor({ timeout: STEP_MS })
    await names.scan('project menu', 15)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Session actions' }).click()
    await page.getByRole('menu').waitFor({ timeout: STEP_MS })
    await names.scan('header ⋯ menu', 15)
    await page.keyboard.press('Escape')
    await page.locator('[data-config-summary]').click()
    await page.locator('.session-popover').waitFor({ timeout: STEP_MS })
    await names.scan('config popover', 15)
    await page.keyboard.press('Escape')
    await expect(page.locator('.session-popover')).toHaveCount(0)
    await page.keyboard.press(sysKey('Alt+Meta+j'))
    await page.locator('.session-popover').waitFor({ timeout: STEP_MS })
    await names.scan('report wrong status', 15)
    await page.keyboard.press('Escape')
    await expect(page.locator('.session-popover')).toHaveCount(0)

    // the dev server running: its chip and Stop
    await page.keyboard.press(sysKey('Meta+r'))
    await waitServer(kea, 'running', 30_000)
    await serverChip(page).waitFor({ timeout: 30_000 })
    await names.scan('dev server running', 15)
    await page.keyboard.press(sysKey('Meta+r'))
    await waitServer(kea, 'stopped', 30_000)

    // the terminal's find bar
    const agent = await fakeAgentTerminal(kea, id)
    await kea.clickTab(agent)
    await page.keyboard.press(sysKey('Meta+f'))
    await page.getByRole('search').getByRole('textbox').waitFor({ timeout: STEP_MS })
    await names.scan('terminal find bar', 15)
    await page.keyboard.press('Escape')

    // a diff tab and a file tab, each with its bars
    await clickChange(kea, 'README.md')
    await page.locator('.viewer .cm-content').first().waitFor({ timeout: GIT_MS })
    await names.scan('diff tab', 15)
    await showMode(kea, 'Files')
    await clickFile(kea, 'package.json')
    await waitBody(kea, 'package.json', 'text')
    await names.scan('file tab', 15)
    await page.locator('.viewer .cm-content').first().click({ position: { x: 200, y: 40 } })
    await page.keyboard.press(sysKey('Meta+f'))
    await page.locator('.viewer .kea-find .kea-bar-input').waitFor({ timeout: STEP_MS })
    await names.scan('viewer find bar', 15)
    await page.keyboard.press('Escape')
    await page.keyboard.press(sysKey('Control+g'))
    await page.locator('.viewer .kea-goto .kea-bar-input').waitFor({ timeout: STEP_MS })
    await names.scan('viewer go to line', 15)
    await page.keyboard.press('Escape')

    // the palette, the finder, the Keyboard Shortcuts sheet
    await openPalette(kea)
    await names.scan('palette', 5)
    await page.keyboard.press('Escape')
    await openPalette(kea, sysKey('Meta+p'))
    await page.keyboard.type('re')
    await expect(page.locator('.finder-row').first()).toBeVisible({ timeout: STEP_MS })
    await names.scan('finder', 2)
    await page.keyboard.press('Escape')
    expect(await runCommand(kea, 'app.shortcuts')).toBe(true)
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible({ timeout: STEP_MS })
    await names.scan('Keyboard Shortcuts', 1)
    await page.keyboard.press('Escape')

    // every Settings page
    await page.keyboard.press(sysKey('Meta+,'))
    const settings = page.getByRole('dialog', { name: /^Settings: / })
    await expect(settings).toBeVisible({ timeout: STEP_MS })
    for (const p of SETTINGS_PAGES) {
      await settings.locator(`[role=tab][data-page="${p}"]`).click()
      await expect(settings.locator(`[role=tabpanel][data-page="${p}"]`)).toBeVisible({ timeout: STEP_MS })
      await names.scan(`Settings › ${p}`, SETTINGS_PAGES.length)
    }
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)

    // a confirmation sheet
    await sessionMenu(kea, id, 'session.delete')
    const del = page.getByRole('alertdialog', { name: 'Delete session' })
    await expect(del.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled({ timeout: STEP_MS })
    await names.scan('delete confirmation', 3)
    await page.keyboard.press('Escape')
    await expect(del).toHaveCount(0)

    // ── the terminal with a screen reader, on the real xterm ──
    await kea.clickTab(agent)
    await until('the Agent terminal on screen', async () => (await kea.shown()) === agent || undefined)
    await page.keyboard.press(sysKey('Meta+t'))
    const shell = await until('a second terminal on screen', async () => {
      const s = await kea.shown()
      return s && s !== agent ? s : undefined
    })
    await kea.clickTab(agent)
    await until('the Agent terminal on screen', async () => (await kea.shown()) === agent || undefined)
    // none runs: no terminal keeps a screen-reader copy; each still says what it is
    let seen = await terminalsSeen(page)
    expect(seen.filter((t) => t.copy)).toEqual([])
    const here = seen.find((t) => t.pty === agent)!
    expect(here).toMatchObject({ shown: true, role: 'group', name: 'Fix auth redirect, Agent terminal', input: 'Fix auth redirect, Agent terminal' })
    // a shell's tab names a terminal already: said once
    expect(seen.find((t) => t.pty === shell)).toMatchObject({ name: 'Fix auth redirect, Terminal 1', input: 'Fix auth redirect, Terminal 1' })
    // one starts: the terminal on screen keeps the copy, and it holds the screen's text; the hidden one pays nothing
    await screenReader(kea, true)
    await until('the screen-reader copy in the terminal on screen', async () => (await terminalsSeen(page)).find((t) => t.pty === agent)?.copy || undefined)
    seen = await terminalsSeen(page)
    expect(seen.filter((t) => t.copy).map((t) => t.pty)).toEqual([agent])
    await until('the copy says the screen', () => page.evaluate((p) => document.querySelector(`.terminal-host[data-pty="${p}"] .xterm-accessibility`)?.textContent?.includes('fake-agent') || undefined, agent))
    await names.scan('terminal with a screen reader', 15)
    // another tab comes on screen: the copy moves with it
    await kea.clickTab(shell)
    await until('the copy in the shell’s terminal alone', async () => {
      const now = (await terminalsSeen(page)).filter((t) => t.copy).map((t) => t.pty)
      return (now.length === 1 && now[0] === shell) || undefined
    })
    // a rename reaches the names
    await sessionMenu(kea, id, 'session.rename')
    const rename = page.getByRole('textbox', { name: 'Session title' })
    await expect(rename).toBeFocused({ timeout: STEP_MS })
    await names.scan('renaming', 15)
    await rename.fill('Auth redirect loop')
    await page.keyboard.press('Enter')
    await until('the terminals say the new title', async () => (await terminalsSeen(page)).every((t) => t.name?.startsWith('Auth redirect loop, ')) || undefined)
    // it stops: no copy anywhere, at once
    await screenReader(kea, false)
    await until('no screen-reader copy', async () => (await terminalsSeen(page)).every((t) => !t.copy) || undefined)

    // ── the ended session's overlay (Resume, Restart) ──
    await kea.clickTab(agent)
    expect(await runCommand(kea, 'session.stop', { id })).toBe(true)
    await waitRow(kea, id, 'detached', (r) => r.lifecycle === 'detached')
    await page.getByRole('status', { name: 'Session ended' }).waitFor({ timeout: STEP_MS })
    await names.scan('session ended', 15)

    expect(names.unnamed, `checked ${JSON.stringify([...names.checked])}`).toEqual([])
    await kea.assertUnfocused()
  } finally {
    await names.dispose()
  }
})

const REGIONS = [
  ['sidebar', 'aside.sidebar-column'],
  ['file panel', 'section.file-panel'],
  ['header', '.main-header'],
  ['work pane', '.work-pane'],
  ['agent pane', '.agent-pane'],
] as const
type RegionName = (typeof REGIONS)[number][0]

interface FocusStop {
  /** Nothing has the keyboard (the page's body does). */
  lost: boolean
  region: RegionName | null
  what: string
  /** The keyboard is in a terminal, whose sign of it is xterm's own (the cursor filled in). */
  terminal: boolean
  terminalFocused: boolean
  /** The focused element with room for its ring, inside the window; null when it has no box there. */
  clip: { x: number; y: number; width: number; height: number } | null
}

/** Where the keyboard is now. */
function focusStop(page: Page): Promise<FocusStop> {
  return page.evaluate((regions) => {
    const a = document.activeElement
    if (!(a instanceof HTMLElement) || a === document.body) return { lost: true, region: null, what: 'body', terminal: false, terminalFocused: false, clip: null }
    const region = regions.find(([, sel]) => a.closest(sel))?.[0] ?? null
    const term = a.closest('.xterm')
    const r = (term ?? a).getBoundingClientRect()
    const ring = 4 // the ring is --size-focus-ring wide, 1 px off the element (app/renderer/src/styles.css)
    const x = Math.max(0, Math.floor(r.left - ring))
    const y = Math.max(0, Math.floor(r.top - ring))
    const right = Math.min(window.innerWidth, Math.ceil(r.right + ring))
    const bottom = Math.min(window.innerHeight, Math.ceil(r.bottom + ring))
    const name = a.getAttribute('aria-label') ?? a.textContent?.trim().slice(0, 40) ?? ''
    return {
      lost: false,
      region,
      what: `${a.tagName.toLowerCase()}${a.getAttribute('role') ? `[role=${a.getAttribute('role')}]` : ''}${a.className && typeof a.className === 'string' ? `.${a.className.split(' ')[0]}` : ''} “${name}”`,
      terminal: term !== null,
      terminalFocused: term?.classList.contains('focus') ?? false,
      clip: right - x > 0 && bottom - y > 0 && r.width > 0 && r.height > 0 ? { x, y, width: right - x, height: bottom - y } : null,
    }
  }, REGIONS)
}

/** Two animation frames of the page: what a key pressed before them changed is drawn by then. */
const drawn = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

/**
 * Follows the keyboard from stop to stop and checks each one shows: the element is on screen, and what is drawn there
 * while it has the keyboard differs from what is drawn once the keyboard has moved on (a ring, a highlighted row, a
 * caret). A terminal's sign is xterm's own focused cursor.
 */
class FocusTrail {
  private readonly page: Page
  private last: { stop: FocusStop; shot: Buffer } | null = null
  readonly stops: FocusStop[] = [] // bounded: the stops of one test (a few dozen)
  readonly problems: string[] = [] // bounded: one test's findings (none, when it passes)

  constructor(page: Page) {
    this.page = page
  }

  /** The keyboard has just moved: note where it is, and that the stop before showed. */
  async note(after: string): Promise<FocusStop> {
    await drawn(this.page)
    const stop = await focusStop(this.page)
    await this.settle()
    this.stops.push(stop)
    if (stop.lost) this.problems.push(`after ${after}: nothing has the keyboard`)
    else if (stop.terminal) {
      if (!stop.terminalFocused) this.problems.push(`after ${after}: the terminal has the keyboard and does not show it`)
    } else if (!stop.clip) this.problems.push(`after ${after}: ${stop.what} has the keyboard and is not on screen`)
    else this.last = { stop, shot: await this.page.screenshot({ clip: stop.clip }) }
    return stop
  }

  /** Compare the stop before with how the same place looks now that the keyboard left it. */
  private async settle(): Promise<void> {
    const l = this.last
    this.last = null
    if (!l?.stop.clip) return
    const now = await this.page.screenshot({ clip: l.stop.clip })
    if (now.equals(l.shot)) this.problems.push(`${l.stop.what} (${l.stop.region ?? 'no region'}) looks the same with the keyboard as without it`)
  }

  /** The keyboard is about to go somewhere this trail does not follow: check the last stop still. */
  async end(): Promise<void> {
    await drawn(this.page)
    await this.settle()
  }

  /** The regions visited, in order, each once per visit. */
  regions(from = 0): (RegionName | null)[] {
    const out: (RegionName | null)[] = []
    for (const s of this.stops.slice(from)) if (out.at(-1) !== s.region) out.push(s.region)
    return out
  }
}

test('A-3 · the keyboard follows the regions’ order and focus always shows: F6 goes sidebar → file panel → header → work pane → agent pane and ⇧F6 back, Tab walks the same five regions in that order, every stop shows where the keyboard is, a row that goes while it holds the keyboard hands it on, and a sheet taller than the pane keeps its title and its buttons in view', async ({ run, launch }) => {
  test.setTimeout(120_000)
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  const root = tinyRepo({ name: 'atlas-web', parent: run.home }).root
  await addProject(kea, root, 'atlas-web')
  const a = (await startFakeSession(kea, 'a3-a', 'Fix auth redirect', QUIET, { background: true })).id
  const b = (await startFakeSession(kea, 'a3-b', 'Add billing page', QUIET, { background: true })).id
  // both idle, so nothing in a row moves by itself (the working arc would)
  const done: AgentEvent[] = [{ t: 'turn.started' }, { t: 'turn.finished', lastMessage: 'Done.', backgroundWork: false }]
  await kea.pretendFocused(true)
  for (const id of [b, a]) {
    await selectSession(kea, id)
    await status(kea, id, 'idle', ...done)
  }
  await kea.pretendFocused(false)
  await waitTree(kea, 'the worktree listed', (rows) => rows.length > 0)
  const agent = await fakeAgentTerminal(kea, a)
  await kea.clickTab(agent)
  await page.mouse.move(1000, 600)

  // ── a sheet taller than the pane: its title and its buttons stay, its body scrolls ──
  expect(await runCommand(kea, 'app.shortcuts')).toBe(true)
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(sheet.getByRole('button', { name: 'Done' })).toBeFocused({ timeout: STEP_MS })
  const box = await sheet.evaluate((el) => {
    const pane = el.parentElement!.getBoundingClientRect()
    const inPane = (e: Element | null): boolean => {
      const r = e?.getBoundingClientRect()
      return !!r && r.top >= pane.top - 0.5 && r.bottom <= pane.bottom + 0.5
    }
    const body = el.querySelector('.sheet-body')!
    return { title: inPane(el.querySelector('.sheet-title')), done: inPane(el.querySelector('.sheet-buttons button')), taller: body.scrollHeight > body.clientHeight || el.scrollHeight > el.clientHeight, firstRow: inPane(el.querySelector('[data-testid=keyboard-list]')?.firstElementChild ?? null) }
  })
  expect(box.taller, 'the list is longer than the pane (or this step checks nothing)').toBe(true)
  expect(box, 'opened at its top, with its title and Done both in view').toMatchObject({ title: true, done: true, firstRow: true })
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await until('the keyboard back in the terminal', () => focusIn(kea, '.terminal-host.shown'))

  // ── F6 and ⇧F6: the five regions, in order, both ways (the work pane holds only + here) ──
  const trail = new FocusTrail(page)
  await trail.note('the sheet closed')
  for (let i = 0; i < REGIONS.length; i++) {
    await page.keyboard.press('F6')
    await trail.note(`F6 × ${i + 1}`)
  }
  expect(trail.regions(1), 'F6 from the agent').toEqual(['sidebar', 'file panel', 'header', 'work pane', 'agent pane'])
  let from = trail.stops.length
  for (let i = 0; i < REGIONS.length; i++) {
    await page.keyboard.press('Shift+F6')
    await trail.note(`⇧F6 × ${i + 1}`)
  }
  expect(trail.regions(from), '⇧F6 from the agent').toEqual(['work pane', 'header', 'file panel', 'sidebar', 'agent pane'])

  // ── Tab: the same regions in the same order, every stop of them ──
  await page.keyboard.press('F6')
  from = trail.stops.length
  await trail.note('F6 to the sidebar')
  const TAB_STOPS_MAX = 60
  for (let i = 0; i < TAB_STOPS_MAX && !trail.stops.at(-1)!.terminal; i++) {
    await page.keyboard.press('Tab')
    await trail.note(`Tab × ${i + 1}`)
  }
  expect(trail.stops.at(-1)!.terminal, `Tab reaches the terminal within ${TAB_STOPS_MAX} stops: ${trail.stops.slice(from).map((s) => s.what).join(' → ')}`).toBe(true)
  expect(trail.regions(from), 'Tab from the sidebar').toEqual(['sidebar', 'file panel', 'header', 'work pane', 'agent pane'])
  // and back with ⇧Tab from the header's first control: the file panel, then the sidebar
  await page.keyboard.press('Shift+F6')
  await trail.note('⇧F6 to the work pane')
  await page.keyboard.press('Shift+F6')
  from = trail.stops.length
  await trail.note('⇧F6 to the header')
  for (let i = 0; i < TAB_STOPS_MAX && trail.stops.at(-1)!.region !== 'sidebar'; i++) {
    await page.keyboard.press('Shift+Tab')
    await trail.note(`⇧Tab × ${i + 1}`)
  }
  expect(trail.regions(from), '⇧Tab from the header').toEqual(['header', 'file panel', 'sidebar'])

  // ── a row that goes while it holds the keyboard: the keyboard is handed on, never dropped ──
  await sessionRow(page, b).focus()
  await trail.note('the keyboard on a session’s row')
  expect(await runCommand(kea, 'session.archive', { id: b })).toBe(true)
  await until('the row gone from the list', async () => (await page.locator(`[role=treeitem][data-session-id="${b}"]`).count()) === 0 || undefined)
  const handed = await trail.note('its row went')
  expect(handed.lost, `the keyboard after the row went: ${handed.what}`).toBe(false)
  expect(handed.region).toBe('sidebar')
  // (the trail's last stop is checked once the keyboard has left it)
  await page.keyboard.press('F6')
  await until('the keyboard in the file panel', () => focusIn(kea, 'section.file-panel'))
  await trail.end()

  expect(trail.problems, trail.stops.map((s) => `${s.region}: ${s.what}`).join('\n')).toEqual([])
  await kea.assertUnfocused()
})
