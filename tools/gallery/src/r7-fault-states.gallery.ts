// Review set R-7: states the other sets do not reach, each made with a fault a test can set: a project whose folder is
// gone, the dev server stopping, the creation view, a session whose worktree is gone and an archived one, and the
// first-quit sheet over an open composer (the one screen where two buttons could each be the window's only filled
// accent button). Taken only with `pnpm gallery --review` (or `--only R-7`).
//
// Not here: the dev server's "Starting". It lasts while the server's terminal is started, less than a store tick on
// this machine, and nothing holds core there; tests/e2e/server.spec.ts reads its label and state as it passes.

import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '../../../tests/e2e/fixtures.ts'
import { STEP_MS, until } from '../../../tests/support/app.ts'
import { pressQuit, quitSheet } from '../../../tests/support/app-menubar.ts'
import { commitFiles, waitServer } from '../../../tests/support/app-server.ts'
import { addProject, projectRow, promptBox, rowState, selectSession, sessionMenu, sessionRow, startSession, waitRow } from '../../../tests/support/app-sessions.ts'
import { tinyRepo } from '../../repo-factory/src/index.ts'
import { cwdOf, demoProject, openKea, REVIEW, session } from './scene.ts'
import { GallerySet } from './shots.ts'

const MAIN = { x: 504, y: 0, width: 936, height: 900 }
const TOP = { x: 504, y: 0, width: 936, height: 360 }
const HEADER = { x: 504, y: 0, width: 936, height: 96 }

/**
 * A dev server that takes no notice of the signals a Stop begins with: the control says "Stopping…" until Stop ends in
 * SIGKILL. It makes the file `deaf` beside itself once it is deaf, so a Stop is not pressed while its shell
 * could still be interrupted.
 */
const DEAF_SERVER = '#!/bin/sh\ntrap "" INT TERM HUP\necho "listening, and deaf to signals"\n: > "$(dirname "$0")/deaf"\nexec /bin/sleep 600\n'

