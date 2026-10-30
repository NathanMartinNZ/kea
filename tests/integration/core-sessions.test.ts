// The session lifecycle in core against real git, real holders and repos from tools/repo-factory: core assembled as
// main.ts assembles it, on a temp KEA_HOME, wired to a real ptyhost. Every session runs the `shell` pseudo-agent, or
// what a test's agent command answers.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { blockBases, blockFree, bindProbe } from '@kea/core/src/server/ports.ts'
import type { AgentCommand, AgentLaunchHow } from '@kea/core/src/sessions/sessions.ts'
import { L, SETTINGS, type DeletePreview, type SessionView } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { kitOs } from '../../packages/kit/src/os/index.ts'
import { holderAlive, until } from '../support/holders.ts'
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

const settingDefault = (key: string) => SETTINGS.find((k) => k.key === key)!.default as number
const DAY_MS = 86_400_000

async function live(s: SessionsUnderTest, id: string): Promise<SessionView> {
  const v = await s.until(id, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
  if (v.lifecycle !== 'live') throw new Error(`creation failed: ${v.creation?.error}`)
  return v
}

async function create(s: SessionsUnderTest, projectId: string, prompt: string, more: Record<string, unknown> = {}): Promise<SessionView> {
  const r = await s.call<{ sessionId: string }>('sessions.create', createArgs(projectId, prompt, more))
  return live(s, r.sessionId)
}

const commit = (dir: string, file: string, msg = file) => {
  fs.writeFileSync(path.join(dir, file), `${msg}\n`)
  gitIn(dir, 'add', file)
  gitIn(dir, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', msg)
}

describe('a PTY that ends at once', () => {
  it('I-SES-5 · a script that exits before its launch is recorded (during the spawn call, or before the holder list answers) still ends its record with its exit code and fires one exit event', async () => {
    let hold: 'spawn' | 'list' | null = null
    let spawned = ''
    const exitNoted = (ptyId: string) => s.h.notes.some((n) => n.m === 'pty.exit' && (n.a as { ptyId: string }).ptyId === ptyId)
    const s: SessionsUnderTest = await sessions({
      // the exit note reaches core before the spawn call returns, or before the holder list core asks for next answers
      wrap: async (m, a, run) => {
        if (m === 'pty.spawn') {
          spawned = a.ptyId as string
          const r = await run()
          if (hold === 'spawn') await until('the child’s exit note', () => exitNoted(spawned))
          return r
        }
        if (m === 'pty.list' && hold === 'list') await until('the child’s exit note', () => exitNoted(spawned))
        return run()
      },
    })
    const r = fixture()
    const p = await s.project(r.root)
    const v = await live(s, (await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, 'quick exits'))).sessionId)
    const t = s.c.core.terminals
    const exits = new Map<string, number>()
    const sub = t.exits.event((e) => exits.set(e.ptyId, (exits.get(e.ptyId) ?? 0) + 1))
    cleanup.push(() => sub.dispose())
    for (const [i, when] of (['spawn', 'list', null] as const).entries()) {
      hold = when
      const { ptyId } = await t.launch({ sessionId: v.id, kind: 'script', title: 'Teardown', command: { argv: ['/bin/sh', '-c', `exit ${i + 3}`] }, cwd: v.cwd, cols: 80, rows: 24 })
      hold = null
      expect(await t.waitExit(ptyId, 10_000)).toBe(true)
      await until(`the exit event of ${ptyId} (${when})`, () => exits.has(ptyId))
      expect(t.record(ptyId), `exit during ${when}`).toMatchObject({ state: 'exited', exitCode: i + 3, exitSignal: null })
      expect(exits.get(ptyId)).toBe(1)
    }
  })
})

describe('optimistic creation', () => {
  it('I-SES-7 · create answers with the row listed before any git check: a branch that appeared after validation fails the creation in place at its first step, again on Retry, and Discard leaves that branch; an automatic name whose branch exists moves to the next free one, also on a Retry from the first step', async () => {
    let failGit = false
    const s = await sessions({ opts: { faults: (point) => {
      if (point === 'create:git' && failGit) {
        failGit = false
        throw new Error('injected: Kea quit here')
      }
    } } })
    const r = fixture()
    const p = await s.project(r.root)
    gitIn(r.root, 'branch', 'taken')
    gitIn(r.root, 'branch', 'kea/fix-bug')
    const tips = () => Object.fromEntries(['taken', 'kea/fix-bug'].map((b) => [b, gitIn(r.root, 'rev-parse', b).trim()]))
    const before = tips()
    const settled = (x: SessionView) => x.lifecycle === 'live' || x.lifecycle === 'create_failed'
    // the branch asked for exists (made after the composer validated): no rejection, the row says why in place
    const asked = await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, 'use taken', { branch: 'taken' }))
    expect(s.c.core.sessions.store.get(asked.sessionId)?.lifecycle, 'listed at once').toBe('creating')
    const failed = await s.until(asked.sessionId, 'creation settles', settled)
    expect(failed.lifecycle).toBe('create_failed')
    expect(failed.creation).toMatchObject({ step: 'git', error: expect.stringContaining('taken already exists') })
    expect(fs.existsSync(failed.cwd), 'no worktree made').toBe(false)
    // Retry checks again, and fails in the same place; Discard touches nothing of the user's
    await s.call('sessions.retry', { id: asked.sessionId })
    const retried = await s.until(asked.sessionId, 'Retry settles', settled)
    expect(retried.creation).toMatchObject({ step: 'git', error: expect.stringContaining('taken already exists') })
    await s.call('sessions.discard', { id: asked.sessionId })
    // an automatic name: listed under it at once, then moved past the existing branch before the worktree is made
    const auto = await s.call<{ sessionId: string; slug: string }>('sessions.create', createArgs(p.id, 'fix bug'))
    expect(auto.slug).toBe('fix-bug')
    const v = await live(s, auto.sessionId)
    expect({ slug: v.slug, branch: v.branch, title: v.title, dir: path.basename(v.cwd) }).toEqual({ slug: 'fix-bug-2', branch: 'kea/fix-bug-2', title: 'Fix bug 2', dir: 'fix-bug-2' })
    // the same after a failure at the first step, before its checks ran: Retry runs them
    failGit = true
    const again = await s.call<{ sessionId: string; slug: string }>('sessions.create', createArgs(p.id, 'fix bug'))
    expect(again.slug, 'listed under the name the database leaves free').toBe('fix-bug')
    await s.until(again.sessionId, 'failed at git', (x) => x.lifecycle === 'create_failed')
    gitIn(r.root, 'branch', 'kea/fix-bug-3') // and one more appears meanwhile
    await s.call('sessions.retry', { id: again.sessionId })
    const w = await live(s, again.sessionId)
    expect(w.branch).toBe('kea/fix-bug-4')
    expect(branches(r.root)).toEqual(expect.arrayContaining(['kea/fix-bug', 'kea/fix-bug-2', 'kea/fix-bug-3', 'kea/fix-bug-4', 'taken']))
    expect(tips(), 'the user’s branches are where they were').toEqual(before)
  })
})

