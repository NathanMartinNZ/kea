// The worktree journeys: setup and teardown scripts as a person meets them in the window. Kea launched through
// tests/e2e/fixtures.ts (unfocused, temp KEA_HOME, hermetic git); the scripts are committed in a demo repository and
// read what to do from a file in the run's home, so each step is the test's to choose: wait on a FIFO, fail, or
// succeed.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { runProcess } from '@kea/kit'
import { fixtureGitEnv } from '@kea-tools/repo-factory/src/index.ts'
import { STEP_MS, until, writeFifo, type KeaRun } from '../support/app.ts'
import { addProject, demoRepo, paneSession, rowState, selectSession, sessionMenu, sessionRow, startSession, tabKinds, tabOf, waitRow } from '../support/app-sessions.ts'
import { expect, test } from './fixtures.ts'

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()

/**
 * A demo repository with `.kea/<name>.sh` committed: it prints a line naming the session and its reason, then does what
 * `<home>/<name>-mode` says — `wait` (until a line arrives on `<home>/<name>.fifo`), `fail` (exit 3), else exit 0.
 */
async function repoWithScript(run: KeaRun, name: 'setup' | 'teardown'): Promise<{ root: string; mode(m: 'wait' | 'fail' | 'ok'): void; fifo: string }> {
  const repo = demoRepo(run)
  const modeFile = path.join(run.home, `${name}-mode`)
  const fifo = path.join(run.home, `${name}.fifo`)
  expect((await runProcess('/usr/bin/mkfifo', [fifo], { pool: 'other' })).code).toBe(0) // os-ok: in /usr/bin on both systems
  const reason = name === 'setup' ? '$KEA_SETUP_REASON' : '$KEA_TEARDOWN_REASON'
  const script = `#!/bin/sh
echo "${name} of $KEA_SESSION_SLUG (${reason})"
case "$(cat '${modeFile}')" in
  wait) read line < '${fifo}' ;;
  fail) echo "${name} failed on purpose"; exit 3 ;;
esac
echo "${name} done"
`
  fs.mkdirSync(path.join(repo.root, '.kea'), { recursive: true })
  fs.writeFileSync(path.join(repo.root, '.kea', `${name}.sh`), script, { mode: 0o755 })
  gitIn(repo.root, 'add', '.kea')
  gitIn(repo.root, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', `${name} script`)
  return { root: repo.root, fifo, mode: (m) => fs.writeFileSync(modeFile, m) }
}

/** A session's log (`<KEA_HOME>/sessions/<id>/creation.log`), and how many setup runs it records. */
const logOf = (run: KeaRun, id: string) => fs.readFileSync(path.join(run.home, 'sessions', id, 'creation.log'), 'utf8')
const runsIn = (log: string) => (log.match(/ setup \(create\): /g) ?? []).length

test('E-WT-1 · a project with .kea/setup.sh: the Setup tab runs first and the agent starts after exit 0; Skip starts the agent while setup runs on; a failure offers Retry and Start agent anyway, and each works', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const r = await repoWithScript(run, 'setup')
  await addProject(kea, r.root)
  const strip = (text: string) => page.getByRole('status').filter({ hasText: text })

  // 1. setup runs first, in its tab; the agent waits for its exit 0, then takes the active tab
  r.mode('wait')
  const first = await startSession(kea, 'setup first', { open: false })
  const setup = await tabOf(kea, 'script')
  await kea.waitScreen('setup’s first line, with its reason', (s) => /setup of [a-z0-9-]+ \(create\)/.test(s))
  await expect(strip('Setup is running'), 'the running strip, with Skip').toBeVisible()
  expect(await tabKinds(page), 'no Agent tab while setup runs').toEqual(['script'])
  expect((await rowState(page, first))?.lifecycle).toBe('creating')
  await writeFifo(r.fifo, 'go\n')
  await waitRow(kea, first, 'live after setup’s exit 0', (x) => x.lifecycle === 'live')
  const agent = await tabOf(kea, 'agent')
  await until('the Agent tab active', async () => (await kea.shown()) === agent || undefined)
  expect(await tabKinds(page), 'Agent first, Setup after').toEqual(['agent', 'script'])
  await kea.clickTab(setup)
  await kea.waitScreen('setup’s last line', (s) => s.includes('setup done'))

  // 2. Skip: the agent starts now; setup keeps running in its tab until it ends
  const second = await startSession(kea, 'skip the setup')
  await expect(strip('Setup is running')).toBeVisible({ timeout: STEP_MS })
  const setup2 = await tabOf(kea, 'script')
  await strip('Setup is running').getByRole('button', { name: 'Skip' }).click()
  await waitRow(kea, second, 'live after Skip', (x) => x.lifecycle === 'live')
  await tabOf(kea, 'agent')
  expect(run.holderAlive(run.holder(setup2)), 'setup still running after Skip').toBe(true)
  await writeFifo(r.fifo, 'go\n')
  await until('the skipped setup to finish', () => run.holder(setup2).exited || undefined)

  // 3. failure: Retry, which succeeds this time
  r.mode('fail')
  const third = await startSession(kea, 'retry the setup')
  const failedStrip = strip('Setup failed (exit 3)')
  await expect(failedStrip, 'the failed strip').toBeVisible({ timeout: STEP_MS })
  await expect(failedStrip.getByRole('button', { name: 'Start agent anyway' })).toBeVisible()
  await expect(failedStrip.getByRole('button', { name: 'View log' })).toBeVisible()
  expect((await rowState(page, third))?.lifecycle, 'the agent waits').toBe('creating')
  r.mode('ok')
  const failedRun = await tabOf(kea, 'script')
  await failedStrip.getByRole('button', { name: 'Retry' }).click()
  await waitRow(kea, third, 'live after a retried setup succeeds', (x) => x.lifecycle === 'live')
  await expect(failedStrip).toHaveCount(0)
  // Retry ran setup again, in a run of its own (Start agent anyway would not): a new Setup tab, and the session's log
  // has the failed run, then the retried one, which finished
  await until('the retried setup’s own tab', async () => ((await tabOf(kea, 'script')) !== failedRun ? true : undefined))
  await until('the retried run in the log, after the failed one', () => /setup failed \(exit 3\)[\s\S]*setup \(create\)[\s\S]*setup done[\s\S]*setup finished/.test(logOf(run, third)) || undefined)
  expect(runsIn(logOf(run, third)), 'two setup runs: the failed one and the retry').toBe(2)
  // its tab shows its last screen once its holder has gone (from checkpoint and ring), not a blank terminal
  const retried = await tabOf(kea, 'script')
  await until('the retried setup’s holder gone', () => {
    const h = run.holders().find((x) => x.ptyId === retried)
    return !h || !run.holderAlive(h) || undefined
  })
  await kea.clickTab(retried)
  await kea.waitScreen('the retried setup’s last screen', (s) => s.includes('setup done'))

  // 4. failure: Start agent anyway
  r.mode('fail')
  const fourth = await startSession(kea, 'start anyway')
  await expect(failedStrip).toBeVisible({ timeout: STEP_MS })
  await failedStrip.getByRole('button', { name: 'View log' }).click()
  const log = page.getByRole('dialog', { name: 'Session log' })
  await expect(log, 'the log names the failure').toContainText('setup failed on purpose', { timeout: STEP_MS })
  await page.keyboard.press('Escape')
  await failedStrip.getByRole('button', { name: 'Start agent anyway' }).click()
  await waitRow(kea, fourth, 'live after Start agent anyway', (x) => x.lifecycle === 'live')
  await tabOf(kea, 'agent')
  // the person chose to go on: the strip goes; the Setup tab stays, with the failed run's output
  await expect(failedStrip).toHaveCount(0)
  expect(await tabKinds(page), 'the Setup tab stays beside the agent').toEqual(['agent', 'script'])
  await kea.clickTab(await tabOf(kea, 'script'))
  await kea.waitScreen('the failed setup’s output', (s) => s.includes('setup failed on purpose'))
  // Start agent anyway did not run setup again (Retry would have): one run in the log, the failed one
  expect(runsIn(logOf(run, fourth)), 'one setup run').toBe(1)
  expect(logOf(run, fourth), 'no run finished').not.toMatch(/setup finished/)
  await kea.assertUnfocused()
})

