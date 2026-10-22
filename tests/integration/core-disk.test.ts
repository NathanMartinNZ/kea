// Disk usage in core against real git, real holders and a repo from tools/repo-factory: core assembled as main.ts
// assembles it, on a temp KEA_HOME, the size walk on its real worker thread. The walk's own accounting, the schedule
// and the Disk page have unit and e2e tests of their own.
//
// Time Machine: the exclusion is a sticky attribute on the folder itself (the one `tmutil addexclusion` sets; Kea writes
// it directly), so these tests mark only folders of their own temp worktrees; nothing of the Mac's backup settings is
// read or changed, and `tmutil` is never run.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@kea/kit'
import { isAvailable, L, type BuildFoldersRemoved, type DiskUsage, type SessionView } from '@kea/protocol'
import { WorkerWalker, type DiskWalker } from '@kea/core/src/worktrees/disk.ts'
import { scanForGit, walkDisk } from '@kea/core/src/worktrees/disk-walk.ts'
import { WORKTREE_TRASH } from '@kea/core/src/worktrees/ops.ts'
import { until } from '../support/holders.ts'
import { createArgs, gitIn, repo, startSessions, type SessionsUnderTest } from './core-sessions-support.ts'
import { coreOs } from '../../app/core/src/os/index.ts'

// Excluding a folder from backups is Time Machine’s attribute on macOS; Linux has no such thing to set.
const backups = isAvailable(coreOs.backupExclude)

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function sessions(o: Parameters<typeof startSessions>[0] = {}): Promise<SessionsUnderTest> {
  const s = await startSessions(o)
  cleanup.push(() => s.dispose())
  return s
}

