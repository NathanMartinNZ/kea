// The file viewer and the diff view: Kea launched through tests/e2e/fixtures.ts, a session started in a demo
// repository, and files put into its worktree and opened as a person opens them: clicks on rows in Files and Changes
// and on tabs, a double-click or `↵` to pin (tests/support/app-files.ts `clickFile`, `clickChange`), never
// `viewer.open` through a probe. What the viewer shows is read from the page as a person sees it, and from the viewer's
// read-only probe (tests/support/app-viewer.ts). tabs.spec.ts covers the tab strip's own rules.
//
// Nothing here reaches the person's clipboard, browser or apps: clipboard writes are recorded in the page, and whatever
// the viewer hands to the system goes, under the harness, to a stand-in or a recorder (E-FV-7 holds it to that): `open`
// is the run's own (tests/support/app-server.ts `EditorWorld`), a web link is recorded by main and a reveal is logged
// by it, neither opened.

import fs from 'node:fs'
import path from 'node:path'
import { L } from '@kea/protocol'
import { STEP_MS, until, type Kea } from '../support/app.ts'
import { claudeByDefault, fakeAgentTerminal, gate, startFakeSession } from '../support/app-fake-agent.ts'
import { EditorWorld, OPENER, opened } from '../support/app-server.ts'
import { addProject, agentTerminal, demoRepo, selectSession, startSession, waitLive } from '../support/app-sessions.ts'
import { changeRows, clickChange, clickFile, clickScope, GIT_MS, panelModes, panelRegion, scopeShown, treeRows, waitChanges } from '../support/app-files.ts'
import { clickFileTab, fileTab, fileTabs, pinFileTab, viewerShown } from '../support/app-tabs.ts'
import { changeMarker, commitAll, gitIn, gutterLines, loginSource, png, sessionWorktree, tokenClasses, viewer, viewerCopy, viewerRows, viewerText, waitBody, waitViewer, writeFiles } from '../support/app-viewer.ts'
import { expect, test } from './fixtures.ts'
import { sysKey, textKey } from '../support/keys.ts'
import { protocolOs } from '../../packages/protocol/src/os/index.ts'

/** The file manager's name in a title: Finder, or File Manager on Linux. */
const FILE_MANAGER = protocolOs.words.fileManager

const LOGIN = 'src/auth/login.ts'

/** A demo project with `files` committed, and a session started in it: its id and its worktree. */
async function sessionWith(kea: Kea, run: Parameters<typeof demoRepo>[0], files: Record<string, string | Uint8Array>): Promise<{ id: string; worktree: string; repo: string }> {
  await kea.pretendFocused(true)
  const repo = demoRepo(run)
  if (Object.keys(files).length > 0) {
    writeFiles(repo.root, files)
    commitAll(repo.root, 'Add files')
  }
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'viewer')
  await waitLive(kea, id)
  return { id, worktree: sessionWorktree(repo.root), repo: repo.root }
}

/** `⌃G`, `line[:col]`, `↵`. */
async function goToLine(kea: Kea, where: string): Promise<void> {
  const page = await kea.page()
  await page.keyboard.press(sysKey('Control+g'))
  await page.locator('.viewer .kea-goto .kea-bar-input').waitFor()
  await page.keyboard.type(where)
  await page.keyboard.press('Enter')
  await page.locator('.viewer .kea-goto').waitFor({ state: 'detached' })
}

/** Select whole lines `from`…`to` with the keyboard, as a person does. */
async function selectLines(kea: Kea, from: number, to: number): Promise<void> {
  const page = await kea.page()
  await goToLine(kea, String(from))
  for (let i = from; i <= to; i++) await page.keyboard.press('Shift+ArrowDown')
  await waitViewer(kea, `lines ${from}–${to} selected`, (v) => v.text?.selection.from.line === from && v.text.selection.to.line === to + 1)
}

/**
 * Scroll the document a little with the wheel, as a person does (so that the view is not at a line's edge); resolves
 * once the scroll has arrived (the wheel's scroll is animated: a position read meanwhile is not where it ends).
 */
async function wheelDocument(kea: Kea, px: number): Promise<void> {
  const page = await kea.page()
  const scroller = page.locator('.viewer .cm-editor:not(.cm-merge-a) .cm-scroller')
  const box = await scroller.boundingBox()
  if (!box) throw new Error('no document on screen')
  const from = await scroller.evaluate((s) => s.scrollTop)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, px)
  await until(`the document scrolled by ${px} px`, () => scroller.evaluate((s, want) => Math.abs(s.scrollTop - want) < 1 || undefined, from + px))
  // the system's font sets the line height, so `px` can still end at a line's edge (the position is read in whole
  // pixels): one pixel more
  if ((await viewer(kea))?.text?.scroll.offset === 0) await wheelDocument(kea, 1)
}

/** The unified diff's removed lines on screen, top to bottom (a hunk that only adds has an empty block: no lines). */
function removedLines(kea: Kea): Promise<string[]> {
  return kea.page().then((page) => page.locator('.viewer .cm-deletedChunk .cm-deletedLine').allTextContents())
}

/** A reload keeps the first visible line where it was to within this (positions are kept in whole pixels). */
const ANCHOR_PX = 2

/** How far the view moved against the document's lines between two scroll positions, `added` lines having been put in above it (px). */
async function drift(kea: Kea, before: { line: number; offset: number }, after: { line: number; offset: number }, added: number): Promise<number> {
  const page = await kea.page()
  const lineHeight = await page.locator('.viewer .cm-content .cm-line').first().evaluate((l) => l.getBoundingClientRect().height)
  return (after.line - before.line - added) * lineHeight + (after.offset - before.offset)
}

/** Clipboard writes are recorded in the page and never reach the person's clipboard. */
async function recordClipboard(kea: Kea): Promise<() => Promise<string[]>> {
  const page = await kea.page()
  await page.evaluate(() => {
    const w = window as unknown as { __keaClipboard: string[] }
    w.__keaClipboard = []
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (t: string) => void w.__keaClipboard.push(t) })
  })
  return () => page.evaluate(() => (window as unknown as { __keaClipboard: string[] }).__keaClipboard)
}

/** Everything a person could do to change the text: typing, deleting, a paste, a drop. */
async function tryToEdit(kea: Kea): Promise<void> {
  const page = await kea.page()
  await page.keyboard.type('typed text')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Delete')
  await page.keyboard.press(textKey('Meta+Backspace'))
  await page.evaluate(() => {
    const content = document.querySelector('.viewer .cm-editor:not(.cm-merge-a) .cm-content') as HTMLElement
    const data = new DataTransfer()
    data.setData('text/plain', 'pasted text')
    content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    content.dispatchEvent(new ClipboardEvent('cut', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }))
    content.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
    content.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'inserted', bubbles: true, cancelable: true }))
  })
}

