// V-7 and V-13: the diff tab (unified, split, collapsed regions, binary, the large-diff notice) and the file viewer
// (TypeScript with folds, change markers and find open; Markdown preview; an image; the binary placeholder; the
// large-file notice).

import fs from 'node:fs'
import path from 'node:path'
import { L } from '../../../packages/protocol/src/index.ts'
import { expect, test } from '../../../tests/e2e/fixtures.ts'
import { STEP_MS, type Kea } from '../../../tests/support/app.ts'
import { clickChange, clickFile, GIT_MS, waitChanges } from '../../../tests/support/app-files.ts'
import { fakeAgentTerminal } from '../../../tests/support/app-fake-agent.ts'
import { addProject } from '../../../tests/support/app-sessions.ts'
import { commitAll, loginSource, png, waitBody, waitViewer, writeFiles } from '../../../tests/support/app-viewer.ts'
import { tinyRepo } from '../../repo-factory/src/index.ts'
import { cwdOf, openKea, QUIET, runCommand, session } from './scene.ts'
import { GallerySet } from './shots.ts'

const LOGIN = 'src/auth/login.ts'
/** The main column. */
const MAIN = { x: 504, y: 0, width: 936, height: 900 }
const TOP = { x: 504, y: 44, width: 936, height: 260 }

const README = ['# Atlas', '', 'A small service used for the gallery.', '', '## Running', '', '1. Install the dependencies', '2. `pnpm dev`', '', '> Sessions keep running when the window closes.', '', '| Command | What |', '|---|---|', '| `pnpm dev` | the dev server |', '| `pnpm test` | the tests |', '', '```ts', 'export const answer: number = 42', '```', '', 'See [the plan](docs/plan.md).', ''].join('\n')

/** A project with the viewer's files committed, one fake-agent session on screen, and its worktree changed. */
async function scene(kea: Kea): Promise<{ id: string; worktree: string }> {
  const repo = tinyRepo({ name: 'atlas-web', parent: kea.run.home })
  const base = loginSource(30).split('\n')
  writeFiles(repo.root, { [LOGIN]: base.join('\n'), 'docs/guide.md': README, 'big.txt': 'small\n', 'data.bin': Buffer.from([1, 2, 0, 3, 4, 5, 0, 0]), 'img/pic.png': png(640, 400) })
  commitAll(repo.root, 'Add files')
  await addProject(kea, repo.root, 'atlas-web')
  const id = await session(kea, 'viewer', 'fix the auth redirect', QUIET, { open: false })
  await fakeAgentTerminal(kea, id)
  const worktree = await cwdOf(kea, id)
  const changed = [...base]
  changed[5] = '  // step zero'
  changed.splice(12, 2)
  changed.splice(40, 0, '  const started = Date.now()', '  log("login", started)')
  changed[239] = '  // step two-forty'
  writeFiles(worktree, { [LOGIN]: changed.join('\n') })
  return { id, worktree }
}

test('V-7 · diff tab', async ({ run, launch }) => {
  const set = new GallerySet('V-7', 'Diff tab')
  const kea = await openKea(run, launch)
  const page = await kea.page()
  const { worktree } = await scene(kea)
  fs.writeFileSync(path.join(worktree, 'big.txt'), 'x'.repeat(100).concat('\n').repeat(Math.ceil((L.diffMaxBytes + 1024) / 101)))
  fs.writeFileSync(path.join(worktree, 'data.bin'), Buffer.from([1, 2, 0, 3, 4, 5, 0, 0, 9, 9, 9, 9]))
  fs.writeFileSync(path.join(worktree, 'img/pic.png'), png(320, 320))
  await runCommand(kea, 'files.showChanges')
  await waitChanges(kea, 'the changes', (rows) => rows.length === 4)

  await clickChange(kea, LOGIN)
  await waitBody(kea, LOGIN, 'diff')
  await waitViewer(kea, 'the status entry', (v) => v.ui.entry !== null, GIT_MS)
  await expect(page.locator('.viewer .cm-collapsedLines').first()).toBeVisible({ timeout: STEP_MS })
  await page.mouse.move(1000, 800)
  await set.shot(kea, 'unified', 'Unified: the header (status letter, path, +n −n, File · Diff, Unified · Split, Open in editor ⌘↵); added lines --ok at 14 %, removed --danger at 14 %, changed words at 28 %; collapsed regions "⋯ n unchanged lines" on --surface-1', 'File viewer', { rect: MAIN })

  await page.keyboard.press('Meta+Shift+Backslash')
  await waitViewer(kea, 'side by side', (v) => v.ui.layout === 'split' && v.resources.viewerMerges === 1)
  await expect(page.locator('.viewer .cm-mergeView .cm-collapsedLines').first()).toBeVisible({ timeout: STEP_MS })
  await page.mouse.move(1000, 800)
  await set.shot(kea, 'split', 'Side by side (⌘⇧\\): the same changes, the unchanged regions collapsed on both sides', 'File viewer', { rect: MAIN })
  await page.keyboard.press('Meta+Shift+Backslash')

  await clickChange(kea, 'data.bin')
  await waitBody(kea, 'data.bin', 'note')
  await page.mouse.move(1000, 800)
  await set.shot(kea, 'binary', 'A binary file: one line saying its type and how its size changed', 'File viewer', { rect: TOP })

  await clickChange(kea, 'big.txt')
  await waitBody(kea, 'big.txt', 'note')
  await page.mouse.move(1000, 800)
  await set.shot(kea, 'large', 'A diff over the limit: one line, "Large diff", offering the editor', 'File viewer', { rect: TOP })

  await clickChange(kea, 'img/pic.png')
  await waitBody(kea, 'img/pic.png', 'images')
  await expect(page.locator('.viewer .viewer-images img').nth(1)).toBeVisible({ timeout: STEP_MS })
  await page.mouse.move(1000, 800)
  await set.shot(kea, 'images', 'A changed image: before and after, side by side', 'File viewer', { rect: MAIN })
})

