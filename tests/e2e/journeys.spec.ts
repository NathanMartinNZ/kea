// The file panel, the viewer, the dev server and the editor used in one sitting, with real clicks and keys only. Each
// has its own spec file (files, viewer, server and editor.spec.ts); these are the paths that cross from one into
// another, and what a session keeps of each while another is on screen. Probes only read state or set up what no click
// can (files on disk, the fake agent's script and gates). Nothing reaches the person's editor, browser, Trash or
// clipboard: the editor is a fake one under the run's HOME, links are recorded by main, and the dev server is a
// stand-in on loopback (tests/support/app-server.ts).

import fs from 'node:fs'
import path from 'node:path'
import { L } from '@kea/protocol'
import { STEP_MS, until, type Kea } from '../support/app.ts'
import { AGENT_MARK, agentEvents, claudeByDefault, fakeAgentTerminal, gate, startFakeSession } from '../support/app-fake-agent.ts'
import { changeRows, clickChange, clickFile, clickScope, diffStatText, GIT_MS, panelModes, panelRegion, scopeShown, showMode, tree, treeRowInView, treeRows, waitChanges, waitTree, wheel } from '../support/app-files.ts'
import { addProject, agentTerminal, demoRepo, paneSession, selectSession, sessionIds, startSession, waitLive } from '../support/app-sessions.ts'
import { commitFiles, EditorWorld, editorButton, listening, opened, pidAlive, serverAddress, serverAnswer, serverChip, serverControl, serverTreeScript, treePids, waitServer, worktreesOf } from '../support/app-server.ts'
import { clickFileTab, fileTabs, viewerShown } from '../support/app-tabs.ts'
import { changeMarker, commitAll, gutterLines, loginSource, tokenClasses, viewer, viewerText, waitBody, waitViewer, writeFiles } from '../support/app-viewer.ts'
import { expect, test } from './fixtures.ts'
import { sysKey } from '../support/keys.ts'

const focusIn = (kea: Kea, selector: string): Promise<boolean> => kea.page().then((page) => page.evaluate((s) => !!document.activeElement?.closest(s), selector))
/** The file and diff tabs as one line each: `path kind`, ` preview` until pinned, ` *` for the one on screen. */
const tabShape = async (kea: Kea): Promise<string[]> => (await fileTabs(kea)).map((t) => `${t.path} ${t.kind}${t.pinned ? '' : ' preview'}${t.selected ? ' *' : ''}`)
/** The tree's rows as drawn: `path`, `+` for an open folder, `[letter]` for a change, ` *` for the row the keyboard is on. */
const treeShape = async (kea: Kea): Promise<string[]> => (await treeRows(kea)).map((r) => `${r.path}${r.expanded ? ' +' : ''}${r.git ? ` [${r.git}]` : ''}${r.selected ? ' *' : ''}`)
const treeTop = (kea: Kea): Promise<number> => kea.page().then((page) => tree(page).evaluate((el) => el.scrollTop))

/** `⌃G`, `line`, `↵`. */
async function goToLine(kea: Kea, line: number): Promise<void> {
  const page = await kea.page()
  await page.keyboard.press(sysKey('Control+g'))
  await page.locator('.viewer .kea-goto .kea-bar-input').waitFor()
  await page.keyboard.type(String(line))
  await page.keyboard.press('Enter')
  await page.locator('.viewer .kea-goto').waitFor({ state: 'detached' })
}

