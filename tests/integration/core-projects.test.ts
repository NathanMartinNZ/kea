// Projects in core against real repositories (tools/repo-factory) and, where sessions run, real holders: core assembled
// as main.ts assembles it (core.ts), on a temp KEA_HOME, wired to a real ptyhost.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ulid } from '@kea/kit'
import { SETTINGS, type Project, type SessionView } from '@kea/protocol'
import { INIT_COMMIT_MESSAGE } from '@kea/core/src/sessions/projects.ts'
import { insertSession, type SessionRow } from '@kea/core/src/sessions/rows.ts'
import { fixtureGitEnv, tinyRepo } from '@kea-tools/repo-factory/src/index.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { holderAlive, ptyhostHarness, testEnv, until, type Harness } from '../support/holders.ts'
import { ownPtyIds, startFullCore, type FullCoreUnderTest } from './core-support.ts'
import { createArgs, startSessions } from './core-sessions-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function harness(): Promise<Harness> {
  const h = await ptyhostHarness()
  cleanup.push(async () => {
    for (const id of ownPtyIds(h.home)) h.spawned.add(id)
    await h.dispose()
  })
  return h
}

function core(h: Harness): FullCoreUnderTest {
  const c = startFullCore(h, { env: testEnv() })
  cleanup.push(() => c.dispose())
  return c
}

function repo(name = 'demo') {
  const r = tinyRepo({ name })
  cleanup.push(() => r.dispose())
  return r
}

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()

/**
 * A linked worktree of `root` at `<fixture dir>/worktrees/<project>/<slug>`, as a session would have; removed with the
 * fixture.
 */
function linkedWorktree(root: string, slug: string): string {
  const wt = path.join(path.dirname(root), 'worktrees', path.basename(root), slug)
  fs.mkdirSync(path.dirname(wt), { recursive: true })
  gitIn(root, 'worktree', 'add', '-q', '-b', `kea/${slug}`, wt)
  return fs.realpathSync(wt)
}

/** Every file under `dir` with its type, mode and content hash: "byte-identical" means equal snapshots. */
function snapshot(dir: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const st = fs.lstatSync(p)
      const rel = path.relative(dir, p)
      if (skip(rel)) continue
      if (e.isDirectory()) {
        out[rel] = `dir ${st.mode}`
        walk(p)
      } else if (e.isSymbolicLink()) out[rel] = `link ${fs.readlinkSync(p)}`
      else out[rel] = `file ${st.mode} ${createHash('sha1').update(fs.readFileSync(p)).digest('hex')}`
    }
  }
  walk(dir)
  return out
}

function session(c: FullCoreUnderTest, projectId: string, over: Partial<SessionRow> = {}): string {
  const id = ulid()
  const row: SessionRow = {
    id, projectId, slug: `s-${id.slice(-6).toLowerCase()}`, title: 'Session', titleSource: 'auto', isolation: 'inplace', cwd: '/', worktreeRoot: null, branch: null,
    baseBranch: null, baseCommit: null, portBase: null, agent: 'shell', agentSessionId: null, transcriptPath: null, launchConfig: '{"prompt":""}',
    lifecycle: 'detached', endReason: 'stopped', deletedAt: null, snapshotRef: null, creationStep: null, diskBytes: null, diskAt: null,
    sortOrder: 0, pinnedOrder: 0, createdAt: Date.now(), archivedAt: null, ...over,
  }
  c.core.db.tx(() => insertSession(c.core.db, row))
  return id
}

const ordered = (c: FullCoreUnderTest): Project[] => c.core.projects.list()