function tmpDir(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

/** Every file under `dir` (but `.git`) with its type, mode and content hash: "byte-identical" means equal snapshots. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const rel = path.relative(dir, p)
      if (e.name === '.git') continue
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

/**
 * Allocated bytes of everything at and under `p`, links not followed, nothing deduplicated: the size walk's sum,
 * counted here by itself.
 */
function allocated(p: string): number {
  const st = fs.lstatSync(p)
  let n = st.blocks * 512
  if (st.isDirectory()) for (const name of fs.readdirSync(p)) n += allocated(path.join(p, name))
  return n
}

/** A repository of its own at `dir` with one commit that exists nowhere else (a dependency cloned and patched there). Its HEAD. */
function nestedRepo(dir: string, note: string): string {
  fs.mkdirSync(dir, { recursive: true })
  gitIn(dir, 'init', '-q')
  fs.writeFileSync(path.join(dir, 'patch.txt'), note)
  gitIn(dir, 'add', '-A')
  gitIn(dir, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', note)
  return gitIn(dir, 'rev-parse', 'HEAD').trim()
}

const TM_ATTR = 'com.apple.metadata:com_apple_backup_excludeItem'
/** The folder carries Time Machine's sticky exclusion. */
function excluded(p: string): boolean {
  try {
    execFileSync('/usr/bin/xattr', ['-p', TM_ATTR, p], { stdio: ['ignore', 'pipe', 'pipe'] }) // os-ok: macOS test tool, called only where Time Machine's exclusion exists
    return true
  } catch {
    return false
  }
}

async function live(s: SessionsUnderTest, projectId: string, prompt: string): Promise<SessionView> {
  const r = await s.call<{ sessionId: string }>('sessions.create', createArgs(projectId, prompt))
  const v = await s.until(r.sessionId, 'creation and setup settle', (x) => (x.lifecycle === 'live' && (x.setup === null || x.setup.state !== 'running')) || x.lifecycle === 'create_failed')
  if (v.lifecycle !== 'live') throw new Error(`creation failed: ${v.creation?.error}`)
  return v
}

/**
 * A repository whose worktrees get, from the setup command, every kind of folder the rebuildable rule tells apart:
 *   node_modules/, target/, web/node_modules/, packages/web/dist/   ignored and matching: rebuildable
 *   build/        ignored and matching, but it holds a tracked file (`build/keep.txt`): never rebuildable as a whole
 *   out/          matching, not ignored itself; all it holds is an ignored `*.log`
 *   coverage/     matching, untracked and not ignored
 *   dist          matching and ignored, but a symbolic link (to a folder outside the worktree)
 *   .env, notes.txt   an ignored file, an untracked one
 * `node_modules` holds a megabyte three times: the file, a hard link to it, an APFS clone of it.
 */
function buildFolderRepo(outside: string): { root: string; setup: string; rebuildable: string[] } {
  const r = repo()
  cleanup.push(() => r.dispose())
  fs.writeFileSync(path.join(r.root, '.gitignore'), 'node_modules/\ntarget/\nbuild/\ndist\n*.log\n.env\n')
  fs.mkdirSync(path.join(r.root, 'build'))
  fs.writeFileSync(path.join(r.root, 'build/keep.txt'), 'tracked, in an ignored folder\n')
  gitIn(r.root, 'add', '-A')
  gitIn(r.root, 'add', '-f', 'build/keep.txt')
  gitIn(r.root, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'ignore rules')
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'outside the worktree\n')
  const setup = [
    'mkdir -p node_modules/dep target/debug web/node_modules packages/web/dist out coverage',
    'dd if=/dev/urandom of=node_modules/dep/big.bin bs=1048576 count=1 2>/dev/null',
    'ln node_modules/dep/big.bin node_modules/dep/hard.bin',
    'cp -c node_modules/dep/big.bin node_modules/dep/clone.bin 2>/dev/null || cp node_modules/dep/big.bin node_modules/dep/clone.bin',
    'echo bin > target/debug/app',
    'echo dep > web/node_modules/dep.js',
    'echo out > packages/web/dist/out.js',
    'echo gen > build/gen.o',
    'echo log > out/debug.log',
    'echo report > coverage/report.txt',
    `ln -s ${outside} dist`,
    'echo SECRET=1 > .env',
    'echo note > notes.txt',
  ].join(' && ')
  return { root: r.root, setup, rebuildable: ['node_modules', 'packages/web/dist', 'target', 'web/node_modules'] }
}

describe('disk usage', () => {
  it.runIf(backups)('I-WT-17 · after setup the rebuildable folders at the root and one level below are excluded from Time Machine, and no other; a worktree’s size counts a clone and a hard link in full; a walk past L.diskWalkTimeoutMs is cancelled and says so; Remove build folders takes only folders that match and are ignored, through the trash', async () => {
    const outside = tmpDir('kea-disk-outside-')
    const fx = buildFolderRepo(outside)
    // the walks run on the real worker thread, but for the one made to pass the cap: that one runs here, on a clock
    // that jumps L.diskWalkTimeoutMs while the second folder is read
    const cap = { on: false }
    const thread = new WorkerWalker(createMemoryLogger({ process: 'core' }))
    const walker: DiskWalker = {
      walk: (req) => {
        if (!cap.on) return thread.walk(req)
        let reads = 0
        const clock = () => (reads >= 2 ? L.diskWalkTimeoutMs : 0)
        return Promise.resolve(walkDisk(req, clock, { lstatSync: (x) => fs.lstatSync(x), readdirSync: (x) => (reads++, fs.readdirSync(x)) }))
      },
      holdsGit: (req) => thread.holdsGit(req),
      release: () => thread.release(),
      get workers() {
        return thread.workers
      },
      dispose: () => thread.dispose(),
    }
    const s = await sessions({ opts: { disk: { walker } } })
    const p = await s.project(fx.root)
    await s.call('projects.updateSettings', { id: p.id, set: { setupCommand: fx.setup } })
    const a = await live(s, p.id, 'disk usage')
    expect(a.setup).toMatchObject({ state: 'done' })
    const wt = (...rel: string[]) => path.join(a.cwd, ...rel)

    // Marked after setup (the session's log says so once the attribute is written): rebuildable, at the root or
    // one level below
    const logOf = async () => (await s.call<{ text: string }>('sessions.creationLog', { id: a.id })).text
    await until('the folders are excluded from Time Machine', async () => (await logOf()).includes('excluded from Time Machine'))
    expect(await logOf()).toContain('excluded from Time Machine: node_modules, target, web/node_modules\n')
    for (const dir of ['node_modules', 'target', 'web/node_modules']) expect(excluded(wt(dir)), dir).toBe(true)
    // one level further down is not Time Machine's; the rest is not rebuildable: a folder with a tracked file, one that
    // is not ignored itself, an untracked one, a link, the sources
    for (const dir of ['packages/web/dist', 'build', 'out', 'coverage', 'dist', 'src', '.']) expect(excluded(wt(dir)), dir).toBe(false)
    expect(excluded(outside)).toBe(false)

    // The size, walked on the worker thread when the Disk view asks. The megabyte in node_modules is on disk
    // once and counted three times (the file, its hard link, its clone): an upper bound. The link `dist` is not followed
    const disk = s.c.core.disk
    const row = (): DiskUsage => disk.store.get(a.id)!
    expect(row()).toMatchObject({ bytes: null, at: null, measuring: false })
    expect(await s.call('disk.measure', {})).toEqual({ queued: 1 })
    expect(row().measuring).toBe(true)
    await disk.idle()
    const share = fx.rebuildable.reduce((n, dir) => n + allocated(wt(dir)), 0)
    expect(row()).toEqual({ bytes: allocated(a.cwd), rebuildableBytes: share, capped: false, at: s.view(a.id)!.diskAt, measuring: false, visible: false, viewedAt: null })
    expect(row().bytes).toBeGreaterThanOrEqual(3 << 20)
    expect(share).toBeGreaterThanOrEqual(3 << 20)
    expect(row().bytes! - share).toBeLessThan(1 << 20)
    expect(s.view(a.id)).toMatchObject({ diskBytes: row().bytes })
    expect(row().at).not.toBeNull()
    // measured within the hour: the view opening again asks for nothing; its Refresh walks again
    expect(await s.call('disk.measure', {})).toEqual({ queued: 0 })
    // the thread went with the last walk
    expect(disk.resourceCounts).toMatchObject({ rows: 1, queued: 0, walking: 0, workers: 0 })

    // a walk that passes its cap (the clock a stub: L.diskWalkTimeoutMs passes while it reads its second folder) is
    // cancelled: what it had counted is the size, marked as such
    cap.on = true
    expect(await s.call('disk.measure', { all: true })).toEqual({ queued: 1 })
    await disk.idle()
    cap.on = false
    expect(row().capped).toBe(true)
    expect(row().bytes).toBeGreaterThan(0)
    expect(row().bytes).toBeLessThan(allocated(a.cwd))
    await s.call('disk.measure', { all: true })
    await disk.idle()
    expect(row()).toMatchObject({ bytes: allocated(a.cwd), rebuildableBytes: share, capped: false })

    // Remove build folders takes the four rebuildable folders and nothing else, through the worktree root's trash
    const kept = (rel: string) => !fx.rebuildable.some((dir) => rel === dir || rel.startsWith(`${dir}/`))
    const before = Object.fromEntries(Object.entries(snapshot(a.cwd)).filter(([rel]) => kept(rel)))
    const status = gitIn(a.cwd, 'status', '--porcelain')
    const removed = await s.call<BuildFoldersRemoved>('disk.removeBuildFolders', { id: a.id })
    expect(removed).toEqual({ removed: fx.rebuildable, kept: [], bytes: share })
    for (const dir of fx.rebuildable) expect(fs.existsSync(wt(dir)), dir).toBe(false)
    expect(snapshot(a.cwd)).toEqual(before)
    // still there: the tracked file in an ignored folder, the folder no rule ignores, the untracked one, the link and
    // what it points at, the ignored file
    for (const rel of ['build/keep.txt', 'build/gen.o', 'out/debug.log', 'coverage/report.txt', '.env', 'notes.txt', 'src/math.js']) expect(fs.existsSync(wt(rel)), rel).toBe(true)
    expect(fs.readlinkSync(wt('dist'))).toBe(outside)
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('outside the worktree\n')
    expect(gitIn(a.cwd, 'status', '--porcelain')).toBe(status)
    // through the worktree root's trash: emptied in the background
    const trash = path.join(path.dirname(path.dirname(a.cwd)), WORKTREE_TRASH)
    expect(fs.existsSync(trash)).toBe(true)
    await disk.idle()
    expect(fs.readdirSync(trash)).toEqual([])
    expect(await logOf()).toContain('Remove build folders: node_modules, packages/web/dist, target, web/node_modules\n')
    // and the size is measured again
    expect(row()).toMatchObject({ bytes: allocated(a.cwd), rebuildableBytes: 0, capped: false, measuring: false })
    expect(row().bytes).toBeLessThan(1 << 20)
    // again: nothing to remove, nothing touched
    expect(await s.call('disk.removeBuildFolders', { id: a.id })).toEqual({ removed: [], kept: [], bytes: 0 })
    expect(snapshot(a.cwd)).toEqual(before)

    // a session with no worktree of its own has no row and nothing to remove
    const inplace = (await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, 'in place', { isolation: 'inplace' }))).sessionId
    await s.until(inplace, 'live', (v) => v.lifecycle === 'live')
    expect(disk.store.has(inplace)).toBe(false)
    await expect(s.call('disk.removeBuildFolders', { id: inplace })).rejects.toMatchObject({ code: 'wrong_state' })
    expect((await s.call<{ branch: unknown }>('disk.branch', { id: inplace })).branch).toBeNull()
    // The row's branch state. Uncommitted files as the delete confirmation counts them: the two untracked files that
    // are not ignored. The branch adds nothing to its base, so nothing of its own is unpushed: the repository has no
    // remote, and its history is not the session's unpushed work
    const uncommitted = gitIn(a.cwd, 'status', '--porcelain', '-uall').split('\n').filter(Boolean)
    expect(uncommitted.map((l) => l.slice(3)).sort()).toEqual(['coverage/report.txt', 'notes.txt'])
    expect(Number(gitIn(a.cwd, 'rev-list', '--count', 'HEAD', '--not', '--remotes'))).toBeGreaterThan(0)
    expect((await s.call<{ branch: unknown }>('disk.branch', { id: a.id })).branch).toEqual({ uncommittedFiles: 2, unpushedCommits: 0, commits: 0, merged: true })
    // a commit of its own, pushed nowhere: one unpushed commit, and the branch is no longer merged
    gitIn(a.cwd, 'add', 'notes.txt')
    gitIn(a.cwd, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'notes')
    expect((await s.call<{ branch: unknown }>('disk.branch', { id: a.id })).branch).toEqual({ uncommittedFiles: 1, unpushedCommits: 1, commits: 1, merged: false })
  })

  it('I-WT-18 · an archived session sheds its rebuildable folders once the clock is past general.pruneArchivedBuildDirsDays, everything else byte-identical; unarchive then runs setup again, and only then', async () => {
    const outside = tmpDir('kea-disk-outside-')
    const marks = tmpDir('kea-disk-marks-')
    const fx = buildFolderRepo(outside)
    let ahead = 0
    const s = await sessions({ opts: { now: () => Date.now() + ahead } })
    const days = s.c.core.settings.values.get<number>('general.pruneArchivedBuildDirsDays')
    expect(days).toBe(7)
    const p = await s.project(fx.root)
    // setup says why it ran; `dist` is a link it makes once
    await s.call('projects.updateSettings', { id: p.id, set: { setupCommand: `echo "$KEA_SETUP_REASON" >> ${marks}/setup.txt; ${fx.setup.replace(`ln -s ${outside} dist`, `ln -sfn ${outside} dist`)}` } })
    const a = await live(s, p.id, 'prune me')
    const wt = (...rel: string[]) => path.join(a.cwd, ...rel)
    const disk = s.c.core.disk
    const setups = () => fs.readFileSync(path.join(marks, 'setup.txt'), 'utf8')
    expect(setups()).toBe('create\n')

    expect(await s.call('sessions.archive', { id: a.id, confirmed: true })).toMatchObject({ archived: true })
    // Measured once on archive
    await disk.idle()
    expect(disk.store.get(a.id)).toMatchObject({ bytes: allocated(a.cwd), capped: false })
    const kept = (rel: string) => !fx.rebuildable.some((dir) => rel === dir || rel.startsWith(`${dir}/`))
    const all = snapshot(a.cwd)
    const before = Object.fromEntries(Object.entries(all).filter(([rel]) => kept(rel)))
    expect(Object.keys(all).length).toBeGreaterThan(Object.keys(before).length)

    // a day short of the period: nothing goes
    ahead = (days - 1) * 86_400_000
    await disk.tick()
    await disk.idle()
    expect(snapshot(a.cwd)).toEqual(all)
    // past it: the rebuildable folders go, and only they
    ahead = days * 86_400_000 + 1000
    await disk.tick()
    await disk.idle()
    for (const dir of fx.rebuildable) expect(fs.existsSync(wt(dir)), dir).toBe(false)
    expect(snapshot(a.cwd)).toEqual(before)
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('outside the worktree\n')
    expect((await s.call<{ text: string }>('sessions.creationLog', { id: a.id })).text).toContain(`archived for ${days} days, build folders removed: node_modules, packages/web/dist, target, web/node_modules\n`)
    expect(disk.store.get(a.id)).toMatchObject({ bytes: allocated(a.cwd), rebuildableBytes: 0 })
    expect(s.view(a.id)?.lifecycle).toBe('archived')
    // once per archive: the next ticks ask nothing of it
    const gitCalls = s.c.log.entries.length
    await disk.tick()
    await disk.idle()
    expect(s.c.log.entries.slice(gitCalls).filter((e) => /build folders/.test(e.msg))).toEqual([])
    expect(disk.resourceCounts).toMatchObject({ timers: 0, retries: 0, queued: 0, walking: 0, workers: 0 })

    // unarchive: setup runs again (the project has no teardown command: the prune is the reason) and the folders are back
    await s.call('sessions.unarchive', { id: a.id })
    await s.until(a.id, 'setup ran again', (v) => v.setup?.reason === 'unarchive' && v.setup.state === 'done')
    expect(setups()).toBe('create\nunarchive\n')
    for (const dir of fx.rebuildable) expect(fs.existsSync(wt(dir)), dir).toBe(true)
    // archived and unarchived again with its folders in place: no reason to run setup
    expect(await s.call('sessions.archive', { id: a.id, confirmed: true })).toMatchObject({ archived: true })
    await s.call('sessions.unarchive', { id: a.id })
    await s.idle()
    await disk.idle()
    expect(s.view(a.id)?.lifecycle).toBe('detached')
    expect(setups()).toBe('create\nunarchive\n')
  })

  it('I-WT-32 · a build folder that holds a git repository of its own, at any depth (a clone, a linked worktree), is never removed, by hand or by the prune: it and its commits stay, the session’s log and the answer say which were kept, and its bytes are not counted as rebuildable', async () => {
    const outside = tmpDir('kea-disk-outside-')
    const r = repo()
    cleanup.push(() => r.dispose())
    fs.writeFileSync(path.join(r.root, '.gitignore'), 'node_modules/\nbuild/\n.venv/\ntarget/\nout/\n')
    gitIn(r.root, 'add', '-A')
    gitIn(r.root, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'ignore rules')
    let ahead = 0
    // the looks run on the real worker thread, but for those made to fail: at the cap (a clock that is past it), or with
    // no answer at all (the thread went)
    const look: { fails: 'cap' | 'thread' | null } = { fails: null }
    const thread = new WorkerWalker(createMemoryLogger({ process: 'core' }))
    const walker: DiskWalker = {
      walk: (req) => thread.walk(req),
      holdsGit: (req) => {
        if (look.fails === null) return thread.holdsGit(req)
        let asked = 0
        return Promise.resolve(look.fails === 'cap' ? scanForGit(req, () => (asked++ === 0 ? 0 : L.diskWalkTimeoutMs)) : null)
      },
      release: () => thread.release(),
      get workers() {
        return thread.workers
      },
      dispose: () => thread.dispose(),
    }
    const s = await sessions({ opts: { now: () => Date.now() + ahead, disk: { walker } } })
    const days = s.c.core.settings.values.get<number>('general.pruneArchivedBuildDirsDays')
    const p = await s.project(r.root)
    const a = await live(s, p.id, 'a patched dependency')
    const wt = (...rel: string[]) => path.join(a.cwd, ...rel)
    const disk = s.c.core.disk

    // build/ is itself a clone with a commit that exists nowhere else (depth 1: `build/.git`); .venv holds one three
    // levels down (`.venv/src/pkg/.git`); target holds a linked worktree of the first (`target/dep/.git` is a file)
    const commits = { build: nestedRepo(wt('build'), 'patched in build'), venv: nestedRepo(wt('.venv/src/pkg'), 'patched in the venv') }
    gitIn(wt('build'), 'worktree', 'add', '-q', '-b', 'side', wt('target/dep'))
    expect(fs.lstatSync(wt('target/dep/.git')).isFile()).toBe(true)
    fs.writeFileSync(wt('target/dep/wip.txt'), 'uncommitted work in a linked worktree\n')
    // rebuildable and holding none: node_modules, and out, whose link to a repository elsewhere is not followed
    fs.mkdirSync(wt('node_modules/dep'), { recursive: true })
    fs.writeFileSync(wt('node_modules/dep/index.js'), 'x'.repeat(20_000))
    const elsewhere = nestedRepo(path.join(outside, 'repo'), 'outside the worktree')
    fs.mkdirSync(wt('out'))
    fs.writeFileSync(wt('out/gen.js'), 'y'.repeat(20_000))
    fs.symlinkSync(path.join(outside, 'repo'), wt('out/linked'))

    const intact = () => {
      expect(gitIn(wt('build'), 'rev-parse', 'HEAD').trim()).toBe(commits.build)
      expect(gitIn(wt('build'), 'log', '-1', '--format=%s').trim()).toBe('patched in build')
      expect(gitIn(wt('.venv/src/pkg'), 'rev-parse', 'HEAD').trim()).toBe(commits.venv)
      expect(fs.readFileSync(wt('.venv/src/pkg/patch.txt'), 'utf8')).toBe('patched in the venv')
      expect(gitIn(wt('target/dep'), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('side')
      expect(fs.readFileSync(wt('target/dep/wip.txt'), 'utf8')).toBe('uncommitted work in a linked worktree\n')
      expect(gitIn(path.join(outside, 'repo'), 'rev-parse', 'HEAD').trim()).toBe(elsewhere)
    }
    intact()
    const holding = ['.venv', 'build', 'target']
    // the walk's thread does one thing at a time, in the order asked: a look asked for during a walk waits for it
    const both = await Promise.all([thread.walk({ root: a.cwd, rebuildable: [], timeoutMs: L.diskWalkTimeoutMs }), thread.holdsGit({ dir: wt('.venv'), timeoutMs: L.diskWalkTimeoutMs }), thread.holdsGit({ dir: wt('node_modules'), timeoutMs: L.diskWalkTimeoutMs })])
    expect(both).toMatchObject([{ bytes: allocated(a.cwd), capped: false }, { git: 'src/pkg/.git', unchecked: null }, { git: null, unchecked: null }])
    thread.release()
    expect(thread.workers).toBe(0)
    const logOf = async () => (await s.call<{ text: string }>('sessions.creationLog', { id: a.id })).text

    // What holds a repository is not rebuildable, so the share counts only the two that hold none
    await s.call('disk.measure', {})
    await disk.idle()
    const share = allocated(wt('node_modules')) + allocated(wt('out'))
    expect(disk.store.get(a.id)).toMatchObject({ bytes: allocated(a.cwd), rebuildableBytes: share, capped: false })

    // asked first (the confirmation of a removal from the palette or the menu bar): what would go and what would stay;
    // nothing is touched
    const everything = snapshot(a.cwd)
    expect(await s.call('disk.buildFolders', { id: a.id })).toEqual({ folders: ['node_modules', 'out'], kept: holding.map((dir) => ({ path: dir, reason: 'git' })), bytes: share })
    expect(snapshot(a.cwd)).toEqual(everything)
    intact()

    // by hand: the two go, the three stay whole, and the answer and the log say which and why
    const removed = await s.call<BuildFoldersRemoved>('disk.removeBuildFolders', { id: a.id })
    expect(removed.removed).toEqual(['node_modules', 'out'])
    expect(removed.kept).toEqual(holding.map((dir) => ({ path: dir, reason: 'git' })))
    expect(removed.bytes).toBe(share)
    for (const dir of ['node_modules', 'out']) expect(fs.existsSync(wt(dir)), dir).toBe(false)
    intact()
    await disk.idle()
    expect(await logOf()).toContain('Remove build folders: node_modules, out\n')
    expect(await logOf()).toContain('kept, it holds a git repository: .venv, build, target\n')
    expect(disk.store.get(a.id)).toMatchObject({ bytes: allocated(a.cwd), rebuildableBytes: 0 })

    // a folder that could not be looked through is kept as well: the look reached its cap, or its thread gave no answer
    fs.mkdirSync(wt('node_modules/dep'), { recursive: true })
    fs.writeFileSync(wt('node_modules/dep/index.js'), 'x')
    for (const fails of ['cap', 'thread'] as const) {
      look.fails = fails
      const none = await s.call<BuildFoldersRemoved>('disk.removeBuildFolders', { id: a.id })
      expect(none.removed, fails).toEqual([])
      expect(none.kept, fails).toEqual(['.venv', 'build', 'node_modules', 'target'].map((dir) => ({ path: dir, reason: 'unchecked' })))
      expect(fs.existsSync(wt('node_modules/dep/index.js')), fails).toBe(true)
    }
    look.fails = null
    intact()
    expect(await logOf()).toContain('Remove build folders: none found\n')
    expect(await logOf()).toContain('kept, it could not be checked for a git repository: .venv, build, node_modules, target\n')
    expect(disk.resourceCounts).toMatchObject({ queued: 0, walking: 0, workers: 0 })

    // The prune of the archived session keeps them too, and is done for this archive (no retry every hour)
    expect(await s.call('sessions.archive', { id: a.id, confirmed: true })).toMatchObject({ archived: true })
    await disk.idle()
    ahead = days * 86_400_000 + 1000
    await disk.tick()
    await disk.idle()
    expect(fs.existsSync(wt('node_modules'))).toBe(false)
    intact()
    const log = await logOf()
    expect(log).toContain(`archived for ${days} days, build folders removed: node_modules\n`)
    expect(log.match(/kept, it holds a git repository: \.venv, build, target\n/g)).toHaveLength(2)
    expect(disk.resourceCounts).toMatchObject({ timers: 0, retries: 0, queued: 0, walking: 0, workers: 0 })
    // nothing of them went through the trash either
    expect(fs.readdirSync(path.join(path.dirname(path.dirname(a.cwd)), WORKTREE_TRASH))).toEqual([])
  })

  it('I-WT-33 · Remove build folders is refused while the session’s setup runs (also one that was skipped and has not ended), with the reason; what setup has made so far stays; once setup has ended the folders go', async () => {
    const marks = tmpDir('kea-disk-marks-')
    const r = repo()
    cleanup.push(() => r.dispose())
    // the demo repository ignores `node_modules/`
    const s = await sessions()
    const p = await s.project(r.root)
    // setup makes half of node_modules, then, when it runs for an unarchive, waits until the test lets it go on (it
    // reads a FIFO: nothing is polled), then makes the rest
    const gate = path.join(marks, 'go')
    execFileSync('/usr/bin/mkfifo', [gate]) // os-ok: in /usr/bin on both systems
    const setup = `mkdir -p node_modules && echo half > node_modules/half && if [ "$KEA_SETUP_REASON" = unarchive ]; then cat ${gate} > /dev/null; fi && echo full > node_modules/full`
    await s.call('projects.updateSettings', { id: p.id, set: { setupCommand: setup } })
    const a = await live(s, p.id, 'mid install')
    const wt = (...rel: string[]) => path.join(a.cwd, ...rel)
    expect(a.setup).toMatchObject({ state: 'done', reason: 'create' })
    expect(fs.existsSync(wt('node_modules/full'))).toBe(true)

    // archived, its build folders removed by hand: unarchive runs setup again, in the session's Setup tab
    expect(await s.call('sessions.archive', { id: a.id, confirmed: true })).toMatchObject({ archived: true })
    expect(await s.call<BuildFoldersRemoved>('disk.removeBuildFolders', { id: a.id })).toMatchObject({ removed: ['node_modules'], kept: [] })
    await s.call('sessions.unarchive', { id: a.id })
    await s.until(a.id, 'setup runs again', (v) => v.setup?.state === 'running' && v.setup.reason === 'unarchive')
    await until('setup is half way', () => fs.existsSync(wt('node_modules/half')))
    expect(fs.existsSync(wt('node_modules/full'))).toBe(false)

    // mid-install: refused, with the reason, and nothing is touched
    const refused = { code: 'wrong_state', message: expect.stringMatching(/setup is running/) }
    await expect(s.call('disk.removeBuildFolders', { id: a.id })).rejects.toMatchObject(refused)
    await expect(s.call('disk.buildFolders', { id: a.id })).rejects.toMatchObject(refused)
    expect(fs.readFileSync(wt('node_modules/half'), 'utf8')).toBe('half\n')
    // skipped, but its script has not ended: still refused
    await s.call('sessions.setup', { id: a.id, action: 'skip' })
    await expect(s.call('disk.removeBuildFolders', { id: a.id })).rejects.toMatchObject(refused)
    expect(fs.existsSync(wt('node_modules/half'))).toBe(true)

    // setup goes on and ends: the folders can go again
    await fs.promises.writeFile(gate, 'go\n')
    await until('setup made the rest', () => fs.existsSync(wt('node_modules/full')))
    await until('the setup script has ended', () => !s.c.core.terminals.sessionRecords(a.id).some((x) => x.kind === 'script' && x.state === 'running'))
    await s.idle()
    expect(await s.call<BuildFoldersRemoved>('disk.removeBuildFolders', { id: a.id })).toMatchObject({ removed: ['node_modules'], kept: [] })
    expect(fs.existsSync(wt('node_modules'))).toBe(false)
    await s.c.core.disk.idle()
  })

  it('I-WT-31 · a worktree that goes takes its size with it: a session deleted and restored is not measured until asked, and its size is then the restored worktree’s, never the deleted one’s', async () => {
    const s = await sessions()
    const r = repo()
    cleanup.push(() => r.dispose())
    // the demo repository ignores `node_modules/`
    const p = await s.project(r.root)
    const a = await live(s, p.id, 'come back')
    const disk = s.c.core.disk
    // two megabytes git ignores (a delete does not keep them) and a file of its own that it does keep
    fs.mkdirSync(path.join(a.cwd, 'node_modules'))
    fs.writeFileSync(path.join(a.cwd, 'node_modules', 'blob.bin'), Buffer.alloc(2_000_000, 1))
    fs.writeFileSync(path.join(a.cwd, 'notes.txt'), 'mine\n')
    expect((await s.call<{ queued: number }>('disk.measure', {})).queued).toBe(1)
    await disk.idle()
    const before = allocated(a.cwd)
    expect(disk.store.get(a.id)).toMatchObject({ bytes: before, rebuildableBytes: allocated(path.join(a.cwd, 'node_modules')), measuring: false })
    expect(s.view(a.id)).toMatchObject({ diskBytes: before })

    expect(await s.call('sessions.delete', { id: a.id, deleteBranch: false })).toMatchObject({ deleted: true })
    expect(disk.store.has(a.id), 'no worktree, no row').toBe(false)
    expect(fs.existsSync(a.cwd)).toBe(false)
    await s.call('sessions.restore', { id: a.id })
    const back = await s.until(a.id, 'restored', (v) => v.lifecycle === 'detached' && (v.setup === null || v.setup.state !== 'running'))
    // its worktree is another one now: what the deleted one took says nothing about it
    expect(back).toMatchObject({ diskBytes: null, diskAt: null })
    expect(disk.store.get(a.id)).toMatchObject({ bytes: null, rebuildableBytes: null, at: null, capped: false })
    expect(fs.existsSync(path.join(a.cwd, 'node_modules'))).toBe(false)
    expect(fs.readFileSync(path.join(a.cwd, 'notes.txt'), 'utf8')).toBe('mine\n')
    // the Disk view asks for what was never measured: this one is
    expect((await s.call<{ queued: number }>('disk.measure', {})).queued).toBe(1)
    await disk.idle()
    const now = allocated(a.cwd)
    expect(now).toBeLessThan(before - 1_900_000)
    expect(disk.store.get(a.id)).toMatchObject({ bytes: now, rebuildableBytes: 0, measuring: false })
    expect(s.view(a.id)).toMatchObject({ diskBytes: now })
  })
})