test('E-FV-1 · a changed file opened from Files shows its text coloured, with line numbers and a change marker on each changed region; File → Diff opens the diff at the same line; opened from Changes it is the diff directly', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const base = loginSource(14).split('\n')
  const { worktree } = await sessionWith(kea, run, { [LOGIN]: base.join('\n') })
  // the session's change: line 42 modified, two lines added after line 60, the two lines that were 100 and 101 removed
  const changed = [...base]
  changed[41] = '  // step four'
  changed.splice(99, 2)
  changed.splice(60, 0, '  audit(session)', '  log(6)')
  writeFiles(worktree, { [LOGIN]: changed.join('\n') })

  // 1. a click on its row in Files (its folders opened first): the file's text, coloured, numbered
  await clickFile(kea, LOGIN)
  const shown = await waitBody(kea, LOGIN, 'text')
  expect(shown.ui.language).toBe('TypeScript')
  expect(await viewerText(kea), 'the file as it is on disk').toBe(changed.join('\n'))
  expect(await viewerShown(kea)).toEqual({ path: LOGIN, mode: 'file', focused: true })
  await expect(page.locator('.viewer .cm-content'), 'the document has the keyboard').toBeFocused()
  await waitViewer(kea, 'every line coloured', (v) => v.text?.tokenised === changed.length)
  expect(await tokenClasses(kea)).toEqual(expect.arrayContaining(['kea-tok-keyword', 'kea-tok-string', 'kea-tok-comment', 'kea-tok-function', 'kea-tok-constant']))
  expect((await gutterLines(kea)).slice(0, 3), 'line numbers').toEqual([1, 2, 3])
  await expect(page.locator('.viewer .viewer-crumbs .crumb')).toHaveText(['src', 'auth', 'login.ts'])

  // 2. the gutter marks the changed lines; ⌥↓ / ⌥↑ step through the regions and around
  await waitViewer(kea, 'three changed regions', (v) => v.ui.changes === 3)
  const cursor = async () => (await viewer(kea))?.text?.selection.from.line
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(cursor).toBe(42)
  expect(await changeMarker(kea, 42)).toBe('modified')
  expect(await changeMarker(kea, 41), 'an unchanged line has no marker').toBeNull()
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(cursor).toBe(61)
  expect([await changeMarker(kea, 61), await changeMarker(kea, 62), await changeMarker(kea, 63)]).toEqual(['added', 'added', null])
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(cursor).toBe(101)
  expect(await changeMarker(kea, 101), 'lines were removed after line 101').toBe('deleted')
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(cursor, { message: 'around the end' }).toBe(42)
  await page.keyboard.press('Alt+ArrowUp')
  await expect.poll(cursor).toBe(101)
  await page.keyboard.press('Alt+ArrowUp')
  await expect.poll(cursor).toBe(61)

  // 3. File → Diff on the tab: the same tab, the diff, at the same line
  const toDiff = page.locator('.viewer .viewer-switch[aria-label="File or diff"] button', { hasText: 'Diff' })
  await toDiff.waitFor({ timeout: GIT_MS })
  await toDiff.click()
  const diff = await waitBody(kea, LOGIN, 'diff')
  expect(diff.text?.selection.from.line, 'the cursor is on the line it was on').toBe(61)
  expect(await gutterLines(kea), 'and that line is on screen').toContain(61)
  expect((await fileTabs(kea)).map((t) => `${t.path} ${t.kind}`), 'still one tab for the path').toEqual([`${LOGIN} diff`])
  expect(await viewerText(kea), 'the new side is the file').toBe(changed.join('\n'))
  expect((await removedLines(kea))[0], 'what line 42 replaced, above it').toBe('  // step 4')
  // and back, again at the line
  await page.locator('.viewer .viewer-switch[aria-label="File or diff"] button', { hasText: 'File' }).click()
  const back = await waitBody(kea, LOGIN, 'text')
  expect(back.text?.selection.from.line).toBe(61)

  // 4. the same file clicked in Changes opens the diff directly
  await page.keyboard.press('Escape')
  await until('the file tab closed', async () => (await viewerShown(kea)) === null || undefined)
  await clickChange(kea, LOGIN)
  const direct = await waitBody(kea, LOGIN, 'diff')
  expect(await viewerShown(kea), 'the diff has the keyboard').toEqual({ path: LOGIN, mode: 'diff', focused: true })
  expect(direct.ui.changes, 'three hunks').toBe(3)
  await expect(page.locator('.viewer .viewer-code')).toHaveText('M')
  await expect(page.locator('.viewer .viewer-stat')).toHaveText('+3 −3')
})

test('E-FV-2 · in the file view a block folds and unfolds, ⌘F finds with a match count, ⌃G goes to a line, ⌥Z wraps, a selection copies, the breadcrumb names the path, nothing typed changes the text, and ⌘L puts the selected lines’ reference at the agent’s prompt without submitting it', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const source = loginSource(14)
  const lines = source.split('\n')
  const { id } = await sessionWith(kea, run, { [LOGIN]: source })
  const agent = await agentTerminal(kea, id)
  await clickFile(kea, LOGIN)
  await waitBody(kea, LOGIN, 'text')

  // fold and unfold: the chevrons show while the gutter is hovered; a folded block reads ⋯
  await page.locator('.viewer .cm-gutters').hover()
  await page.locator('.viewer .cm-foldGutter .kea-fold-open').first().click()
  await waitViewer(kea, 'one fold', (v) => v.text?.folds === 1)
  await expect(page.locator('.viewer .cm-foldPlaceholder')).toHaveText('⋯')
  expect((await gutterLines(kea)).slice(0, 3), 'the block’s lines are hidden; its closing line stays').toEqual([1, 8, 9])
  // (CodeMirror's hidden gutter spacer holds a marker too: the one a person sees)
  await page.locator('.viewer .cm-foldGutter .kea-fold-closed:visible').first().click()
  await waitViewer(kea, 'unfolded', (v) => v.text?.folds === 0)
  expect((await gutterLines(kea)).slice(0, 3)).toEqual([1, 2, 3])

  // ⌘F: incremental, with a count; ↵ and ⇧↵ step; the toggles narrow it; Esc closes the bar, not the tab
  const count = page.locator('.viewer .kea-find .kea-bar-count')
  await page.keyboard.press(sysKey('Meta+f'))
  await page.locator('.viewer .kea-find .kea-bar-input').waitFor()
  await page.keyboard.type('session')
  await expect(count).toHaveText('1 of 56')
  await expect(page.locator('.viewer .kea-find .kea-bar-input')).toHaveValue('session')
  await page.keyboard.press('Enter')
  await expect(count).toHaveText('2 of 56')
  await page.keyboard.press('Shift+Enter')
  await expect(count).toHaveText('1 of 56')
  expect(await page.locator('.viewer .cm-searchMatch').count(), 'the matches on screen are marked').toBeGreaterThan(10)
  await page.locator('.viewer .kea-find [aria-label="Match Case"]').click()
  await expect(count).toHaveText('1 of 42')
  await page.locator('.viewer .kea-find [aria-label="Match Whole Word"]').click()
  await expect(count).toHaveText('1 of 42')
  await page.locator('.viewer .kea-find [aria-label="Match Case"]').click()
  await page.locator('.viewer .kea-find [aria-label="Match Whole Word"]').click()
  await page.locator('.viewer .kea-find [aria-label="Use Regular Expression"]').click()
  await page.locator('.viewer .kea-find .kea-bar-input').fill('step \\d+$')
  await expect(count).toHaveText('1 of 14')
  await page.locator('.viewer .kea-find .kea-bar-input').fill('no such text anywhere')
  await expect(count).toHaveText('No results')
  await page.keyboard.press('Escape')
  await page.locator('.viewer .kea-find').waitFor({ state: 'detached' })
  expect(await viewerShown(kea), 'Esc closed the bar; the tab is still there, with the keyboard').toEqual({ path: LOGIN, mode: 'file', focused: true })

  // ⌃G
  await goToLine(kea, '40:3')
  expect((await viewer(kea))?.text?.selection.from).toEqual({ line: 40, col: 3 })
  expect(await gutterLines(kea)).toContain(40)

  // ⌥Z: word wrap on and off
  await page.keyboard.press('Alt+z')
  await waitViewer(kea, 'wrap on', (v) => v.text?.wrap === true && v.ui.wrap)
  await page.keyboard.press('Alt+z')
  await waitViewer(kea, 'wrap off', (v) => v.text?.wrap === false && !v.ui.wrap)

  // select and copy: what ⌘C would copy is the selected lines
  await selectLines(kea, 40, 41)
  expect(await viewerCopy(kea)).toBe(`${lines[39]}\n${lines[40]}\n`)
  // ⌘A selects the document, not the page
  await page.keyboard.press(textKey('Meta+a'))
  await waitViewer(kea, 'everything selected', (v) => v.text?.selection.from.line === 1 && v.text.selection.to.line === lines.length)
  expect(await viewerCopy(kea)).toBe(source)

  // the breadcrumb: one segment per folder, each a button. A click reveals that folder in the file tree (E-FT-2
  // follows it into the tree): the tree's row has the keyboard, the tab stays as it is
  await expect(page.locator('.viewer .viewer-crumbs .crumb')).toHaveText(['src', 'auth', 'login.ts'])
  await page.locator('.viewer .viewer-crumbs .crumb', { hasText: 'auth' }).click()
  await until('the folder’s row has the keyboard', async () => ((await treeRows(kea)).find((r) => r.selected)?.path === 'src/auth' && (await page.evaluate(() => !!document.activeElement?.closest('[role=tree]')))) || undefined)
  expect(await viewerShown(kea), 'the tab is still the one on screen').toEqual({ path: LOGIN, mode: 'file', focused: false })
  // a click in the document gives it the keyboard back
  await page.locator('.viewer .cm-content .cm-line').first().click()
  await until('the document has the keyboard again', async () => (await viewerShown(kea))?.focused || undefined)

  // Typing in the file view does nothing
  await goToLine(kea, '5')
  await tryToEdit(kea)
  expect(await viewerText(kea)).toBe(source)

  // Lines 40–52, ⌘L → the Agent tab, the reference at its prompt, not submitted
  await selectLines(kea, 40, 52)
  await page.keyboard.press(sysKey('Meta+l'))
  await until('the Agent terminal on screen', async () => (await kea.shown()) === agent || undefined)
  expect(await viewerShown(kea)).toBeNull()
  const screen = await kea.waitScreen('the reference at the prompt', (s) => s.includes(`${LOGIN}:40-52`))
  expect(screen.trimEnd().endsWith(`${LOGIN}:40-52`), `not submitted: nothing follows it\n${screen}`).toBe(true)
  // the Agent terminal has the keyboard: what is typed next goes on at the prompt, after the reference
  await until('the keyboard in the Agent terminal', () => page.evaluate(() => !!document.activeElement?.closest('.terminal-host.shown') || undefined))
  await page.keyboard.type(' explain')
  await kea.waitScreen('the typing follows the reference', (s) => s.trimEnd().endsWith(`${LOGIN}:40-52 explain`))
})