describe('projects', () => {
  it('I-PRJ-1 · add a repo root, a subdirectory, a linked worktree, the same path twice and a symlink → the repo root each time; rename is display-only; order and collapsed state survive a restart', async () => {
    const h = await harness()
    const demo = repo('demo')
    const other = repo('other')
    const wt = linkedWorktree(demo.root, 'fix-auth')
    const link = path.join(path.dirname(demo.root), 'demo-link')
    fs.symlinkSync(demo.root, link)

    let c = core(h)
    const first = await c.call<{ project: Project; existing: boolean; registered: string }>('projects.add', { path: demo.root })
    expect(first).toMatchObject({ existing: false, registered: 'asGiven', project: { name: 'demo', rootPath: demo.root, isGit: true, missing: false, collapsed: false } })
    const id = first.project.id
    for (const [p, registered] of [
      [path.join(demo.root, 'src'), 'repoRoot'],
      [wt, 'mainWorktree'],
      [path.join(wt, 'src'), 'mainWorktree'],
      [demo.root, 'asGiven'],
      [link, 'asGiven'],
    ] as const) {
      const r = await c.call<{ project: Project; existing: boolean; registered: string }>('projects.add', { path: p })
      expect(r, p).toMatchObject({ existing: true, registered, project: { id, rootPath: demo.root } })
    }
    expect(c.core.projects.store.size).toBe(1)

    const second = (await c.call<{ project: Project }>('projects.add', { path: other.root })).project
    const plain = fs.mkdtempSync(path.join(path.dirname(other.root), 'plain-'))
    cleanup.push(() => fs.rmSync(plain, { recursive: true, force: true }))
    const third = (await c.call<{ project: Project }>('projects.add', { path: plain })).project
    expect(third).toMatchObject({ isGit: false, name: path.basename(plain) })
    expect(ordered(c).map((p) => p.id), 'new projects are appended').toEqual([id, second.id, third.id])
    await expect(c.call('projects.add', { path: path.join(plain, 'nope') })).rejects.toMatchObject({ code: 'invalid_path' })

    const before = snapshot(demo.root)
    expect((await c.call<{ project: Project }>('projects.rename', { id, name: '  Demo app ' })).project).toMatchObject({ name: 'Demo app', rootPath: demo.root })
    expect(snapshot(demo.root), 'rename is display-only').toEqual(before)
    await c.call('projects.move', { id: third.id, index: 0 })
    await c.call('projects.move', { id, index: 2 })
    await c.call('projects.setCollapsed', { id: second.id, collapsed: true })
    expect(ordered(c).map((p) => p.id)).toEqual([third.id, second.id, id])

    // restart: the database has it all
    c.dispose()
    c = core(h)
    await c.core.started
    expect(ordered(c).map((p) => [p.id, p.name, p.collapsed])).toEqual([
      [third.id, path.basename(plain), false],
      [second.id, 'other', true],
      [id, 'Demo app', false],
    ])
  })

  it('I-PRJ-2 · Remove Project is refused while a session has a worktree on disk or a creation in progress or failed, naming them; deleted sessions and a worktree auto-clean removed do not block, and removing ends their restorability; running sessions without a worktree stop only on "Stop and remove"; the repository is byte-identical afterwards and holds nothing of Kea’s', async () => {
    let clock = Date.now()
    let failCopy = false
    const s = await startSessions({ opts: { now: () => clock, faults: (point) => {
      if (point === 'create:copy' && failCopy) {
        failCopy = false
        throw new Error('injected fault at copy')
      }
    } } })
    cleanup.push(() => s.dispose())
    const demo = repo('demo')
    const p = await s.project(demo.root)
    const noGit = (rel: string) => rel === '.git'
    const before = snapshot(demo.root, noGit)
    const settled = (x: SessionView) => x.lifecycle === 'live' || x.lifecycle === 'create_failed'
    const make = async (prompt: string, more: Record<string, unknown> = {}) => (await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, prompt, more))).sessionId
    // a detached worktree session with uncommitted work, a failed creation, a clean archived one, a live in-place one
    const dirty = await s.until(await make('dirty work'), 'live', settled)
    fs.writeFileSync(path.join(dirty.cwd, 'precious.txt'), 'uncommitted work\n')
    await s.call('sessions.stop', { id: dirty.id })
    failCopy = true
    const failed = await s.until(await make('failed creation'), 'failed', settled)
    expect(failed.lifecycle).toBe('create_failed')
    const archived = await s.until(await make('archived clean'), 'live', settled)
    await s.call('sessions.archive', { id: archived.id, confirmed: true })
    const inplace = await s.until(await make('in place', { isolation: 'inplace' }), 'live', settled)
    expect(inplace.lifecycle).toBe('live')
    const blocking = [
      { sessionId: dirty.id, title: dirty.title, reason: 'worktree' },
      { sessionId: failed.id, title: failed.title, reason: 'createFailed' },
      { sessionId: archived.id, title: archived.title, reason: 'worktree' },
    ]
    const sorted = <T extends { sessionId: string }>(xs: T[]) => [...xs].sort((a, b) => a.sessionId.localeCompare(b.sessionId))

    // refused, even with "Stop and remove": nothing is stopped, moved or deleted
    for (const stopSessions of [true, false]) {
      const r = await s.call<{ removed: boolean; blocking: typeof blocking; running: unknown[]; restorable: number }>('projects.remove', { id: p.id, stopSessions })
      expect(r.removed).toBe(false)
      expect(sorted(r.blocking)).toEqual(sorted(blocking))
      expect(r).toMatchObject({ running: [{ sessionId: inplace.id, title: inplace.title }], restorable: 0 })
    }
    expect(fs.readFileSync(path.join(dirty.cwd, 'precious.txt'), 'utf8')).toBe('uncommitted work\n')
    expect(fs.existsSync(failed.cwd)).toBe(true)
    expect(s.view(inplace.id)?.lifecycle).toBe('live')
    expect(s.c.core.projects.get(p.id)).toBeDefined()

    // auto-clean removes the archived worktree; the user discards, and deletes (its confirmation lists what is lost)
    clock += ((SETTINGS.find((k) => k.key === 'general.autoCleanArchivedDays')!.default as number) + 1) * 86_400_000
    await s.c.core.sessions.maintain()
    expect(fs.existsSync(archived.cwd)).toBe(false)
    await s.call('sessions.discard', { id: failed.id })
    await s.call('sessions.delete', { id: dirty.id, deleteBranch: false })
    expect(gitIn(demo.root, 'for-each-ref', 'refs/kea/')).not.toBe('')
    const preview = await s.call<object>('projects.removePreview', { id: p.id })
    expect(preview).toEqual({ blocking: [], running: [{ sessionId: inplace.id, title: inplace.title }], restorable: 1 })
    expect(await s.call('projects.remove', { id: p.id })).toEqual({ removed: false, ...preview })
    const agent = s.c.core.terminals.sessionRecords(inplace.id).find((x) => x.kind === 'agent')!.ptyId
    expect(await s.call('projects.remove', { id: p.id, stopSessions: true })).toEqual({ removed: true, ...preview })
    expect(s.c.core.projects.get(p.id)).toBeUndefined()
    for (const t of ['projects', 'sessions', 'ptys', 'session_runtime', 'session_ui']) expect(s.c.core.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n, t).toBe(0)
    await until('the agent’s holder gone', () => !holderAlive(s.h.home, agent))
    expect(fs.readdirSync(path.join(s.h.home, 'sessions'))).toEqual([])
    expect(snapshot(demo.root, noGit), 'the working tree is untouched').toEqual(before)
    expect(gitIn(demo.root, 'for-each-ref', 'refs/kea/'), 'no ref of Kea’s left').toBe('')
    expect(gitIn(demo.root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    await expect(s.call('projects.remove', { id: p.id })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('I-PRJ-6 · a bare repository is a git project: its own folder, a folder inside it, a folder whose `.git` file names it and one of its worktrees all register it; its sessions are worktrees, from its default branch or a named one; in place and "Current HEAD" are refused before anything is made; its folder holds nothing of a session', async () => {
    const s = await startSessions()
    cleanup.push(() => s.dispose())
    const src = repo('demo')
    const holder = path.dirname(src.root)
    const bare = path.join(holder, 'demo.git')
    gitIn(src.root, 'clone', '-q', '--bare', src.root, bare)
    gitIn(bare, 'branch', 'release', 'main')
    type Added = { project: Project; existing: boolean; registered: string }

    const first = await s.call<Added>('projects.add', { path: bare })
    expect(first).toMatchObject({ existing: false, registered: 'asGiven', project: { name: 'demo', rootPath: bare, isGit: true, bare: true, missing: false } })
    const id = first.project.id
    // a worktree made by hand, and the layout that keeps the repository in a hidden folder beside its worktrees
    const byHand = path.join(holder, 'by-hand')
    gitIn(bare, 'worktree', 'add', '-q', '-b', 'by-hand', byHand, 'main')
    const hidden = path.join(holder, 'site')
    fs.mkdirSync(hidden)
    gitIn(src.root, 'clone', '-q', '--bare', src.root, path.join(hidden, '.bare'))
    fs.writeFileSync(path.join(hidden, '.git'), 'gitdir: ./.bare\n')
    for (const [given, registered] of [
      [path.join(bare, 'refs', 'heads'), 'repoRoot'],
      [byHand, 'mainWorktree'],
      [path.join(byHand, 'src'), 'mainWorktree'],
      [bare, 'asGiven'],
    ] as const) {
      expect(await s.call<Added>('projects.add', { path: given }), given).toMatchObject({ existing: true, registered, project: { id, rootPath: bare, bare: true } })
    }
    expect(await s.call<Added>('projects.add', { path: hidden })).toMatchObject({ existing: false, registered: 'repoRoot', project: { name: 'site', rootPath: path.join(hidden, '.bare'), isGit: true, bare: true } })
    // an ordinary repository says nothing of the kind
    expect((await s.call<Added>('projects.add', { path: src.root })).project).not.toHaveProperty('bare')

    // what the composer is told: no current HEAD to start from; the branches are there
    const bases = await s.call<{ defaultBranch: string | null; head: string | null; bare: boolean; refs: { name: string; kind: string; checkedOutAt: string | null }[] }>('sessions.bases', { projectId: id })
    expect(bases).toMatchObject({ defaultBranch: 'main', head: null, bare: true })
    expect(bases.refs).toEqual(expect.arrayContaining([{ name: 'main', kind: 'local', checkedOutAt: null }, { name: 'by-hand', kind: 'local', checkedOutAt: byHand }]))

    // in place has no folder to run in, and there is no checkout whose HEAD could be a base: refused, nothing listed
    type Validation = { problems: { code: string; hard: boolean; message: string }[] }
    const args = (more: Record<string, unknown>) => createArgs(id, 'fix the header', { base: { kind: 'default' }, ...more })
    expect((await s.call<Validation>('sessions.validate', args({ isolation: 'inplace' }))).problems).toEqual([expect.objectContaining({ code: 'bareInPlace', hard: true })])
    expect((await s.call<Validation>('sessions.validate', args({ base: { kind: 'head' } }))).problems).toEqual([expect.objectContaining({ code: 'baseMissing', hard: true })])
    expect((await s.call<Validation>('sessions.validate', args({}))).problems).toEqual([])
    await expect(s.call('sessions.create', args({ isolation: 'inplace' }))).rejects.toMatchObject({ code: 'invalid_session' })
    await expect(s.call('sessions.create', args({ base: { kind: 'head' } }))).rejects.toMatchObject({ code: 'invalid_session' })
    expect(s.c.core.sessions.store.size).toBe(0)

    // worktree sessions: from the default branch, and from a named one
    const entries = new Set(fs.readdirSync(bare))
    const settled = (x: SessionView) => x.lifecycle === 'live' || x.lifecycle === 'create_failed'
    const one = await s.until((await s.call<{ sessionId: string }>('sessions.create', args({}))).sessionId, 'live', settled)
    expect(one, JSON.stringify(one.creation)).toMatchObject({ lifecycle: 'live', isolation: 'worktree', branch: 'kea/fix-header', baseBranch: 'main' })
    expect(gitIn(one.cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('kea/fix-header')
    expect(fs.existsSync(path.join(one.cwd, 'README.md'))).toBe(true)
    const two = await s.until((await s.call<{ sessionId: string }>('sessions.create', args({ base: { kind: 'ref', ref: 'release' } }))).sessionId, 'live', settled)
    expect(two, JSON.stringify(two.creation)).toMatchObject({ lifecycle: 'live', isolation: 'worktree', baseBranch: 'release' })
    expect(gitIn(two.cwd, 'rev-parse', 'HEAD')).toBe(gitIn(bare, 'rev-parse', 'refs/heads/release'))
    // the repository's folder got nothing new but git's own note of the fetch (its `worktrees` folder was there)
    await s.idle()
    expect(fs.readdirSync(bare).filter((name) => !entries.has(name))).toEqual(['FETCH_HEAD'])

    // a restart knows it still, and a deleted session's worktree and branch go as in any repository
    await s.relaunch()
    expect(s.c.core.projects.get(id)).toMatchObject({ rootPath: bare, isGit: true, bare: true })
    await s.call('sessions.delete', { id: two.id, deleteBranch: true })
    await s.idle()
    expect(fs.existsSync(two.cwd)).toBe(false)
    expect(gitIn(bare, 'worktree', 'list', '--porcelain')).not.toContain(two.cwd)
  })

  it('I-PRJ-3 · a project root renamed while Kea is closed is flagged missing at launch; after Locate, git worktree repair ran and its sessions work', async () => {
    const h = await harness()
    const demo = repo('demo')
    const wt = linkedWorktree(demo.root, 'fix-auth')
    let c = core(h)
    const p = (await c.call<{ project: Project }>('projects.add', { path: demo.root })).project
    const inplace = session(c, p.id, { cwd: demo.root })
    session(c, p.id, { isolation: 'worktree', cwd: wt, worktreeRoot: path.dirname(path.dirname(wt)), branch: 'kea/fix-auth' })
    c.dispose()

    const moved = path.join(path.dirname(demo.root), 'demo-renamed')
    fs.renameSync(demo.root, moved)
    expect(() => gitIn(wt, 'status', '--porcelain'), 'the worktree lost its repository').toThrow()

    c = core(h)
    await c.core.started
    expect(c.core.projects.get(p.id)).toMatchObject({ missing: true, rootPath: demo.root })
    expect(await c.call('projects.checkRoots', {})).toEqual({ missing: [p.id] })

    const r = await c.call<{ project: Project; repaired: boolean; registered: string }>('projects.locate', { id: p.id, path: path.join(moved, 'src') })
    expect(r).toMatchObject({ repaired: true, registered: 'repoRoot', project: { id: p.id, rootPath: fs.realpathSync(moved), missing: false, name: 'demo' } })
    expect(gitIn(wt, 'status', '--porcelain'), 'the session’s worktree works again').toBe('')
    expect(gitIn(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('kea/fix-auth')
    expect(c.core.db.get<{ cwd: string }>('SELECT cwd FROM sessions WHERE id = ?', inplace)!.cwd, 'in-place sessions move with the root').toBe(fs.realpathSync(moved))

    // the root is another project's: refused
    const other = repo('other')
    const q = (await c.call<{ project: Project }>('projects.add', { path: other.root })).project
    await expect(c.call('projects.locate', { id: q.id, path: moved })).rejects.toMatchObject({ code: 'already_registered' })
  })

  it('I-PRJ-5 · "Initialise git…" on a plain folder: git init there and one empty commit with the user’s own identity, no hook run and nothing signed, and the project is a git project; with no identity configured the init stays and the call says why; a plain folder inside a repository (added while git was missing) is refused and gets no nested repository', async () => {
    const h = await harness()
    // the user's git: their identity in their global config, a hook that would leave a mark, and signing turned on
    // (with no key to sign with, a signed commit would fail)
    const userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-user-home-')))
    cleanup.push(() => fs.rmSync(userHome, { recursive: true, force: true }))
    const hooks = path.join(userHome, 'hooks')
    const marks = path.join(userHome, 'hook-ran')
    fs.mkdirSync(hooks)
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit']) fs.writeFileSync(path.join(hooks, hook), `#!/bin/sh\necho ${hook} >> '${marks}'\n`, { mode: 0o755 })
    const config = path.join(userHome, '.gitconfig')
    // os-ok: in /usr/bin on both systems
    fs.writeFileSync(config, `[user]\n\tname = Kea Test User\n\temail = user@kea.invalid\n[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = /usr/bin/false\n`)
    const base = { PATH: testEnv().PATH ?? '/usr/bin:/bin', HOME: userHome, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1' }
    let gitEnv: Record<string, string> = { ...base, GIT_CONFIG_GLOBAL: config }
    const c = startFullCore(h, { env: testEnv(), opts: { gitEnv: async () => gitEnv } })
    cleanup.push(() => c.dispose())
    const plainFolder = () => {
      const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-plain-')))
      cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }))
      fs.writeFileSync(path.join(d, 'notes.txt'), 'hello\n')
      return d
    }

    const plain = plainFolder()
    const p = (await c.call<{ project: Project }>('projects.add', { path: plain })).project
    expect(p.isGit).toBe(false)
    const q = (await c.call<{ project: Project }>('projects.initGit', { id: p.id })).project
    expect(q).toMatchObject({ id: p.id, isGit: true, rootPath: plain })
    expect(c.core.projects.get(p.id)?.isGit, 'the store says so').toBe(true)
    expect(gitIn(plain, 'rev-parse', '--show-toplevel').trim()).toBe(plain)
    expect(gitIn(plain, 'log', '--format=%an <%ae> · %cn <%ce> · %s · %P · %G?').trim().split('\n'), 'one commit, by the user, the fixed message, no parent, unsigned').toEqual([`Kea Test User <user@kea.invalid> · Kea Test User <user@kea.invalid> · ${INIT_COMMIT_MESSAGE} ·  · N`])
    expect(gitIn(plain, 'diff-tree', '--no-commit-id', '-r', '--root', 'HEAD').trim(), 'an empty commit').toBe('')
    expect(gitIn(plain, 'status', '--porcelain').trim(), 'the folder’s files untouched: still untracked').toBe('?? notes.txt')
    expect(fs.existsSync(marks), 'no hook ran').toBe(false)
    expect((await c.call<{ project: Project }>('projects.initGit', { id: p.id })).project.isGit, 'a second time changes nothing').toBe(true)
    expect(gitIn(plain, 'rev-list', '--count', 'HEAD').trim(), 'still one commit').toBe('1')

    // no identity configured: the init stays, the project is a git project, the call says why, and no commit is made
    gitEnv = { ...base, GIT_CONFIG_GLOBAL: '/dev/null' }
    const bare = plainFolder()
    const b = (await c.call<{ project: Project }>('projects.add', { path: bare })).project
    await expect(c.call('projects.initGit', { id: b.id })).rejects.toMatchObject({ code: 'git_failed', message: expect.stringMatching(/no user name and email/) })
    expect(c.core.projects.get(b.id)?.isGit, 'a git project now').toBe(true)
    expect(gitIn(bare, 'rev-parse', '--show-toplevel').trim()).toBe(bare)
    expect(() => gitIn(bare, 'rev-parse', '--verify', '-q', 'HEAD'), 'no commit was made').toThrow()

    // a folder inside a repository, registered as plain (as when git was missing at the time it was added)
    const demo = repo('demo')
    const sub = path.join(demo.root, 'src')
    const id = ulid()
    c.core.db.tx(() => c.core.db.run('INSERT INTO projects (id, name, root_path, is_git, default_branch, sort_order, collapsed, settings, missing, trust_confirmed, created_at) VALUES (?, ?, ?, 0, NULL, 99, 0, ?, 0, 0, ?)', id, 'src', sub, '{}', Date.now()))
    c.core.projects.reload()
    await expect(c.call('projects.initGit', { id })).rejects.toMatchObject({ code: 'git_failed' })
    expect(fs.existsSync(path.join(sub, '.git')), 'no nested repository').toBe(false)
  })
})