describe('delete confirmation', () => {
  it('I-SES-2 · the confirmation’s numbers equal git status --porcelain (one entry per file) and git rev-list on the worktree; the commits counted as lost are those no other local branch or remote-tracking ref holds, with a remote and without one; a fresh session has nothing to lose', async () => {
    const s = await sessions()
    const r = fixture()
    const remotes = tmpDir('kea-remote-')
    gitIn(r.root, 'clone', '-q', '--bare', r.root, path.join(remotes, 'origin.git'))
    gitIn(r.root, 'remote', 'add', 'origin', path.join(remotes, 'origin.git'))
    gitIn(r.root, 'fetch', '-q', 'origin')
    const p = await s.project(r.root)
    const preview = (id: string) => s.call<DeletePreview>('sessions.deletePreview', { id })
    const own = (v: SessionView) => Number(gitIn(v.cwd, 'rev-list', '--count', `refs/heads/${v.branch}`, '--not', `--exclude=${v.branch}`, '--branches', '--remotes').trim())

    // a fresh session: no work of its own, nothing to lose, the branch may go
    const fresh = await create(s, p.id, 'nothing yet', { base: { kind: 'default' } })
    expect(await preview(fresh.id)).toMatchObject({ uncommittedFiles: 0, ownCommits: 0, uniqueCommits: 0, deleteBranchDefault: true })

    const v = await create(s, p.id, 'count my work', { base: { kind: 'default' } })
    commit(v.cwd, 'one.txt')
    commit(v.cwd, 'two.txt')
    gitIn(v.cwd, 'push', '-q', 'origin', `HEAD:refs/heads/${v.branch}`)
    commit(v.cwd, 'three.txt')
    fs.appendFileSync(path.join(v.cwd, 'README.md'), 'edit\n')
    fs.rmSync(path.join(v.cwd, 'src/counter.js'))
    gitIn(v.cwd, 'mv', 'src/hello.js', 'src/greet.js')
    fs.mkdirSync(path.join(v.cwd, 'newdir'))
    fs.writeFileSync(path.join(v.cwd, 'newdir/a.txt'), 'a\n')
    fs.writeFileSync(path.join(v.cwd, 'newdir/b.txt'), 'b\n')
    fs.writeFileSync(path.join(v.cwd, 'loose.txt'), 'x\n')
    const prev = await preview(v.id)
    // one per file, whatever the git config: the rename is its deletion and its new file, newdir/ is its two files
    expect(prev.uncommittedFiles).toBe(gitIn(v.cwd, 'status', '--porcelain', '--no-renames', '--untracked-files=all').split('\n').filter(Boolean).length)
    expect(prev.uncommittedFiles).toBe(7)
    // two of its three commits are on origin: only the third is the branch's own
    expect(prev.ownCommits).toBe(own(v))
    expect(prev.ownCommits).toBe(1)
    expect(prev.uniqueCommits).toBe(Number(gitIn(v.cwd, 'rev-list', '--count', `${v.baseBranch}..HEAD`).trim()))
    expect(prev.uniqueCommits).toBe(3)
    expect(prev).toMatchObject({ merged: false, deleteBranchDefault: false, branch: v.branch, retentionDays: settingDefault('general.deletedRetentionDays') })
    // another local branch holds the third: nothing of the branch's own is left, so deleting it loses nothing
    gitIn(r.root, 'branch', 'keep-three', v.branch!)
    expect(await preview(v.id)).toMatchObject({ ownCommits: 0, merged: false, deleteBranchDefault: true })

    // no remote at all: the commits no other branch holds
    const plain = fixture('plain')
    const q = await s.project(plain.root)
    const w = await create(s, q.id, 'local only')
    commit(w.cwd, 'a.txt')
    commit(w.cwd, 'b.txt')
    gitIn(plain.root, 'branch', 'holds-a', `${w.branch}~1`)
    const wp = await preview(w.id)
    expect(wp.ownCommits).toBe(own(w))
    expect(wp).toMatchObject({ ownCommits: 1, uniqueCommits: 2, deleteBranchDefault: false })
  })
})