test('E-FV-3 · the agent rewrites the open file: the view takes the change without jumping to the top and the gutter follows; the agent deletes it: the last content stays, dimmed, under “Deleted”', async ({ run, launch }) => {
  test.setTimeout(120_000)
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  await kea.pretendFocused(true)
  const FILE = 'src/live.ts'
  const base = loginSource(40).split('\n')
  // the rewrite: ten lines put in after line 1, and what was line 250 changed
  const rewritten = [...base]
  rewritten[249] = '  // REWRITTEN'
  rewritten.splice(1, 0, ...Array.from({ length: 10 }, (_, i) => `// INSERTED ${i}`))
  const repo = demoRepo(run)
  writeFiles(repo.root, { [FILE]: base.join('\n') })
  commitAll(repo.root, 'Add live')
  await addProject(kea, repo.root)
  const write = gate(run, 'write')
  const remove = gate(run, 'remove')
  const { id } = await startFakeSession(
    kea,
    'live',
    'rewrite the file',
    ['steps:', '  - frame: ["✻ fake-agent · {{model}}", "", "> {{prompt}}"]', `  - ${write.step}`, `  - file: { op: write, path: ${FILE}, content: ${JSON.stringify(rewritten.join('\n'))} }`, `  - ${remove.step}`, `  - file: { op: delete, path: ${FILE} }`].join('\n'),
  )
  await fakeAgentTerminal(kea, id)

  // the file, clicked in Files, taken to line 200 (⌃G) and scrolled a little further with the wheel so that the view
  // is not at a line's edge
  await clickFile(kea, FILE)
  await waitBody(kea, FILE, 'text')
  await goToLine(kea, '200')
  await waitViewer(kea, 'the cursor on line 200', (v) => v.text?.selection.from.line === 200)
  await wheelDocument(kea, 7)
  const before = await waitViewer(kea, 'scrolled', (v) => (v.text?.scroll.line ?? 0) > 100 && v.text?.scroll.offset !== 0)
  const first = before.text!.scroll
  expect(await viewerText(kea)).toBe(base.join('\n'))

  // 1. the rewrite arrives: the same line is still the first one on screen (now ten lines further down the file)
  await write.open()
  await until('the view shows the rewritten file', async () => (await viewerText(kea)) === rewritten.join('\n') || undefined)
  const after = (await viewer(kea))!.text!
  expect(Math.abs(await drift(kea, first, after.scroll, 10)), 'anchored on the first visible line: it is where it was, ten lines further down the file').toBeLessThanOrEqual(ANCHOR_PX)
  expect(after.scroll.line, 'not at the top').toBeGreaterThan(100)
  expect(after.selection.from.line, 'the cursor stays on its line').toBe(210)
  // the gutter follows: the inserted lines and the changed one
  await waitViewer(kea, 'two changed regions', (v) => v.ui.changes === 2)
  await page.keyboard.press('Alt+ArrowDown')
  await waitViewer(kea, 'the changed line', (v) => v.text?.selection.from.line === 260)
  // the jump scrolls the line into view first: its gutter is read once it is drawn
  await expect.poll(() => changeMarker(kea, 260), { timeout: STEP_MS }).toBe('modified')
  await page.keyboard.press('Alt+ArrowDown')
  await waitViewer(kea, 'the inserted lines', (v) => v.text?.selection.from.line === 2)
  await expect.poll(async () => [await changeMarker(kea, 1), await changeMarker(kea, 2), await changeMarker(kea, 11), await changeMarker(kea, 12)], { timeout: STEP_MS }).toEqual([null, 'added', 'added', null])

  // 2. the file is deleted: its last content stays, dimmed, and the notice says so
  await remove.open()
  const gone = await waitViewer(kea, 'the deleted state', (v) => v.ui.deleted)
  expect(gone.ui.notices).toEqual(['Deleted'])
  expect(gone.ui.body.kind).toBe('text')
  await expect(page.locator('.viewer .viewer-notice')).toHaveText('Deleted')
  await expect(page.locator('.viewer .viewer-body.deleted .cm-content')).toContainText('// INSERTED 0')
  expect(await viewerText(kea), 'the last content').toBe(rewritten.join('\n'))
  expect(fs.existsSync(path.join(sessionWorktree(repo.root), FILE))).toBe(false)
})