test('E-SES-13 · two sessions, each with its own file panel and file tabs: the folders open in the tree, its scroll position and the row the keyboard is on, Files or Changes, the Changes list’s row, the file tabs with the one on screen and where it was scrolled to all come back when the session does, by ⌘1 / ⌘2 and by a click in the sidebar, and nothing of the session that left is shown meanwhile', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  await kea.oneColumn()
  const page = await kea.page()
  await kea.pretendFocused(true)
  const repo = demoRepo(run)
  // a folder long enough that the tree scrolls, and a file long enough that the viewer does
  const files: Record<string, string> = { 'src/long.ts': loginSource(40) }
  for (let i = 1; i <= 60; i++) files[`many/f${String(i).padStart(2, '0')}.txt`] = `file ${i}\n`
  writeFiles(repo.root, files)
  commitAll(repo.root, 'Add files')
  await addProject(kea, repo.root)

  // ── session A: two folders open, the tree scrolled, a pinned file tab scrolled to line 150, Changes with a row chosen ──
  const a = await startSession(kea, 'first')
  await waitLive(kea, a)
  await agentTerminal(kea, a)
  const dirA = worktreesOf(repo.root).find((w) => w.branch.includes('first'))!.dir
  await waitTree(kea, 'the root is listed', (rows) => rows.some((r) => r.path === 'README.md'))
  await (await treeRowInView(kea, 'many')).click()
  await waitTree(kea, 'many is open', (rows) => rows.some((r) => r.path === 'many/f01.txt'))
  await clickFile(kea, 'src/long.ts') // opens src on the way, far down the list: the tree is scrolled to it
  await waitBody(kea, 'src/long.ts', 'text')
  await until('the document has the keyboard', async () => (await viewerShown(kea))?.focused || undefined)
  await page.keyboard.press('Enter') // pinned
  await until('long.ts pinned', async () => (await tabShape(kea)).includes('src/long.ts file *') || undefined)
  await goToLine(kea, 150)
  const placeA = (await waitViewer(kea, 'the cursor on line 150, the view scrolled to it', (v) => v.text?.selection.from.line === 150 && (v.text.scroll.line ?? 0) > 100)).text!
  // the tree a little further up, by the wheel: not at either end, the row of long.ts still drawn
  await wheel(page, tree(page), -60)
  const topA = await treeTop(kea)
  expect(topA, 'the tree is scrolled').toBeGreaterThan(200)
  // what the session changed (its tree lists the new file), then Changes, and its row clicked: a diff in the preview tab
  writeFiles(dirA, { 'src/math.js': 'export const add = (a, b) => a + b\n', 'a-only.txt': 'only in the first session\n', 'many/f10.txt': 'changed\n' })
  await until('the header counts three changes', async () => (await panelModes(kea)).some((m) => m.label === 'Changes 3') || undefined, GIT_MS)
  await waitTree(kea, 'the changes are decorated', (rows) => rows.find((r) => r.path === 'a-only.txt')?.git === 'U' && rows.find((r) => r.path === 'src/math.js')?.git === 'M', GIT_MS)
  expect(await treeTop(kea), 'the tree stayed where it was').toBe(topA)
  const treeA = await treeShape(kea)
  expect(treeA).toEqual(expect.arrayContaining(['src + [dot]', 'src/long.ts *', 'src/math.js [M]', 'a-only.txt [U]']))
  await clickChange(kea, 'src/math.js')
  await waitBody(kea, 'src/math.js', 'diff')
  // the pinned tab on screen again, where it was left
  await clickFileTab(kea, 'src/long.ts')
  await waitViewer(kea, 'long.ts where it was left', (v) => v.ui.path === 'src/long.ts' && v.text?.scroll.line === placeA.scroll.line && v.text.scroll.offset === placeA.scroll.offset)
  const tabsA = ['src/long.ts file *', 'src/math.js diff preview']
  const changesA = ['U a-only.txt', 'M many/f10.txt', 'M src/math.js *']
  const statA = await diffStatText(kea)
  expect(statA).toMatch(/^\+\d+ −\d+$/)

  /** Session A is on screen exactly as it was left; `mode`: what its panel was last looked at in. */
  const expectA = async (mode: 'Files' | 'Changes', how: string) => {
    await until(`${how}: session A in the main pane`, async () => (await paneSession(page)) === a || undefined)
    await until(`${how}: its panel in ${mode}, counting its three changes`, async () => {
      const m = await panelModes(kea)
      return (m.some((x) => x.on && x.label.startsWith(mode)) && m.some((x) => x.label === 'Changes 3')) || undefined
    })
    expect(await tabShape(kea), `${how}: its file tabs, the same one on screen`).toEqual(tabsA)
    const v = await waitViewer(kea, `${how}: long.ts read again, where it was left`, (x) => x.ui.path === 'src/long.ts' && x.ui.body.kind === 'text' && x.text?.scroll.line === placeA.scroll.line && x.text.scroll.offset === placeA.scroll.offset)
    expect(v.text!.selection, `${how}: the cursor where it was`).toEqual(placeA.selection)
    expect(await diffStatText(kea), `${how}: the header’s diff stat`).toBe(statA)
    if (mode === 'Changes') {
      await waitChanges(kea, `${how}: its three changes`, (r) => r.length === 3)
      expect((await changeRows(kea)).map((r) => `${r.letter} ${r.path}${r.selected ? ' *' : ''}`), `${how}: the Changes list and its row`).toEqual(changesA)
    } else {
      await waitTree(kea, `${how}: its tree`, (rows) => rows.some((r) => r.path === 'src/long.ts'))
      await until(`${how}: the tree scrolled where it was`, async () => (await treeTop(kea)) === topA || undefined)
      await waitTree(kea, `${how}: its changes decorated again`, (rows) => rows.find((r) => r.path === 'a-only.txt')?.git === 'U', GIT_MS)
      expect(await treeShape(kea), `${how}: the folders open, the changes’ letters and the row the keyboard was on`).toEqual(treeA)
    }
  }

  // ── session B: started while A's panel showed Changes; its own panel: Files, one folder open, one preview tab, the Agent tab on screen ──
  const b = await startSession(kea, 'second')
  await waitLive(kea, b)
  const agentB = await agentTerminal(kea, b)
  // a session never looked at takes the window's current mode; it has no changes, no tabs, no diff stat
  await until('the new session’s panel, in Changes with none', async () => {
    const m = await panelModes(kea)
    return (m.some((x) => x.on && x.label === 'Changes') && !m.some((x) => /\d/.test(x.label))) || undefined
  })
  expect(await changeRows(kea), 'none of the first session’s changes').toEqual([])
  expect(await tabShape(kea), 'none of the first session’s tabs').toEqual([])
  expect(await viewerShown(kea)).toBeNull()
  expect(await diffStatText(kea)).toBeNull()
  await showMode(kea, 'Files')
  const fresh = await waitTree(kea, 'its own tree, from the top, nothing open', (rows) => rows.some((r) => r.path === 'README.md'))
  expect(fresh.filter((r) => r.expanded || r.selected || r.git !== null || r.path === 'a-only.txt'), 'no folder open, no row chosen, no change, no file of the first session').toEqual([])
  expect(await treeTop(kea)).toBe(0)
  await clickFile(kea, 'test/math.test.js')
  await waitBody(kea, 'test/math.test.js', 'text')
  await kea.clickTab(agentB)
  const treeB = await treeShape(kea)
  expect(treeB).toEqual(['many', 'src', 'test +', 'test/counter.test.js', 'test/math.test.js *', '.gitignore', '.kea-fixture-repo', 'package.json', 'README.md'])
  const tabsB = ['test/math.test.js file preview']

  const expectB = async (how: string) => {
    await until(`${how}: session B in the main pane`, async () => (await paneSession(page)) === b || undefined)
    await until(`${how}: its panel in Files, counting no change`, async () => {
      const m = await panelModes(kea)
      return (m.some((x) => x.on && x.label === 'Files') && m.some((x) => x.label === 'Changes')) || undefined
    })
    await waitTree(kea, `${how}: its tree`, (rows) => rows.some((r) => r.path === 'test/math.test.js'))
    expect(await treeShape(kea), `${how}: its folders and its row, none of the other session’s`).toEqual(treeB)
    expect(await treeTop(kea), `${how}: at the top`).toBe(0)
    expect(await tabShape(kea), `${how}: its one file tab, not on screen`).toEqual(tabsB)
    await until(`${how}: its Agent terminal on screen`, async () => (await kea.shown()) === agentB || undefined)
    expect(await viewerShown(kea), `${how}: no viewer`).toBeNull()
    expect(await diffStatText(kea), `${how}: no diff stat`).toBeNull()
  }
  await expectB('as set up')

  // ── away and back, by the keyboard (⌘1 … ⌘9 are the sidebar's rows, top to bottom) and by a click ──
  const order = await sessionIds(page)
  const keyOf = (id: string) => sysKey(`Meta+${order.indexOf(id) + 1}`)
  await page.keyboard.press(keyOf(a))
  await expectA('Changes', '⌘n')
  // Files in A (its tree was kept while Changes showed): from now on that is what A was last looked at in
  await showMode(kea, 'Files')
  await expectA('Files', 'Files shown')
  await page.keyboard.press(keyOf(b))
  await expectB('⌘n')
  await selectSession(kea, a)
  await expectA('Files', 'a click')
  await selectSession(kea, b)
  await expectB('a click')
  // the keyboard came along each time: B's Agent terminal has it
  await until('the keyboard in the terminal on screen', () => focusIn(kea, '.terminal-host.shown'))
  expect((await viewer(kea)) === null, 'no viewer is mounted for a session showing its terminal').toBe(true)
  // once more each way: nothing creeps (no file tab comes back further down than it was left)
  await page.keyboard.press(keyOf(a))
  await expectA('Files', '⌘n again')
  await selectSession(kea, b)
  await expectB('a click again')
  await selectSession(kea, a)
  await expectA('Files', 'a click again')
})