describe('auto-clean', () => {
  it('I-SES-4 · archived sessions clean+merged, clean+unmerged and dirty, the clock past the auto-clean age: only the clean+merged worktree goes; record and branch stay', async () => {
    let clock = Date.now()
    const s = await sessions({ opts: { now: () => clock } })
    const r = fixture()
    const p = await s.project(r.root)
    const merged = await create(s, p.id, 'merged work')
    commit(merged.cwd, 'm.txt')
    gitIn(r.root, 'merge', '-q', '--ff-only', merged.branch!)
    const unmerged = await create(s, p.id, 'unmerged work')
    commit(unmerged.cwd, 'u.txt')
    const dirty = await create(s, p.id, 'dirty work')
    fs.writeFileSync(path.join(dirty.cwd, 'wip.txt'), 'wip\n')
    for (const v of [merged, unmerged, dirty]) expect(await s.call('sessions.archive', { id: v.id, confirmed: true })).toMatchObject({ archived: true })
    // not old enough yet
    await s.relaunch()
    for (const v of [merged, unmerged, dirty]) expect(fs.existsSync(v.cwd)).toBe(true)
    clock += (settingDefault('general.autoCleanArchivedDays') + 1) * DAY_MS
    await s.relaunch()
    expect(fs.existsSync(merged.cwd)).toBe(false)
    expect(worktreePaths(r.root)).not.toContain(merged.cwd)
    expect(fs.existsSync(unmerged.cwd)).toBe(true)
    expect(fs.existsSync(dirty.cwd)).toBe(true)
    expect(fs.readFileSync(path.join(dirty.cwd, 'wip.txt'), 'utf8')).toBe('wip\n')
    expect(branches(r.root)).toEqual(expect.arrayContaining([merged.branch, unmerged.branch, dirty.branch]))
    expect(s.view(merged.id)).toMatchObject({ lifecycle: 'archived', worktreeMissing: false })
    // unarchive adds it back from its branch
    await s.call('sessions.unarchive', { id: merged.id })
    expect(fs.existsSync(path.join(merged.cwd, 'm.txt'))).toBe(true)
    expect(s.view(merged.id)?.lifecycle).toBe('detached')
  })
})

