// V-1 and V-2: the full window and the sidebar's states: three projects, eight sessions covering every status glyph,
// the file tree with every git decoration, and a terminal showing a frame of a scrubbed cassette (fixtures/cassettes).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { repoRoot } from '../../perf/src/launch.ts'
import { fixtureGitEnv } from '../../repo-factory/src/index.ts'
import { test } from '../../../tests/e2e/fixtures.ts'
import { GIT_MS, waitChanges, waitTree } from '../../../tests/support/app-files.ts'
import { fakeAgentTerminal } from '../../../tests/support/app-fake-agent.ts'
import { projectRow, selectSession, sessionRow, waitRow } from '../../../tests/support/app-sessions.ts'
import { cwdOf, demoProject, projectId, failed, finished, limited, openKea, permission, question, QUIET, runCommand, session, status, working, write } from './scene.ts'
import { STEP_MS, type Kea } from '../../../tests/support/app.ts'
import { GallerySet } from './shots.ts'

type Page = Awaited<ReturnType<Kea['page']>>

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()

/**
 * A frame of a recorded Claude Code turn (fixtures/cassettes, scrubbed): the last screen of the fix-typo cassette down
 * to its prompt box, with the rules drawn to this terminal's width (the recording was 120 columns wide).
 */
function recordedFrame(cols: number): string {
  const screen = JSON.parse(fs.readFileSync(path.join(repoRoot, 'fixtures/cassettes/claude-classic-fix-typo.screen.json'), 'utf8')) as { ansi: string }
  const lines = screen.ansi.split('\r\n')
  const end = lines.findLastIndex((l, i) => i < 16 && l.includes('─'.repeat(40)))
  const fit = (l: string) => l.replace(/─{40,}/, (m) => '─'.repeat(Math.min(m.length, cols))).replace(/ {40,}/, (m) => ' '.repeat(Math.max(1, m.length - Math.max(0, 120 - cols))))
  const text = lines.slice(0, end + 1).map(fit).join('\r\n').replace('/exit', '')
  return `steps:
  - print: ${JSON.stringify(`${text}\u001b[0m\r\n`)}
  - wait: { answer: "~" }
`
}

/** Three projects and eight sessions covering every status glyph; `auth` is on screen, drawing the recorded frame. */
async function fleet(kea: Kea): Promise<Record<'readme' | 'api' | 'billing' | 'auth' | 'links' | 'seo' | 'hooks' | 'rounding', string> & { projects: Record<'atlas' | 'docs' | 'billingApi', string> }> {
  const atlas = await projectId(kea, await demoProject(kea, 'atlas-web'))
  const readme = await session(kea, 'v1-readme', 'update the readme', QUIET, { open: false })
  const api = await session(kea, 'v1-api', 'refactor the api client', QUIET, { open: false })
  const billing = await session(kea, 'v1-billing', 'add the billing page', QUIET, { open: false })
  const docs = await projectId(kea, await demoProject(kea, 'docs-site'))
  const links = await session(kea, 'v1-links', 'find broken links', QUIET, { open: false })
  const seo = await session(kea, 'v1-seo', 'seo pass', QUIET, { open: false })
  const billingApi = await projectId(kea, await demoProject(kea, 'billing-api'))
  const hooks = await session(kea, 'v1-hooks', 'retry failed webhooks', QUIET, { open: false })
  const rounding = await session(kea, 'v1-rounding', 'invoice rounding', QUIET, { open: false })
  // the session on screen, started last in the first project: its agent draws the recorded frame at this terminal's width
  await fakeAgentTerminal(kea, readme)
  const cols = (await kea.views()).find((v) => v.shown)?.cols ?? 100
  await runCommand(kea, 'session.new', { projectId: atlas })
  const auth = await session(kea, 'v1-auth', 'fix the auth redirect', recordedFrame(cols), { open: false })

  await status(kea, billing, 'needsYou', ...permission('npm test'))
  await status(kea, api, 'unread', ...finished('Done.'))
  await status(kea, links, 'failed', ...failed('API error'))
  await status(kea, hooks, 'needsYou', ...question('Which provider?'))
  await runCommand(kea, 'session.stop', { id: seo })
  await waitRow(kea, seo, 'detached', (r) => r.lifecycle === 'detached')
  // read and idle: its turn finishes while it is on screen and the window counts as focused
  await selectSession(kea, readme)
  await kea.pretendFocused(true)
  await status(kea, readme, 'idle', ...finished('Done.'))
  await kea.pretendFocused(false)
  // the account condition last: any turn finishing after it would end it
  await status(kea, rounding, 'limited', ...limited(Date.now() + 3 * 3600_000))
  await selectSession(kea, auth)
  await status(kea, auth, 'working', ...working)
  await kea.waitScreen('the recorded frame', (s) => s.includes('Update(src/hello.js)'))
  return { readme, api, billing, auth, links, seo, hooks, rounding, projects: { atlas, docs, billingApi } }
}

/**
 * Every git decoration the tree can show in `wt`: M, A, U, R, !, a folder's dot, an ignored folder; D shows in Changes.
 */
function decorate(wt: string): void {
  write(wt, { 'src/auth/login.js': 'export const login = () => "ok"\n', 'src/auth/session.js': 'export const session = () => null\n', 'src/components/Button.js': 'export const Button = () => null\n' })
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'auth')
  // a conflict: the same line changed on two branches
  git(wt, 'checkout', '-q', '-b', 'other')
  write(wt, { 'src/hello.js': 'export function greet(name) {\n  return `Hi, ${name}!`\n}\n' })
  git(wt, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-am', 'hi')
  git(wt, 'checkout', '-q', '-')
  write(wt, { 'src/hello.js': 'export function greet(name) {\n  return `Hello, ${name}!`\n}\n' })
  git(wt, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-am', 'hello')
  try {
    git(wt, 'merge', '--no-gpg-sign', 'other')
  } catch {
    // the conflict is the point
  }
  write(wt, {
    'README.md': '# demo\n\nSign-in redirects back to where you were.\n',
    'src/index.js': "import { greet } from './hello.js'\n\nconsole.log(greet('world'))\n",
    'src/auth/login.js': 'export const login = () => "redirect"\n',
    'src/auth/callback.js': 'export const callback = () => null\n',
    'src/auth/token.js': 'export const token = () => null\n',
    'node_modules/left-pad/index.js': 'module.exports = () => ""\n',
  })
  git(wt, 'add', 'src/auth/token.js')
  git(wt, 'mv', 'src/math.js', 'src/arith.js')
  fs.rmSync(path.join(wt, 'src/counter.js'))
}

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
/** The part of the sidebar the rows are in. */
const ROWS = { x: 0, y: 0, width: 240, height: 440 }

test('V-1 · full window', async ({ run, launch }) => {
  const set = new GallerySet('V-1', 'Full window')
  const kea = await openKea(run, launch)
  const page = await kea.page()
  const s = await fleet(kea)
  decorate(await cwdOf(kea, s.auth))
  await runCommand(kea, 'files.toggleIgnored')
  const tree = page.getByRole('tree', { name: 'Files' })
  await tree.locator('[data-path="src"]').click()
  await tree.locator('[data-path="src/auth"]').click()
  await waitTree(kea, 'the decorated tree', (rows) => rows.some((r) => r.path === 'README.md' && r.git === 'M') && rows.some((r) => r.git === '!'), GIT_MS)
  await page.locator('.terminal-host.shown').click({ position: { x: 400, y: 500 } })
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'window', 'Three projects, eight sessions with every status glyph (working, needs you ×2, unread, idle, detached, failed, limited) and the footer’s condition line; the tree with M, A, U, R, !, the folders’ dots and an ignored folder; a recorded agent frame in the terminal', 'Window layout, Sidebar, File tree, Header, Terminal')
  await runCommand(kea, 'files.showChanges')
  await waitChanges(kea, 'the changes listed', (rows) => rows.some((r) => r.letter === 'D'))
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'changes', 'The same window on Changes: scope switch, totals, the branch line with MERGING, and every letter (a deleted file struck through, a rename as old → new)', 'File tree')
})