// ── an agent's turn, followed by the file panel ─────────────────────────────────────────────────────

/** Files a `pnpm install` stand-in writes into each of its two folders under `node_modules/`. */
const INSTALLED = 1000
const GUIDE = '# Guide\n\nHow the demo is laid out.\n\n- `src/` holds the code\n- `test/` holds the tests\n- `package.json` names the scripts\n'

/**
 * The agent's turn in three parts, each behind a gate the test opens: the edits (one changed, one new, one deleted, one
 * renamed), the install (a burst under the ignored `node_modules/`, then the lockfile, as one Bash tool), and one more
 * edit. The fake agent has no step that runs a program, so the commit between the first two is the test's `git commit`
 * in the worktree, as the agent's Bash tool would run it.
 */
const agentWork = (g: { edit: string; install: string; again: string }): string => `steps:
  - frame: ["${AGENT_MARK}", "", "> {{prompt}}"]
  - ${g.edit}
  - hook: UserPromptSubmit
  - hook: { event: PreToolUse, tool: Edit, input: { file_path: "src/math.js" } }
  - file: { op: modify, path: src/math.js, find: "return a + b", replace: "return a + b // sum" }
  - file: { op: write, path: src/feature/flag.js, content: "export const flag = true\\n" }
  - file: { op: delete, path: src/counter.js }
  - file: { op: rename, path: docs/guide.md, to: docs/handbook.md }
  - hook: { event: PostToolUse, tool: Edit }
  - ${g.install}
  - hook: { event: PreToolUse, tool: Bash, input: { command: "pnpm install" } }
  - loop:
      times: ${INSTALLED}
      steps:
        - file: { op: write, path: "node_modules/.pnpm/pkg-{{i}}/index.js", content: "module.exports = {{i}}\\n" }
  - loop:
      times: ${INSTALLED}
      steps:
        - file: { op: write, path: "node_modules/left-pad/lib/f{{i}}.js", content: "module.exports = {{i}}\\n" }
  - file: { op: write, path: pnpm-lock.yaml, content: "lockfileVersion: 9\\n" }
  - hook: { event: PostToolUse, tool: Bash }
  - ${g.again}
  - hook: { event: PreToolUse, tool: Edit, input: { file_path: "src/math.js" } }
  - file: { op: append, path: src/math.js, content: "\\nexport const mul = (a, b) => a * b\\n" }
  - hook: { event: PostToolUse, tool: Edit }
  - hook: Stop
`