describe('auto-clean, edge cases', () => {
  it('I-SES-8 · auto-clean acts on each session as it is in its turn: an Unarchive queued first keeps the worktree; a base that no longer resolves counts as not merged; a squash-merged branch goes only once nothing of it is unpushed', async () => {
    let clock = Date.now()
    const s = await sessions({ opts: { now: () => clock } })
    const r = fixture()
    const remotes = tmpDir('kea-remote-')
    gitIn(r.root, 'clone', '-q', '--bare', r.root, path.join(remotes, 'origin.git'))
    gitIn(r.root, 'remote', 'add', 'origin', path.join(remotes, 'origin.git'))
    gitIn(r.root, 'fetch', '-q', 'origin')
    const p = await s.project(r.root)
    const ageOut = () => (clock += (settingDefault('general.autoCleanArchivedDays') + 1) * DAY_MS)

    // clean and merged, unarchived while auto-clean waits its turn
    const racer = await create(s, p.id, 'race me')
    await s.call('sessions.archive', { id: racer.id, confirmed: true })
    // a base branch deleted since: its own commit is not on any remote
    gitIn(r.root, 'branch', 'feature/base', 'main')
    const orphanBase = await create(s, p.id, 'base goes away', { base: { kind: 'ref', ref: 'feature/base' } })
    commit(orphanBase.cwd, 'own.txt')
    await s.call('sessions.archive', { id: orphanBase.id, confirmed: true })
    gitIn(r.root, 'branch', '-D', 'feature/base')
    // squash-merged into main: one pushed, one not
    const squashed = async (prompt: string, push: boolean) => {
      const v = await create(s, p.id, prompt)
      commit(v.cwd, `${v.slug}.txt`)
      if (push) gitIn(v.cwd, 'push', '-q', 'origin', `HEAD:refs/heads/${v.branch}`)
      gitIn(r.root, 'merge', '-q', '--squash', v.branch!)
      gitIn(r.root, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', `squash ${v.slug}`)
      await s.call('sessions.archive', { id: v.id, confirmed: true })
      return v
    }
    const pushed = await squashed('squash pushed', true)
    const unpushed = await squashed('squash unpushed', false)

    ageOut()
    const [cleaned] = await Promise.all([s.c.core.sessions.autoClean(), s.call('sessions.unarchive', { id: racer.id })])
    await s.idle()
    expect(s.view(racer.id)?.lifecycle).toBe('detached')
    expect(fs.existsSync(racer.cwd), 'the unarchived session keeps its worktree').toBe(true)
    expect(cleaned.sort()).toEqual([pushed.id])
    expect(fs.existsSync(pushed.cwd)).toBe(false)
    for (const v of [orphanBase, unpushed]) expect(fs.existsSync(v.cwd), v.slug).toBe(true)
  })
})

describe('Stop', () => {
  it('I-SES-9 · Stop hangs the shell pseudo-agent up, and terminates one that ignores the hang-up after L.shellCloseGraceMs: either way the session is detached with end reason stopped, not failed, and its agent’s holder is gone', async () => {
    // On Linux the shell is bash, not /bin/sh: dash runs a HUP trap only once its read of the terminal returns, so under
    // dash the first case below would be the second. And line editing goes off first there: bash 5.2 hung up inside
    // readline exits without the trap's redirection. macOS's /bin/sh (bash 3.2) needs neither
    const linux = kitOs.system === 'linux'
    const s = await sessions(linux ? { env: { SHELL: '/bin/bash' } } : {})
    const r = fixture()
    const p = await s.project(r.root)
    const marks = tmpDir('kea-stop-')
    const agentOf = (id: string) => s.c.core.terminals.sessionRecords(id).find((x) => x.kind === 'agent')!.ptyId
    const type = async (id: string, line: string, ready: string) => {
      s.h.manager.get(agentOf(id))!.input(`${line}; touch ${path.join(marks, ready)}\r`)
      await until(`the agent of ${id} ran: ${line}`, () => fs.existsSync(path.join(marks, ready)))
    }
    const stopped = async (id: string) => {
      const ptyId = agentOf(id)
      const t0 = performance.now()
      expect(await s.call('sessions.stop', { id })).toEqual({ ok: true })
      const took = performance.now() - t0
      expect(s.view(id)).toMatchObject({ lifecycle: 'detached', endReason: 'stopped', glyph: 'detached' })
      await until('the agent’s holder gone', () => !holderAlive(s.h.home, ptyId))
      return took
    }

    // a shell that exits on SIGHUP: hung up, at once
    const a = await create(s, p.id, 'hang me up', { isolation: 'inplace' })
    await type(a.id, `${linux ? 'set +o emacs; ' : ''}trap 'echo hup > ${path.join(marks, 'hup')}; exit 0' HUP`, 'a-ready')
    expect(await stopped(a.id)).toBeLessThan(L.shellCloseGraceMs)
    expect(fs.readFileSync(path.join(marks, 'hup'), 'utf8')).toBe('hup\n')

    // one that ignores it: terminated once the grace has passed
    const b = await create(s, p.id, 'ignore the hangup', { isolation: 'inplace' })
    await type(b.id, `trap '' HUP`, 'b-ready')
    expect(await stopped(b.id)).toBeGreaterThanOrEqual(L.shellCloseGraceMs)
    expect(s.c.core.sessions.resourceCounts.perSession, 'no stop left in progress').toBe(0)
  })
})

describe('order', () => {
  it('I-SES-10 · sessions.move counts the index in the sidebar’s order, newest first among equal sort orders (as a rebuild can leave them): the session lands just where it was dropped, and a tie is renumbered', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const a = await create(s, p.id, 'oldest', { isolation: 'inplace' })
    const b = await create(s, p.id, 'middle', { isolation: 'inplace' })
    const c = await create(s, p.id, 'newest', { isolation: 'inplace' })
    const order = () => [a, b, c].map((v) => s.view(v.id)!).sort((x, y) => x.sortOrder - y.sortOrder || y.createdAt - x.createdAt || x.id.localeCompare(y.id)).map((v) => v.title)
    expect(order()).toEqual([c.title, b.title, a.title])
    s.c.core.db.tx(() => s.c.core.db.run('UPDATE sessions SET sort_order = 0 WHERE project_id = ?', p.id))
    s.c.core.sessions.reload()
    expect(order(), 'newest first among equals').toEqual([c.title, b.title, a.title])
    // the newest dropped just past the middle one: index 1 of the order without it
    await s.call('sessions.move', { id: c.id, index: 1 })
    expect(order()).toEqual([b.title, c.title, a.title])
    await s.call('sessions.move', { id: a.id, index: 0 })
    expect(order()).toEqual([a.title, b.title, c.title])
  })
})

describe('launch', () => {
  it('I-SES-11 · a creation asked after core says ready but before its launch work runs (the window a rebuild or a slow root check holds open) goes on and completes; only the creation the previous run left mid-step is failed for Retry or Discard', async () => {
    let killAt: string | null = null
    let killed: Promise<void> | null = null
    let s!: SessionsUnderTest
    const gate = () => {
      let open!: () => void
      const p = new Promise<void>((r) => (open = r))
      return { p, open }
    }
    let launch: ReturnType<typeof gate> | null = null
    let launchReached = false
    let add: ReturnType<typeof gate> | null = null
    const faults = async (point: string) => {
      if (point === 'launch' && launch) {
        launchReached = true
        await launch.p
      }
      if (point === 'create:add' && add) await add.p
      if (point !== killAt) return
      killAt = null
      // core dies mid-creation; the next one's launch work waits until the test lets it go
      launch = gate()
      killed = s.crashAndRelaunch()
      throw new Error(`core killed at ${point}`)
    }
    s = await sessions({ opts: { faults } })
    const r = fixture()
    const p = await s.project(r.root)
    killAt = 'create:copy'
    const left = (await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, 'left mid-step'))).sessionId
    await until('the relaunched core’s launch work', () => launchReached)
    // the new core already answers: a creation asked now is in flight when the launch work reads the rows
    add = gate()
    const asked = (await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, 'asked in the window'))).sessionId
    launch!.open()
    await killed
    expect(s.view(asked)?.lifecycle, 'a creation in flight is not one Kea left behind').toBe('creating')
    expect(s.view(left)).toMatchObject({ lifecycle: 'create_failed', creation: { step: 'copy' } })
    add.open()
    const ok = await live(s, asked)
    expect(worktreePaths(r.root)).toContain(ok.cwd)
  })
})