test('V-2 · sidebar states', async ({ run, launch }) => {
  const set = new GallerySet('V-2', 'Sidebar states')
  const kea = await openKea(run, launch)
  const page = await kea.page()
  const s = await fleet(kea)
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'rows', 'Selected (working), needs you with its label, unread, idle, detached, failed, limited; the footer line of the account condition', 'Sidebar', { rect: { ...ROWS, height: 900 } })

  await sessionRow(page, s.api).hover()
  await set.shot(kea, 'hover-session', 'Hover on a session row: --surface-2, the archive button in the meta’s place', 'Sidebar', { rect: ROWS })
  await projectRow(page, 'docs-site').hover()
  await set.shot(kea, 'hover-project', 'Hover on a project row: the + (new session in this project)', 'Sidebar', { rect: ROWS })
  await page.mouse.move(1000, 700)

  // the keyboard in the tree: the focus ring on a row
  await page.keyboard.press('F6')
  await page.keyboard.press('ArrowDown')
  await set.shot(kea, 'focus', 'The keyboard on a row (F6, ↓): the focus ring, and the row’s action shown', 'Sidebar, Space and shape', { rect: ROWS })

  // collapsed, with the count of sessions needing you
  await projectRow(page, 'atlas-web').click()
  await projectRow(page, 'billing-api').click()
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'collapsed', 'Collapsed projects: the caret and the count of sessions needing you', 'Sidebar', { rect: ROWS })
  await projectRow(page, 'atlas-web').click()
  await projectRow(page, 'billing-api').click()

  // the archived group, closed and open
  await runCommand(kea, 'session.archive', { id: s.readme })
  await waitRow(kea, s.readme, 'archived', (r) => r.lifecycle === 'archived').catch(() => undefined)
  const archived = page.getByRole('treeitem', { name: /^Archived \(1\)$/ })
  await archived.waitFor({ timeout: STEP_MS })
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'archived-closed', 'The Archived section (the only uppercase label), collapsed', 'Sidebar', { rect: ROWS })
  await archived.click()
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'archived-open', 'The Archived section open', 'Sidebar', { rect: ROWS })

  // typing filters
  await projectRow(page, 'docs-site').focus()
  await page.keyboard.type('bil')
  await set.shot(kea, 'filter', 'Typing in the sidebar filters by title or branch', 'Sidebar', { rect: ROWS })
  await page.keyboard.press('Escape')

  // the row menus
  await sessionRow(page, s.billing).click({ button: 'right' })
  await page.getByRole('menu', { name: 'Session menu' }).waitFor({ timeout: STEP_MS })
  await set.shot(kea, 'session-menu', 'The session context menu: --surface-4, 10 px radius, 28 px rows, the first enabled item highlighted, shortcuts in kbd chips', 'Floating layers', { rect: { x: 0, y: 0, width: 520, height: 620 } })
  await page.keyboard.press('Escape')
  await projectRow(page, 'docs-site').click({ button: 'right' })
  await page.getByRole('menu', { name: 'Project menu' }).waitFor({ timeout: STEP_MS })
  await set.shot(kea, 'project-menu', 'The project context menu; Restore Deleted Session… disabled with nothing to restore', 'Floating layers', { rect: { x: 0, y: 0, width: 520, height: 620 } })
  await page.keyboard.press('Escape')
  await sidebar(page).waitFor()
})
