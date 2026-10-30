// The session parts of the kill, race and resource tests, against the real app (tests/support/app.ts): projects added
// and sessions started, deleted and restored through the window (tests/support/app-sessions.ts). The app is killed at
// an exact point of a creation, a delete or a restore with the test hook's `hold` (tests/support/app-child-hooks.cjs):
// core stops there for good and writes the session's id to a file; the test then SIGKILLs main, core and ptyhost
// (holders run on) and relaunches. tests/integration/core-sessions.test.ts kills core at the same points in-process;
// these prove the same end to end. They run only with `pnpm chaos`.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fixtureGitEnv } from '@kea-tools/repo-factory/src/index.ts'
import { WORKTREE_TRASH as KEA_TRASH } from '@kea/core/src/worktrees/ops.ts'
import { slugFromPrompt } from '@kea/core/src/worktrees/slug.ts'
import { CREATION_STEPS, L } from '@kea/protocol'
import { KeaRun, PROMPT, STEP_MS, until, zooShellCommand, type Kea } from '../support/app.ts'
import { holdersUnharmed } from '../support/app-chaos.ts'
import { addProject, agentTerminal, demoRepo, rowState, selectSession, sessionMenu, sessionRow, startSession, waitLive, waitRow } from '../support/app-sessions.ts'
import { sysKey } from '../support/keys.ts'