test('E-FV-4 · other types: a Markdown preview renders with no request to the network and no script run, images show scaled and at full size, an SVG is an image whose script never runs and has a Source view, a binary file is one line, invalid UTF-8 and CRLF are said, a link shows its target or only where it leads', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const { worktree } = await sessionWith(kea, run, {})
  writeFiles(worktree, {
    'doc.md': ['# Title', '', '<script>window.__pwned = 1</script>', '', '<img src="https://example.invalid/raw.png" onerror="window.__pwned = 2">', '', '![remote](https://example.invalid/track.png) ![local](img/pic.png)', '', '[site](https://example.com/) [js](javascript:window.__pwned=3) [file](src/math.js)', '', '```ts', 'const answer: number = 42 // fence', '```', ''].join('\n'),
    'img/pic.png': png(64, 48),
    'img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><script>window.__svg = 1</script><image href="https://example.invalid/inside.png" width="10" height="10"/><rect width="120" height="60" fill="green"/></svg>\n',
    'data.bin': Buffer.from([1, 2, 0, 3, 4, 5, 0, 0]),
    'bad.txt': Buffer.from([0x6f, 0x6b, 0x20, 0xc3, 0x28, 0x20, 0x62, 0x61, 0x64, 0x0a]),
    'crlf.txt': 'one\r\ntwo\r\nthree\r\n',
  })
  fs.symlinkSync('doc.md', path.join(worktree, 'alias.md'))
  fs.symlinkSync('/etc/hosts', path.join(worktree, 'outside.txt')) // os-ok: test data
  const requests: string[] = [] // bounded: the requests of one test
  page.on('request', (r) => requests.push(r.url()))
  const flags = () => page.evaluate(() => ({ pwned: (window as unknown as { __pwned?: number }).__pwned ?? null, svg: (window as unknown as { __svg?: number }).__svg ?? null }))

  // Markdown: the source, coloured; ⇧⌘V renders it
  await clickFile(kea, 'doc.md')
  const md = await waitBody(kea, 'doc.md', 'text')
  expect([md.ui.language, md.ui.canPreview, md.ui.preview]).toEqual(['Markdown', true, false])
  await page.keyboard.press(sysKey('Meta+Shift+v'))
  await waitBody(kea, 'doc.md', 'preview')
  const preview = page.locator('.viewer .viewer-preview')
  await expect(preview.locator('h1')).toHaveText('Title')
  await expect(preview, 'raw HTML is text').toContainText('<script>window.__pwned = 1</script>')
  expect(await preview.locator('script, iframe, style, [onerror]').count()).toBe(0)
  await expect(preview.locator('.md-no-image'), 'a remote image is its alt text').toHaveText('remote')
  // the local image comes through kea-file://
  await until('the local image loaded', () => preview.locator('img').evaluate((i) => ((i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth === 64) || undefined))
  expect(await preview.locator('img').count()).toBe(1)
  expect(await preview.locator('img').getAttribute('src')).toMatch(/^kea-file:\/\/f\/.*\/img\/pic\.png$/)
  // links: a web address is a link (also the one in the raw HTML's text: a click would open the browser, nothing loads
  // it), the script link has no target, the file link names a file of the worktree
  expect(await preview.locator('a').evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('data-path')]))).toEqual([
    ['https://example.invalid/raw.png', 'https://example.invalid/raw.png', null],
    ['site', 'https://example.com/', null],
    ['js', null, null],
    ['file', null, 'src/math.js'],
  ])
  // the fence is coloured by the same worker
  await until('the fence coloured', async () => (await preview.locator('pre code .kea-tok-keyword').count()) > 0 || undefined)
  await expect(preview.locator('pre code')).toHaveText('const answer: number = 42 // fence')
  expect(await flags(), 'no script of the document ran').toEqual({ pwned: null, svg: null })
  // the same file through a link inside the worktree: its target is shown
  await clickFile(kea, 'alias.md')
  const alias = await waitBody(kea, 'alias.md', 'text')
  expect(alias.ui.link).toBe('doc.md')
  expect(await viewerText(kea)).toContain('# Title')
  // a link that leads out of the worktree shows only where it leads
  await clickFile(kea, 'outside.txt')
  const outside = await waitBody(kea, 'outside.txt', 'note')
  expect(outside.ui.body.text).toMatch(/^A link to \/(private\/)?etc\/hosts$/)
  expect(outside.ui.body.actions).toEqual([])

  // PNG: scaled to fit, a click shows it at its own size; the header has its dimensions and size
  await clickFile(kea, 'img/pic.png')
  await waitBody(kea, 'img/pic.png', 'image')
  const img = page.locator('.viewer .viewer-image img')
  await until('the image decoded', () => img.evaluate((i) => (i as HTMLImageElement).naturalWidth === 64 || undefined))
  await expect(page.locator('.viewer .viewer-image-info')).toHaveText(/^64 × 48 · [\d.]+ KB$/)
  await img.click()
  await expect(page.locator('.viewer .viewer-image')).toHaveClass(/actual/)
  await img.click()
  await expect(page.locator('.viewer .viewer-image')).not.toHaveClass(/actual/)

  // SVG: an image (its script and its external image are inert), with a Source view
  await clickFile(kea, 'img/logo.svg')
  await waitBody(kea, 'img/logo.svg', 'image')
  await until('the SVG drawn', () => page.locator('.viewer .viewer-image img').evaluate((i) => (i as HTMLImageElement).naturalWidth === 120 || undefined))
  await page.locator('.viewer .viewer-switch[aria-label="Image or source"] button', { hasText: 'Source' }).click()
  const svg = await waitBody(kea, 'img/logo.svg', 'text')
  expect(svg.ui.language).toBe('XML')
  expect(await viewerText(kea)).toContain('<script>window.__svg = 1</script>')
  await page.locator('.viewer .viewer-switch[aria-label="Image or source"] button', { hasText: 'Image' }).click()
  await waitBody(kea, 'img/logo.svg', 'image')
  expect(await flags(), 'the SVG’s script never ran').toEqual({ pwned: null, svg: null })

  // binary: one line — type, size, what can be done (never pressed here)
  await clickFile(kea, 'data.bin')
  const bin = await waitBody(kea, 'data.bin', 'note')
  expect(bin.ui.body).toEqual({ kind: 'note', text: 'BIN file · 8 B', actions: ['default', 'reveal'] })
  await expect(page.locator('.viewer .viewer-note button')).toHaveText(['Open with default app', `Reveal in ${FILE_MANAGER}`])

  // invalid UTF-8: replacement characters and a notice
  await clickFile(kea, 'bad.txt')
  const bad = await waitBody(kea, 'bad.txt', 'text')
  expect(bad.ui.notices).toEqual(['Not valid UTF-8 · some characters are replaced'])
  expect(await viewerText(kea)).toBe('ok �( bad\n')

  // CRLF: said in the header, and kept in what is copied
  await clickFile(kea, 'crlf.txt')
  const crlf = await waitBody(kea, 'crlf.txt', 'text')
  expect([crlf.ui.encoding, crlf.text?.lines]).toEqual(['CRLF', 4])
  await expect(page.locator('.viewer .viewer-encoding')).toHaveText('CRLF')
  await page.keyboard.press(textKey('Meta+a'))
  await waitViewer(kea, 'everything selected', (v) => v.text?.selection.to.line === 4)
  expect(await viewerCopy(kea)).toBe('one\r\ntwo\r\nthree\r\n')

  // nothing of all this asked the network for anything, and the only files asked for are the two images' own
  expect(requests.filter((u) => /^(https?|wss?|ftp):/i.test(u)), 'requests to the network').toEqual([])
  expect([...new Set(requests.filter((u) => u.startsWith('kea-file:')).map((u) => new URL(u).pathname.split('/').slice(-2).join('/')))].sort()).toEqual(['img/logo.svg', 'img/pic.png'])
})