test('V-13 · file viewer', async ({ run, launch }) => {
  const set = new GallerySet('V-13', 'File viewer')
  const kea = await openKea(run, launch)
  const page = await kea.page()
  const { worktree } = await scene(kea)
  const MB = 1024 * 1024
  const unit = 'function a(b,c){return b+c*2};var x="str",y=[1,2,3].map(function(n){return n*2});if(x){console.log(y)}'
  fs.writeFileSync(path.join(worktree, 'bundle.min.js'), `${unit.repeat(40)}\n`.repeat(Math.ceil((2 * MB) / (unit.length * 40))))
  fs.writeFileSync(path.join(worktree, 'huge.log'), '2026-10-11T12:00:00.000Z INFO  request id=abcdef0123456789 path=/api/v1/things status=200 ms=12\n'.repeat(Math.ceil((L.viewerMaxBytes + MB) / 95)))
  const tree = page.getByRole('tree', { name: 'Files' })
  for (const dir of ['src', 'src/auth', 'docs', 'img']) await tree.locator(`[data-path="${dir}"]`).click()

  await clickFile(kea, LOGIN)
  await waitBody(kea, LOGIN, 'text')
  await waitViewer(kea, 'coloured', (v) => (v.text?.tokenised ?? 0) > 0, GIT_MS)
  await expect(page.locator('.viewer .kea-change').first()).toBeVisible({ timeout: GIT_MS })
  // fold a block: the chevrons show while the gutter is hovered
  await page.locator('.viewer .cm-gutters').hover()
  await page.locator('.viewer .cm-foldGutter .kea-fold-open').nth(2).click()
  await waitViewer(kea, 'one fold', (v) => v.text?.folds === 1)
  await set.shot(kea, 'typescript', 'TypeScript: the breadcrumb (last segment --text-1), the language, File · Diff, Open in editor; a folded block (⋯); change markers at the far left (modified, added, a deletion’s wedge); fold chevrons while the gutter is hovered', 'File viewer', { rect: MAIN })

  await page.locator('.viewer .cm-content').click({ position: { x: 300, y: 200 } })
  await page.keyboard.press('Meta+f')
  await page.locator('.viewer .kea-find .kea-bar-input').waitFor({ timeout: STEP_MS })
  await page.keyboard.type('session')
  await expect(page.locator('.viewer .kea-find .kea-bar-count')).toContainText('of', { timeout: STEP_MS })
  await page.mouse.move(1000, 800)
  await set.shot(kea, 'find', 'Find in file (⌘F): matches --warn at 25 %, the current one outlined; the current line on --surface-1', 'File viewer', { rect: MAIN })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+g')
  await page.locator('.viewer .kea-goto .kea-bar-input').waitFor({ timeout: STEP_MS })
  await set.shot(kea, 'goto', 'Go to Line (⌃G)', 'File viewer', { rect: TOP })
  await page.keyboard.press('Escape')

  await clickFile(kea, 'docs/guide.md')
  await waitBody(kea, 'docs/guide.md', 'text')
  await page.keyboard.press('Meta+Shift+v')
  await waitBody(kea, 'docs/guide.md', 'preview')
  await page.mouse.move(1000, 800)
  await set.shot(kea, 'markdown', 'Markdown preview (⇧⌘V): Source · Preview in the header', 'File viewer', { rect: MAIN })

  await clickFile(kea, 'img/pic.png')
  await waitBody(kea, 'img/pic.png', 'image')
  await expect(page.locator('.viewer .viewer-image img')).toBeVisible({ timeout: STEP_MS })
  await page.mouse.move(1000, 800)
  await set.shot(kea, 'image', 'An image: scaled to fit, its size in the header', 'File viewer', { rect: MAIN })

  await clickFile(kea, 'data.bin')
  await waitBody(kea, 'data.bin', 'note')
  await page.mouse.move(1000, 800)
  await set.shot(kea, 'binary', 'A binary file: one line', 'File viewer', { rect: TOP })

  await clickFile(kea, 'bundle.min.js')
  await waitBody(kea, 'bundle.min.js', 'text')
  await waitViewer(kea, 'the highlighting-stopped notice', (v) => v.ui.notices.length > 0, 30_000)
  await page.mouse.move(1000, 800)
  await set.shot(kea, 'large-notice', 'A large file: the notice is one line of --text-3 under the header', 'File viewer', { rect: { ...MAIN, height: 400 } })

  await clickFile(kea, 'huge.log')
  await waitBody(kea, 'huge.log', 'note')
  await page.mouse.move(1000, 800)
  await set.shot(kea, 'too-large', 'A file over the viewer’s limit: one line offering the editor', 'File viewer', { rect: TOP })

  // deleted while open: the last content stays, dimmed, under "Deleted"
  await clickFile(kea, 'docs/guide.md')
  await waitBody(kea, 'docs/guide.md', 'preview').catch(() => waitBody(kea, 'docs/guide.md', 'text'))
  fs.rmSync(path.join(worktree, 'docs/guide.md'))
  await waitViewer(kea, 'deleted', (v) => v.ui.notices.some((n) => /Deleted/.test(n)), GIT_MS)
  await page.mouse.move(1000, 800)
  await set.shot(kea, 'deleted', 'The file was deleted while open: its last content, dimmed, under the notice', 'File viewer', { rect: MAIN })
})