test('E-WT-3 · a failing teardown: archive completes anyway; the row says "teardown failed" with Retry teardown and View log; Retry with the script fixed clears it', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const r = await repoWithScript(run, 'teardown')
  await addProject(kea, r.root)
  r.mode('fail')
  const id = await startSession(kea, 'tear me down', { open: false })
  await waitRow(kea, id, 'live', (x) => x.lifecycle === 'live')
  const title = (await rowState(page, id))!.title
  await sessionRow(page, id).hover()
  await page.getByRole('button', { name: `Archive ${title}` }).click()
  // archive is not blocked: the session is archived, and says its teardown failed
  const group = page.getByRole('treeitem', { name: 'Archived (1)' })
  await expect(group).toBeVisible({ timeout: STEP_MS })
  await group.click()
  await waitRow(kea, id, 'archived', (x) => x.lifecycle === 'archived')
  const row = sessionRow(page, id)
  await expect(row).toContainText('teardown failed', { timeout: STEP_MS })
  await row.hover()
  await expect(row.getByRole('button', { name: 'Retry teardown' })).toBeVisible()
  await row.getByRole('button', { name: 'View log' }).click()
  const log = page.getByRole('dialog', { name: 'Session log' })
  await expect(log).toContainText('teardown failed on purpose', { timeout: STEP_MS })
  await expect(log).toContainText('(archive)')
  await page.keyboard.press('Escape')
  // the session pane says so too
  await selectSession(kea, id)
  expect(await paneSession(page)).toBe(id)
  const strip = page.getByRole('status').filter({ hasText: 'Teardown failed.' })
  await expect(strip).toBeVisible()
  // fixed: Retry teardown clears it
  r.mode('ok')
  await row.hover()
  await row.getByRole('button', { name: 'Retry teardown' }).click()
  await expect(row).not.toContainText('teardown failed', { timeout: STEP_MS })
  await expect(strip).toHaveCount(0)
  expect((await rowState(page, id))?.lifecycle, 'still archived').toBe('archived')
  await kea.assertUnfocused()
})