describe('the row before git', () => {
  it('I-SES-12 · while git’s environment (the login shell’s, on a cold launch) has not answered, sessions.create still answers and lists the row; the creation then goes on from its git step', async () => {
    let held: Promise<void> | null = null
    let release!: () => void
    let waited = 0
    const s = await sessions({
      opts: {
        gitEnv: async () => {
          if (held) {
            waited++
            await held
          }
          return s.env
        },
      },
    })
    const r = fixture()
    const p = await s.project(r.root)
    held = new Promise<void>((res) => (release = res))
    const { sessionId } = await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, 'before the shell answers'))
    expect(s.view(sessionId)).toMatchObject({ lifecycle: 'creating', creation: { step: 'git' } })
    await until('the git step waits for the environment', () => waited > 0)
    release()
    held = null
    const v = await live(s, sessionId)
    expect(worktreePaths(r.root)).toContain(v.cwd)
  })
})

describe('port blocks and services', () => {
  it('I-SRV-5 · two sessions of one repository each serve on their own KEA_PORT; both reachable at once', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const server = `exec node -e "require('http').createServer((q, s) => s.end(process.env.KEA_SESSION_SLUG)).listen(Number(process.env.KEA_PORT), '127.0.0.1')"`
    await s.call('projects.updateSettings', { id: p.id, set: { setupCommand: server, startAgentWithoutWaitingForSetup: true } })
    const a = await create(s, p.id, 'first server')
    const b = await create(s, p.id, 'second server')
    expect(a.portBase).not.toBe(b.portBase)
    expect(Math.abs(a.portBase! - b.portBase!)).toBeGreaterThanOrEqual(L.portBlockSize)
    for (const v of [a, b]) {
      let body = ''
      await until(`session ${v.slug} serves on ${v.portBase}`, async () => {
        body = await fetch(`http://127.0.0.1:${v.portBase}/`).then((res) => res.text(), () => '')
        return body !== ''
      })
      expect(body).toBe(v.slug)
    }
    for (const v of [a, b]) await s.call('sessions.delete', { id: v.id, deleteBranch: true })
  })

  it('I-SRV-9 · a per-session project: distinct COMPOSE_PROJECT_NAMEs, the whole block in KEA_PORT/KEA_PORT_COUNT; a block with KEA_PORT + 7 held by a stray process is skipped; a shared project sets none', async () => {
    const marks = tmpDir('kea-compose-')
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    // the stand-in `docker compose up`: records what a compose stack would be named and the block it may use
    const record = `echo "$COMPOSE_PROJECT_NAME $KEA_PORT $KEA_PORT_COUNT" > ${marks}/$KEA_SESSION_SLUG`
    await s.call('projects.updateSettings', { id: p.id, set: { services: 'perSession', setupCommand: record } })
    const a = await create(s, p.id, 'compose one')
    const b = await create(s, p.id, 'compose two')
    const read = (slug: string) => fs.readFileSync(path.join(marks, slug), 'utf8').trim().split(' ')
    expect(read(a.slug)).toEqual([`kea-demo-${a.slug}`, String(a.portBase), String(L.portBlockSize)])
    expect(read(b.slug)).toEqual([`kea-demo-${b.slug}`, String(b.portBase), String(L.portBlockSize)])
    // a stray process holds KEA_PORT + 7 of the block the next session would get
    const taken = new Set(s.c.core.db.all<{ port_base: number }>('SELECT port_base FROM sessions WHERE port_base IS NOT NULL').map((x) => x.port_base))
    let next = 0
    for (const base of blockBases()) {
      if (!taken.has(base) && (await blockFree(base, bindProbe))) {
        next = base
        break
      }
    }
    const stray = net.createServer()
    await new Promise<void>((res) => stray.listen({ port: next + 7, host: '127.0.0.1' }, res))
    cleanup.push(() => new Promise<void>((res) => stray.close(() => res())))
    const c = await create(s, p.id, 'compose three')
    expect(c.portBase).not.toBe(next)
    expect(c.portBase!).toBeGreaterThan(next)
    // shared (the default): nothing is set
    await s.call('projects.updateSettings', { id: p.id, set: { services: 'shared' } })
    const d = await create(s, p.id, 'shared stack')
    expect(read(d.slug)[0]).toBe(String(d.portBase)) // the name is empty: the line starts with the port
  })
})

describe('shell tabs of a session', () => {
  it('I-PTY-32 · ⌘T in a session: a login shell at the pane’s grid in the session’s worktree with its environment, listed under the session; refused once the session is archived', async () => {
    const s = await sessions()
    const marks = tmpDir('kea-shells-')
    // every login shell of the session reads this profile: the agent (the shell pseudo-agent) and the tab
    fs.writeFileSync(path.join(s.env.HOME!, '.profile'), `echo "$KEA_SESSION_ID $KEA_PORT $(pwd -P)" >> ${marks}/started\n`)
    const r = fixture()
    const p = await s.project(r.root)
    const v = await create(s, p.id, 'shell tabs')
    const { ptyId } = await s.call<{ ptyId: string }>('sessions.openShell', { id: v.id, grid: { cols: 100, rows: 30 } })
    expect(s.c.core.terminals.record(ptyId)).toMatchObject({ sessionId: v.id, kind: 'shell', cwd: v.cwd, cols: 100, rows: 30, state: 'running' })
    const lines = () => (fs.existsSync(path.join(marks, 'started')) ? fs.readFileSync(path.join(marks, 'started'), 'utf8').trim().split('\n') : [])
    await until('the agent’s and the tab’s profile lines', () => lines().length === 2)
    for (const line of lines()) expect(line).toBe(`${v.id} ${v.portBase} ${fs.realpathSync(v.cwd)}`)
    await s.call('sessions.archive', { id: v.id, confirmed: true })
    expect(s.c.core.terminals.record(ptyId)?.state, 'archiving stops the tab with the rest').not.toBe('running')
    await expect(s.call('sessions.openShell', { id: v.id })).rejects.toThrow(/archived/)
  })
})