test('E-FV-5 · large files: a 15 MB minified bundle shows at once and says where highlighting stopped, a 30 MB log is plain text without folding or wrap, a 60 MB file is one line offering the editor; no frame takes longer than 100 ms throughout', async ({ run, launch }) => {
  test.setTimeout(180_000)
  const kea = await launch()
  const page = await kea.page()
  const { worktree } = await sessionWith(kea, run, {})
  const MB = 1024 * 1024
  const unit = 'function a(b,c){return b+c*2};var x="str",y=[1,2,3].map(function(n){return n*2});if(x){console.log(y)}'
  const bundleLine = `${unit.repeat(40)}\n`
  const logLine = '2026-10-11T12:00:00.000Z INFO  request id=abcdef0123456789 path=/api/v1/things status=200 ms=12\n'
  const fill = (name: string, line: string, bytes: number) => fs.writeFileSync(path.join(worktree, name), line.repeat(Math.ceil(bytes / line.length)))
  fill('bundle.min.js', bundleLine, 15 * MB)
  fill('server.log', logLine, 30 * MB)
  fill('huge.log', logLine, 60 * MB)
  await page.evaluate(() => (globalThis as unknown as { __keaPerf: { framesStart(): void } }).__keaPerf.framesStart())

  // 15 MB (between L.viewerFullBytes and L.viewerPlainBytes): text at once, colours within the budget, then the notice
  await clickFile(kea, 'bundle.min.js')
  const bundle = await waitBody(kea, 'bundle.min.js', 'text')
  expect(bundle.text?.chars).toBeGreaterThan(15 * MB)
  const stopped = await waitViewer(kea, 'the highlighting-stopped notice', (v) => v.ui.notices.some((n) => /^Highlighting stopped at line \d+$/.test(n)), 30_000)
  expect(stopped.text!.tokenised, 'what was coloured stays coloured').toBeGreaterThan(0)
  expect(stopped.text!.tokenised).toBeLessThan(stopped.text!.lines)
  await expect(page.locator('.viewer .viewer-notice')).toHaveText(/Highlighting stopped at line \d+/)
  expect(await tokenClasses(kea)).toContain('kea-tok-keyword')
  // it scrolls
  for (let i = 0; i < 8; i++) await page.keyboard.press('PageDown')
  await waitViewer(kea, 'scrolled down', (v) => (v.text?.scroll.line ?? 0) > 100)
  // a line of 4 000 characters cannot be wrapped away: wrap is available below L.viewerWrapLineMax, and works
  expect(bundle.ui.canWrap).toBe(true)

  // 30 MB (over L.viewerPlainBytes): plain text — no colours, no folding, no wrap
  await clickFile(kea, 'server.log')
  const log = await waitBody(kea, 'server.log', 'text')
  expect(log.ui.notices).toEqual(['Large file · shown as plain text'])
  expect([log.ui.canWrap, log.text?.tokenised]).toEqual([false, 0])
  expect(log.text!.lines).toBeGreaterThan(L.viewerPlainLines)
  expect(await page.locator('.viewer .cm-foldGutter').count(), 'no fold gutter').toBe(0)
  expect(await tokenClasses(kea)).toEqual([])
  await page.keyboard.press('Alt+z')
  for (let i = 0; i < 8; i++) await page.keyboard.press('PageDown')
  const scrolled = await waitViewer(kea, 'scrolled down', (v) => (v.text?.scroll.line ?? 0) > 100)
  expect(scrolled.text?.wrap, '⌥Z is not available').toBe(false)

  // 60 MB (over L.viewerMaxBytes): not loaded
  await clickFile(kea, 'huge.log')
  const huge = await waitBody(kea, 'huge.log', 'note')
  expect(huge.ui.body.text).toMatch(/^Large file · 6\d(\.\d)? MB$/)
  expect(huge.ui.body.actions).toEqual(['editor', 'reveal'])
  await expect(page.locator('.viewer .viewer-note button').first()).toHaveText('Open in editor')
  expect(huge.resources.viewerDocBytes, 'nothing of it is held').toBe(0)

  const frames = await page.evaluate(() => (globalThis as unknown as { __keaPerf: { framesStop(): { maxGapMs: number; frames: number } } }).__keaPerf.framesStop())
  expect(frames.frames).toBeGreaterThan(60)
  expect(frames.maxGapMs, 'the longest frame (the app stays responsive)').toBeLessThanOrEqual(100)
})

test('E-FV-6 · a file in a language not used yet shows as plain text first and its colours follow; an unknown type stays plain text; pinning a ninth file tab closes the least recently viewed pinned one; a tab shown again is where it was left', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const python = ['def first(n):', '    """Doc."""', '    return [x * 2 for x in range(n)]  # comment', '', 'class Thing:', '    name = "thing"', ''].join('\n')
  const files: Record<string, string> = { 'tool.py': python, 'notes.xyz': 'def not_code(n):\n    return "plain"\n' }
  for (let i = 1; i <= 8; i++) files[`pin/f${i}.txt`] = `file ${i}\n`
  files['pin/f9.txt'] = Array.from({ length: 300 }, (_, i) => `line ${i + 1} of file 9`).join('\n')
  await sessionWith(kea, run, files)

  // 1. first use: watch the document's DOM for the text and for the first coloured token
  expect((await viewer(kea))?.highlighter.starts ?? 0, 'no highlight worker yet').toBe(0)
  await page.evaluate(() => {
    const w = window as unknown as { __firstUse: { text: number | null; token: number | null; plainWhenShown: boolean | null } }
    w.__firstUse = { text: null, token: null, plainWhenShown: null }
    const look = () => {
      const content = document.querySelector('.viewer .cm-content')
      if (!content) return
      const coloured = content.querySelector('[class*="kea-tok-"]') !== null
      if (w.__firstUse.text === null && content.textContent?.includes('def first(n):')) {
        w.__firstUse.text = performance.now()
        w.__firstUse.plainWhenShown = !coloured
      }
      if (w.__firstUse.token === null && coloured) w.__firstUse.token = performance.now()
    }
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] })
  })
  await clickFile(kea, 'tool.py')
  const py = await waitBody(kea, 'tool.py', 'text')
  expect(py.ui.language).toBe('Python')
  await waitViewer(kea, 'the colours', (v) => v.text?.tokenised === v.text?.lines && v.highlighter.starts === 1)
  const seen = await page.evaluate(() => (window as unknown as { __firstUse: { text: number | null; token: number | null; plainWhenShown: boolean | null } }).__firstUse)
  expect(seen.plainWhenShown, 'the text was on screen before any colour').toBe(true)
  expect(seen.token! - seen.text!, 'colours followed').toBeGreaterThan(0)
  expect(await tokenClasses(kea)).toEqual(expect.arrayContaining(['kea-tok-keyword', 'kea-tok-string', 'kea-tok-comment']))

  // 2. an unknown type: plain text, whatever it looks like
  await clickFile(kea, 'notes.xyz')
  const plain = await waitBody(kea, 'notes.xyz', 'text')
  expect([plain.ui.language, plain.text?.tokenised]).toEqual(['Plain Text', 0])
  expect(await viewerText(kea)).toBe(files['notes.xyz'])
  expect(await tokenClasses(kea)).toEqual([])
  // a tab that is gone keeps nothing: the preview tab showed the Python file before this one, and now it is closed —
  // neither document is held, on screen or among the recently viewed ones
  await page.keyboard.press('Escape')
  await until('the tab closed', async () => (await viewerShown(kea)) === null || undefined)
  expect(await fileTabs(kea)).toEqual([])
  const kept = await viewerRows(kea)
  expect([kept.viewerDocBytes, kept.viewerCachedDocs, kept.viewerCachedBytes], 'characters on screen, documents kept, their bytes').toEqual([0, 0, 0])

  // 3. eight pinned tabs at most: the ninth closes the least recently viewed pinned one. Each is clicked in Files (the
  // preview tab) and pinned as a person pins: `↵` in the viewer, or a double-click on the tab
  const pinned = async () => (await fileTabs(kea)).filter((t) => t.pinned).map((t) => t.path)
  const openPinned = async (p: string, how: 'enter' | 'double-click') => {
    await clickFile(kea, p)
    await waitBody(kea, p, 'text')
    expect((await fileTabs(kea)).find((t) => t.path === p), 'a click opens the preview tab').toMatchObject({ pinned: false, selected: true })
    if (how === 'enter') {
      await until('the document has the keyboard', async () => (await viewerShown(kea))?.focused || undefined)
      await page.keyboard.press('Enter')
      await until(`${p} pinned`, async () => (await pinned()).includes(p) || undefined)
    } else await pinFileTab(kea, p)
  }
  for (let i = 1; i <= 8; i++) await openPinned(`pin/f${i}.txt`, i % 2 ? 'enter' : 'double-click')
  // f1 is looked at again (a click on its tab), so f2 is now the least recently viewed
  await clickFileTab(kea, 'pin/f1.txt')
  await waitBody(kea, 'pin/f1.txt', 'text')
  expect(await pinned()).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((i) => `pin/f${i}.txt`))
  await openPinned('pin/f9.txt', 'enter')
  expect(await pinned()).toEqual([1, 3, 4, 5, 6, 7, 8, 9].map((i) => `pin/f${i}.txt`))
  expect(await viewerText(kea)).toBe(files['pin/f9.txt'])

  // a tab keeps its place: the scroll position and the selection are there again when it is shown again
  await selectLines(kea, 200, 201)
  await wheelDocument(kea, 7)
  const left = (await waitViewer(kea, 'scrolled', (v) => (v.text?.scroll.line ?? 0) > 100 && v.text?.scroll.offset !== 0)).text!
  await clickFileTab(kea, 'pin/f1.txt')
  await waitBody(kea, 'pin/f1.txt', 'text')
  expect(await viewerText(kea)).toBe('file 1\n')
  await clickFileTab(kea, 'pin/f9.txt')
  await waitBody(kea, 'pin/f9.txt', 'text')
  const again = await waitViewer(kea, 'the place it was left at', (v) => v.text?.scroll.line === left.scroll.line && v.text.scroll.offset === left.scroll.offset)
  expect(again.text!.selection).toEqual(left.selection)
  await expect(page.locator('.viewer .cm-content'), 'and the document has the keyboard').toBeFocused()
  // the same through Files: a click on the row of a file that has a tab shows that tab (one tab per file),
  // still pinned, where it was left
  const tabsBefore = await fileTabs(kea)
  await clickFile(kea, 'pin/f1.txt')
  await waitBody(kea, 'pin/f1.txt', 'text')
  await clickFile(kea, 'pin/f9.txt')
  await waitBody(kea, 'pin/f9.txt', 'text')
  const viaTree = await waitViewer(kea, 'the place it was left at, opened from Files', (v) => v.text?.scroll.line === left.scroll.line && v.text.scroll.offset === left.scroll.offset)
  expect(viaTree.text!.selection).toEqual(left.selection)
  expect(await fileTabs(kea), 'no tab was added, none lost its pin').toEqual(tabsBefore)
  expect((await viewer(kea))!.resources.viewerEditors, 'one editor served every tab').toBe(1)
  expect((await viewer(kea))!.resources.viewerCachedDocs).toBeLessThanOrEqual(L.viewerDocCache)
})

