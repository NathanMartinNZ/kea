// The worktree location (`general.worktreeRoot`) is read when a session is planned and recorded on its row;
// changing it moves nothing. The sessions here are core's own `Sessions` over an in-memory database and a real
// `settings.json`, with the setting changed through `SettingsFile.set`, as the Settings sheet does.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryLogger, gitText, ulid } from '@kea/kit'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type KeaDb } from '../platform/db/db.ts'
import { checkInvariants } from '../platform/db/invariants.ts'
import { PortBlocks } from '../server/ports.ts'
import { Projects } from '../sessions/projects.ts'
import { insertSession } from '../sessions/rows.ts'
import { Sessions } from '../sessions/sessions.ts'
import type { Terminals } from '../terminal/terminals.ts'
import { RepoMutex } from '../worktrees/mutex.ts'
import { SettingsFile } from './settings.ts'

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
})

/** Hermetic git: no user or system config. */
const env = { PATH: process.env.PATH ?? '', HOME: '', LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Kea Test', GIT_AUTHOR_EMAIL: 'test@kea.invalid', GIT_COMMITTER_NAME: 'Kea Test', GIT_COMMITTER_EMAIL: 'test@kea.invalid' }

/** No terminal runs in these tests: the sessions' records are empty and nothing exits. */
const noTerminals = { exits: { event: () => ({ dispose() {} }) }, sessionRecords: () => [] } as unknown as Terminals

describe('the worktree location', () => {
  it('U-SET-2 · changing the worktree location does not alter an existing session’s paths, in the database or in the window’s view, also after a relaunch; only what is planned next reads the new location', async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-set6-')))
    cleanup.push(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const home = path.join(tmp, 'home')
    const repo = path.join(tmp, 'repos', 'demo')
    const [oldRoot, newRoot] = [path.join(tmp, 'old-worktrees'), path.join(tmp, 'new-worktrees')]
    for (const d of [home, repo, oldRoot, newRoot]) fs.mkdirSync(d, { recursive: true })
    await gitText(['init', '-q', '-b', 'main'], { cwd: repo, env })
    fs.writeFileSync(path.join(repo, 'README.md'), 'demo\n')
    await gitText(['add', '-A'], { cwd: repo, env })
    await gitText(['commit', '-q', '-m', 'base'], { cwd: repo, env })

    const log = createMemoryLogger({ process: 'core' })
    const { db } = openDatabase({ file: ':memory:', log })
    cleanup.push(() => db.abandon())
    fs.writeFileSync(path.join(home, 'settings.json'), `{\n  // where my worktrees go\n  "general": { "worktreeRoot": ${JSON.stringify(oldRoot)} }\n}\n`)
    const settings = new SettingsFile({ home, log, watch: false })
    cleanup.push(() => settings.dispose())
    const projects = new Projects({ db, log, gitReady: Promise.resolve(true), gitEnv: () => Promise.resolve(env) })
    cleanup.push(() => projects.dispose())
    const project = (await projects.add(repo)).project
    expect(project.isGit).toBe(true)
    const open = (database: KeaDb): Sessions => {
      const s = new Sessions({ db: database, log, home, projects, terminals: noTerminals, settings, mutex: new RepoMutex(), ports: new PortBlocks({ db: database, log }), git: Promise.resolve({ usable: true, missing: null }), env: () => Promise.resolve(env) })
      cleanup.push(() => s.dispose())
      return s
    }

    // a session made while the location was the old one: its worktree is on disk under it, and its row says so
    const cwd = path.join(oldRoot, 'demo', 'fix-auth')
    await gitText(['worktree', 'add', '-q', '-b', 'kea/fix-auth', cwd], { cwd: repo, env })
    const id = ulid()
    db.tx(() =>
      insertSession(db, {
        id, projectId: project.id, slug: 'fix-auth', title: 'Fix auth', titleSource: 'auto', isolation: 'worktree', cwd, worktreeRoot: oldRoot, branch: 'kea/fix-auth',
        baseBranch: 'main', baseCommit: null, portBase: null, agent: 'shell', agentSessionId: null, transcriptPath: null, launchConfig: '{"prompt":"fix auth"}',
        lifecycle: 'detached', endReason: null, deletedAt: null, snapshotRef: null, creationStep: null, diskBytes: null, diskAt: null,
        sortOrder: 0, pinnedOrder: 0, createdAt: 1, archivedAt: null,
      }),
    )
    const sessions = open(db)
    const row = () => db.get<{ cwd: string; worktree_root: string; branch: string; slug: string }>('SELECT cwd, worktree_root, branch, slug FROM sessions WHERE id = ?', id)
    const before = { row: row(), view: structuredClone(sessions.store.get(id)) }
    expect(before.row).toEqual({ cwd, worktree_root: oldRoot, branch: 'kea/fix-auth', slug: 'fix-auth' })
    expect(before.view).toMatchObject({ cwd, isolation: 'worktree', branch: 'kea/fix-auth' })
    const ask = { projectId: project.id, prompt: 'add a login page', isolation: 'worktree' as const, base: { kind: 'head' as const } }
    // the old location is usable: a new session there has nothing against it
    expect((await sessions.validate(ask)).problems).toEqual([])

    // the setting changes, as the Settings sheet changes it: one key written, in force at once
    await settings.set('general.worktreeRoot', newRoot)
    expect(settings.values.get('general.worktreeRoot')).toBe(newRoot)
    expect(fs.readFileSync(settings.file, 'utf8')).toContain('// where my worktrees go')

    // the session that exists keeps its paths: nothing was rewritten, nothing moved
    sessions.reload()
    expect(row()).toEqual(before.row)
    expect(sessions.store.get(id)).toEqual(before.view)
    expect(fs.existsSync(cwd), 'its worktree is where it was').toBe(true)
    expect(fs.readdirSync(newRoot), 'nothing was moved to the new location').toEqual([])
    expect(checkInvariants(db)).toEqual([])
    // … also when Kea comes back with the new setting (the row is what a relaunch reads)
    const again = open(db)
    expect(again.store.get(id)).toEqual(before.view)
    expect(row()).toEqual(before.row)

    // what is planned next reads the new location: a location that cannot hold worktrees (it holds the project) is
    // refused for a new session by its path, while the existing session, under the old one, is untouched by it
    const holdsProject = path.dirname(repo)
    await settings.set('general.worktreeRoot', holdsProject)
    const refused = (await sessions.validate(ask)).problems
    expect(refused).toContainEqual(expect.objectContaining({ code: 'worktreeRoot', hard: true, path: holdsProject }))
    sessions.reload()
    expect(row()).toEqual(before.row)
    expect(sessions.store.get(id)).toEqual(before.view)
    // back to no setting at all (the default, <KEA_HOME>/worktrees): the same
    await settings.reset('general.worktreeRoot')
    expect(settings.values.get('general.worktreeRoot')).toBeNull()
    expect((await sessions.validate(ask)).problems).toEqual([])
    sessions.reload()
    expect(row()).toEqual(before.row)
    expect(sessions.store.get(id)).toEqual(before.view)
  })
})