test('R-7 · states made with a fault', async ({ run, launch }) => {
  test.skip(!REVIEW, 'a review set: pnpm gallery --review')
  test.setTimeout(240_000)
  const set = new GallerySet('R-7', 'States made with a fault')
  let kea = await openKea(run, launch)
  let page = await kea.page()
  const root = tinyRepo({ name: 'atlas-web', parent: run.home }).root
  commitFiles(root, { 'start.sh': DEAF_SERVER }, { executable: true })
  await addProject(kea, root, 'atlas-web')

  // ── the dev server, stopping ──────────
  const fix = await session(kea, 'r7-fix', 'Fix auth redirect')
  await selectSession(kea, fix)
  await waitServer(kea, 'stopped')
  await page.keyboard.press('Meta+r')
  await waitServer(kea, 'running')
  const worktree = await cwdOf(kea, fix)
  await until('the server deaf to signals', () => fs.existsSync(path.join(worktree, 'deaf')) || undefined)
  await page.keyboard.press('Meta+r')
  await waitServer(kea, 'stopping')
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'server-stopping', 'Dev server stopping: "Stopping…" in the header where Stop was, a quiet button, no dot; a click is the second click (SIGKILL)', 'Dev server control', { rect: HEADER })
  await waitServer(kea, 'stopped', 30_000).catch(() => waitServer(kea, 'crashed', STEP_MS).catch(() => undefined))

  // ── the creation view: a creation stopped at "copy" (the hold a chaos test uses) ──
  const held = path.join(run.home, 'held-create-copy')
  await kea.debug('core', 'hold', `create:copy|${held}`)
  const making = await startSession(kea, 'Migrate the billing tables')
  await until('core held in the creation', () => (fs.existsSync(held) ? fs.readFileSync(held, 'utf8') || undefined : undefined))
  await waitRow(kea, making, 'creating', (r) => r.lifecycle === 'creating')
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'creating', 'A session being created: its row is listed at once with the creating glyph; the main pane shows the steps, the one running marked', 'Terminal', { rect: MAIN })
  await set.shot(kea, 'creating-row', 'Its row in the sidebar', 'Sidebar', { part: sessionRow(page, making), pad: 8 })

  // ── with Kea closed: a session's worktree is removed, an archived session is left, and a project's folder is moved ──
  const gone = worktree
  const other = await demoProject(kea, 'ledger-api')
  await expect(promptBox(page)).toBeFocused({ timeout: STEP_MS })
  await page.keyboard.press('Escape')
  await selectSession(kea, fix)
  await kea.close()
  // (the held creation ends with core: the relaunch finds it unfinished and offers Retry · Discard)
  fs.rmSync(gone, { recursive: true, force: true })
  fs.renameSync(other, `${other}-moved`)
  kea = await openKea(run, launch, { ready: 'window' })
  page = await kea.page()

  await waitRow(kea, fix, 'listed again', () => true)
  await selectSession(kea, fix)
  const missing = page.getByRole('status').filter({ hasText: 'Worktree missing.' })
  await expect(missing).toBeVisible({ timeout: STEP_MS })
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'worktree-missing', 'Worktree missing: a strip under the header, "Worktree missing." with Recreate from branch and Delete session (--danger text); no detached overlay under it', 'Terminal', { rect: TOP })

  await set.shot(kea, 'project-missing', 'A project whose folder is gone: dimmed in the sidebar with Locate… and Remove; its sessions untouched', 'Sidebar', { part: projectRow(page, 'ledger-api'), pad: 10 })
  await projectRow(page, 'ledger-api').hover()
  await set.shot(kea, 'project-missing-hover', 'The same row under the pointer', 'Sidebar', { part: projectRow(page, 'ledger-api'), pad: 10 })
  await set.shot(kea, 'create-failed', 'The creation the quit cut short: its row says so, with Retry and Discard', 'Sidebar', { part: sessionRow(page, making), pad: 8 })

  // ── an archived session, shown ──
  const old = await session(kea, 'r7-old', 'Remove the old cron', undefined, { open: true })
  await sessionMenu(kea, old, 'session.archive')
  const ask = page.getByRole('alertdialog', { name: 'Archive session' })
  await until('archived, or asked', async () => ((await rowState(page, old))?.lifecycle ?? 'archived') === 'archived' || (await ask.isVisible()) || undefined)
  if (await ask.isVisible()) await ask.getByRole('button', { name: 'Archive', exact: true }).click()
  const group = page.getByRole('treeitem', { name: /^Archived \(\d+\)$/ })
  await expect(group).toBeVisible({ timeout: STEP_MS })
  await group.click()
  await waitRow(kea, old, 'archived, listed', (r) => r.lifecycle === 'archived')
  await selectSession(kea, old)
  await expect(page.getByRole('status').filter({ hasText: 'Archived. Its worktree and branch are kept.' })).toBeVisible({ timeout: STEP_MS })
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'archived', 'An archived session shown: a strip under the header, "Archived. Its worktree and branch are kept." with Unarchive; the Archived group open in the sidebar', 'Terminal')

  // ── the first-quit sheet over an open composer ──
  await page.keyboard.press('Meta+n')
  await expect(promptBox(page)).toBeFocused({ timeout: STEP_MS })
  await page.keyboard.insertText('Add rate limiting to the public API')
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled({ timeout: STEP_MS })
  await pressQuit(kea)
  await expect(quitSheet(page)).toBeVisible({ timeout: STEP_MS })
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'first-quit-over-composer', 'The first-quit sheet over an open composer: one filled accent button on screen is the rule; here the composer’s Start and the sheet’s Keep in Menu Bar are both on screen', 'Floating layers', { rect: MAIN })
  await page.keyboard.press('Escape')
  await expect(quitSheet(page)).toHaveCount(0)
})