type KitReport = Record<string, number | Record<string, number>>
/** Core's own count of what it holds for the file panels (the resource report's `core.files`). */
type CoreFiles = { dirs: number; entries: number; gitEntries: number; statusRunning: number; statusPending: number }
const coreFiles = async (kea: Kea): Promise<CoreFiles> => ((await kea.debug<KitReport>('core', 'kit')) ?? {})['core.files'] as unknown as CoreFiles

// What the install part checks, and what it does not: no row for the ignored folder or anything in it, no folder of it
// listed by core, and exactly two entries more in core (the lockfile's and the ignored folder's own). It says nothing
// of how many status pipelines a burst starts (no status storm, the scheduler's debounce): the watcher excludes the
// ignored folder in the kernel, so no event of the burst reaches the scheduler here, and a count of `git status` runs
// this short could not tell a storm from none. The perf test P-GS-3 measures that, on 60 000 files.
test('E-FT-8 · the file tree’s journey, by clicks and keys only: a fake agent changes, adds, deletes and renames files, and the tree’s letters, the folders’ dots, the Changes list, the header’s diff stat and the diff opened from the list all follow; its work is committed and Branch still lists it while Uncommitted is empty; a `pnpm install` then writes two thousand files under the ignored node_modules: the tree gains the lockfile’s row and no other, core lists no folder more and holds exactly two entries more, and the next edit still reaches the open diff', async ({ run, launch }) => {
  test.setTimeout(180_000)
  claudeByDefault(run)
  const repo = demoRepo(run)
  commitFiles(repo.root, { 'docs/guide.md': GUIDE })
  const kea = await launch()
  const page = await kea.page()
  await kea.pretendFocused(true)
  await addProject(kea, repo.root)
  const gates = { edit: gate(run, 'e-ft-8-edit'), install: gate(run, 'e-ft-8-install'), again: gate(run, 'e-ft-8-again') }
  const agent = await startFakeSession(kea, 'e-ft-8', 'tidy the project', agentWork({ edit: gates.edit.step, install: gates.install.step, again: gates.again.step }))
  await fakeAgentTerminal(kea, agent.id)
  const dir = worktreesOf(repo.root)[0]!.dir
  const labels = async () => (await panelModes(kea)).map((m) => m.label)
  const listed = async () => (await changeRows(kea)).map((r) => `${r.letter} ${r.path}`)
  const counted = (n: number) => until(`the header counts ${n} changes`, async () => (await labels()).includes(`Changes ${n}`) || undefined, GIT_MS)

  // ── before the agent does anything: the tree, src opened by a click, nothing changed ──
  await waitTree(kea, 'the root is listed', (rows) => rows.some((r) => r.path === 'README.md'))
  await (await treeRowInView(kea, 'src')).click()
  await waitTree(kea, 'src is open', (rows) => rows.some((r) => r.path === 'src/counter.js'))
  expect(await treeShape(kea)).toEqual(['docs', 'src + *', 'src/counter.js', 'src/hello.js', 'src/index.js', 'src/math.js', 'test', '.gitignore', '.kea-fixture-repo', 'package.json', 'README.md'])
  expect(await labels()).toEqual(['Files', 'Changes'])
  expect(await diffStatText(kea), 'no diff stat while nothing is changed').toBeNull()

  // ── the agent edits, adds, deletes and renames: the tree follows, with nothing clicked ────────────
  await gates.edit.open()
  await counted(5)
  // the changed file's letter, the deleted file gone, the new folder there, a dot on every folder holding a change
  await waitTree(kea, 'the tree follows the edits', (rows) => rows.find((r) => r.path === 'src/math.js')?.git === 'M' && !rows.some((r) => r.path === 'src/counter.js') && rows.find((r) => r.path === 'src/feature')?.git === 'dot' && rows.find((r) => r.path === 'docs')?.git === 'dot', GIT_MS)
  expect(await treeShape(kea)).toEqual(['docs [dot]', 'src + [dot] *', 'src/feature [dot]', 'src/hello.js', 'src/index.js', 'src/math.js [M]', 'test', '.gitignore', '.kea-fixture-repo', 'package.json', 'README.md'])
  // inside the folders: the new file and the renamed one, each untracked so far
  await (await treeRowInView(kea, 'src/feature')).click()
  await (await treeRowInView(kea, 'docs')).click()
  await waitTree(kea, 'the new and the renamed file', (rows) => rows.find((r) => r.path === 'src/feature/flag.js')?.git === 'U' && rows.find((r) => r.path === 'docs/handbook.md')?.git === 'U' && !rows.some((r) => r.path === 'docs/guide.md'), GIT_MS)
  // the header's diff stat: every line of the five, the untracked files' included
  await until('the header’s diff stat', async () => (await diffStatText(kea)) === '+9 −14' || undefined, GIT_MS)
  // Changes: the list, by path; a rename git has not been told of is a deletion and a new file
  await showMode(kea, 'Changes')
  const edited = await waitChanges(kea, 'the five changes', (r) => r.length === 5)
  expect(edited.map((r) => `${r.letter} ${r.path} ${r.stat}${r.struck ? ' struck' : ''}`)).toEqual(['D docs/guide.md +0 −7 struck', 'U docs/handbook.md +7', 'D src/counter.js +0 −6 struck', 'U src/feature/flag.js +1', 'M src/math.js +1 −1'])
  // a click on a change: its diff, in the preview tab
  await clickChange(kea, 'src/math.js')
  const diff = await waitBody(kea, 'src/math.js', 'diff')
  expect([diff.ui.entry?.code, diff.ui.counts, diff.ui.changes]).toEqual(['M', { added: 1, removed: 1 }, 1])
  await expect(page.locator('.viewer .viewer-stat')).toHaveText('+1 −1')
  expect(await tabShape(kea)).toEqual(['src/math.js diff preview *'])

  // ── the work is committed: Branch still lists it, the rename now one row; Uncommitted is empty ────────────
  commitAll(dir, 'Tidy the project')
  await waitViewer(kea, 'the commit seen', (v) => v.git.head?.ahead === 1, GIT_MS)
  expect(await scopeShown(kea)).toBe('Branch')
  await counted(4)
  const branch = await waitChanges(kea, 'Branch: the four changes', (r) => r.length === 4)
  expect(branch.map((r) => `${r.letter} ${r.name} | ${r.dir}`)).toEqual(['R guide.md → handbook.md | docs', 'D counter.js | src', 'A flag.js | src/feature', 'M math.js | src'])
  await until('the diff stat without the renamed file’s lines', async () => (await diffStatText(kea)) === '+2 −7' || undefined, GIT_MS)
  expect((await viewer(kea))?.ui.counts, 'the open diff is the same against the branch’s base').toEqual({ added: 1, removed: 1 })
  await clickScope(kea, 'Uncommitted')
  await waitViewer(kea, 'Uncommitted: nothing listed, no change in the open diff', (v) => v.git.head?.scope === 'uncommitted' && v.git.changed === 0 && v.ui.changes === 0, GIT_MS)
  await waitChanges(kea, 'Uncommitted: no rows', (r) => r.length === 0)
  await expect(panelRegion(page).getByText('No changes yet.')).toBeVisible()
  expect([await labels(), await diffStatText(kea)], 'the header counts none and shows no diff stat').toEqual([['Files', 'Changes'], null])
  await clickScope(kea, 'Branch')
  await waitViewer(kea, 'Branch again: the diff against the base', (v) => v.git.head?.scope === 'branch' && v.git.changed === 4 && v.ui.changes === 1, GIT_MS)
  // the tree in Branch scope: what the branch changed keeps its letter after the commit
  await showMode(kea, 'Files')
  await waitTree(kea, 'the tree after the commit', (rows) => rows.find((r) => r.path === 'src/feature/flag.js')?.git === 'A' && rows.find((r) => r.path === 'docs/handbook.md')?.git === 'R', GIT_MS)
  const committed = ['docs + [dot] *', 'docs/handbook.md [R]', 'src + [dot]', 'src/feature + [dot]', 'src/feature/flag.js [A]', 'src/hello.js', 'src/index.js', 'src/math.js [M]', 'test', '.gitignore', '.kea-fixture-repo', 'package.json', 'README.md']
  expect(await treeShape(kea)).toEqual(committed)

  // ── `pnpm install`: two thousand files under the ignored node_modules, then the lockfile ──
  const atRest = (what: string) => until(`${what}: no status running or waiting`, async () => (((f) => f.statusRunning === 0 && f.statusPending === 0)(await coreFiles(kea)) ? true : undefined), GIT_MS)
  const writes = () => agentEvents(agent.log).filter((e) => e.t === 'file').length
  await atRest('before the install')
  const before = { core: await coreFiles(kea), writes: writes() }
  await gates.install.open()
  // the lockfile is the install's last write: once it is listed, all of the burst is on disk
  await waitTree(kea, 'the lockfile is listed', (rows) => rows.find((r) => r.path === 'pnpm-lock.yaml')?.git === 'U', GIT_MS)
  await counted(5)
  await atRest('after the install')
  expect(writes() - before.writes, 'every file of the install was written').toBe(2 * INSTALLED + 1)
  expect(fs.readdirSync(path.join(dir, 'node_modules', '.pnpm')).length + fs.readdirSync(path.join(dir, 'node_modules', 'left-pad', 'lib')).length).toBe(2 * INSTALLED)
  // no row: the tree is what it was, plus the lockfile
  expect(await treeShape(kea), 'no row for node_modules or anything in it').toEqual([...committed.slice(0, -1), 'pnpm-lock.yaml [U]', 'README.md'])
  // no cached entry: core listed no folder and holds two entries more, the lockfile and the ignored folder's own
  const core = await coreFiles(kea)
  expect([core.dirs, core.entries - before.core.entries, core.gitEntries - before.core.gitEntries], 'folders listed; entries and changes more than before').toEqual([before.core.dirs, 2, 1])
  // Changes: the four and the lockfile, nothing of node_modules; the diff stat has the lockfile's one line more
  await showMode(kea, 'Changes')
  await waitChanges(kea, 'the lockfile in Changes', (r) => r.length === 5)
  expect(await listed()).toEqual(['R docs/handbook.md', 'U pnpm-lock.yaml', 'D src/counter.js', 'A src/feature/flag.js', 'M src/math.js'])
  expect(await diffStatText(kea)).toBe('+3 −7')

  // ── one more edit: the diff that stayed open all along follows, and so do its row and the header ──
  expect(await viewerShown(kea), 'the diff opened before the commit is still on screen').toMatchObject({ path: 'src/math.js', mode: 'diff' })
  await gates.again.open()
  // the diff itself (two changed places now) and the line counts beside its name (git's, a moment later)
  const more = await waitViewer(kea, 'the open diff follows the edit', (v) => v.ui.path === 'src/math.js' && v.ui.changes === 2 && v.ui.counts?.added === 3, GIT_MS)
  expect(more.ui.counts).toEqual({ added: 3, removed: 1 })
  expect(await viewerText(kea)).toContain('return a + b // sum')
  expect((await viewerText(kea)).endsWith('\nexport const mul = (a, b) => a * b\n')).toBe(true)
  await expect(page.locator('.viewer .viewer-stat')).toHaveText('+3 −1')
  await waitChanges(kea, 'its row follows', (r) => r.find((x) => x.path === 'src/math.js')?.stat === '+3 −1')
  await until('the header’s diff stat follows', async () => (await diffStatText(kea)) === '+5 −7' || undefined, GIT_MS)
  expect(await labels()).toEqual(['Files', 'Changes 5'])
  await kea.assertUnfocused()
})

