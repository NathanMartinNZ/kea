// A project's folder moved while Kea runs, against the real app with tools/fake-agent as its `claude`: a session of a
// demo repository on screen, the repository renamed under it. Nothing watches a project's root; the move is found when
// a Kea window next gets the keyboard, the same moment every visible session is read again, and Locate… with
// `git worktree repair` brings the project and its session back.
//
// The folder picker is the harness's (`__keaTest.queueFolder`): no native dialog opens. The window's focus is the
// harness's stand-in (`Kea.pretendFocused`): a test window never takes the keyboard.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KeaRun, STEP_MS, until, type Kea } from '../support/app.ts'
import { holdersUnharmed } from '../support/app-chaos.ts'
import { GIT_MS, panelModes, treeRows, waitTree } from '../support/app-files.ts'
import { addProject, demoRepo, projectRow, startSession, waitLive, waitRow } from '../support/app-sessions.ts'
import { gitIn, sessionWorktree } from '../support/app-viewer.ts'

const runs: KeaRun[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose()
})

/** The project's row as the sidebar shows it: flagged missing, and the actions a missing project has. */
async function projectSeen(kea: Kea, name: string): Promise<{ missing: boolean; actions: string[] }> {
  const row = projectRow(await kea.page(), name)
  return row.evaluate((e) => ({ missing: e.classList.contains('missing'), actions: [...e.querySelectorAll('.sb-actions.always button')].map((b) => b.textContent?.trim() ?? '') }))
}

const changesLabel = async (kea: Kea): Promise<string | undefined> => (await panelModes(kea)).map((m) => m.label).find((l) => l.startsWith('Changes'))

describe('a project’s folder moved while Kea runs', () => {
  it('C-RES-6 · the repository of a session on screen renamed while Kea runs: nothing is flagged until a window gets the keyboard, then the project is missing with Locate… and Remove; the session, its agent and its holder are untouched; Locate… at the new place runs git worktree repair, and the session’s tree and changes follow its worktree again', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    const page = await kea.page()
    const repo = demoRepo(run)
    await addProject(kea, repo.root)
    const id = await startSession(kea, 'work while the folder moves')
    await waitLive(kea, id)
    const worktree = sessionWorktree(repo.root)
    await waitTree(kea, 'the session’s root is listed', (rows) => rows.some((r) => r.path === 'README.md'))
    fs.writeFileSync(path.join(worktree, 'before.txt'), 'made before the move\n')
    await until('the change made before the move is counted', async () => (await changesLabel(kea)) === 'Changes 1' || undefined, GIT_MS)
    const holders = run.holders()
    expect(holders.length, 'the session’s terminals have holders').toBeGreaterThan(0)

    // the repository is renamed; the session's worktree (under KEA_HOME) stays where it is and loses its repository
    const moved = path.join(path.dirname(repo.root), 'demo-moved')
    fs.renameSync(repo.root, moved)
    expect(() => gitIn(worktree, 'status', '--porcelain'), 'the worktree lost its repository').toThrow()
    // nothing watches the root: the row is as it was
    expect(await projectSeen(kea, 'demo')).toEqual({ missing: false, actions: [] })

    // back to Kea: the window gets the keyboard, and core checks every project's root
    await kea.pretendFocused(true)
    await until('the project flagged missing', async () => (await projectSeen(kea, 'demo')).missing || undefined)
    expect(await projectSeen(kea, 'demo')).toEqual({ missing: true, actions: ['Locate…', 'Remove'] })
    // no automatic action: the session is there, live, with its agent and its holder
    expect((await waitRow(kea, id, 'still live', (r) => r.lifecycle === 'live')).lifecycle).toBe('live')
    holdersUnharmed(run, holders)
    expect(kea.logLines('core').filter((l) => l.level === 'error'), 'core logged no error').toEqual([])

    // Locate… at the new place (the picker answers with it): the project is back, at its new root
    await kea.app.evaluate((_e, p) => (globalThis as unknown as { __keaTest: { queueFolder(p: string): void } }).__keaTest.queueFolder(p), moved)
    await projectRow(page, 'demo').getByRole('button', { name: 'Locate…' }).click({ timeout: STEP_MS })
    await until('the project no longer missing', async () => !(await projectSeen(kea, 'demo')).missing || undefined)
    const located = kea.logLines('core').filter((l) => l.msg === 'project located')
    expect(located.map((l) => [l.to, l.repaired])).toEqual([[fs.realpathSync(moved), true]])
    // git worktree repair ran: the worktree has its repository again, on the session's branch, with its change
    expect(gitIn(worktree, 'status', '--porcelain').trim()).toBe('?? before.txt')

    // and the panel follows the worktree again, with no relaunch: a new file is listed and counted
    fs.writeFileSync(path.join(worktree, 'after.txt'), 'made after Locate\n')
    await waitTree(kea, 'a file made after Locate is listed', (rows) => rows.some((r) => r.path === 'after.txt'), GIT_MS)
    await until('both changes counted', async () => (await changesLabel(kea)) === 'Changes 2' || undefined, GIT_MS)
    expect((await treeRows(kea)).filter((r) => r.git !== null).map((r) => `${r.path} ${r.git}`)).toEqual(['after.txt U', 'before.txt U'])

    holdersUnharmed(run, holders)
    await kea.assertUnfocused()
  })
})