describe('archive asks about a shell that may be busy', () => {
  it('I-SES-17 · Archive asks when it could not be learned whether a shell of the session has a program in its foreground (ptyhost has no answer), and says that it is not known: the session is not archived, and its shells keep running, until the person confirms; with idle shells it archives without asking', async () => {
    let unknown = false
    const s = await sessions({ wrap: (m, _a, run) => (m === 'pty.stat' && unknown ? null : run()) })
    const r = fixture()
    const p = await s.project(r.root)
    const v = await create(s, p.id, 'maybe busy')
    const { ptyId } = await s.call<{ ptyId: string }>('sessions.openShell', { id: v.id, grid: { cols: 80, rows: 24 } })
    const archive = (confirmed: boolean) => s.call<{ archived: boolean; reasons: { kind: string; detail: string }[] }>('sessions.archive', { id: v.id, confirmed })
    unknown = true
    const asked = await archive(false)
    expect(asked.archived).toBe(false)
    expect(asked.reasons.length).toBeGreaterThan(0)
    // said as what it is, not as a busy shell: the sheet then says a program may be running, not that one is
    for (const reason of asked.reasons) expect(reason).toEqual({ kind: 'shellUnknown', detail: '' })
    expect(s.view(v.id)?.lifecycle).toBe('live')
    expect(s.c.core.terminals.record(ptyId)?.state).toBe('running')
    // known to be idle again: nothing to ask about
    unknown = false
    expect(await archive(false)).toMatchObject({ archived: true, reasons: [] })
  })
})

describe('Resume', () => {
  it('I-SES-6 · stop and Resume, three times: the new agent takes the session’s one Agent tab; the ended agent it replaces leaves no record, no store entry and no state files, so a session’s records and files do not grow with resumes', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const v = await create(s, p.id, 'resume me')
    const t = s.c.core.terminals
    const dir = path.join(s.h.home, 'sessions', v.id)
    const agents = () => t.sessionRecords(v.id).filter((x) => x.kind === 'agent')
    const files = () => fs.readdirSync(dir).filter((f) => /\.(ring|json|ckpt)$/.test(f)).sort()
    const first = agents()
    expect(first.map((x) => x.state)).toEqual(['running'])
    // the files of every PTY but the agent (the setup has none here): these must stay as they are
    const others = () => files().filter((f) => !f.startsWith(`${agents()[0]!.ptyId}.`))
    const before = others()
    let prev = first[0]!.ptyId
    for (const n of [1, 2, 3]) {
      await s.call('sessions.stop', { id: v.id })
      await s.until(v.id, `detached after stop ${n}`, (x) => x.lifecycle === 'detached')
      await s.call('sessions.resume', { id: v.id })
      await s.until(v.id, `live after Resume ${n}`, (x) => x.lifecycle === 'live')
      const now = agents()
      expect(now, `one agent record after Resume ${n}`).toHaveLength(1)
      expect(now[0]).toMatchObject({ state: 'running' })
      expect(now[0]!.ptyId).not.toBe(prev)
      expect(t.record(prev), `the replaced agent ${prev} is forgotten`).toBeUndefined()
      expect(t.store.has(prev), 'and gone from the store').toBe(false)
      expect(files().filter((f) => f.startsWith(`${prev}.`)), 'its state files removed').toEqual([])
      expect(others(), 'nothing else touched').toEqual(before)
      prev = now[0]!.ptyId
    }
  })
})