/**
 * Stop's worst case: two escalation steps and the settle after each, as I-SRV-2 holds it in core. Here it is the
 * window's time, from the click on Stop to the control showing Run again.
 */
const STOP_WORST_MS = 2 * L.serverStopStepMs + 2 * L.serverStopSettleMs

// ── a file, a diff, the dev server and the editor, by clicks only ───────────────────────────────────

test('E-FV-9 · the file viewer’s journey, by clicks only, in one session and in this order: a file clicked in Files is shown coloured, numbered and with a marker on its changed lines; clicked in Changes it is its diff; Run starts the worktree’s start.sh, a script with a watcher beside its server, and the `:PORT ↗` chip opens its URL (recorded, no browser); Stop leaves no process of the server’s tree alive and its port free; the header’s Code button opens the worktree in VS Code (the stand-in)', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const world = new EditorWorld(run)
  world.editor('vscode')
  world.open()
  const repo = demoRepo(run)
  const pids = path.join(run.home, 'server-tree.pids')
  commitFiles(repo.root, { 'start.sh': serverTreeScript(pids) }, { executable: true })
  const kea = await launch()
  const page = await kea.page()
  await kea.pretendFocused(true)
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'ship')
  await waitLive(kea, id)
  const agent = await agentTerminal(kea, id)
  const dir = worktreesOf(repo.root)[0]!.dir
  /** The server's tree as far as the test has learnt it: stopped by hand if the test fails before Stop did it. */
  const serverTree: number[] = []
  try {
    // what the session changed (files on disk are setup): line 2 of math.js, and a function added at its end
    const math = 'export function add(a, b) {\n  return a + b // sum\n}\n\nexport function sub(a, b) {\n  return a - b\n}\n\nexport function mul(a, b) {\n  return a * b\n}\n'
    writeFiles(dir, { 'src/math.js': math })

    // ── 1. click a file, see it formatted ────────────
    await clickFile(kea, 'src/math.js')
    const file = await waitBody(kea, 'src/math.js', 'text')
    expect([file.ui.language, await viewerText(kea)]).toEqual(['JavaScript', math])
    await waitViewer(kea, 'every line coloured', (v) => v.text?.tokenised === math.split('\n').length)
    expect(await tokenClasses(kea)).toEqual(expect.arrayContaining(['kea-tok-keyword', 'kea-tok-function', 'kea-tok-comment']))
    expect(await gutterLines(kea), 'line numbers').toEqual(math.split('\n').map((_, i) => i + 1))
    await waitViewer(kea, 'two changed regions', (v) => v.ui.changes === 2, GIT_MS)
    expect([await changeMarker(kea, 1), await changeMarker(kea, 2), await changeMarker(kea, 9)], 'a marker on the changed and the added lines only').toEqual([null, 'modified', 'added'])
    expect(await tabShape(kea)).toEqual(['src/math.js file preview *'])

    // ── 2. click a change, see the diff ────────────
    await clickChange(kea, 'src/math.js')
    const diff = await waitBody(kea, 'src/math.js', 'diff')
    await waitViewer(kea, 'the diff’s two changes', (v) => v.ui.changes === 2 && v.ui.entry?.code === 'M', GIT_MS)
    expect(diff.ui.layout).toBe('unified')
    await expect(page.locator('.viewer .viewer-stat')).toHaveText('+5 −1')
    await expect(page.locator('.viewer .cm-deletedChunk').first(), 'the line the base had, above the one that replaced it').toHaveText('  return a + b')
    expect(await tabShape(kea), 'the same tab: one tab for a path').toEqual(['src/math.js diff preview *'])
    expect(await diffStatText(kea)).toBe('+5 −1')

    // ── 3. Run: the button, then Stop with the chip beside it ────────────
    const control = serverControl(page)
    await waitServer(kea, 'stopped')
    // the diff stat keeps its place while the control beside it changes state and width
    const statBox = async (): Promise<{ x: number; width: number }> => {
      const b = await page.locator('.header-right .diff-stat').boundingBox()
      if (!b) throw new Error('the header shows no diff stat')
      return { x: b.x, width: b.width }
    }
    const statAtRest = await statBox()
    await control.getByRole('button', { name: 'Run' }).click()
    await waitServer(kea, 'running')
    const at = await serverAddress(kea)
    expect(at).toMatchObject({ url: `http://localhost:${at.port}/`, label: `:${at.port} ↗` })
    await expect(control.getByRole('button', { name: 'Stop' })).toBeVisible()
    await expect(serverChip(page)).toBeVisible()
    expect(await statBox(), 'the diff stat where it was, beside Stop and the chip').toEqual(statAtRest)
    const answer = /^ok (\d+) (\d+) /.exec(await until('the server answers', async () => (await serverAnswer(at.port)) || undefined))
    const made = await until('the script wrote its pids', () => treePids(pids) ?? undefined)
    const server = Number(answer?.[1])
    serverTree.push(made.shell, made.watcher, server)
    expect(new Set(serverTree).size, 'the script’s shell, its watcher and the server are three processes').toBe(3)
    expect(serverTree.map(pidAlive)).toEqual([true, true, true])
    expect(await viewerShown(kea), 'running it took nothing off the screen').toMatchObject({ path: 'src/math.js', mode: 'diff' })

    // ── 4. open the URL chip: main is asked to open it; under the harness it is recorded, no browser opens ───────────
    expect(await opened(kea)).toEqual([])
    await serverChip(page).click()
    await until('the link to reach main', async () => (await opened(kea)).length > 0 || undefined)
    expect(await opened(kea)).toEqual([at.url])

    // ── 5. Stop, with nothing left behind: the watcher ignores ⌃C, so Stop goes on to SIGTERM ──────────────────
    // Stop's own time: from the click to Run on screen again, within its worst case
    const stopClicked = performance.now()
    await control.getByRole('button', { name: 'Stop' }).click()
    await waitServer(kea, 'stopped', STOP_WORST_MS)
    await expect(control.getByRole('button', { name: 'Run' })).toBeVisible()
    expect(performance.now() - stopClicked, 'from the click on Stop to Run on screen again (ms)').toBeLessThan(STOP_WORST_MS)
    await expect(serverChip(page)).toHaveCount(0)
    expect(await statBox(), 'and beside Run again').toEqual(statAtRest)
    const left = () => serverTree.filter(pidAlive)
    expect(left(), 'no process of the server’s tree is alive').toEqual([])
    expect(await listening(at.port), `port ${at.port} is free`).toBe(false)

    // ── 6. open the worktree in VS Code: the header’s button ────────────
    const button = editorButton(page)
    await expect(button).toHaveAttribute('data-editor', 'vscode', { timeout: STEP_MS })
    expect(world.launches(), 'nothing was launched so far').toEqual([])
    await button.getByRole('button', { name: 'Code', exact: true }).click()
    const launches = await world.waitLaunches(1)
    expect(launches.map((l) => l.argv), 'the bundle’s own CLI, with the worktree').toEqual([[dir]])

    // the end of the sitting: one session, its diff still in the work pane beside the agent, nothing running
    expect(await tabShape(kea)).toEqual(['src/math.js diff preview *'])
    expect(await kea.shown('work'), 'no terminal took the work pane').toBeNull()
    expect(left()).toEqual([])
    expect(await listening(at.port)).toBe(false)
    await kea.assertUnfocused()
  } finally {
    // a failure before Stop must not leave the stand-ins running: they are this test's own processes
    for (const pid of serverTree) if (pidAlive(pid)) process.kill(pid, 'SIGKILL')
  }
})
