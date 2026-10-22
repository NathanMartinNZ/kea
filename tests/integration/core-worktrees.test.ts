// The worktree pipeline in core against real git, real holders and repos from tools/repo-factory: core assembled as
// main.ts assembles it, on a temp KEA_HOME, wired to a real ptyhost.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ptyId as newPtyId, ulid } from '@kea/kit'
import { kitOs } from '../../packages/kit/src/os/index.ts'
import { L, type DeletePreview, type SessionView } from '@kea/protocol'
import { kvSet } from '@kea/core/src/platform/db/db.ts'
import { TEARDOWN_KV } from '@kea/core/src/sessions/sessions.ts'
import { WORKTREE_TRASH as KEA_TRASH } from '@kea/core/src/worktrees/ops.ts'
import { SETTINGS } from '@kea/protocol'
import { BUDGETS } from '../../tools/perf/src/generated/budgets.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { holderAlive, holderChildAlive, holderState, until } from '../support/holders.ts'
import { branches, createArgs, gitIn, repo, startSessions, worktreePaths, type SessionsUnderTest } from './core-sessions-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function sessions(o: Parameters<typeof startSessions>[0] = {}): Promise<SessionsUnderTest> {
  const s = await startSessions(o)
  cleanup.push(() => s.dispose())
  return s
}

function fixture(name = 'demo') {
  const r = repo(name)
  cleanup.push(() => r.dispose())
  return r
}