test('E-WT-4 · a failing teardown on delete: the delete completes anyway (no row, no worktree); a toast names the session with View log, which opens the log with the teardown’s output and its reason', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const r = await repoWithScript(run, 'teardown')
  await addProject(kea, r.root)
  r.mode('fail')
  const id = await startSession(kea, 'tear me down on delete', { open: false })
  await waitRow(kea, id, 'live', (x) => x.lifecycle === 'live')
  const title = (await rowState(page, id))!.title
  const cwd = gitIn(r.root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length)).find((w) => w !== r.root)!
  await sessionMenu(kea, id, 'session.delete')
  const sheet = page.getByRole('alertdialog', { name: 'Delete session' })
  await expect(sheet, 'the sheet says the teardown runs first').toContainText("The project's teardown command runs first.", { timeout: STEP_MS })
  await sheet.getByRole('button', { name: 'Delete', exact: true }).click()
  // the delete is not blocked: no row, no worktree
  await until('the row gone', async () => (await rowState(page, id)) === null || undefined)
  await until('the worktree gone', () => !fs.existsSync(cwd) || undefined)
  // a toast names the session, with View log
  const toast = page.getByRole('alert').filter({ hasText: `The teardown of ${title} failed.` })
  await expect(toast).toBeVisible({ timeout: STEP_MS })
  await toast.getByRole('button', { name: 'View log' }).click()
  await expect(toast).toHaveCount(0)
  const log = page.getByRole('dialog', { name: 'Session log' })
  await expect(log).toContainText('teardown failed on purpose', { timeout: STEP_MS })
  await expect(log).toContainText('(delete)')
  await page.keyboard.press('Escape')
  await expect(log).toHaveCount(0)
  await kea.assertUnfocused()
})