test('E-FV-7 · what the viewer hands to the system is, under the harness, recorded and never opened: “Open with default app” runs only the run’s own `open` and says so when there is none, “Reveal in Finder” reaches main and opens no Finder, a preview’s web link goes to main’s link recorder, a script link goes nowhere, a file link opens in the viewer', async ({ run, launch }) => {
  test.setTimeout(120_000)
  // the run's own world: no editor, no `open` (the harness gives Kea an empty HOME and core looks nowhere else)
  const world = new EditorWorld(run)
  const kea = await launch()
  const page = await kea.page()
  const { worktree } = await sessionWith(kea, run, {})
  writeFiles(worktree, {
    'data.bin': Buffer.from([1, 2, 0, 3, 4, 5, 0, 0]),
    'doc.md': ['# Links', '', '[site](https://example.com/docs?q=1) [js](javascript:window.__pwned=3) [file](src/math.js)', ''].join('\n'),
  })
  const real = fs.realpathSync(worktree)

  // 1. Open with default app, with no `open` in the run's world: nothing starts, and the window says so
  await clickFile(kea, 'data.bin')
  await waitBody(kea, 'data.bin', 'note')
  const openDefault = page.locator('.viewer .viewer-note button', { hasText: 'Open with default app' })
  await openDefault.click()
  await expect(page.locator('.toast[role=alert] .toast-text')).toHaveText('The file could not be opened')
  expect(world.launches(), 'nothing was launched').toEqual([])
  // 2. with the run's own stand-in `open`: it gets the file's real path, and it is the only thing that runs
  world.open()
  await openDefault.click()
  expect(await world.waitLaunches(1)).toEqual([{ tool: OPENER, argv: [path.join(real, 'data.bin')] }])

  // 3. Reveal in the file manager: main is asked for this file and opens nothing (`--kea-perf`)
  await page.locator('.viewer .viewer-note button', { hasText: `Reveal in ${FILE_MANAGER}` }).click()
  const reveal = await until('the reveal asked of main', () => kea.logLines('main').find((l) => l.msg === 'reveal not opened (perf)'))
  expect(reveal.path).toBe(path.join(real, 'data.bin'))

  // 4. a Markdown preview's links: the web link is recorded by main, not opened; the script link reaches nothing
  await clickFile(kea, 'doc.md')
  await waitBody(kea, 'doc.md', 'text')
  await page.keyboard.press(sysKey('Meta+Shift+v'))
  await waitBody(kea, 'doc.md', 'preview')
  const preview = page.locator('.viewer .viewer-preview')
  expect(await opened(kea), 'no link yet').toEqual([])
  await preview.locator('a', { hasText: 'js' }).click()
  await preview.locator('a', { hasText: 'site' }).click()
  await expect.poll(() => opened(kea)).toEqual(['https://example.com/docs?q=1'])
  expect(kea.logLines('main').filter((l) => l.msg === 'link not opened'), 'nothing else was asked of main').toEqual([])
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned ?? null), 'the script link ran nothing').toBeNull()
  expect(page.url(), 'the window went nowhere').toMatch(/^kea:\/\/app\//)
  // the file link opens that file of the worktree in the viewer
  await preview.locator('a', { hasText: 'file' }).click()
  await waitBody(kea, 'src/math.js', 'text')
  expect(await viewerText(kea)).toContain('export function add(a, b)')

  // all of it: one run of the stand-in `open`, one recorded link, and no window but Kea's
  expect(world.launches()).toHaveLength(1)
  expect(await opened(kea)).toHaveLength(1)
  expect(await kea.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})

test('E-FV-8 · another session comes on screen: the viewer keeps nothing of the one that left — no document, none cached, nothing followed in the window or in core — and kea-file:// stops serving that session’s images; shown again, its file tabs are still there and the file is read anew', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const source = (n: number): string => `${Array.from({ length: 40 }, (_, i) => `export const v${n}_${i} = ${i}`).join('\n')}\n`
  const { id: a } = await sessionWith(kea, run, { 'src/one.ts': source(1), 'src/two.ts': source(2), 'img/pic.png': png(64, 64) })
  const b = await startSession(kea, 'second')
  await waitLive(kea, b)
  await selectSession(kea, a)
  const coreFollows = async (): Promise<number> => ((await kea.debug<Record<string, { follows?: number } | undefined>>('core', 'kit'))['core.viewer']?.follows ?? -1)
  /** Ask for a `kea-file://` URL the page has not loaded yet (another version of it), so main's handler answers. */
  const served = (url: string, version: number): Promise<string> =>
    page.evaluate(
      (src) =>
        new Promise<string>((resolve) => {
          const i = new Image()
          i.onload = () => resolve('served')
          i.onerror = () => resolve('refused')
          i.src = src
        }),
      `${url.replace(/\?v=\d+$/, '')}?v=${version}`,
    )

  // session A: an image through kea-file://, then two text files, so one document is on screen and one in the cache
  await clickFile(kea, 'img/pic.png')
  await waitBody(kea, 'img/pic.png', 'image')
  await pinFileTab(kea, 'img/pic.png')
  const img = page.locator('.viewer .viewer-image img')
  await until('the image decoded', () => img.evaluate((i) => (i as HTMLImageElement).naturalWidth === 64 || undefined))
  const url = (await img.getAttribute('src')) ?? ''
  expect(url).toMatch(/^kea-file:\/\/f\/.*\/img\/pic\.png\?v=\d+$/)
  for (const p of ['src/one.ts', 'src/two.ts']) {
    await clickFile(kea, p)
    await waitViewer(kea, `${p} shown`, (v) => v.ui.path === p && v.ui.body.kind === 'text' && v.highlighter.pending === 0)
    await pinFileTab(kea, p)
  }
  await until('the open file followed', async () => ((await viewerRows(kea)).viewerFollows === 1 && (await coreFollows()) === 1) || undefined)
  const held = await viewerRows(kea)
  expect(held.viewerDocBytes).toBeGreaterThan(0)
  expect(held.viewerCachedDocs).toBeGreaterThanOrEqual(1)
  expect(await served(url, 1)).toBe('served')

  // session B on screen: A is out of the window's visible set
  await selectSession(kea, b)
  await until('nothing of the session that left in the window', async () => {
    const r = await viewerRows(kea)
    return (r.viewerDocBytes === 0 && r.viewerCachedDocs === 0 && r.viewerCachedBytes === 0 && r.viewerFollows === 0 && r.viewerReads === 0) || undefined
  })
  await until('nothing followed in core', async () => (await coreFollows()) === 0 || undefined)
  expect(await viewerShown(kea)).toBeNull()
  expect(await served(url, 2), 'an image of a session no window shows').toBe('refused')

  // A again: its tabs are the strip's and were kept; what they show is read again
  await selectSession(kea, a)
  expect((await fileTabs(kea)).map((t) => t.path).sort()).toEqual(['img/pic.png', 'src/one.ts', 'src/two.ts'])
  if ((await viewerShown(kea))?.path !== 'src/two.ts') await fileTab(page, 'src/two.ts').click()
  await waitViewer(kea, 'src/two.ts read again', (v) => v.ui.path === 'src/two.ts' && v.ui.body.kind === 'text' && v.highlighter.pending === 0)
  expect(await viewerText(kea)).toBe(source(2))
  await until('followed again', async () => ((await viewerRows(kea)).viewerFollows === 1 && (await coreFollows()) === 1) || undefined)
  expect(await served(url, 3)).toBe('served')
})