describe('Kea killed mid-operation', () => {
  it('I-WT-20 · core killed at each creation step, at each delete stage and during a restore: the relaunch converges — Retry/Discard, a delete undone before its ref and completed after it, a restore rolled back (with a branch it re-created)', async () => {
    let killAt: string | null = null
    let killed: Promise<void> | null = null
    let s!: SessionsUnderTest
    const faults = async (point: string) => {
      if (point !== killAt) return
      killAt = null
      // core dies here: what it had written is all there is; a new core starts on the same home
      killed = s.crashAndRelaunch()
      throw new Error(`core killed at ${point}`)
    }
    s = await sessions({ opts: { faults } })
    const r = fixture()
    const p = await s.project(r.root)
    const relaunched = async () => {
      await until('the relaunch', () => killed !== null)
      await killed
      killed = null
    }

    for (const step of ['git', 'base', 'add', 'copy', 'submodules', 'setup', 'launch']) {
      killAt = `create:${step}`
      const { sessionId } = await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, `killed at ${step}`))
      await relaunched()
      const v = await s.until(sessionId, 'Retry / Discard offered', (x) => x.lifecycle === 'create_failed')
      expect(v.creation?.step).toBe(step)
      await s.call('sessions.retry', { id: sessionId })
      const ok = await live(s, sessionId)
      expect(worktreePaths(r.root)).toContain(ok.cwd)
    }

    for (const stage of ['stop', 'snapshot', 'teardown', 'trash', 'prune']) {
      const v = await create(s, p.id, `delete killed at ${stage}`)
      fs.writeFileSync(path.join(v.cwd, 'work.txt'), 'uncommitted\n')
      killAt = `delete:${stage}`
      await expect(s.call('sessions.delete', { id: v.id, deleteBranch: false })).rejects.toThrow(/core killed/)
      await relaunched()
      const row = s.c.core.db.get<{ lifecycle: string; creation_step: string | null; snapshot_ref: string | null }>('SELECT lifecycle, creation_step, snapshot_ref FROM sessions WHERE id = ?', v.id)!
      const refExists = gitIn(r.root, 'for-each-ref', `refs/kea/deleted/${v.id}`) !== ''
      expect(row.creation_step).toBeNull()
      if (stage === 'stop' || stage === 'snapshot') {
        // before the ref: the session is as it was
        expect(row.lifecycle).not.toBe('deleted')
        expect(fs.readFileSync(path.join(v.cwd, 'work.txt'), 'utf8')).toBe('uncommitted\n')
        expect(refExists).toBe(false)
        await s.call('sessions.delete', { id: v.id, deleteBranch: false })
      } else {
        // after it: the delete completed; the worktree is never gone without its ref
        expect(row.lifecycle).toBe('deleted')
        expect(refExists).toBe(true)
        expect(fs.existsSync(v.cwd)).toBe(false)
        expect(worktreePaths(r.root)).not.toContain(v.cwd)
        expect(fs.existsSync(path.join(s.h.home, 'sessions', v.id))).toBe(false)
      }
    }

    for (const [point, deleteBranch] of [['restore:add', false], ['restore:copy', false], ['restore:copy', true]] as const) {
      const v = await create(s, p.id, `restore killed at ${point.slice(8)}${deleteBranch ? ' branch gone' : ''}`)
      fs.writeFileSync(path.join(v.cwd, 'keep.txt'), 'keep\n')
      await s.call('sessions.delete', { id: v.id, deleteBranch })
      killAt = point
      await expect(s.call('sessions.restore', { id: v.id })).rejects.toThrow()
      await relaunched()
      const row = s.c.core.db.get<{ lifecycle: string; creation_step: string | null }>('SELECT lifecycle, creation_step FROM sessions WHERE id = ?', v.id)!
      expect(row).toEqual({ lifecycle: 'deleted', creation_step: null })
      expect(fs.existsSync(v.cwd)).toBe(false)
      expect(worktreePaths(r.root)).not.toContain(v.cwd)
      // the session's branch is as the delete left it: kept, or (deleted with it) not re-created by the rolled-back restore
      expect(branches(r.root).includes(v.branch!), v.branch!).toBe(!deleteBranch)
      // and it restores cleanly afterwards
      await s.call('sessions.restore', { id: v.id })
      expect(fs.readFileSync(path.join(v.cwd, 'keep.txt'), 'utf8')).toBe('keep\n')
    }
    // every session directory left belongs to a session the database has (none comes back as a stray)
    for (const id of fs.readdirSync(path.join(s.h.home, 'sessions'))) expect(s.c.core.db.get('SELECT 1 AS x FROM sessions WHERE id = ?', id), id).toBeDefined()
  })
})