const runs: KeaRun[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose()
})
function newRun(): KeaRun {
  const r = KeaRun.create()
  runs.push(r)
  return r
}

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const worktrees = (root: string) =>
  gitIn(root, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
const keaBranches = (root: string) => gitIn(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/kea/').split('\n').filter(Boolean)
const deletedRef = (root: string, id: string) => gitIn(root, 'for-each-ref', '--format=%(refname)', `refs/kea/deleted/${id}`).trim()

/** The next time core passes `point`, it stops there for good; resolves with the file the session's id lands in. */
async function holdAt(run: KeaRun, kea: Kea, point: string): Promise<string> {
  const file = path.join(run.home, `held-${point.replace(':', '-')}`)
  fs.rmSync(file, { force: true })
  await kea.debug('core', 'hold', `${point}|${file}`)
  return file
}

/** The session core stopped for (the hold's file). */
function heldSession(file: string, point: string): Promise<string> {
  return until(`core held at ${point}`, () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') || undefined : undefined))
}

/** Kill the app as a crash does: main, then core and ptyhost (identity-checked); holders run on. */
async function killApp(run: KeaRun, kea: Kea): Promise<void> {
  const procs = await kea.processes()
  await kea.signal('main', 'SIGKILL')
  for (const p of [procs.core, procs.ptyhost]) {
    try {
      if (p) run.signalProcess(p, 'SIGKILL')
    } catch {
      // gone with main already
    }
  }
  await kea.gone()
}

/** A session's branch from its prompt (`kea/<slug>`). */
const branchOf = (prompt: string) => `kea/${slugFromPrompt(prompt)}`

/** The worktree of a session by its branch, if any. */
function worktreeOf(root: string, branch: string): string | undefined {
  let at = ''
  for (const l of gitIn(root, 'worktree', 'list', '--porcelain').split('\n')) {
    if (l.startsWith('worktree ')) at = l.slice('worktree '.length)
    else if (l === `branch refs/heads/${branch}`) return at
  }
  return undefined
}

/** A row's hover button (Retry, Discard, …). */
async function rowButton(kea: Kea, id: string, name: string): Promise<void> {
  const page = await kea.page()
  const row = sessionRow(page, id)
  await row.hover()
  await row.getByRole('button', { name, exact: true }).click({ timeout: STEP_MS })
}

/** Delete a session through its menu and the sheet (the branch kept). */
async function deleteSession(kea: Kea, id: string): Promise<void> {
  const page = await kea.page()
  await sessionMenu(kea, id, 'session.delete')
  const sheet = page.getByRole('alertdialog', { name: 'Delete session' })
  await sheet.waitFor({ timeout: STEP_MS })
  await sheet.getByRole('button', { name: 'Delete', exact: true }).click()
}

/**
 * A detached session's ended Agent tab shows its last screen (rendered from its checkpoint and ring, its holder gone),
 * dimmed, under the detached overlay saying what ended.
 */
async function lastScreen(kea: Kea, id: string, agent: string, marker: string, ended: string): Promise<void> {
  const page = await kea.page()
  await selectSession(kea, id)
  await kea.clickTab(agent)
  await kea.waitScreen(`session ${id}’s last screen`, (s) => s.includes(marker))
  expect(await page.locator('.terminal-frame.ended').count(), 'dimmed').toBe(1)
  const overlay = page.getByRole('status', { name: 'Session ended' })
  await until(`the overlay says: ${ended}`, async () => ((await overlay.textContent().catch(() => '')) ?? '').includes(ended) || undefined)
  expect(await overlay.getByRole('button', { name: 'Resume' }).isVisible()).toBe(true)
}

describe('kill matrix, sessions (app)', () => {
  it('C-KILL-9 · the app killed at each creation step: the relaunch offers Retry and Discard; Retry makes the session live in its worktree, Discard leaves no worktree and no branch', async () => {
    const run = newRun()
    const repo = demoRepo(run)
    let kea = await run.launch()
    await addProject(kea, repo.root)
    for (const [i, step] of CREATION_STEPS.entries()) {
      const file = await holdAt(run, kea, `create:${step}`)
      const prompt = `killed at ${step}`
      const id = await startSession(kea, prompt)
      expect(await heldSession(file, `create:${step}`)).toBe(id)
      const branch = branchOf(prompt)
      await killApp(run, kea)
      kea = await run.launch({ ready: 'window' })
      await waitRow(kea, id, `Retry / Discard offered after a kill at ${step}`, (r) => r.lifecycle === 'create_failed')
      if (i % 2 === 0) {
        await rowButton(kea, id, 'Retry')
        await waitLive(kea, id)
        expect(worktreeOf(repo.root, branch), `${step}: Retry made the worktree`).toBeDefined()
      } else {
        await rowButton(kea, id, 'Discard')
        await until(`${step}: the discarded row gone`, async () => (await rowState(await kea.page(), id)) === null || undefined)
        await until(`${step}: no worktree and no branch left`, () => (worktreeOf(repo.root, branch) === undefined && !keaBranches(repo.root).includes(branch)) || undefined)
      }
    }
    // only the retried sessions' worktrees and branches: nothing orphaned
    const kept = CREATION_STEPS.filter((_, i) => i % 2 === 0).map((s) => branchOf(`killed at ${s}`))
    expect(keaBranches(repo.root).sort()).toEqual(kept.sort())
    expect(worktrees(repo.root).filter((w) => w !== repo.root)).toHaveLength(kept.length)
    await kea.assertUnfocused()
  }, 5 * 60_000 - 1)

  it('C-KILL-10 · the app killed during a worktree removal, after the rename into the trash and before the prune: the relaunch finishes the removal (no worktree entry, the trash emptied, the delete complete)', async () => {
    const run = newRun()
    const repo = demoRepo(run)
    const kea = await run.launch()
    await addProject(kea, repo.root)
    const id = await startSession(kea, 'removed half way')
    await waitLive(kea, id)
    const wt = worktreeOf(repo.root, branchOf('removed half way'))!
    fs.writeFileSync(path.join(wt, 'work.txt'), 'uncommitted\n')
    const file = await holdAt(run, kea, 'delete:prune')
    await deleteSession(kea, id)
    expect(await heldSession(file, 'delete:prune')).toBe(id)
    expect(fs.existsSync(wt), 'renamed into the trash before the hold').toBe(false)
    expect(worktrees(repo.root), 'the worktree entry still listed (not pruned)').toContain(wt)
    await killApp(run, kea)
    const again = await run.launch({ ready: 'window' })
    await until('the delete completed', async () => (await rowState(await again.page(), id)) === null || undefined)
    await until('the worktree entry pruned', () => !worktrees(repo.root).includes(wt) || undefined)
    const trash = path.join(path.dirname(wt), KEA_TRASH)
    await until('the trash emptied', () => !fs.existsSync(trash) || fs.readdirSync(trash).length === 0 || undefined)
    expect(deletedRef(repo.root, id), 'the snapshot ref kept').toBe(`refs/kea/deleted/${id}`)
    expect(fs.existsSync(path.join(run.home, 'sessions', id)), 'the session’s state directory gone').toBe(false)
    await again.assertUnfocused()
  })

  it('C-KILL-15 · the app killed during a delete (before the snapshot ref, after it, during teardown, after the rename): before the ref the session is as it was; after it the delete completes and the worktree is never gone without its ref', async () => {
    // (the restore part has a test of its own, C-KILL-26, from Settings › Disk › Recently deleted)
    const run = newRun()
    const repo = demoRepo(run)
    let kea = await run.launch()
    await addProject(kea, repo.root)
    for (const stage of ['stop', 'snapshot', 'teardown', 'trash']) {
      const id = await startSession(kea, `delete killed at ${stage}`)
      await waitLive(kea, id)
      const wt = worktreeOf(repo.root, branchOf(`delete killed at ${stage}`))!
      fs.writeFileSync(path.join(wt, 'work.txt'), 'uncommitted\n')
      const file = await holdAt(run, kea, `delete:${stage}`)
      await deleteSession(kea, id)
      expect(await heldSession(file, `delete:${stage}`)).toBe(id)
      await killApp(run, kea)
      kea = await run.launch({ ready: 'window' })
      const page = await kea.page()
      if (stage === 'stop' || stage === 'snapshot') {
        // before the ref: the session is as it was, its work in place
        await waitRow(kea, id, `${stage}: listed as it was`, (r) => r.lifecycle === 'live' || r.lifecycle === 'detached')
        expect(fs.readFileSync(path.join(wt, 'work.txt'), 'utf8')).toBe('uncommitted\n')
        expect(deletedRef(repo.root, id), `${stage}: no snapshot ref`).toBe('')
        await deleteSession(kea, id)
        await until(`${stage}: deleted when asked again`, async () => (await rowState(page, id)) === null || undefined)
      } else {
        // after it: the delete completed; the worktree went with its ref there
        await until(`${stage}: the delete completed`, async () => (await rowState(page, id)) === null || undefined)
        expect(deletedRef(repo.root, id), `${stage}: the snapshot ref`).toBe(`refs/kea/deleted/${id}`)
        await until(`${stage}: the worktree gone`, () => (!fs.existsSync(wt) && !worktrees(repo.root).includes(wt)) || undefined)
      }
      expect(deletedRef(repo.root, id), `${stage}: a deleted session always has its ref`).toBe(`refs/kea/deleted/${id}`)
    }

    // every session directory left belongs to a session still listed (none comes back as a stray)
    const page = await kea.page()
    for (const id of fs.readdirSync(path.join(run.home, 'sessions'))) {
      if (id === 'shells') continue
      expect(await rowState(page, id), `state directory ${id} belongs to a listed session`).not.toBeNull()
    }
    await kea.assertUnfocused()
  }, 5 * 60_000 - 1)

  it('C-KILL-26 · the app killed during a Restore from Settings › Disk › Recently deleted (before the worktree is added, and after it before the project’s files are copied): the relaunch rolls the restore back — the session is still under Recently deleted with its snapshot ref, no worktree is left half-made; Restore pressed again brings it back with its uncommitted work', async () => {
    // (the restore part of C-KILL-15, through the window's own way in; core-sessions.test.ts kills core at the same
    // points in-process)
    const run = newRun()
    const repo = demoRepo(run)
    let kea = await run.launch()
    await addProject(kea, repo.root)
    /** Settings › Disk, opened by its command; resolves with the Recently deleted entry of `id`. */
    const deletedEntry = async (id: string) => {
      const page = await kea.page()
      await until('Show Disk Usage in the menu bar', () => kea.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('app.showDisk')?.enabled === true) || undefined)
      await kea.app.evaluate(({ Menu, BrowserWindow }) => Menu.getApplicationMenu()!.getMenuItemById('app.showDisk')!.click(undefined, BrowserWindow.getAllWindows()[0], undefined))
      await page.getByRole('dialog', { name: 'Settings: Disk', exact: true }).waitFor({ timeout: STEP_MS })
      const entry = page.locator(`[data-disk-deleted="${id}"]`)
      await entry.waitFor({ timeout: STEP_MS })
      return entry
    }
    for (const stage of ['add', 'copy']) {
      const prompt = `restore killed at ${stage}`
      const id = await startSession(kea, prompt)
      await waitLive(kea, id)
      const wt = worktreeOf(repo.root, branchOf(prompt))!
      fs.writeFileSync(path.join(wt, 'work.txt'), 'uncommitted\n')
      await deleteSession(kea, id)
      await until(`${stage}: deleted`, async () => (await rowState(await kea.page(), id)) === null || undefined)
      await until(`${stage}: the worktree gone`, () => (!fs.existsSync(wt) && !worktrees(repo.root).includes(wt)) || undefined)
      expect(deletedRef(repo.root, id)).toBe(`refs/kea/deleted/${id}`)
      const branchesLeft = keaBranches(repo.root)

      // Restore, from the Disk view; core stops inside it and the app is killed there
      const file = await holdAt(run, kea, `restore:${stage}`)
      await (await deletedEntry(id)).getByRole('button', { name: /^Restore / }).click()
      expect(await heldSession(file, `restore:${stage}`)).toBe(id)
      // (after `add` the worktree is there already: the kill leaves it half-restored on disk)
      if (stage === 'copy') expect(fs.existsSync(wt), 'the worktree was added before the kill').toBe(true)
      await killApp(run, kea)
      kea = await run.launch({ ready: 'window' })

      // rolled back: not listed, nothing half-made, still restorable
      const entry = await deletedEntry(id)
      expect(await rowState(await kea.page(), id), `${stage}: not listed`).toBeNull()
      await until(`${stage}: no worktree left behind`, () => (!fs.existsSync(wt) && !worktrees(repo.root).includes(wt)) || undefined)
      expect(deletedRef(repo.root, id), `${stage}: the snapshot ref kept`).toBe(`refs/kea/deleted/${id}`)
      expect(keaBranches(repo.root), `${stage}: the branches as the delete left them (a branch the restore re-created is gone again)`).toEqual(branchesLeft)

      // and Restore pressed again brings it back, work and all
      await entry.getByRole('button', { name: /^Restore / }).click()
      await waitRow(kea, id, `${stage}: restored`, (r) => r.lifecycle === 'detached')
      expect(fs.readFileSync(path.join(wt, 'work.txt'), 'utf8'), `${stage}: its uncommitted work`).toBe('uncommitted\n')
      expect(deletedRef(repo.root, id), `${stage}: the ref released`).toBe('')
      await (await kea.page()).keyboard.press('Escape')
    }
    await kea.assertUnfocused()
  })

  it('C-KILL-17 · SIGKILL one holder of a session (the session part of C-KILL-6): that session goes detached and shows its last screen under the detached overlay; the other sessions and their holders are untouched', async () => {
    const run = newRun()
    const repo = demoRepo(run)
    const kea = await run.launch()
    await addProject(kea, repo.root)
    const ids: string[] = []
    for (const p of ['kept one', 'killed one', 'kept two']) ids.push(await startSession(kea, p, { background: true, open: ids.length === 0 }))
    for (const id of ids) await waitLive(kea, id)
    const agents = new Map<string, string>()
    for (const [i, id] of ids.entries()) {
      agents.set(id, await agentTerminal(kea, id))
      await kea.enter(`echo "C-KILL-17 session ${i}"`)
      await kea.waitScreen(`session ${i}’s marker`, (s) => s.includes(`C-KILL-17 session ${i}\n`))
    }
    const victim = ids[1]!
    const others = run.holders().filter((h) => run.holderAlive(h) && ids.includes(h.sessionId) && h.ptyId !== agents.get(victim))
    expect(others.map((h) => h.ptyId).sort()).toEqual([agents.get(ids[0]!), agents.get(ids[2]!)].sort())
    run.killHolderTree(run.holder(agents.get(victim)!))
    await waitRow(kea, victim, 'detached after its holder was killed', (r) => r.lifecycle === 'detached')
    for (const id of [ids[0]!, ids[2]!]) expect((await rowState(await kea.page(), id))?.lifecycle, 'the other sessions stay live').toBe('live')
    holdersUnharmed(run, others)
    // the lost session: its last screen (checkpoint and ring), dimmed, under the overlay
    await lastScreen(kea, victim, agents.get(victim)!, 'C-KILL-17 session 1\n', 'Agent lost with its terminal')
    // the others still answer
    await agentTerminal(kea, ids[2]!)
    await kea.echo('ckill17')
    await kea.assertUnfocused()
  })

  it('C-KILL-20 · everything killed, holders included, with sessions (the session part of C-KILL-11): every session detached with end reason lost; each shows its cold-restored last screen; Resume starts its agent through the resume path', async () => {
    const run = newRun()
    const repo = demoRepo(run)
    const kea = await run.launch()
    await addProject(kea, repo.root)
    const ids: string[] = []
    for (const p of ['reboot one', 'reboot two']) ids.push(await startSession(kea, p, { background: true, open: ids.length === 0 }))
    for (const id of ids) await waitLive(kea, id)
    const agents = new Map<string, string>()
    for (const [i, id] of ids.entries()) {
      agents.set(id, await agentTerminal(kea, id))
      await kea.enter(`echo "C-KILL-20 session $((${i}+40))"`)
      await kea.waitScreen(`session ${i}’s marker`, (s) => s.includes(`C-KILL-20 session ${i + 40}\n`))
    }
    const holders = run.holders().filter((h) => run.holderAlive(h))
    await killApp(run, kea)
    for (const h of holders) run.killHolderTree(h)
    await until('every holder gone', () => holders.every((h) => !run.holderAlive(h)) || undefined)

    const again = await run.launch({ ready: 'window' })
    for (const id of ids) await waitRow(again, id, 'detached after everything was killed', (r) => r.lifecycle === 'detached')
    for (const [i, id] of ids.entries()) await lastScreen(again, id, agents.get(id)!, `C-KILL-20 session ${i + 40}\n`, 'Agent lost with its terminal')
    // Resume, from the overlay: the agent starts again through the resume path, in the session's one Agent tab
    const page = await again.page()
    const resumed = ids[1]!
    await page.getByRole('status', { name: 'Session ended' }).getByRole('button', { name: 'Resume' }).click()
    await waitRow(again, resumed, 'live after Resume', (r) => r.lifecycle === 'live')
    await until('the agent launched through the resume path', () => again.logLines('core').some((l) => l.msg === 'agent launched' && l.sessionId === resumed && l.how === 'resume') || undefined)
    const next = await agentTerminal(again, resumed)
    expect(next, 'a new agent PTY').not.toBe(agents.get(resumed))
    await again.echo('ckill20')
    expect((await rowState(page, ids[0]!))?.lifecycle, 'the other stays detached').toBe('detached')
    await again.assertUnfocused()
  })
})

describe('races and resources, sessions (app)', () => {
  /** C-RES-3: the open-file limit, and how many sessions must start under it. */
  const MAX_FILES = 256
  const SESSIONS = 30

  it('C-RES-3 · open files limited to 256 (ulimit -n): 30 sessions start; more are started until one cannot, which says why, with no banner; no crash', async () => {
    const run = newRun()
    const repo = demoRepo(run)
    const kea = await run.launch({ maxFiles: MAX_FILES })
    const page = await kea.page()
    await addProject(kea, repo.root)
    const procs = await kea.processes()
    const settle = async (id: string) => (await waitRow(kea, id, 'creation settled', (r) => r.lifecycle === 'live' || r.lifecycle === 'create_failed', 2 * STEP_MS)).lifecycle
    const ids: string[] = []
    for (let i = 0; i < SESSIONS; i++) ids.push(await startSession(kea, `limited ${i + 1}`, { background: true, open: i === 0 }))
    for (const id of ids) expect(await settle(id), `session ${id}: starts under the limit`).toBe('live')
    // then one at a time until the limit bites: every session holds at least one of ptyhost's descriptors (its holder's
    // socket), so fewer than MAX_FILES sessions in all reach it
    let failed: string | null = null
    while (!failed && ids.length < MAX_FILES) {
      const id = await startSession(kea, `limited ${ids.length + 1}`, { background: true })
      ids.push(id)
      if ((await settle(id)) === 'create_failed') failed = id
    }
    expect(failed, `a session cannot start within ${MAX_FILES} sessions`).not.toBeNull()
    await selectSession(kea, failed!)
    const main = page.getByRole('main', { name: 'Session' })
    // the session's own creation error names the limit and what frees it, not the banner strip
    const failure = main.getByRole('status').filter({ has: page.getByRole('button', { name: 'Retry' }) })
    await until(`session ${failed}: its creation error said`, async () => /EMFILE|too many open files/i.test((await failure.textContent()) ?? '') || undefined)
    expect(await failure.textContent(), 'a resource limit is no missing helper: no build or reinstall advice').not.toMatch(/helper:build|Reinstall Kea/)
    // no banner: not "Terminals are unavailable", not "Sessions won't survive a crash or an update of Kea"
    const strip = page.getByRole('region', { name: 'Banners' })
    const banners = async () => ((await strip.count()) > 0 ? ((await strip.textContent()) ?? '') : '')
    expect(await banners(), 'no banner for a resource limit').toBe('')
    // no crash: the same processes as before the sessions
    const now = await kea.processes()
    for (const p of ['main', 'core', 'ptyhost', 'renderer'] as const) expect(now[p]?.pid, `${p} not restarted (session ${ids.length} could not start)`).toBe(procs[p]?.pid)
    // and a live one still works at the limit
    await agentTerminal(kea, ids[SESSIONS - 1]!)
    await kea.echo('cres3')
    // the limit held all the way down: the session's shell runs under it too
    await kea.enter('echo "open files: $(ulimit -n)"')
    await kea.waitScreen('the shell’s limit', (sc) => sc.includes(`open files: ${MAX_FILES}\n`))
    // still no banner, long after the failure reached core: terminals stayed available
    expect(await banners(), 'no banner after the failed launch').toBe('')
    expect(await main.textContent(), 'no build advice anywhere in the main column').not.toMatch(/helper:build/)
    await kea.assertUnfocused()
  }, 4 * 60_000)

  /** C-RACE-3: switches per second, and for how long. */
  const RATE = 20
  const RACE_MS = 10_000

  it('C-RACE-3 · rapid session switching (20 a second for 10 s) while two sessions flood: no crash, no leaked terminal or WebGL context, the final view correct', async () => {
    const run = newRun()
    const repo = demoRepo(run)
    const kea = await run.launch()
    const page = await kea.page()
    await addProject(kea, repo.root)
    const prompts = ['race one', 'race two', 'race three', 'race four', 'race five']
    const ids: string[] = []
    for (const p of prompts) ids.push(await startSession(kea, p, { background: true, open: ids.length === 0 }))
    for (const id of ids) await waitLive(kea, id)
    const order = await page.evaluate(() => [...document.querySelectorAll('[role=treeitem][data-session-id]')].map((e) => e.getAttribute('data-session-id') ?? ''))
    // the sessions on ⌘1 and ⌘2 flood without end; the others print a marker
    const agents = new Map<string, string>()
    for (const [k, id] of order.entries()) {
      agents.set(id, await agentTerminal(kea, id))
      if (k < 2) await kea.enter(zooShellCommand('flood', ['--bytes', '1000G']))
      else {
        await kea.enter(`echo "C-RACE-3 row ${k + 1}"`)
        await kea.waitScreen(`row ${k + 1}’s marker`, (s) => s.includes(`C-RACE-3 row ${k + 1}\n`))
      }
    }
    const procs = await kea.processes()
    const holders = run.holders().filter((h) => run.holderAlive(h))

    // as fast as the keyboard goes, never slower than RATE a second, for RACE_MS; the last switch lands on row 5
    const start = Date.now()
    let switches = 0
    while (Date.now() - start < RACE_MS || switches % order.length !== 0) {
      await page.keyboard.press(sysKey(`Meta+${(switches % order.length) + 1}`))
      switches++
    }
    const elapsed = Date.now() - start
    expect(switches / (elapsed / 1000), `switches a second (${switches} in ${elapsed} ms)`).toBeGreaterThanOrEqual(RATE)

    // the final view: row 5 in the pane, its own Agent terminal on screen with its own text
    const last = order[order.length - 1]!
    await waitRow(kea, last, 'row 5 selected', (r) => r.selected)
    await until('row 5’s Agent terminal on screen', async () => (await kea.shown()) === agents.get(last) || undefined)
    await kea.waitScreen('row 5’s own text', (s) => s.includes(`C-RACE-3 row ${order.length}\n`) && s.includes(PROMPT))
    // no crash: the same processes; no leak: the active session's one tab plus the warm ones, WebGL contexts
    // within their cap
    const now = await kea.processes()
    for (const p of ['main', 'core', 'ptyhost', 'renderer'] as const) expect(now[p]?.pid, `${p} not restarted`).toBe(procs[p]?.pid)
    await until('the views settle at the policy’s count', async () => (await kea.views()).length <= 1 + L.warmTerminals || undefined)
    const res = await page.evaluate(() => (window as unknown as { __keaPerf: { resources(): Record<string, number> } }).__keaPerf.resources())
    expect(res['renderer.terminals'], 'xterm instances').toBeLessThanOrEqual(1 + L.warmTerminals)
    expect(res['renderer.webglContexts'], 'WebGL contexts').toBeLessThanOrEqual(L.webglContextsMax)
    holdersUnharmed(run, holders)
    await kea.assertUnfocused()
  })
})