test('E-DF-1 · a changed file clicked in Changes is its diff against the branch’s base; ] and [ step through the changed files and around; after the agent commits it is still listed and still a diff in Branch scope; a click on Uncommitted in the Changes header empties the list and the open diff together, a new edit shows in both, and a click on Branch puts both back on the branch’s base', async ({ run, launch }) => {
  test.setTimeout(180_000)
  const kea = await launch()
  const page = await kea.page()
  const { worktree } = await sessionWith(kea, run, {})
  const math = 'export function add(a, b) {\n  // sum\n  return a + b\n}\n\nexport function mul(a, b) {\n  return a * b\n}\n'
  writeFiles(worktree, { 'src/math.js': math, 'src/hello.js': 'export function greet(name) {\n  return `Hello, ${name}!`\n}\n', 'notes.txt': 'one\ntwo\n' })

  // the diff of a modified file: old side the base's, new side the file
  await clickChange(kea, 'src/math.js')
  await waitBody(kea, 'src/math.js', 'diff')
  expect(await viewerText(kea)).toBe(math)
  expect(await removedLines(kea), 'what the base had').toEqual(['export function sub(a, b) {', '  return a - b'])
  const listed = await waitViewer(kea, 'the three changed files listed', (v) => v.git.changed === 3 && v.ui.entry !== null, GIT_MS)
  expect([listed.git.head?.scope, listed.ui.entry?.code, listed.ui.counts]).toEqual(['branch', 'M', { added: 3, removed: 2 }])
  await expect(page.locator('.viewer .viewer-code')).toHaveText('M')
  await expect(page.locator('.viewer .viewer-stat')).toHaveText('+3 −2')

  // ] / [: the Changes list's order (by path), around the ends
  const shownPath = async () => (await viewer(kea))?.ui.path
  await page.keyboard.press('BracketRight')
  await expect.poll(shownPath, { message: '] from the last file wraps to the first' }).toBe('notes.txt')
  const untracked = await waitBody(kea, 'notes.txt', 'diff')
  expect(await viewerText(kea), 'an untracked file is fully added').toBe('one\ntwo\n')
  expect([untracked.ui.changes, await removedLines(kea)]).toEqual([1, []])
  await page.keyboard.press('BracketRight')
  await expect.poll(shownPath).toBe('src/hello.js')
  await waitBody(kea, 'src/hello.js', 'diff')
  await page.keyboard.press('BracketLeft')
  await expect.poll(shownPath).toBe('notes.txt')
  await page.keyboard.press('BracketLeft')
  await expect.poll(shownPath, { message: '[ from the first wraps to the last' }).toBe('src/math.js')
  await waitBody(kea, 'src/math.js', 'diff')
  expect((await fileTabs(kea)).map((t) => `${t.path} ${t.kind}`), 'all in the preview tab').toEqual(['src/math.js diff'])

  // the agent commits: Branch scope still compares with where the branch started
  gitIn(worktree, 'add', '-A')
  gitIn(worktree, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'Change things')
  const committed = await waitViewer(kea, 'the commit seen', (v) => v.git.head?.ahead === 1, GIT_MS)
  expect([committed.git.changed, committed.ui.entry?.code, committed.ui.body.kind, committed.ui.changes]).toEqual([3, 'M', 'diff', 2])
  expect(await removedLines(kea)).toEqual(['export function sub(a, b) {', '  return a - b'])

  // the scope switch in the Changes header, with the diff tab open: one click re-bases the list and the open diff
  // together. Branch so far: the three files, the diff against where the branch started
  const labels = async () => (await panelModes(kea)).map((m) => m.label)
  const listedNow = async () => (await changeRows(kea)).map((r) => `${r.letter} ${r.path}`)
  expect(await scopeShown(kea)).toBe('Branch')
  expect(await listedNow(), 'committed on the branch: the new file is added, no longer untracked').toEqual(['A notes.txt', 'M src/hello.js', 'M src/math.js'])
  await expect(panelRegion(page).getByLabel('Totals')).toHaveText(/3 files/)
  await until('the diff has the keyboard', async () => (await viewerShown(kea))?.focused || undefined)

  // Uncommitted: nothing is changed since the commit, in the list and in the diff
  await clickScope(kea, 'Uncommitted')
  const clean = await waitViewer(kea, 'Uncommitted: nothing listed, no change in the diff', (v) => v.git.head?.scope === 'uncommitted' && v.git.changed === 0 && v.ui.changes === 0, GIT_MS)
  expect(clean.ui.entry).toBeNull()
  expect(await removedLines(kea)).toEqual([])
  expect(await viewerText(kea)).toBe(math)
  await waitChanges(kea, 'Uncommitted: no rows', (r) => r.length === 0)
  await expect(panelRegion(page).getByText('No changes yet.')).toBeVisible()
  expect(await labels(), 'and the header counts none').toEqual(['Files', 'Changes'])
  expect(await viewerShown(kea), 'the switch leaves the diff tab on screen, with the keyboard').toEqual({ path: 'src/math.js', mode: 'diff', focused: true })
  expect((await fileTabs(kea)).map((t) => `${t.path} ${t.kind}`)).toEqual(['src/math.js diff'])
  // a new edit is an uncommitted change again: one row, one hunk
  fs.appendFileSync(path.join(worktree, 'src/math.js'), '\nexport const TWO = 2\n')
  const again = await waitViewer(kea, 'the new change listed and shown', (v) => v.git.changed === 1 && v.ui.changes === 1, GIT_MS)
  expect([again.ui.entry?.code, again.ui.counts]).toEqual(['M', { added: 2, removed: 0 }])
  await waitChanges(kea, 'the one uncommitted change', (r) => r.length === 1 && r[0]?.path === 'src/math.js' && r[0].stat === '+2 −0')
  await expect(page.locator('.viewer .viewer-stat')).toHaveText('+2 −0')
  expect(await removedLines(kea)).toEqual([])

  // Branch again: the same click the other way, and both are back on the branch's base, the new edit included
  await clickScope(kea, 'Branch')
  const branch = await waitViewer(kea, 'Branch: the three files, the diff against the base', (v) => v.git.head?.scope === 'branch' && v.git.changed === 3 && v.ui.changes === 3, GIT_MS)
  expect([branch.ui.entry?.code, branch.ui.counts]).toEqual(['M', { added: 5, removed: 2 }])
  expect(await removedLines(kea)).toEqual(['export function sub(a, b) {', '  return a - b'])
  await waitChanges(kea, 'Branch: the three rows', (r) => r.length === 3)
  expect(await listedNow()).toEqual(['A notes.txt', 'M src/hello.js', 'M src/math.js'])
  expect(await scopeShown(kea)).toBe('Branch')
  await until('the header counts three again', async () => (await labels()).includes('Changes 3') || undefined, GIT_MS)
  // and ] still steps through that list
  await page.keyboard.press('BracketRight')
  await expect.poll(shownPath).toBe('notes.txt')
})