function tmpDir(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

/** Every file under `dir` (but `.git`) with its type, mode and content hash: "byte-identical" means equal snapshots. */
function snapshot(dir: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const rel = path.relative(dir, p)
      if (e.name === '.git' || skip(rel)) continue
      const st = fs.lstatSync(p)
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

async function create(s: SessionsUnderTest, projectId: string, prompt: string, more: Record<string, unknown> = {}): Promise<string> {
  const r = await s.call<{ sessionId: string }>('sessions.create', createArgs(projectId, prompt, more))
  return r.sessionId
}

const settled = (v: SessionView) => v.lifecycle === 'live' || v.lifecycle === 'create_failed'

async function live(s: SessionsUnderTest, id: string): Promise<SessionView> {
  const v = await s.until(id, 'creation settles', settled)
  if (v.lifecycle !== 'live') throw new Error(`creation failed: ${v.creation?.error}\n${(await s.call<{ text: string }>('sessions.creationLog', { id })).text}`)
  return v
}

const logOf = async (s: SessionsUnderTest, id: string) => (await s.call<{ text: string }>('sessions.creationLog', { id })).text

describe('create', () => {
  it('I-WT-1 · from the default branch with a reachable, an unreachable and a hanging remote: the fresh ref, the cached one with a notice, the cached one after L.fetchTimeoutMs', async () => {
    const s = await sessions()
    const r = fixture()
    const remotes = tmpDir('kea-remote-')
    const bare = path.join(remotes, 'origin.git')
    execFileSync('git', ['clone', '-q', '--bare', r.root, bare], { env: s.env })
    gitIn(r.root, 'remote', 'add', 'origin', bare)
    gitIn(r.root, 'fetch', '-q', 'origin')
    gitIn(r.root, 'remote', 'set-head', 'origin', '--auto')
    // a newer commit reaches the remote only: a fresh fetch is needed to see it
    const other = path.join(remotes, 'other')
    execFileSync('git', ['clone', '-q', bare, other], { env: s.env })
    fs.writeFileSync(path.join(other, 'fresh.txt'), 'fresh\n')
    gitIn(other, 'add', 'fresh.txt')
    gitIn(other, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'fresh')
    gitIn(other, 'push', '-q', 'origin', 'main')
    const fresh = gitIn(other, 'rev-parse', 'HEAD').trim()
    const p = await s.project(r.root)

    const a = await live(s, await create(s, p.id, 'reachable remote', { base: { kind: 'default' } }))
    expect(a.baseCommit).toBe(fresh)
    expect(a.baseBranch).toBe('origin/main')
    expect(fs.existsSync(path.join(a.cwd, 'fresh.txt'))).toBe(true)
    expect(await logOf(s, a.id)).not.toContain('notice')

    gitIn(r.root, 'remote', 'set-url', 'origin', path.join(remotes, 'missing.git'))
    const b = await live(s, await create(s, p.id, 'unreachable remote', { base: { kind: 'default' } }))
    expect(b.baseCommit).toBe(fresh) // the cached origin/main
    expect(await logOf(s, b.id)).toMatch(/notice: using cached origin\/main \(fetch failed\)/)

    const hang = path.join(remotes, 'hang.sh')
    fs.writeFileSync(hang, '#!/bin/sh\nexec sleep 600\n', { mode: 0o755 })
    gitIn(r.root, 'remote', 'set-url', 'origin', bare)
    gitIn(r.root, 'config', 'remote.origin.uploadpack', hang)
    const t0 = performance.now()
    const cId = await create(s, p.id, 'hanging remote', { base: { kind: 'default' } })
    const c = await s.until(cId, 'creation settles', settled, L.fetchTimeoutMs * 4)
    expect(c.lifecycle).toBe('live')
    expect(performance.now() - t0).toBeGreaterThanOrEqual(L.fetchTimeoutMs)
    expect(c.baseCommit).toBe(fresh)
    expect(await logOf(s, cId)).toMatch(/using cached origin\/main \(fetch timed out\)/)
  })

  it('I-WT-2 · five concurrent creations on one repository: five valid worktrees, serialised by the mutex, no lock left behind', async () => {
    // the mutex core runs every worktree mutation through, watched: never two of one repository at once
    const { RepoMutex } = await import('@kea/core/src/worktrees/mutex.ts')
    let active = 0
    let most = 0
    let runs = 0
    // every section waits until all five adds have asked for the mutex: whatever overlap it would allow, it does
    let asked = 0
    let open!: () => void
    const allAsked = new Promise<void>((resolve) => (open = resolve))
    const mutex = new RepoMutex()
    const run = mutex.run.bind(mutex)
    mutex.run = (repo, fn) => {
      if (++asked === 5) open()
      return run(repo, async () => {
        runs++
        most = Math.max(most, ++active)
        try {
          await allAsked
          return await fn()
        } finally {
          active--
        }
      })
    }
    const s = await sessions({ opts: { mutex } })
    const r = fixture()
    const p = await s.project(r.root)
    const ids = await Promise.all([1, 2, 3, 4, 5].map((i) => create(s, p.id, `parallel task ${i}`)))
    const views = await Promise.all(ids.map((id) => live(s, id)))
    expect(new Set(views.map((v) => v.cwd)).size).toBe(5)
    const listed = worktreePaths(r.root)
    for (const v of views) {
      expect(listed).toContain(v.cwd)
      expect(gitIn(v.cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(v.branch)
    }
    const gitDir = path.join(r.root, '.git')
    expect(fs.existsSync(path.join(gitDir, 'index.lock'))).toBe(false)
    expect(gitIn(r.root, 'worktree', 'list', '--porcelain')).not.toMatch(/^locked/m)
    expect(s.c.core.projects.resourceCounts.repoLocks).toBe(0)
    expect(runs, 'every add (and its prune) went through the mutex').toBeGreaterThanOrEqual(5)
    expect(most, 'one worktree mutation of the repository at a time').toBe(1)
  })

  it('I-WT-3 · a fault at each pipeline step: Retry succeeds from that step; Discard leaves no worktree and no branch', async () => {
    let failAt: string | null = null
    const s = await sessions({
      opts: {
        faults: (point) => {
          if (point === failAt) {
            failAt = null
            throw new Error(`injected fault at ${point}`)
          }
        },
      },
    })
    const r = fixture()
    const p = await s.project(r.root)
    for (const step of ['git', 'base', 'add', 'copy', 'submodules', 'setup', 'launch']) {
      // Retry
      failAt = `create:${step}`
      const id = await create(s, p.id, `retry after ${step}`)
      const failed = await s.until(id, 'failed', (v) => v.lifecycle === 'create_failed')
      expect(failed.creation).toMatchObject({ step, error: expect.stringContaining('injected fault') })
      expect(failed.glyph).toBe('failed')
      await s.call('sessions.retry', { id })
      const ok = await live(s, id)
      expect(worktreePaths(r.root)).toContain(ok.cwd)
      // Discard
      failAt = `create:${step}`
      const id2 = await create(s, p.id, `discard after ${step}`)
      const f2 = await s.until(id2, 'failed', (v) => v.lifecycle === 'create_failed')
      await s.call('sessions.discard', { id: id2 })
      await until('the row goes', () => !s.view(id2))
      expect(worktreePaths(r.root)).not.toContain(f2.cwd)
      expect(fs.existsSync(f2.cwd)).toBe(false)
      expect(branches(r.root)).not.toContain(f2.branch)
      expect(fs.existsSync(path.join(s.h.home, 'sessions', id2))).toBe(false)
      expect(s.c.core.db.get('SELECT 1 AS x FROM sessions WHERE id = ?', id2)).toBeUndefined()
    }
  })

  it('I-WT-4 · the default patterns and .worktreeinclude: exactly the matching untracked files, byte-identical, nothing tracked, .claude/settings.local.json never', async () => {
    const s = await sessions()
    const r = fixture()
    fs.appendFileSync(path.join(r.root, '.gitignore'), '.env*\n!.env.example\nCLAUDE.local.md\n.claude/settings.local.json\ncerts/\n')
    gitIn(r.root, 'add', '.gitignore')
    fs.writeFileSync(path.join(r.root, '.env.example'), 'TRACKED=1\n')
    gitIn(r.root, 'add', '.env.example')
    gitIn(r.root, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'ignore secrets')
    const files: Record<string, string> = {
      '.env': 'A=1\n',
      '.env.local': 'B=2\n',
      'src/.env.test': 'C=3\n',
      'CLAUDE.local.md': '# local\n',
      '.commandcode/settings.local.json': '{"approve":[]}\n',
      '.claude/settings.local.json': '{"permissions":{}}\n',
      'certs/dev.pem': 'cert\n',
      'node_modules/x/index.js': 'x\n',
      'notes.txt': 'untracked, not ignored\n',
    }
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(r.root, rel)), { recursive: true })
      fs.writeFileSync(path.join(r.root, rel), body)
    }
    fs.writeFileSync(path.join(r.root, '.env.example'), 'TRACKED=changed-in-main\n') // a tracked file is never copied
    const p = await s.project(r.root)
    const a = await live(s, await create(s, p.id, 'default patterns'))
    const copied = ['.env', '.env.local', 'src/.env.test', 'CLAUDE.local.md', '.commandcode/settings.local.json']
    for (const rel of copied) expect(fs.readFileSync(path.join(a.cwd, rel), 'utf8'), rel).toBe(files[rel])
    for (const rel of ['.claude/settings.local.json', 'certs/dev.pem', 'node_modules/x/index.js', 'notes.txt']) expect(fs.existsSync(path.join(a.cwd, rel)), rel).toBe(false)
    expect(fs.readFileSync(path.join(a.cwd, '.env.example'), 'utf8')).toBe('TRACKED=1\n')
    expect(await logOf(s, a.id)).toContain('copied: .commandcode/settings.local.json, .env, .env.local, CLAUDE.local.md, src/.env.test')
    expect(await logOf(s, a.id)).not.toContain('A=1')

    // .worktreeinclude: what matches it and is ignored; a directory is cloned whole; untracked-not-ignored never
    fs.writeFileSync(path.join(r.root, '.worktreeinclude'), 'certs/\n.env\nnotes.txt\n')
    const b = await live(s, await create(s, p.id, 'worktreeinclude'))
    expect(snapshot(path.join(b.cwd, 'certs'))).toEqual(snapshot(path.join(r.root, 'certs')))
    expect(fs.readFileSync(path.join(b.cwd, '.env'), 'utf8')).toBe(files['.env'])
    for (const rel of ['.env.local', 'notes.txt', 'CLAUDE.local.md']) expect(fs.existsSync(path.join(b.cwd, rel)), rel).toBe(false)
  })

  it('I-WT-5 · an existing branch checked out in another worktree: the error names that worktree (and its session)', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const a = await live(s, await create(s, p.id, 'first one'))
    const v = await s.call<{ problems: { code: string; message: string; path: string | null; sessionId: string | null }[] }>('sessions.validate', {
      projectId: p.id, prompt: 'second', isolation: 'worktree', base: { kind: 'existing', ref: a.branch },
    })
    expect(v.problems).toContainEqual(expect.objectContaining({ code: 'branchCheckedOut', path: a.cwd, sessionId: a.id }))
    // Start anyway (validation not waited for): the creation fails in place at its first step, saying where
    const failsAt = async (prompt: string, ref: string) => {
      const { sessionId } = await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, prompt, { base: { kind: 'existing', ref } }))
      const x = await s.until(sessionId, 'creation settles', (y) => y.lifecycle === 'live' || y.lifecycle === 'create_failed')
      expect(x.lifecycle).toBe('create_failed')
      expect(x.creation?.step).toBe('git')
      return x.creation?.error ?? ''
    }
    expect(await failsAt('second', a.branch!)).toContain(a.cwd)
    // main is checked out in the project root
    expect(await failsAt('third', 'main')).toContain(r.root)
    // a branch nobody has checked out is used as-is, and is never deleted by a rollback
    gitIn(r.root, 'branch', 'feature/free')
    const c = await live(s, await create(s, p.id, 'use existing', { base: { kind: 'existing', ref: 'feature/free' } }))
    expect(c.branch).toBe('feature/free')
    expect(gitIn(c.cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/free')
  })

  it('I-WT-21 · a repository with no commit yet (as "Initialise git…" leaves it): validation refuses a worktree from the default branch or HEAD before Start, in place is fine; one commit lifts it', async () => {
    const s = await sessions()
    const root = tmpDir('kea-unborn-')
    gitIn(root, 'init', '-q', '-b', 'main')
    const p = await s.project(root)
    expect(p.isGit).toBe(true)
    const problems = async (isolation: string, base: Record<string, unknown>) =>
      (await s.call<{ problems: { code: string; hard: boolean }[] }>('sessions.validate', { projectId: p.id, prompt: 'x', isolation, base })).problems
    const baseMissing = expect.objectContaining({ code: 'baseMissing', hard: true })
    for (const base of [{ kind: 'default' }, { kind: 'head' }]) expect(await problems('worktree', base)).toContainEqual(baseMissing)
    expect(await problems('inplace', { kind: 'default' })).not.toContainEqual(baseMissing)
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
    gitIn(root, 'add', 'a.txt')
    gitIn(root, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'first')
    for (const base of [{ kind: 'default' }, { kind: 'head' }]) expect(await problems('worktree', base)).not.toContainEqual(baseMissing)
  })

  it('I-WT-30 · a long worktree root: the slug is shortened so the path stays under L.worktreePathMaxChars, and so is a name that collides (`-2` within the room left)', async () => {
    const room = 12
    const tmp = tmpDir('kea-long-')
    const projectDirLength = L.worktreePathMaxChars - 1 - 1 - room
    const root = path.join(tmp, 'x'.repeat(projectDirLength - '/demo'.length - tmp.length - 1))
    const s = await sessions({ settings: { general: { worktreeRoot: root } } })
    const r = fixture()
    const p = await s.project(r.root)
    const a = await live(s, await create(s, p.id, 'make the frobnicator work'))
    const b = await live(s, await create(s, p.id, 'make the frobnicator work'))
    expect(a.slug).not.toBe(b.slug)
    for (const v of [a, b]) {
      expect(v.cwd.length, v.cwd).toBeLessThan(L.worktreePathMaxChars)
      expect(v.slug.length).toBeLessThanOrEqual(room)
    }
  })

  it('I-WT-8 · setup command: success starts the agent after it; failure holds the agent until Retry or Start agent anyway; Skip starts it at once, and the skipped setup is logged and released when it ends', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const marks = tmpDir('kea-setup-')
    const setup = (cmd: string) => s.call('projects.updateSettings', { id: p.id, set: { setupCommand: cmd } })
    const agentRunning = (id: string) => s.c.core.terminals.sessionRecords(id).some((x) => x.kind === 'agent' && x.state === 'running')

    await setup(`echo "$KEA_SETUP_REASON $KEA_SESSION_SLUG" > ${marks}/ok.txt`)
    const a = await live(s, await create(s, p.id, 'setup ok'))
    expect(fs.readFileSync(path.join(marks, 'ok.txt'), 'utf8')).toBe(`create ${a.slug}\n`)
    expect(a.setup).toMatchObject({ state: 'done', exitCode: 0, reason: 'create' })
    expect(await logOf(s, a.id)).toContain('setup finished')

    await setup(`test -f ${marks}/go || exit 3`)
    const bId = await create(s, p.id, 'setup fails')
    const b = await s.until(bId, 'setup failed', (v) => v.setup?.state === 'failed')
    expect(b.lifecycle).toBe('creating')
    expect(b.setup?.exitCode).toBe(3)
    expect(agentRunning(bId)).toBe(false)
    fs.writeFileSync(path.join(marks, 'go'), '')
    await s.call('sessions.setup', { id: bId, action: 'retry' })
    await live(s, bId)
    expect(s.view(bId)?.setup?.state).toBe('done')

    fs.rmSync(path.join(marks, 'go'))
    const cId = await create(s, p.id, 'start anyway')
    await s.until(cId, 'setup failed', (v) => v.setup?.state === 'failed')
    await s.call('sessions.setup', { id: cId, action: 'startAnyway' })
    await live(s, cId)

    await setup(`echo skipped-but-logged; while ! test -f ${marks}/release; do sleep 0.05; done`)
    const dId = await create(s, p.id, 'skip setup')
    const d = await s.until(dId, 'setup running', (v) => v.setup?.state === 'running')
    expect(agentRunning(dId)).toBe(false)
    const tab = s.c.core.terminals.record(d.setup!.ptyId!)
    expect(tab).toMatchObject({ kind: 'script', title: 'Setup' })
    await s.call('sessions.setup', { id: dId, action: 'skip' })
    await live(s, dId)
    expect(s.c.core.terminals.record(d.setup!.ptyId!)?.state).toBe('running') // setup keeps running in its tab
    fs.writeFileSync(path.join(marks, 'release'), '')
    await until('setup ends', () => s.c.core.terminals.record(d.setup!.ptyId!)?.state === 'exited')
    // a skipped setup that ends is still captured to the creation log and its holder released
    await until('the skipped setup’s holder is released', () => !holderAlive(s.h.home, d.setup!.ptyId!))
    expect(await logOf(s, dId)).toMatch(/skipped setup output:\n[^]*skipped-but-logged/)
    expect(s.view(dId)?.setup?.state).toBe('skipped')

    // "Start agent without waiting for setup"
    await s.call('projects.updateSettings', { id: p.id, set: { startAgentWithoutWaitingForSetup: true, setupCommand: `while ! test -f ${marks}/never; do sleep 0.05; done` } })
    const e = await live(s, await create(s, p.id, 'no wait'))
    expect(e.setup?.state).toBe('running')
  })

  it('I-WT-9 · a repository with a submodule and one that uses Git LFS: submodules initialised, LFS pointers pulled, both in the creation log', async () => {
    const lib = fixture('lib')
    const r = fixture()
    gitIn(r.root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib.root, 'vendor/lib')
    gitIn(r.root, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'add submodule')
    // a stand-in git-lfs on PATH: lists one LFS file and records the pull
    const bin = tmpDir('kea-lfs-')
    const pulled = path.join(bin, 'pulled')
    fs.writeFileSync(path.join(bin, 'git-lfs'), `#!/bin/sh\ncase "$1" in\n  ls-files) echo big.bin ;;\n  pull) pwd > "${pulled}" ;;\nesac\n`, { mode: 0o755 })
    const s = await sessions()
    s.env.PATH = `${bin}:${s.env.PATH}`
    s.env.GIT_ALLOW_PROTOCOL = 'file'
    const p = await s.project(r.root)
    const a = await live(s, await create(s, p.id, 'with submodule'))
    expect(fs.readFileSync(path.join(a.cwd, 'vendor/lib/README.md'), 'utf8')).toBe(fs.readFileSync(path.join(lib.root, 'README.md'), 'utf8'))
    expect(gitIn(a.cwd, 'submodule', 'status')).toMatch(/^ [0-9a-f]{40} vendor\/lib/)
    expect(fs.readFileSync(pulled, 'utf8').trim()).toBe(a.cwd)
    expect(await logOf(s, a.id)).toContain('git lfs pull: done')
  })

  it('I-WT-10 · a dirty main checkout is byte-identical after a create and after a delete; its changes are not carried over', async () => {
    const s = await sessions()
    const r = fixture()
    fs.appendFileSync(path.join(r.root, 'src/math.js'), '// work in progress\n')
    fs.rmSync(path.join(r.root, 'test/counter.test.js'))
    fs.writeFileSync(path.join(r.root, 'scratch.txt'), 'untracked\n')
    gitIn(r.root, 'add', 'scratch.txt')
    fs.writeFileSync(path.join(r.root, 'other.txt'), 'untracked\n')
    const before = snapshot(r.root)
    const index = fs.readFileSync(path.join(r.root, '.git/index'))
    const status = gitIn(r.root, 'status', '--porcelain')
    const p = await s.project(r.root)
    const a = await live(s, await create(s, p.id, 'clean start', { base: { kind: 'head' } }))
    expect(fs.readFileSync(path.join(a.cwd, 'src/math.js'), 'utf8')).not.toContain('work in progress')
    expect(fs.existsSync(path.join(a.cwd, 'scratch.txt'))).toBe(false)
    expect(snapshot(r.root)).toEqual(before)
    expect(gitIn(r.root, 'status', '--porcelain')).toBe(status)
    fs.writeFileSync(path.join(a.cwd, 'session.txt'), 'session work\n')
    await s.call('sessions.delete', { id: a.id, deleteBranch: false })
    expect(snapshot(r.root)).toEqual(before)
    expect(fs.readFileSync(path.join(r.root, '.git/index')).equals(index)).toBe(true)
    expect(gitIn(r.root, 'status', '--porcelain')).toBe(status)
  })

  it('I-WT-11 · a failing post-checkout hook: its output is in the creation log, and the creation completes', async () => {
    const s = await sessions()
    const r = fixture()
    fs.writeFileSync(path.join(r.root, '.git/hooks/post-checkout'), '#!/bin/sh\necho "hook says no" >&2\nexit 7\n', { mode: 0o755 })
    const p = await s.project(r.root)
    const a = await live(s, await create(s, p.id, 'hook fails'))
    const log = await logOf(s, a.id)
    expect(log).toContain('hook says no')
    expect(log).toMatch(/a git hook failed after the checkout/)
    expect(worktreePaths(r.root)).toContain(a.cwd)
  })

  it('I-WT-13 · a `git worktree add` killed midway leaves a locked "initializing" entry: Discard unlocks and removes it; the branch goes with -D only while its tip is base_commit, a branch with a commit stays; a branch the creation did not make stays', async () => {
    let stop: ((id: string) => void) | null = null
    let appear: ((id: string) => void) | null = null
    const s = await sessions({ opts: { faults: (point, id) => (point === 'create:copy' ? stop?.(id) : point === 'create:add' ? appear?.(id) : undefined) } })
    const r = fixture()
    const p = await s.project(r.root)
    // the add "was killed": its directory half made, the entry locked as git leaves it
    stop = (id) => {
      const v = s.c.core.sessions.store.get(id)!
      gitIn(r.root, 'worktree', 'lock', '--reason', 'initializing', v.cwd)
      throw new Error('killed during add')
    }
    const id = await create(s, p.id, 'killed add')
    const v = await s.until(id, 'failed', (x) => x.lifecycle === 'create_failed')
    expect(gitIn(r.root, 'worktree', 'list', '--porcelain')).toMatch(/locked initializing/)
    await s.call('sessions.discard', { id })
    expect(worktreePaths(r.root)).not.toContain(v.cwd)
    expect(fs.existsSync(v.cwd)).toBe(false)
    expect(branches(r.root)).not.toContain(v.branch)

    // a commit on the branch before Discard: the worktree goes, the branch stays
    stop = () => {
      throw new Error('fault after add')
    }
    const id2 = await create(s, p.id, 'committed before discard')
    const v2 = await s.until(id2, 'failed', (x) => x.lifecycle === 'create_failed')
    fs.writeFileSync(path.join(v2.cwd, 'work.txt'), 'work\n')
    gitIn(v2.cwd, 'add', 'work.txt')
    gitIn(v2.cwd, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'work')
    await s.call('sessions.discard', { id: id2 })
    expect(fs.existsSync(v2.cwd)).toBe(false)
    expect(branches(r.root)).toContain(v2.branch)

    // a branch this creation did not make is never deleted, even at base_commit: one that appeared between the checks
    // and the add (Retry fails saying so; Discard leaves it), and an existing branch the session was started on
    appear = (id) => {
      const x = s.c.core.db.get<{ branch: string; base_commit: string }>('SELECT branch, base_commit FROM sessions WHERE id = ?', id)!
      gitIn(r.root, 'branch', x.branch, x.base_commit)
      appear = null
      throw new Error('the user made the branch meanwhile')
    }
    const id3 = await create(s, p.id, 'branch appears before add')
    const v3 = await s.until(id3, 'failed', (x) => x.lifecycle === 'create_failed')
    await s.call('sessions.retry', { id: id3 })
    const again = await s.until(id3, 'failed again', (x) => x.lifecycle === 'create_failed' && x.creation?.error !== v3.creation?.error)
    expect(again.creation?.error).toMatch(/already exists/)
    await s.call('sessions.discard', { id: id3 })
    expect(branches(r.root), 'the user’s branch survives Discard').toContain(v3.branch)
    gitIn(r.root, 'branch', 'feature/mine')
    stop = () => {
      stop = null
      throw new Error('fault after add')
    }
    const id4 = await create(s, p.id, 'on my branch', { base: { kind: 'existing', ref: 'feature/mine' } })
    await s.until(id4, 'failed', (x) => x.lifecycle === 'create_failed')
    await s.call('sessions.discard', { id: id4 })
    expect(branches(r.root)).toContain('feature/mine')
  })
})