describe('Resume and Restart through the agent command', () => {
  it('I-SES-13 · the agent starts through the adapter seam: the creation asks for start, Resume for resume with the session’s conversation id, Restart for restart with none, each in the session’s worktree; Restart forgets the old conversation (its id and transcript); either way the new agent takes the one Agent tab', async () => {
    const marks = tmpDir('kea-seam-')
    const ran = path.join(marks, 'ran')
    const calls: { how: AgentLaunchHow; agentSessionId: string | null; cwd: string }[] = []
    const agentCommand: AgentCommand = (x, how) => {
      calls.push({ how, agentSessionId: x.agentSessionId, cwd: x.cwd })
      // the argv the seam answers is what runs: it notes how it was started, then is an interactive shell
      return { argv: ['/bin/sh', '-c', 'echo "$1" >> "$2"; exec /bin/sh', 'agent', how, ran] }
    }
    const s = await sessions({ opts: { agentCommand } })
    const r = fixture()
    const p = await s.project(r.root)
    const v = await create(s, p.id, 'seam')
    const t = s.c.core.terminals
    const conversation = () => s.c.core.db.get<{ a: string | null; t: string | null }>('SELECT agent_session_id AS a, transcript_path AS t FROM sessions WHERE id = ?', v.id)!
    const agents = () => t.sessionRecords(v.id).filter((x) => x.kind === 'agent')
    const ranLines = () => (fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8').trim().split('\n') : [])
    await until('the agent ran', () => ranLines().length === 1)
    expect(calls).toEqual([{ how: 'start', agentSessionId: null, cwd: v.cwd }])
    // as the adapter's intake records it: the CLI's conversation and its transcript
    s.c.core.db.run(`UPDATE sessions SET agent_session_id = 'conv-1', transcript_path = ? WHERE id = ?`, path.join(marks, 'conv-1.jsonl'), v.id)

    const again = async (method: 'sessions.resume' | 'sessions.restart', n: number) => {
      const before = agents()[0]!.ptyId
      await s.call('sessions.stop', { id: v.id })
      await s.until(v.id, `detached before ${method}`, (x) => x.lifecycle === 'detached')
      expect(await s.call(method, { id: v.id })).toEqual({ ok: true })
      await s.until(v.id, `live after ${method}`, (x) => x.lifecycle === 'live')
      await until(`the agent ran (${method})`, () => ranLines().length === n)
      expect(agents().map((x) => x.state), 'one Agent tab').toEqual(['running'])
      expect(t.record(before), 'the ended agent it replaces is forgotten').toBeUndefined()
    }
    await again('sessions.resume', 2)
    expect(calls[1]).toEqual({ how: 'resume', agentSessionId: 'conv-1', cwd: v.cwd })
    expect(conversation(), 'Resume continues the conversation').toEqual({ a: 'conv-1', t: path.join(marks, 'conv-1.jsonl') })
    await again('sessions.restart', 3)
    expect(calls[2]).toEqual({ how: 'restart', agentSessionId: null, cwd: v.cwd })
    expect(conversation(), 'Restart starts a fresh one').toEqual({ a: null, t: null })
    expect(ranLines()).toEqual(['start', 'resume', 'restart'])
  })
})

describe('archived sessions keep their checkpoints', () => {
  it('I-SES-14 · archive folds each ended PTY’s last screen into its checkpoint and removes its ring and state file; an ended shell tab goes with its files; the last screen still comes from the checkpoint alone; a running PTY has none; Unarchive and Resume replace the agent and its checkpoint', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const marks = tmpDir('kea-archive-')
    const v = await create(s, p.id, 'archive me')
    const t = s.c.core.terminals
    const dir = path.join(s.h.home, 'sessions', v.id)
    const agent = t.sessionRecords(v.id).find((x) => x.kind === 'agent')!.ptyId
    const shell = (await s.call<{ ptyId: string }>('sessions.openShell', { id: v.id })).ptyId
    const run = async (ptyId: string, line: string, ready: string) => {
      s.h.manager.get(ptyId)!.input(`${line}; touch ${path.join(marks, ready)}\r`)
      await until(`ran: ${line}`, () => fs.existsSync(path.join(marks, ready)))
    }
    await run(agent, 'echo agent-$((6*7))', 'agent')
    await run(shell, 'echo shell-$((6*7))', 'shell')
    expect(await t.lastScreen(agent, 80, 24), 'a running PTY: attach a stream instead').toBeNull()
    const ptyFiles = (ids: string[]) =>
      fs
        .readdirSync(dir)
        .filter((f) => ids.some((id) => f.startsWith(`${id}.`)))
        .sort()

    expect(await s.call('sessions.archive', { id: v.id, confirmed: true })).toMatchObject({ archived: true })
    expect(ptyFiles([agent, shell]), 'only the agent’s checkpoint').toEqual([`${agent}.ckpt`])
    expect(fs.existsSync(path.join(dir, 'creation.log')), 'the creation log stays (View log)').toBe(true)
    expect(t.record(shell), 'the ended shell tab is forgotten').toBeUndefined()
    expect(t.record(agent)?.state).not.toBe('running')
    const last = await t.lastScreen(agent, 80, 24)
    expect(last?.data, 'the last screen, from the checkpoint alone').toContain('agent-42')

    await s.call('sessions.unarchive', { id: v.id })
    await s.until(v.id, 'detached after Unarchive', (x) => x.lifecycle === 'detached')
    expect((await t.lastScreen(agent, 80, 24))?.data, 'still shown while detached').toContain('agent-42')
    await s.call('sessions.resume', { id: v.id })
    await s.until(v.id, 'live after Resume', (x) => x.lifecycle === 'live')
    const now = t.sessionRecords(v.id).filter((x) => x.kind === 'agent')
    expect(now.map((x) => x.state)).toEqual(['running'])
    expect(ptyFiles([agent]), 'the replaced agent’s checkpoint goes with it').toEqual([])
  })
})

describe('Stop All and Quit', () => {
  it('I-SES-15 · stopEverything stops every session’s running terminals as archive does: a live session ends detached with end reason stopped, a detached one keeps its end reason, and no PTY of either is left running or held', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const a = await create(s, p.id, 'live one', { isolation: 'inplace' })
    const b = await create(s, p.id, 'detached one', { isolation: 'inplace' })
    const t = s.c.core.terminals
    await s.call('sessions.openShell', { id: a.id })
    await s.call('sessions.stop', { id: b.id })
    s.c.core.db.run(`UPDATE sessions SET end_reason = 'crashed' WHERE id = ?`, b.id)
    s.c.core.sessions.refresh(b.id)
    await s.call('sessions.openShell', { id: b.id })
    const ptys = [...t.sessionRecords(a.id), ...t.sessionRecords(b.id)].filter((x) => x.state === 'running').map((x) => x.ptyId)
    expect(ptys).toHaveLength(3)

    await s.c.core.sessions.stopEverything()
    expect(s.view(a.id)).toMatchObject({ lifecycle: 'detached', endReason: 'stopped' })
    expect(s.view(b.id)).toMatchObject({ lifecycle: 'detached', endReason: 'crashed' })
    for (const id of [a.id, b.id]) expect(t.sessionRecords(id).filter((x) => x.state === 'running'), id).toEqual([])
    await until('their holders gone', () => ptys.every((id) => !holderAlive(s.h.home, id)))
    expect(s.c.core.sessions.resourceCounts.perSession, 'no stop left in progress').toBe(0)
  })
  it('I-SES-19 · a quit stops what a session-by-session stop misses: a shell tab outside any session, and nothing starts afterwards', async () => {
    const s = await sessions()
    const t = s.c.core.terminals
    const shell = (await s.call<{ ptyId: string }>('terminal.openShell', { cols: 80, rows: 24 })).ptyId
    expect(t.record(shell)?.state).toBe('running')

    await s.c.core.sessions.stopEverything()
    expect(t.record(shell)?.state, 'the global shell tab is stopped').not.toBe('running')
    await until('its holder gone', () => !holderAlive(s.h.home, shell))
    await expect(s.call('terminal.openShell', { cols: 80, rows: 24 }), 'no terminal starts while Kea quits').rejects.toThrow()
  })

})