test('E-DF-2 · lines selected in a diff and ⌘L: the Agent tab comes on screen with the new side’s line reference at its prompt, not submitted; ⌘⇧C copies the same reference', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const base = loginSource(14).split('\n')
  const { id, worktree } = await sessionWith(kea, run, { [LOGIN]: base.join('\n') })
  const agent = await agentTerminal(kea, id)
  // five lines put in at the top, and lines 40–52 of the new file all changed (so the diff shows every one of them)
  const changed = [...Array.from({ length: 5 }, (_, i) => `// added ${i}`), ...base].map((l, i) => (i >= 39 && i <= 51 ? `${l} // changed` : l))
  writeFiles(worktree, { [LOGIN]: changed.join('\n') })
  const clipboard = await recordClipboard(kea)

  await clickChange(kea, LOGIN)
  await waitBody(kea, LOGIN, 'diff')
  await selectLines(kea, 40, 52)
  // ⌘⇧C: the same reference, copied
  await page.keyboard.press(sysKey('Meta+Shift+c'))
  await expect.poll(clipboard).toEqual([`${LOGIN}:40-52`])
  await page.keyboard.press(sysKey('Meta+l'))
  await until('the Agent terminal on screen', async () => (await kea.shown()) === agent || undefined)
  expect(await viewerShown(kea)).toBeNull()
  const screen = await kea.waitScreen('the reference at the prompt', (s) => s.includes(`${LOGIN}:40-52`))
  expect(screen.trimEnd().endsWith(`${LOGIN}:40-52`), `not submitted: nothing follows it\n${screen}`).toBe(true)
  expect((await fileTabs(kea)).map((t) => t.path), 'the diff tab is still there').toEqual([LOGIN])
})

test('E-DF-3 · a diff: unified and side by side, unchanged regions collapsed behind expanders, the header’s status letter, path copy and +n −n, a change on disk taken without losing the place, nothing typed changes it; a large diff, a binary file and an image each get their own view', async ({ run, launch }) => {
  test.setTimeout(180_000)
  const kea = await launch()
  const page = await kea.page()
  const base = loginSource(30).split('\n')
  const { worktree } = await sessionWith(kea, run, { [LOGIN]: base.join('\n'), 'big.txt': 'small\n', 'data.bin': Buffer.from([1, 2, 0, 3, 4, 5, 0, 0]), 'img/pic.png': png(64, 48) })
  const changed = [...base]
  changed[5] = '  // step zero'
  changed[239] = '  // step two-forty'
  writeFiles(worktree, { [LOGIN]: changed.join('\n') })
  const clipboard = await recordClipboard(kea)

  // unified by default: both changes, what was removed above what replaced it, the rest collapsed
  await clickChange(kea, LOGIN)
  const unified = await waitBody(kea, LOGIN, 'diff')
  expect([unified.ui.layout, unified.ui.changes, unified.resources.viewerMerges, unified.resources.viewerEditors]).toEqual(['unified', 2, 0, 1])
  expect((await removedLines(kea))[0]).toBe('  // step 0')
  const collapsed = page.locator('.viewer .cm-collapsedLines')
  await expect(collapsed.first()).toHaveText(`⋯ ${239 - 6 - 2 * L.diffContextLines} unchanged lines`)
  expect(await gutterLines(kea), 'the lines between the changes are not shown').not.toContain(120)
  expect(await collapsed.count(), 'the lines between the changes, and those after the last').toBe(2)
  await collapsed.first().click()
  await until('the expander showed the lines', async () => (await gutterLines(kea)).includes(20) || undefined)
  await expect(collapsed.filter({ hasText: `${239 - 6 - 2 * L.diffContextLines} unchanged lines` })).toHaveCount(0)

  // the header: status letter, path (a click copies it), +n −n
  await waitViewer(kea, 'the status entry', (v) => v.ui.entry !== null, GIT_MS)
  await expect(page.locator('.viewer .viewer-code')).toHaveText('M')
  await expect(page.locator('.viewer .viewer-stat')).toHaveText('+2 −2')
  await page.locator('.viewer .viewer-path').click()
  await expect.poll(clipboard).toEqual([LOGIN])
  await expect(page.locator('.viewer .viewer-open')).toContainText('Open in editor')

  // side by side and back (⌘⇧\ and the header's switch): one merge view at most, the same two changes
  await page.keyboard.press(sysKey('Meta+Shift+Backslash'))
  const split = await waitViewer(kea, 'side by side', (v) => v.ui.layout === 'split' && v.ui.body.kind === 'diff' && v.resources.viewerMerges === 1)
  expect([split.ui.changes, split.resources.viewerEditors], 'the two sides are the only editors: the unified one is gone').toEqual([2, 2])
  await expect(page.locator('.viewer .cm-mergeView .cm-merge-a .cm-changedLine').first()).toContainText('// step 0')
  await expect(page.locator('.viewer .cm-mergeView .cm-merge-b .cm-changedLine').first()).toContainText('// step zero')
  expect(await page.locator('.viewer .cm-mergeView .cm-collapsedLines').count()).toBeGreaterThan(0)
  await page.locator('.viewer .viewer-switch[aria-label="Diff layout"] button', { hasText: 'Unified' }).click()
  const again = await waitViewer(kea, 'unified again', (v) => v.ui.layout === 'unified' && v.resources.viewerMerges === 0 && v.ui.body.kind === 'diff')
  expect(again.resources.viewerEditors, 'and the two sides went with the merge view').toBe(1)

  // read-only — typing, deleting, a paste and a drop change nothing; there is nothing to accept or revert
  await page.keyboard.press('Alt+ArrowDown')
  await tryToEdit(kea)
  expect(await viewerText(kea)).toBe(changed.join('\n'))
  expect(await page.locator('.viewer .cm-chunkButtons, .viewer .cm-merge-revert').count()).toBe(0)

  // The file changes while the diff is open — the place is kept (the lines between the changes are shown, so
  // that the diff is longer than the window)
  await page.locator('.viewer .cm-collapsedLines').first().click()
  await until('the expander showed the lines', async () => (await gutterLines(kea)).includes(20) || undefined)
  await page.keyboard.press('Alt+ArrowDown')
  await waitViewer(kea, 'on the second change, scrolled to', (v) => v.text?.selection.from.line === 240 && v.text.scroll.line > 100)
  await wheelDocument(kea, 5)
  const before = (await waitViewer(kea, 'scrolled', (v) => (v.text?.scroll.line ?? 0) > 100 && v.text?.scroll.offset !== 0)).text!.scroll
  const later = ['// new 1', '// new 2', '// new 3', ...changed]
  writeFiles(worktree, { [LOGIN]: later.join('\n') })
  await until('the diff shows the file as it is now', async () => (await viewerText(kea)) === later.join('\n') || undefined)
  const after = (await viewer(kea))!
  expect(Math.abs(await drift(kea, before, after.text!.scroll, 3)), 'anchored on the first visible line: it is where it was, three lines further down the file').toBeLessThanOrEqual(ANCHOR_PX)
  expect(after.ui.changes).toBe(3)

  // A side over the limit is not rendered
  fs.writeFileSync(path.join(worktree, 'big.txt'), 'x'.repeat(100).concat('\n').repeat(Math.ceil((L.diffMaxBytes + 1024) / 101)))
  await clickChange(kea, 'big.txt')
  const large = await waitBody(kea, 'big.txt', 'note')
  expect(large.ui.body).toEqual({ kind: 'note', text: 'Large diff', actions: ['editor'] })
  await expect(page.locator('.viewer .viewer-note button')).toHaveText(['Open in editor'])
  // a binary file: its type and how its size changed
  fs.writeFileSync(path.join(worktree, 'data.bin'), Buffer.from([1, 2, 0, 3, 4, 5, 0, 0, 9, 9, 9, 9]))
  await clickChange(kea, 'data.bin')
  expect((await waitBody(kea, 'data.bin', 'note')).ui.body.text).toBe('BIN file · 8 B → 12 B')
  // an image: before and after, side by side
  fs.writeFileSync(path.join(worktree, 'img/pic.png'), png(32, 32))
  await clickChange(kea, 'img/pic.png')
  await waitBody(kea, 'img/pic.png', 'images')
  const sides = page.locator('.viewer .viewer-images img')
  await until('both images decoded', async () => (await sides.evaluateAll((is) => is.map((i) => (i as HTMLImageElement).naturalWidth))).join() === '64,32' || undefined)
  expect(await sides.evaluateAll((is) => is.map((i) => (i as HTMLImageElement).src.split(':')[0]))).toEqual(['data', 'kea-file'])
})