describe('remove, snapshot and restore', () => {
  it('I-WT-6 · remove clean / dirty / unpushed / squash-merged: the preview is right, the directory goes, git worktree list is clean, the branch as chosen', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const preview = (id: string) => s.call<DeletePreview>('sessions.deletePreview', { id })

    // clean, nothing committed: "nothing — branch is merged", delete branch ticked
    const clean = await live(s, await create(s, p.id, 'clean'))
    expect(await preview(clean.id)).toMatchObject({ uncommittedFiles: 0, ownCommits: 0, uniqueCommits: 0, merged: true, deleteBranchDefault: true, oversize: [] })
    await s.call('sessions.delete', { id: clean.id, deleteBranch: true })
    expect(fs.existsSync(clean.cwd)).toBe(false)
    expect(worktreePaths(r.root)).not.toContain(clean.cwd)
    expect(branches(r.root)).not.toContain(clean.branch)

    // dirty: counted; kept branch when not ticked
    const dirty = await live(s, await create(s, p.id, 'dirty'))
    fs.writeFileSync(path.join(dirty.cwd, 'a.txt'), 'a\n')
    fs.appendFileSync(path.join(dirty.cwd, 'README.md'), 'more\n')
    expect(await preview(dirty.id)).toMatchObject({ uncommittedFiles: 2, uniqueCommits: 0 })
    await s.call('sessions.delete', { id: dirty.id, deleteBranch: false })
    expect(fs.existsSync(dirty.cwd)).toBe(false)
    expect(branches(r.root)).toContain(dirty.branch)

    // unpushed, unmerged: not pre-ticked; `-d` refuses, `-D` (after the confirmation) deletes
    const ahead = await live(s, await create(s, p.id, 'ahead'))
    fs.writeFileSync(path.join(ahead.cwd, 'f.txt'), 'f\n')
    gitIn(ahead.cwd, 'add', 'f.txt')
    gitIn(ahead.cwd, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'f')
    expect(await preview(ahead.id)).toMatchObject({ ownCommits: 1, uniqueCommits: 1, merged: false, deleteBranchDefault: false })
    const d1 = await s.call<{ branchDeleted: boolean }>('sessions.delete', { id: ahead.id, deleteBranch: true })
    expect(d1.branchDeleted).toBe(false)
    expect(branches(r.root)).toContain(ahead.branch)

    // squash-merged: its patch is on main, so it counts as merged
    const squash = await live(s, await create(s, p.id, 'squash me'))
    fs.writeFileSync(path.join(squash.cwd, 'sq.txt'), 'sq\n')
    gitIn(squash.cwd, 'add', 'sq.txt')
    gitIn(squash.cwd, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'sq')
    gitIn(r.root, 'merge', '-q', '--squash', squash.branch!)
    gitIn(r.root, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'squashed')
    expect(await preview(squash.id)).toMatchObject({ uniqueCommits: 1, merged: true, deleteBranchDefault: true })
    const d2 = await s.call<{ branchDeleted: boolean }>('sessions.delete', { id: squash.id, deleteBranch: true, forceBranch: true })
    expect(d2.branchDeleted).toBe(true)
    expect(gitIn(r.root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })

  it('I-WT-12 · removing a worktree while its agent, shell and server PTYs are alive: all three end and are confirmed exited before the directory is touched', async () => {
    let atTrash: { alive: boolean[]; dir: boolean } | null = null
    const ptys: string[] = []
    const s = await sessions({
      opts: {
        faults: (point, id) => {
          if (point !== 'delete:trash') return
          const v = s.c.core.sessions.store.get(id) ?? null
          atTrash = { alive: ptys.map((p) => holderChildAlive(s.h.home, p)), dir: v ? fs.existsSync(v.cwd) : fs.existsSync(cwd) }
        },
      },
    })
    const r = fixture()
    const p = await s.project(r.root)
    const a = await live(s, await create(s, p.id, 'busy session'))
    const cwd = a.cwd
    const agent = s.c.core.terminals.sessionRecords(a.id).find((x) => x.kind === 'agent')!.ptyId
    const t = s.c.core.terminals
    const shell = await t.launch({ sessionId: a.id, kind: 'shell', command: { argv: ['/bin/sh', '-c', 'trap "" HUP; while :; do sleep 0.05; done'] }, cwd, cols: 80, rows: 24 })
    const server = await t.launch({ sessionId: a.id, kind: 'server', command: { argv: ['/bin/sh', '-c', 'while :; do sleep 0.05; done'] }, cwd, cols: 80, rows: 24 })
    ptys.push(agent, shell.ptyId, server.ptyId)
    await until('all three run', () => ptys.every((x) => holderChildAlive(s.h.home, x)))
    await s.call('sessions.delete', { id: a.id, deleteBranch: true })
    expect(atTrash).toEqual({ alive: [false, false, false], dir: true })
    expect(fs.existsSync(cwd)).toBe(false)
    for (const x of ptys) expect(holderAlive(s.h.home, x)).toBe(false)
  })

  it('I-WT-16 · delete a dirty worktree, then restore it: index, HEAD and branch untouched by the snapshot, the ref before the rename, the same files back; again with the branch deleted and with its name reused; purged after the retention', async () => {
    let clock = Date.now()
    let refAtTrash: string | null = null
    const s = await sessions({
      opts: {
        now: () => clock,
        faults: (point, id) => {
          if (point === 'delete:trash') refAtTrash = gitIn(r.root, 'for-each-ref', '--format=%(refname)', `refs/kea/deleted/${id}`).trim()
        },
      },
    })
    const r = fixture()
    fs.appendFileSync(path.join(r.root, '.gitignore'), '.env\n')
    gitIn(r.root, 'commit', '-q', '-a', '--no-gpg-sign', '--no-verify', '-m', 'ignore .env')
    fs.writeFileSync(path.join(r.root, '.env'), 'SECRET=1\n')
    const p = await s.project(r.root)

    const dirty = async (prompt: string) => {
      const v = await live(s, await create(s, p.id, prompt))
      fs.appendFileSync(path.join(v.cwd, 'src/math.js'), '// modified\n')
      fs.rmSync(path.join(v.cwd, 'src/counter.js'))
      gitIn(v.cwd, 'mv', 'src/hello.js', 'src/greet.js')
      fs.writeFileSync(path.join(v.cwd, 'new.txt'), 'untracked\n')
      fs.mkdirSync(path.join(v.cwd, 'deep/er'), { recursive: true })
      fs.writeFileSync(path.join(v.cwd, 'deep/er/n.txt'), 'nested\n')
      fs.writeFileSync(path.join(v.cwd, 'huge.bin'), Buffer.alloc(L.snapshotUntrackedMaxBytes + 1))
      return v
    }
    const skipEnv = (rel: string) => rel === '.env' || rel === 'huge.bin'

    const a = await dirty('restore me')
    const before = snapshot(a.cwd, skipEnv)
    const head = gitIn(a.cwd, 'rev-parse', 'HEAD').trim()
    const index = fs.readFileSync(gitIn(a.cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim())
    const status = gitIn(a.cwd, 'status', '--porcelain')
    const prev = await s.call<DeletePreview>('sessions.deletePreview', { id: a.id })
    expect(prev.oversize).toEqual([{ path: 'huge.bin', bytes: L.snapshotUntrackedMaxBytes + 1 }])
    // the snapshot alone (the commit and its ref), timed against budget P-WT-1, leaves the worktree exactly as it was
    const { writeSnapshot } = await import('@kea/core/src/worktrees/ops.ts')
    const { RepoMutex } = await import('@kea/core/src/worktrees/mutex.ts')
    const t0 = performance.now()
    await writeSnapshot({ root: r.root, commonDir: path.join(r.root, '.git'), env: s.env, mutex: new RepoMutex() }, { wt: a.cwd, sessionId: 'probe', slug: a.slug, tmpDir: path.join(s.h.home, 'tmp') })
    expect(performance.now() - t0).toBeLessThanOrEqual(BUDGETS['P-WT-1'].max)
    gitIn(r.root, 'update-ref', '-d', 'refs/kea/deleted/probe')
    expect(gitIn(a.cwd, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(fs.readFileSync(gitIn(a.cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim()).equals(index)).toBe(true)
    expect(gitIn(a.cwd, 'status', '--porcelain')).toBe(status)

    await s.call('sessions.delete', { id: a.id, deleteBranch: false })
    expect(refAtTrash).toBe(`refs/kea/deleted/${a.id}`) // the ref exists before the directory is touched
    expect(fs.existsSync(a.cwd)).toBe(false)
    const row = s.c.core.db.get<{ lifecycle: string; deleted_at: number; port_base: number | null; snapshot_ref: string }>('SELECT lifecycle, deleted_at, port_base, snapshot_ref FROM sessions WHERE id = ?', a.id)
    expect(row).toMatchObject({ lifecycle: 'deleted', port_base: null, snapshot_ref: `refs/kea/deleted/${a.id}` })
    expect(gitIn(r.root, 'cat-file', '-e', `refs/kea/deleted/${a.id}:new.txt`)).toBe('')
    expect(() => gitIn(r.root, 'cat-file', '-e', `refs/kea/deleted/${a.id}:.env`)).toThrow()
    expect(() => gitIn(r.root, 'cat-file', '-e', `refs/kea/deleted/${a.id}:huge.bin`)).toThrow()
    const listed = await s.call<{ sessions: { id: string; snapshotFiles: number }[] }>('sessions.listDeleted', { projectId: p.id })
    // modified, deleted, renamed (its deletion and its new file: rename detection off, as the delete sheet counts),
    // and two untracked files; not the ignored .env, not the oversize file
    expect(listed.sessions).toContainEqual(expect.objectContaining({ id: a.id, snapshotFiles: 6 }))

    const res = await s.call<{ branch: string }>('sessions.restore', { id: a.id })
    expect(res.branch).toBe(a.branch)
    const back = await s.until(a.id, 'detached', (v) => v.lifecycle === 'detached')
    expect(back.portBase).not.toBeNull()
    expect(snapshot(a.cwd, skipEnv)).toEqual(before)
    expect(fs.readFileSync(path.join(a.cwd, '.env'), 'utf8')).toBe('SECRET=1\n') // re-copied
    expect(fs.existsSync(path.join(a.cwd, 'huge.bin'))).toBe(false)
    expect(gitIn(r.root, 'for-each-ref', 'refs/kea/deleted/')).toBe('')

    // the branch deleted meanwhile: recreated at the snapshot's parent
    const b = await dirty('branch deleted')
    const bBefore = snapshot(b.cwd, skipEnv)
    await s.call('sessions.delete', { id: b.id, deleteBranch: true, forceBranch: true })
    expect(branches(r.root)).not.toContain(b.branch)
    expect((await s.call<{ branch: string }>('sessions.restore', { id: b.id })).branch).toBe(b.branch)
    expect(snapshot(b.cwd, skipEnv)).toEqual(bBefore)

    // its name reused meanwhile: `<branch>-restored`
    const c = await dirty('name reused')
    await s.call('sessions.delete', { id: c.id, deleteBranch: true, forceBranch: true })
    gitIn(r.root, 'branch', c.branch!)
    gitIn(r.root, 'commit', '-q', '--allow-empty', '--no-gpg-sign', '--no-verify', '-m', 'move main on')
    gitIn(r.root, 'branch', '-f', c.branch!, 'main')
    expect((await s.call<{ branch: string }>('sessions.restore', { id: c.id })).branch).toBe(`${c.branch}-restored`)

    // past the retention: the ref and the row are purged at launch
    const d = await dirty('expire me')
    await s.call('sessions.delete', { id: d.id, deleteBranch: false })
    const retentionDays = SETTINGS.find((k) => k.key === 'general.deletedRetentionDays')!.default as number
    clock += (retentionDays + 1) * 86_400_000
    await s.relaunch()
    expect(gitIn(r.root, 'for-each-ref', `refs/kea/deleted/${d.id}`)).toBe('')
    expect(s.c.core.db.get('SELECT 1 AS x FROM sessions WHERE id = ?', d.id)).toBeUndefined()
  })
})

describe('a delete that does not finish', () => {
  it('I-WT-26 · a delete that fails after its snapshot is undone before the error returns; work done since is in the next delete’s snapshot, and a relaunch never completes a delete over a worktree changed since its snapshot', async () => {
    let failAt: string | null = null
    let onKill: ((id: string) => void) | null = null
    let killed: Promise<void> | null = null
    let s!: SessionsUnderTest
    s = await sessions({
      opts: {
        faults: (point, id) => {
          if (point !== failAt) return
          failAt = null
          if (onKill) {
            onKill(id)
            killed = s.crashAndRelaunch()
            throw new Error(`core killed at ${point}`)
          }
          throw new Error(`injected fault at ${point}`)
        },
      },
    })
    const r = fixture()
    const p = await s.project(r.root)
    const row = (id: string) => s.c.core.db.get<{ lifecycle: string; creation_step: string | null; snapshot_ref: string | null }>('SELECT lifecycle, creation_step, snapshot_ref FROM sessions WHERE id = ?', id)
    const refOf = (id: string) => gitIn(r.root, 'for-each-ref', `refs/kea/deleted/${id}`)

    // the move to the trash fails (in process): the delete is undone, the session goes on as it was
    const a = await live(s, await create(s, p.id, 'delete fails once'))
    fs.writeFileSync(path.join(a.cwd, 'first.txt'), 'before the failed delete\n')
    failAt = 'delete:trash'
    await expect(s.call('sessions.delete', { id: a.id, deleteBranch: false })).rejects.toThrow(/injected fault/)
    expect(row(a.id)).toEqual({ lifecycle: 'detached', creation_step: null, snapshot_ref: null })
    expect(refOf(a.id), 'no ref of a delete that did not happen').toBe('')
    await s.call('sessions.resume', { id: a.id })
    fs.writeFileSync(path.join(a.cwd, 'second.txt'), 'after the failed delete\n')
    await s.call('sessions.delete', { id: a.id, deleteBranch: false })
    await s.call('sessions.restore', { id: a.id })
    expect(fs.readFileSync(path.join(a.cwd, 'first.txt'), 'utf8')).toBe('before the failed delete\n')
    expect(fs.readFileSync(path.join(a.cwd, 'second.txt'), 'utf8'), 'the second delete snapshotted afresh').toBe('after the failed delete\n')

    // the same failure, then an edit and a relaunch: nothing is completed behind the user's back
    const b = await live(s, await create(s, p.id, 'edited after a failed delete'))
    failAt = 'delete:trash'
    await expect(s.call('sessions.delete', { id: b.id, deleteBranch: false })).rejects.toThrow(/injected fault/)
    fs.writeFileSync(path.join(b.cwd, 'later.txt'), 'edited in another editor\n')
    await s.relaunch()
    expect(row(b.id)).toMatchObject({ lifecycle: 'detached', creation_step: null })
    expect(fs.readFileSync(path.join(b.cwd, 'later.txt'), 'utf8')).toBe('edited in another editor\n')

    // Kea killed after the snapshot, the worktree edited before the relaunch: the delete is undone, not completed
    const c = await live(s, await create(s, p.id, 'killed after its snapshot'))
    failAt = 'delete:trash'
    onKill = () => fs.writeFileSync(path.join(c.cwd, 'late.txt'), 'written after the snapshot\n')
    await expect(s.call('sessions.delete', { id: c.id, deleteBranch: false })).rejects.toThrow(/core killed/)
    await until('the relaunch', () => killed !== null)
    await killed
    expect(row(c.id)).toEqual({ lifecycle: 'detached', creation_step: null, snapshot_ref: null })
    expect(refOf(c.id)).toBe('')
    expect(fs.readFileSync(path.join(c.cwd, 'late.txt'), 'utf8')).toBe('written after the snapshot\n')
  })

  it('I-WT-27 · a session deleted with nothing uncommitted (its work committed) restores on its own branch at its own tip, clean, with setup run for the restore and a port block; also with its branch deleted, and with nothing listed as held by the snapshot', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const marks = tmpDir('kea-restore-setup-')
    await s.call('projects.updateSettings', { id: p.id, set: { setupCommand: `echo "$KEA_SETUP_REASON $KEA_SESSION_SLUG $KEA_PORT" >> ${marks}/setup.txt` } })
    const committed = async (prompt: string) => {
      const v = await live(s, await create(s, p.id, prompt))
      fs.writeFileSync(path.join(v.cwd, 'done.txt'), 'committed work\n')
      gitIn(v.cwd, 'add', 'done.txt')
      gitIn(v.cwd, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'work')
      return { v, head: gitIn(v.cwd, 'rev-parse', 'HEAD').trim() }
    }
    for (const deleteBranch of [false, true]) {
      const { v, head } = await committed(`clean restore ${deleteBranch ? 'branch deleted' : 'branch kept'}`)
      await s.call('sessions.delete', { id: v.id, deleteBranch, forceBranch: deleteBranch })
      expect(branches(r.root).includes(v.branch!)).toBe(!deleteBranch)
      const listed = await s.call<{ sessions: { id: string; snapshotFiles: number }[] }>('sessions.listDeleted', { projectId: p.id })
      expect(listed.sessions.find((x) => x.id === v.id)?.snapshotFiles, 'its last commit is not uncommitted work').toBe(0)
      const res = await s.call<{ branch: string }>('sessions.restore', { id: v.id })
      expect(res.branch).toBe(v.branch)
      expect(gitIn(v.cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(v.branch)
      expect(gitIn(v.cwd, 'rev-parse', 'HEAD').trim()).toBe(head)
      expect(gitIn(v.cwd, 'status', '--porcelain')).toBe('')
      expect(branches(r.root).filter((b) => b.includes('-restored'))).toEqual([])
      // Setup runs with KEA_SETUP_REASON=restore, on a newly allocated port block; the session is left detached
      await s.until(v.id, 'restore setup done', (x) => x.setup?.reason === 'restore' && x.setup.state === 'done')
      const port = s.view(v.id)?.portBase
      expect(port).toEqual(expect.any(Number))
      expect(fs.readFileSync(path.join(marks, 'setup.txt'), 'utf8').trim().split('\n').at(-1)).toBe(`restore ${v.slug} ${port}`)
      expect(s.view(v.id)?.lifecycle).toBe('detached')
    }
  })
})

describe('nested repositories', () => {
  it('I-WT-29 · untracked folders that are repositories of their own (a clone, a fresh git init): the delete confirmation names them as not recoverable, the snapshot leaves them out and the delete succeeds; the rest is restored', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const v = await live(s, await create(s, p.id, 'nested repos'))
    const clone = path.join(v.cwd, 'vendor', 'clone')
    fs.mkdirSync(clone, { recursive: true })
    gitIn(clone, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(clone, 'x.txt'), 'x\n')
    gitIn(clone, 'add', 'x.txt')
    gitIn(clone, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'x')
    fs.writeFileSync(path.join(clone, 'wip.txt'), 'its own uncommitted work\n')
    const fresh = path.join(v.cwd, 'scratch')
    fs.mkdirSync(fresh)
    gitIn(fresh, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(fresh, 'z.txt'), 'z\n')
    fs.writeFileSync(path.join(v.cwd, 'kept.txt'), 'restorable\n')
    const prev = await s.call<DeletePreview>('sessions.deletePreview', { id: v.id })
    expect(prev.nestedRepos).toEqual(['scratch', 'vendor/clone'])
    await s.call('sessions.delete', { id: v.id, deleteBranch: false })
    expect(fs.existsSync(v.cwd)).toBe(false)
    expect(() => gitIn(r.root, 'cat-file', '-e', `refs/kea/deleted/${v.id}:vendor/clone`)).toThrow()
    await s.call('sessions.restore', { id: v.id })
    expect(fs.readFileSync(path.join(v.cwd, 'kept.txt'), 'utf8')).toBe('restorable\n')
    expect(fs.existsSync(path.join(v.cwd, 'vendor', 'clone', 'x.txt'))).toBe(false)
  })
})

/**
 * A folder on a volume of its own, gone with the test: a disk image on macOS; on Linux the tmpfs at /dev/shm, which no
 * temp folder shares (an unprivileged test cannot mount one of its own).
 */
function secondVolume(): string {
  if (kitOs.system === 'linux') {
    const vol = fs.mkdtempSync('/dev/shm/kea-vol-') // os-ok: Linux's shared-memory tmpfs
    cleanup.push(() => fs.rmSync(vol, { recursive: true, force: true }))
    expect(fs.statSync(vol).dev, 'another file system than the temp folder').not.toBe(fs.statSync(os.tmpdir()).dev)
    return vol
  }
  const mount = tmpDir('kea-vol-')
  const dmg = path.join(mount, 'vol.dmg')
  execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-size', '32m', '-fs', 'APFS', '-volname', 'KeaTestVol', dmg]) // os-ok: macOS test tool (Linux takes /dev/shm above)
  const attached = execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountrandom', mount, dmg]).toString() // os-ok: macOS test tool (Linux takes /dev/shm above)
  const vol = attached.trim().split('\n').pop()!.split('\t').pop()!.trim()
  cleanup.push(() => execFileSync('/usr/bin/hdiutil', ['detach', '-force', vol])) // os-ok: macOS test tool (Linux takes /dev/shm above)
  return vol
}

describe('reconciliation and teardown', () => {
  it('I-WT-7 · an orphaned worktree, a missing worktree, a stale trash entry and an add killed midway: each found and reported, and only Kea’s own interrupted add unlocked', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const a = await live(s, await create(s, p.id, 'goes missing'))
    // an orphan: a worktree under Kea's root that no session owns
    const root = path.dirname(path.dirname(a.cwd))
    const orphan = path.join(root, 'demo', 'nobody-owns-this')
    gitIn(r.root, 'worktree', 'add', '-q', '-b', 'kea/orphan', orphan)
    // a stale trash entry (what a crash left: moveToTrash names them by ULID)
    fs.mkdirSync(path.join(root, KEA_TRASH, ulid(), 'x'), { recursive: true })
    // `git worktree add`s killed midway (a locked "initializing" entry, no directory): one under Kea's root, one the
    // user is running elsewhere
    const initializing = (wt: string, branch: string) => {
      gitIn(r.root, 'worktree', 'add', '-q', '-b', branch, wt)
      gitIn(r.root, 'worktree', 'lock', '--reason', 'initializing', wt)
      fs.rmSync(wt, { recursive: true, force: true })
      return fs.realpathSync(path.dirname(wt)) + '/' + path.basename(wt)
    }
    const killedAdd = initializing(path.join(root, 'demo', 'killed-add'), 'kea/killed-add')
    const usersAdd = initializing(path.join(tmpDir('kea-users-wt-'), 'in-progress'), 'users/in-progress')
    // the session's worktree disappears outside Kea
    await s.call('sessions.stop', { id: a.id })
    fs.rmSync(a.cwd, { recursive: true, force: true })
    await s.relaunch()
    const listed = gitIn(r.root, 'worktree', 'list', '--porcelain')
    expect(listed, 'Kea’s interrupted add: unlocked and pruned').not.toContain(killedAdd)
    expect(listed, 'one outside Kea’s roots is not Kea’s to touch').toMatch(new RegExp(`worktree ${usersAdd}\nHEAD [0-9a-f]+\nbranch refs/heads/users/in-progress\nlocked initializing`))
    expect(s.view(a.id)?.worktreeMissing).toBe(true)
    expect(s.view(a.id)?.lifecycle).toBe('detached') // no automatic action
    const o = await s.call<{ orphans: { path: string; branch: string | null }[] }>('worktrees.orphans', { projectId: p.id })
    expect(o.orphans).toEqual([expect.objectContaining({ path: fs.realpathSync(orphan), branch: 'kea/orphan' })])
    expect(fs.readdirSync(path.join(root, KEA_TRASH))).toEqual([])
    // Recreate from branch
    await s.call('sessions.recreateWorktree', { id: a.id })
    expect(fs.existsSync(a.cwd)).toBe(true)
    expect(s.view(a.id)?.worktreeMissing).toBe(false)
    // Adopt / Remove
    const adopted = await s.call<{ sessionId: string }>('worktrees.adopt', { projectId: p.id, path: fs.realpathSync(orphan) })
    expect(s.view(adopted.sessionId)).toMatchObject({ lifecycle: 'detached', cwd: fs.realpathSync(orphan), branch: 'kea/orphan' })
  })

  it('I-WT-14 · the worktree root moved to a second volume: deleting an old session renames into the old root’s .kea-trash (no EXDEV); orphans and trash under both roots are found', async () => {
    const vol = secondVolume()
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const old = await live(s, await create(s, p.id, 'on the old root'))
    const oldRoot = path.dirname(path.dirname(old.cwd))
    // the setting moves (new sessions only)
    const newRoot = path.join(vol, 'worktrees')
    await s.call('settings.set', { key: 'general.worktreeRoot', value: newRoot })
    const fresh = await live(s, await create(s, p.id, 'on the new root'))
    expect(fresh.cwd.startsWith(`${fs.realpathSync(vol)}/`) || fresh.cwd.startsWith(`${vol}/`)).toBe(true)
    // each session's cwd is inside the worktree root recorded on its own row
    for (const v of [old, fresh]) {
      const row = s.c.core.db.get<{ cwd: string; worktree_root: string }>('SELECT cwd, worktree_root FROM sessions WHERE id = ?', v.id)!
      expect(row.cwd.startsWith(`${row.worktree_root}/`)).toBe(true)
    }
    await s.call('sessions.delete', { id: old.id, deleteBranch: true })
    expect(fs.existsSync(old.cwd)).toBe(false)
    expect(s.c.log.entries.some((e) => /EXDEV/.test(JSON.stringify(e)))).toBe(false)
    // orphans and trash under both roots
    gitIn(r.root, 'worktree', 'add', '-q', '-b', 'kea/o1', path.join(oldRoot, 'demo', 'o1'))
    gitIn(r.root, 'worktree', 'add', '-q', '-b', 'kea/o2', path.join(newRoot, 'demo', 'o2'))
    fs.mkdirSync(path.join(oldRoot, KEA_TRASH, ulid()), { recursive: true })
    fs.mkdirSync(path.join(newRoot, KEA_TRASH, ulid()), { recursive: true })
    await s.relaunch()
    const o = await s.call<{ orphans: { path: string }[] }>('worktrees.orphans', { projectId: p.id })
    expect(o.orphans.map((x) => path.basename(x.path)).sort()).toEqual(['o1', 'o2'])
    expect(fs.readdirSync(path.join(oldRoot, KEA_TRASH))).toEqual([])
    expect(fs.readdirSync(path.join(newRoot, KEA_TRASH))).toEqual([])
    await s.call('sessions.delete', { id: fresh.id, deleteBranch: true })
  })

  it('I-WT-23 · a worktree root that holds the project, lies inside it or is the home folder: refused for new sessions and never searched; the main checkout is never an orphan, and Remove or Adopt of a project root is refused', async () => {
    const r = fixture()
    const s = await sessions({ settings: { general: { worktreeRoot: path.dirname(r.root) } } })
    const p = await s.project(r.root)
    const o = await s.call<{ orphans: { path: string }[] }>('worktrees.orphans', { projectId: p.id, refresh: true })
    expect(o.orphans, 'the main checkout is not an orphan').toEqual([])
    await expect(s.call('worktrees.remove', { projectId: p.id, path: r.root })).rejects.toMatchObject({ code: 'not_found' })
    await expect(s.call('worktrees.adopt', { projectId: p.id, path: r.root })).rejects.toMatchObject({ code: 'not_found' })
    await s.idle()
    expect(fs.existsSync(path.join(r.root, '.git')), 'the repository is where it was').toBe(true)
    const rootProblem = async () =>
      (await s.call<{ problems: { code: string; hard: boolean }[] }>('sessions.validate', { projectId: p.id, prompt: 'x', isolation: 'worktree', base: { kind: 'head' } })).problems
    for (const root of [path.dirname(r.root), path.join(r.root, 'worktrees'), s.env.HOME!]) {
      await s.call('settings.set', { key: 'general.worktreeRoot', value: root })
      expect(await rootProblem(), root).toContainEqual(expect.objectContaining({ code: 'worktreeRoot', hard: true }))
      await expect(s.call('sessions.create', createArgs(p.id, 'refused here')), root).rejects.toMatchObject({ code: 'invalid_session' })
    }
    expect(fs.existsSync(path.join(r.root, 'worktrees')), 'nothing made inside the project').toBe(false)
    // in place is unaffected
    expect(await s.call<{ problems: unknown[] }>('sessions.validate', { projectId: p.id, prompt: 'x', isolation: 'inplace', base: { kind: 'head' } })).toMatchObject({ problems: [] })
  })

  it('I-WT-24 · a worktree root reached through a symlink: no session’s own worktree is listed as an orphan; a real orphan still is', async () => {
    const real = tmpDir('kea-realroot-')
    const link = path.join(tmpDir('kea-links-'), 'wt')
    fs.symlinkSync(real, link)
    const r = fixture()
    const s = await sessions({ settings: { general: { worktreeRoot: link } } })
    const p = await s.project(r.root)
    const a = await live(s, await create(s, p.id, 'mine not orphan'))
    const orphan = path.join(link, 'demo', 'made-by-hand')
    gitIn(r.root, 'worktree', 'add', '-q', '-b', 'kea/by-hand', orphan)
    const o = await s.call<{ orphans: { path: string }[] }>('worktrees.orphans', { projectId: p.id, refresh: true })
    expect(o.orphans.map((x) => path.basename(x.path))).toEqual(['made-by-hand'])
    expect(fs.existsSync(a.cwd)).toBe(true)
  })

  it('I-WT-28 · Remove of an orphan fails closed: one with uncommitted work, and one whose git status fails, are refused without force and kept; with force they go', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const a = await live(s, await create(s, p.id, 'anchor'))
    const root = path.dirname(path.dirname(a.cwd))
    const dirty = path.join(root, 'demo', 'dirty-orphan')
    const broken = path.join(root, 'demo', 'broken-orphan')
    gitIn(r.root, 'worktree', 'add', '-q', '-b', 'kea/o1', dirty)
    gitIn(r.root, 'worktree', 'add', '-q', '-b', 'kea/o2', broken)
    fs.writeFileSync(path.join(dirty, 'work.txt'), 'precious\n')
    fs.writeFileSync(path.join(broken, 'work.txt'), 'precious too\n')
    fs.writeFileSync(path.join(broken, '.git'), 'gitdir: /nonexistent/gitdir\n') // git status fails there
    const o = await s.call<{ orphans: { path: string }[] }>('worktrees.orphans', { projectId: p.id, refresh: true })
    expect(o.orphans.map((x) => path.basename(x.path)).sort()).toEqual(['broken-orphan', 'dirty-orphan'])
    expect(await s.call('worktrees.remove', { projectId: p.id, path: dirty })).toEqual({ removed: false, dirty: 1, statusFailed: false })
    expect(await s.call('worktrees.remove', { projectId: p.id, path: broken })).toEqual({ removed: false, dirty: 0, statusFailed: true })
    expect(fs.readFileSync(path.join(broken, 'work.txt'), 'utf8')).toBe('precious too\n')
    expect(fs.readFileSync(path.join(dirty, 'work.txt'), 'utf8')).toBe('precious\n')
    for (const x of [dirty, broken]) {
      expect(await s.call('worktrees.remove', { projectId: p.id, path: x, force: true })).toMatchObject({ removed: true })
      expect(fs.existsSync(x)).toBe(false)
    }
  })

  it('I-WT-25 · launch empties only what Kea put in a root’s trash: a stale ULID-named entry goes; a `.trash` of the user’s and anything else in the trash directory stay', async () => {
    const root = tmpDir('kea-own-root-')
    fs.mkdirSync(path.join(root, '.trash'))
    fs.writeFileSync(path.join(root, '.trash', 'users-file.txt'), 'precious\n')
    fs.mkdirSync(path.join(root, KEA_TRASH, ulid(), 'x'), { recursive: true })
    fs.writeFileSync(path.join(root, KEA_TRASH, 'notes.txt'), 'not Kea’s\n')
    const s = await sessions({ settings: { general: { worktreeRoot: root } } })
    await s.idle()
    expect(fs.readFileSync(path.join(root, '.trash', 'users-file.txt'), 'utf8')).toBe('precious\n')
    expect(fs.readdirSync(path.join(root, KEA_TRASH))).toEqual(['notes.txt'])
  })

  it('I-WT-15 · teardown records its environment on archive and delete, after every PTY exited; setup re-runs on unarchive; a failing and a hanging script never block, and surface; Discard of a creation whose setup started runs teardown first, also after a relaunch', async () => {
    const marks = tmpDir('kea-teardown-')
    const s = await sessions({ opts: { teardownTimeoutMs: L.teardownGraceMs } })
    const r = fixture()
    const p = await s.project(r.root)
    const record = `echo "$KEA_TEARDOWN_REASON $KEA_SESSION_SLUG $KEA_PORT" >> ${marks}/teardown.txt; ls "$KEA_WORKTREE" > /dev/null`
    await s.call('projects.updateSettings', { id: p.id, set: { teardownCommand: record, setupCommand: `echo "$KEA_SETUP_REASON" >> ${marks}/setup.txt` } })
    const a = await live(s, await create(s, p.id, 'tear me down'))
    const port = a.portBase
    const agent = s.c.core.terminals.sessionRecords(a.id).find((x) => x.kind === 'agent')!.ptyId
    const shell = (await s.call<{ ptyId: string }>('sessions.openShell', { id: a.id })).ptyId
    // the teardown says which of the session's other processes still run when it starts: none may
    const pids = [agent, shell].map((x) => holderState(s.h.home, x)!.childPid!)
    const alive = `for p in ${pids.join(' ')}; do kill -0 $p 2>/dev/null && echo "alive $p" >> ${marks}/alive.txt; done; true`
    await s.call('projects.updateSettings', { id: p.id, set: { teardownCommand: `${record}; ${alive}` } })
    const ar = await s.call<{ archived: boolean; teardownFailed: boolean }>('sessions.archive', { id: a.id, confirmed: true })
    expect(ar).toEqual({ archived: true, reasons: [], teardownFailed: false })
    expect(holderChildAlive(s.h.home, agent)).toBe(false)
    expect(fs.readFileSync(path.join(marks, 'teardown.txt'), 'utf8')).toBe(`archive ${a.slug} ${port}\n`)
    expect(fs.existsSync(path.join(marks, 'alive.txt')), 'teardown ran after every other PTY of the session exited').toBe(false)
    expect(s.view(a.id)).toMatchObject({ lifecycle: 'archived', portBase: null, teardownFailed: false })
    await s.call('sessions.unarchive', { id: a.id })
    await s.until(a.id, 'setup re-ran', (v) => v.setup?.reason === 'unarchive' && v.setup.state === 'done')
    expect(fs.readFileSync(path.join(marks, 'setup.txt'), 'utf8')).toBe('create\nunarchive\n')
    await s.call('sessions.delete', { id: a.id, deleteBranch: true })
    expect(fs.readFileSync(path.join(marks, 'teardown.txt'), 'utf8').split('\n')[1]).toMatch(/^delete /)

    // a failing teardown: archived anyway, "Teardown failed", Retry teardown
    await s.call('projects.updateSettings', { id: p.id, set: { teardownCommand: `test -f ${marks}/fixed || exit 4` } })
    const b = await live(s, await create(s, p.id, 'teardown fails'))
    const bar = await s.call<{ archived: boolean; teardownFailed: boolean }>('sessions.archive', { id: b.id, confirmed: true })
    expect(bar).toMatchObject({ archived: true, teardownFailed: true })
    expect(s.view(b.id)).toMatchObject({ lifecycle: 'archived', teardownFailed: true })
    fs.writeFileSync(path.join(marks, 'fixed'), '')
    expect(await s.call('sessions.retryTeardown', { id: b.id })).toEqual({ ok: true, teardownFailed: false })
    expect(s.view(b.id)?.teardownFailed).toBe(false)

    // a hanging teardown: terminated after its time limit; the archive and the delete complete and say so
    const hangPid = path.join(marks, 'hang.pid')
    const killed = () => {
      const pid = Number(fs.readFileSync(hangPid, 'utf8'))
      fs.rmSync(hangPid)
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }
    await s.call('projects.updateSettings', { id: p.id, set: { teardownCommand: `echo $$ > ${hangPid}; while :; do sleep 0.05; done` } })
    const c = await live(s, await create(s, p.id, 'teardown hangs'))
    expect(await s.call('sessions.archive', { id: c.id, confirmed: true })).toMatchObject({ archived: true, teardownFailed: true })
    expect(s.view(c.id)).toMatchObject({ lifecycle: 'archived', teardownFailed: true })
    expect(killed(), 'the hanging teardown was terminated').toBe(true)
    const del = await s.call<{ deleted: boolean; teardownFailed: boolean; log: { text: string } | null }>('sessions.delete', { id: c.id, deleteBranch: true })
    expect(del).toMatchObject({ deleted: true, teardownFailed: true })
    expect(killed()).toBe(true)
    expect(fs.existsSync(c.cwd)).toBe(false)
    expect(await logOfDeleted(s, c.id)).toBeNull() // its state directory (and log) went with it
    // so the delete hands back the log as it left it, for the toast's View log
    expect(del.log?.text, 'the log the delete returned').toMatch(/teardown \(delete\)[\s\S]*teardown timed out after \d+ ms; terminated/)

    // Discard of a creation whose setup had started: teardown (delete) before the rollback
    await s.call('projects.updateSettings', { id: p.id, set: { setupCommand: 'exit 9', teardownCommand: `echo "discard-teardown $KEA_TEARDOWN_REASON" >> ${marks}/discard.txt; test -d "$KEA_WORKTREE"` } })
    const dId = await create(s, p.id, 'discard after setup')
    const d = await s.until(dId, 'setup failed', (v) => v.setup?.state === 'failed')
    await s.call('sessions.discard', { id: dId })
    expect(fs.readFileSync(path.join(marks, 'discard.txt'), 'utf8')).toBe('discard-teardown delete\n')
    expect(fs.existsSync(d.cwd)).toBe(false)
    // the same after a relaunch, when only the creation's journal says setup had started
    const eId = await create(s, p.id, 'discard after relaunch')
    const e = await s.until(eId, 'setup failed', (v) => v.setup?.state === 'failed')
    await s.relaunch()
    expect(s.view(eId)).toMatchObject({ lifecycle: 'create_failed', setup: null })
    await s.call('sessions.discard', { id: eId })
    expect(fs.readFileSync(path.join(marks, 'discard.txt'), 'utf8')).toBe('discard-teardown delete\ndiscard-teardown delete\n')
    expect(fs.existsSync(e.cwd)).toBe(false)
  })
})

describe('a teardown’s terminal', () => {
  it('I-WT-34 · a teardown’s terminal leaves nothing behind once it has ended and its output is in the log: its ring, checkpoint, state file and record are gone after an archive whose script exits, fails, or ignores the terminate, and after Retry teardown; one that nobody waits for any more (the core that started it went) is ended when it exits, or at the next launch when it ended meanwhile; a session keeps its other terminals’ files', async () => {
    const s = await sessions({ opts: { teardownTimeoutMs: L.teardownGraceMs } })
    const r = fixture()
    const p = await s.project(r.root)
    const marks = tmpDir('kea-teardown-left-')
    /** The PTY files in the session's state directory, and the PTYs core has on record for it. */
    const left = (id: string) => ({
      files: fs.readdirSync(path.join(s.h.home, 'sessions', id)).filter((f) => /\.(ring|json|ckpt)$/.test(f)).sort(),
      records: s.c.core.terminals.sessionRecords(id).map((x) => `${x.kind} ${x.ptyId}`).sort(),
    })
    const started = async (what: string, teardownCommand: string): Promise<{ id: string; agent: string; cwd: string }> => {
      await s.call('projects.updateSettings', { id: p.id, set: { teardownCommand } })
      const v = await live(s, await create(s, p.id, `teardown ${what}`))
      return { id: v.id, cwd: v.cwd, agent: s.c.core.terminals.sessionRecords(v.id).find((x) => x.kind === 'agent')!.ptyId }
    }
    const archived = async (what: string, teardownCommand: string): Promise<{ id: string; agent: string }> => {
      const x = await started(what, teardownCommand)
      expect(await s.call('sessions.archive', { id: x.id, confirmed: true }), what).toMatchObject({ archived: true })
      await s.idle()
      return x
    }
    const onlyTheAgentsCheckpoint = (x: { agent: string }) => ({ files: [`${x.agent}.ckpt`], records: [`agent ${x.agent}`] })

    // what `runTeardown` waits for: gone when the archive returns
    const ok = await archived('exits', 'echo torn down')
    expect(left(ok.id), 'a teardown that exits').toEqual(onlyTheAgentsCheckpoint(ok))
    expect(await logOf(s, ok.id)).toMatch(/teardown output:\n.*torn down/)
    const fails = await archived('fails', 'echo no; exit 4')
    expect(left(fails.id), 'a teardown that fails').toEqual(onlyTheAgentsCheckpoint(fails))
    expect(await s.call('sessions.retryTeardown', { id: fails.id })).toEqual({ ok: true, teardownFailed: true })
    expect(left(fails.id), 'Retry teardown').toEqual(onlyTheAgentsCheckpoint(fails))
    // one that ignores the terminate: killed after its grace; the archive completes either way
    const hangs = await archived('hangs', `trap '' TERM HUP; while :; do sleep 0.05; done`)
    await until('the hanging teardown’s terminal is gone', () => left(hangs.id).files.length === 1 && left(hangs.id).records.length === 1)
    expect(left(hangs.id), 'a teardown that hangs').toEqual(onlyTheAgentsCheckpoint(hangs))

    // A teardown nobody waits for: what a core finds whose predecessor went while one ran (its record, its holder
    // still running). Made here as `runTeardown` makes it, a `script` PTY marked as the session's teardown before it
    // is launched, with no run behind it.
    const outlived = async (what: string): Promise<{ id: string; agent: string; ptyId: string; gate: string }> => {
      const x = await started(what, 'true')
      const gate = path.join(marks, `${what}.go`)
      const script = `echo "last words of ${what}"; echo began > ${gate}.began; until test -f ${gate}; do sleep 0.05; done`
      const ptyId = newPtyId()
      kvSet(s.c.core.db, `${TEARDOWN_KV}${ptyId}`, x.id)
      await s.c.core.terminals.launch({ ptyId, sessionId: x.id, kind: 'script', title: 'Teardown', command: { argv: ['/bin/sh', '-c', script] }, cwd: x.cwd, cols: 80, rows: 24 })
      await until(`${what}: the teardown runs`, () => fs.existsSync(`${gate}.began`))
      expect(left(x.id).files, what).toEqual(expect.arrayContaining([`${ptyId}.json`, `${ptyId}.ring`]))
      return { ...x, ptyId, gate }
    }
    const gone = async (x: { id: string; agent: string; ptyId: string }, what: string): Promise<void> => {
      await until(`${what}: the teardown’s terminal is gone`, () => !s.c.core.terminals.record(x.ptyId) && left(x.id).files.every((f) => f.startsWith(`${x.agent}.`)))
      expect(left(x.id).records, `${what}: the session's own terminal stays`).toEqual([`agent ${x.agent}`])
      expect(left(x.id).files, `${what}: with its files`).toEqual(expect.arrayContaining([`${x.agent}.json`, `${x.agent}.ring`]))
      await s.idle()
      expect(await logOf(s, x.id), `${what}: its output is in the log`).toMatch(new RegExp(`teardown output:\\n.*last words of ${what}[\\s\\S]*teardown ended after Kea stopped waiting for it \\(exit 0\\)`))
    }
    // it ends while core runs: the exit ends its terminal
    const later = await outlived('ends-later')
    await s.relaunch()
    expect(s.c.core.terminals.record(later.ptyId), 'still running: left to end by itself').toMatchObject({ state: 'running' })
    fs.writeFileSync(later.gate, '')
    await gone(later, 'ends-later')
    // it ends while no core runs: the next core's first reconciliation finds its record ended
    const meanwhile = await outlived('ends-meanwhile')
    await s.idle()
    s.c.dispose()
    fs.writeFileSync(meanwhile.gate, '')
    await until('the teardown ends with no core', () => !holderChildAlive(s.h.home, meanwhile.ptyId))
    await s.relaunch()
    await gone(meanwhile, 'ends-meanwhile')
    // every teardown's mark went with its record (the runs', the failed ones', the outlived ones')
    await s.idle()
    expect(s.c.core.db.all(`SELECT key FROM kv WHERE key LIKE '${TEARDOWN_KV}%'`)).toEqual([])
  })

  // The end of a teardown terminal that outlived its run is queued in its session's turn. When that turn is a delete,
  // the delete forgets the terminal's record first, so the queued end finds no record and must still drop the mark in
  // `kv`, or the mark stays until the next launch's reconciliation sweeps it.
  it('I-SES-18 · a session deleted while a teardown that outlived its run is still on record leaves no teardown mark behind: the delete stops that terminal and forgets its record, and the end queued for it drops its mark', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    await s.call('projects.updateSettings', { id: p.id, set: { teardownCommand: 'true' } })
    const v = await live(s, await create(s, p.id, 'teardown outlived, then deleted'))
    // a teardown nobody waits for, made as in the test above: marked as the session's before launch, no run behind it
    const gate = path.join(tmpDir('kea-teardown-deleted-'), 'go')
    const ptyId = newPtyId()
    kvSet(s.c.core.db, `${TEARDOWN_KV}${ptyId}`, v.id)
    await s.c.core.terminals.launch({ ptyId, sessionId: v.id, kind: 'script', title: 'Teardown', command: { argv: ['/bin/sh', '-c', `echo began > ${gate}.began; until test -f ${gate}; do sleep 0.05; done`] }, cwd: v.cwd, cols: 80, rows: 24 })
    await until('the teardown runs', () => fs.existsSync(`${gate}.began`))
    expect(await s.call('sessions.delete', { id: v.id, deleteBranch: true }), 'the delete ends it').toMatchObject({ deleted: true })
    await s.idle()
    expect(s.c.core.terminals.record(ptyId), 'its record went with the session').toBeUndefined()
    expect(s.c.core.db.all(`SELECT key, value FROM kv WHERE key LIKE '${TEARDOWN_KV}%'`), 'and so did its mark').toEqual([])
  })
})

describe('the session log', () => {
  it('I-WT-22 · a setup’s and a teardown’s output reach the session log whole: the last line a script prints right before it exits is there', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const script = (name: string) => `echo "${name} line 1"; echo "${name} line 2"; echo "${name} last line"; exit 3`
    await s.call('projects.updateSettings', { id: p.id, set: { setupCommand: script('setup'), teardownCommand: script('teardown') } })
    for (const n of [1, 2, 3]) {
      const id = await create(s, p.id, `log whole ${n}`)
      await s.until(id, 'setup failed', (v) => v.setup?.state === 'failed')
      expect(await logOf(s, id), `setup run ${n}: its whole output in the log`).toMatch(/setup output:\n\S+ setup line 1\n\S+ setup line 2\n\S+ setup last line\n\S+ setup failed \(exit 3\)/)
      await s.call('sessions.setup', { id, action: 'startAnyway' })
      await live(s, id)
      const ar = await s.call<{ teardownFailed: boolean }>('sessions.archive', { id, confirmed: true })
      expect(ar.teardownFailed).toBe(true)
      expect(await logOf(s, id), `teardown run ${n}: its whole output in the log`).toMatch(/teardown output:\n\S+ teardown line 1\n\S+ teardown line 2\n\S+ teardown last line\n\S+ teardown failed \(exit 3\)/)
    }
  })
})

async function logOfDeleted(s: SessionsUnderTest, id: string): Promise<string | null> {
  const f = path.join(s.h.home, 'sessions', id, 'creation.log')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
}

describe('git missing', () => {
  // the Xcode stub is macOS's: Linux has none to stand in for git
  it.runIf(kitOs.system === 'darwin')('I-WT-19 · only the Xcode stub and no Command Line Tools: a clear error, the stub never run (no install dialog), projects open as non-git, the banner says how to fix it', async () => {
    const dir = tmpDir('kea-xcode-')
    const ran = path.join(dir, 'stub-ran')
    const stub = path.join(dir, 'git')
    fs.writeFileSync(stub, `#!/bin/sh\ntouch "${ran}"\nexit 1\n`, { mode: 0o755 })
    const xcodeSelect = path.join(dir, 'xcode-select')
    fs.writeFileSync(xcodeSelect, '#!/bin/sh\necho "xcode-select: error: unable to get active developer directory" >&2\nexit 2\n', { mode: 0o755 })
    const s = await startSessions({ env: { PATH: dir }, opts: { gitBinary: undefined as unknown as string, gitProbePaths: { stub, xcodeSelect } } })
    cleanup.push(() => s.dispose())
    const r = fixture()
    // the PATH core resolved git from was the shell's: only the stub's directory
    expect(await s.c.core.gitReady).toBe(false)
    expect(fs.existsSync(ran)).toBe(false)
    const p = await s.project(r.root)
    expect(p.isGit).toBe(false)
    expect(s.c.core.banners.store.get('gitMissing')).toMatchObject({ source: 'git', fix: expect.stringContaining('xcode-select --install') })
    const v = await s.call<{ problems: { code: string; hard: boolean }[] }>('sessions.validate', { projectId: p.id, prompt: 'x', isolation: 'worktree', base: { kind: 'default' } })
    expect(v.problems).toContainEqual(expect.objectContaining({ code: 'notGit', hard: false }))
  })
})
