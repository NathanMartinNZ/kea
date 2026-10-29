// The file tree in core: `tree:<sessionId>` kept current from the real file watcher, what git ignores, big
// directories, folders that are not repositories, the refresh triggers and the finder. Harness: core-files-support.ts.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import { setGitBinary } from '@kea/kit'
import { isAvailable, L, type Project } from '@kea/protocol'
import { loadNativeWatcher, type NativeCallback, type NativeEvent, type NativeOptions, type NativeWatcher } from '@kea/core/src/platform/watch/native.ts'
import { fixtureGitEnv, mediumRepo } from '@kea-tools/repo-factory/src/index.ts'
import { ManualClock } from '../../app/ptyhost/src/test-support.ts'
import { until } from '../support/holders.ts'
import { cleanup, gitIn, later, linkedWorktree, repo, startFiles, tempDir, write, type FilesUnderTest } from './core-files-support.ts'
import { coreOs } from '../../app/core/src/os/index.ts'

// Live updates need the native watcher: FSEvents on macOS, inotify through Kea's patched build on Linux.
const watching = isAvailable(coreOs.watcher)

let t: FilesUnderTest | null = null
afterEach(async () => {
  await t?.dispose()
  t = null
  cleanup()
})

/** Wait for the store to hold what `cond` wants, and say how long it took from `t0`. */
async function seen(what: string, t0: number, cond: () => boolean): Promise<number> {
  let at = 0
  await until(what, () => {
    if (!cond()) return false
    at = performance.now() - t0
    return true
  })
  return at
}

/** Core's git is a script that writes down the folder of each `rev-parse` asking whether it is a repository. */
function countingRevParse(): (root: string) => number {
  const real = execFileSync('/usr/bin/which', ['git'], { env: fixtureGitEnv() }).toString().trim() // os-ok: in /usr/bin on both systems
  const dir = tempDir('kea-git-count-')
  const log = path.join(dir, 'asked')
  fs.writeFileSync(log, '')
  const file = path.join(dir, 'git')
  fs.writeFileSync(file, `#!/bin/sh\ncase " $* " in *" rev-parse --path-format=absolute --show-toplevel "*) pwd -P >> '${log}' ;; esac\nexec '${real}' "$@"\n`, { mode: 0o755 })
  setGitBinary(file) // put back by cleanup()
  return (root) => fs.readFileSync(log, 'utf8').split('\n').filter((l) => l === root).length
}

/** The real native watcher, counting the streams opened on each folder. */
function countingNative(): { native: NativeWatcher; opened(dir: string): number } {
  const real = loadNativeWatcher()
  const opened = new Map<string, number>()
  return {
    native: {
      async subscribe(dir: string, fn: NativeCallback, opts: NativeOptions) {
        opened.set(dir, (opened.get(dir) ?? 0) + 1)
        return real.subscribe(dir, fn, opts)
      },
      unsubscribe: (dir: string, fn: NativeCallback, opts: NativeOptions) => real.unsubscribe(dir, fn, opts),
      keaPatch: real.keaPatch,
    },
    opened: (dir) => opened.get(dir) ?? 0,
  }
}

describe('the file tree in core', () => {
  it.runIf(watching)('I-FT-1 · a file created, modified, deleted, renamed or saved atomically in an expanded directory is in the tree store within L.treeUpdateMs, and the final entries are right', async () => {
    const r = repo()
    t = await startFiles()
    t.session('s1', r.root)
    t.show('s1')
    expect(t.stores.names()).toEqual(expect.arrayContaining(['tree:s1', 'git:s1'])) // registered inside `visible.set`
    await t.ready('s1')
    expect(t.treeHead('s1')).toEqual({ git: true, live: true, missing: false })
    expect(t.names('s1')).toEqual(['src', 'test', '.gitignore', '.kea-fixture-repo', 'package.json', 'README.md']) // directories first; `.git` never
    expect(t.dir('s1', 'src')).toBeUndefined() // lazy: nothing below the root until it is expanded
    expect(await t.call('files.expand', { sessionId: 's1', path: 'src' })).toEqual({ ok: true })
    expect(t.names('s1', 'src')).toEqual(['counter.js', 'hello.js', 'index.js', 'math.js'])
    await until('the stream to be live', () => t?.watcher?.followed()[0]?.mode === 'live')

    const src = path.join(r.root, 'src')
    const took: Record<string, number> = {}
    const updates = t.s('s1').stats.treeUpdates
    // create
    let t0 = performance.now()
    fs.writeFileSync(path.join(src, 'new.js'), 'export const n = 1\n')
    took.create = await seen('the new file', t0, () => t!.names('s1', 'src').includes('new.js'))
    // a new directory, shown before the files
    t0 = performance.now()
    fs.mkdirSync(path.join(src, 'lib'))
    took.mkdir = await seen('the new directory', t0, () => t!.names('s1', 'src')[0] === 'lib')
    // delete
    t0 = performance.now()
    fs.rmSync(path.join(src, 'counter.js'))
    took.delete = await seen('the deleted file to go', t0, () => !t!.names('s1', 'src').includes('counter.js'))
    // rename
    t0 = performance.now()
    fs.renameSync(path.join(src, 'hello.js'), path.join(src, 'greeting.js'))
    took.rename = await seen('the renamed file', t0, () => t!.names('s1', 'src').includes('greeting.js') && !t!.names('s1', 'src').includes('hello.js'))
    // an atomic save (temp file, then rename over the target): the temp file never stays, the target is there
    t0 = performance.now()
    fs.writeFileSync(path.join(src, '.math.js.tmp-1'), 'export const add = (a, b) => a + b\n')
    fs.renameSync(path.join(src, '.math.js.tmp-1'), path.join(src, 'math.js'))
    fs.writeFileSync(path.join(src, 'after-save.js'), '')
    took.atomic = await seen('the save', t0, () => t!.names('s1', 'src').includes('after-save.js'))
    expect(t.names('s1', 'src')).toEqual(['lib', 'after-save.js', 'greeting.js', 'index.js', 'math.js', 'new.js'])
    for (const [op, ms] of Object.entries(took)) expect(ms, `${op} took ${Math.round(ms)} ms`).toBeLessThanOrEqual(L.treeUpdateMs)

    // a modification changes no entry: no tree delta for it (the status carries it)
    await t.idle('s1')
    const before = t.s('s1').stats.treeUpdates
    expect(before).toBeGreaterThan(updates)
    const runs = t.statusRuns('s1')
    fs.appendFileSync(path.join(src, 'index.js'), '// more\n')
    await until('the status to follow the edit', () => t!.statusRuns('s1') > runs && t!.codes('s1')['src/index.js'] === 'M')
    expect(t.s('s1').stats.treeUpdates).toBe(before)

    // a change in a directory that is not expanded reads nothing
    const listings = t.s('s1').stats.listings
    fs.writeFileSync(path.join(r.root, 'test', 'extra.test.js'), '')
    await until('the status to list it', () => t!.codes('s1')['test/extra.test.js'] === 'U')
    expect(t.s('s1').stats.listings).toBe(listings)

    // a loaded directory deleted: its row goes, its parent loses the entry; collapsing forgets a row
    await t.call('files.expand', { sessionId: 's1', path: 'src/lib' })
    expect(t.dir('s1', 'src/lib')?.entries).toEqual([])
    fs.rmSync(path.join(src, 'lib'), { recursive: true })
    await until('the directory to go', () => t!.dir('s1', 'src/lib') === undefined && !t!.names('s1', 'src').includes('lib'))
    await t.call('files.collapse', { sessionId: 's1', path: 'src' })
    expect(t.dir('s1', 'src')).toBeUndefined()
    // only directories inside the working directory, reached without a symlink, can be expanded
    fs.symlinkSync(path.dirname(r.root), path.join(r.root, 'up'))
    await until('the link', () => t!.names('s1').includes('up'))
    expect(t.dir('s1')?.entries.find((e) => e.name === 'up')?.kind).toBe('symlink')
    expect(await t.call('files.expand', { sessionId: 's1', path: 'up' })).toEqual({ ok: false })
    expect(await t.call('files.expand', { sessionId: 's1', path: 'README.md' })).toEqual({ ok: false })
    expect(await t.call('files.expand', { sessionId: 's1', path: 'no/such' })).toEqual({ ok: false })
  })

  it.runIf(watching)('I-FT-6 · an ignored top-level directory and a nested ignored file carry the ignored flag (the panel hides or dims them), as does everything below an ignored directory and a file that becomes ignored later', async () => {
    const r = repo()
    fs.writeFileSync(path.join(r.root, '.gitignore'), 'node_modules/\n*.secret\ncache/\n')
    write(r.root, 'node_modules/left-pad/index.js')
    write(r.root, 'src/api.secret')
    write(r.root, 'src/visible.js')
    write(r.root, 'cache/a/b.bin')
    t = await startFiles()
    t.session('s1', r.root)
    t.show('s1')
    await t.ready('s1')
    await until('the ignored list', () => t!.s('s1').ignore?.loaded === true && t!.dir('s1')?.entries.find((e) => e.name === 'node_modules')?.ignored === true)
    const flags = (rel = ''): Record<string, boolean> => Object.fromEntries((t!.dir('s1', rel)?.entries ?? []).map((e) => [e.name, e.ignored]))
    expect(flags()).toEqual({ cache: true, node_modules: true, src: false, test: false, '.gitignore': false, '.kea-fixture-repo': false, 'package.json': false, 'README.md': false })
    await t.call('files.expand', { sessionId: 's1', path: 'src' })
    expect(flags('src')).toMatchObject({ 'api.secret': true, 'visible.js': false, 'math.js': false })
    // below an ignored directory everything is ignored, with no query at all
    const checks = t.s('s1').stats.ignoreChecks
    await t.call('files.expand', { sessionId: 's1', path: 'cache' })
    await t.call('files.expand', { sessionId: 's1', path: 'cache/a' })
    expect(flags('cache')).toEqual({ a: true })
    expect(flags('cache/a')).toEqual({ 'b.bin': true })
    expect(t.s('s1').stats.ignoreChecks).toBe(checks)
    // `.git` is never listed, and git's ignored files are no changes
    expect(Object.keys(flags())).not.toContain('.git')
    expect(t.codes('s1')).toEqual({ '.gitignore': 'M', 'src/visible.js': 'U' })

    // a new file that matches a pattern: flagged when it appears (one check), and no status entry
    await until('the stream to be live', () => t?.watcher?.followed()[0]?.mode === 'live')
    await t.idle('s1')
    write(r.root, 'src/later.secret')
    write(r.root, 'src/later.js')
    await until('the new files', () => 'later.secret' in flags('src') && 'later.js' in flags('src'))
    await until('the ignored flag', () => flags('src')['later.secret'] === true)
    expect(flags('src')['later.js']).toBe(false)
    await until('the status', () => t!.codes('s1')['src/later.js'] === 'U')
    expect(t.codes('s1')['src/later.secret']).toBeUndefined()
    // the rules change: the list is read again and the rows follow
    const loads = t.s('s1').stats.ignoreLoads
    fs.writeFileSync(path.join(r.root, '.gitignore'), 'node_modules/\ncache/\n*.js\n')
    await until('the new rules', () => flags('src')['later.js'] === true && flags('src')['api.secret'] === false)
    expect(t.s('s1').stats.ignoreLoads).toBe(loads + 1)
  })

  it('I-FT-7 · a directory with 50 000 entries sends its first page and the total; "Show all" sends every entry; the cache never holds more entries than its cap', async () => {
    const root = tempDir()
    const big = path.join(root, 'big')
    fs.mkdirSync(big)
    const N = 50_000
    for (let i = 0; i < N; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), '')
    fs.mkdirSync(path.join(big, 'zz-dir'))
    t = await startFiles()
    t.session('s1', root)
    t.show('s1')
    await t.ready('s1')
    expect(N).toBeGreaterThan(L.dirBigThreshold)
    expect(await t.call('files.expand', { sessionId: 's1', path: 'big' })).toEqual({ ok: true })
    const page = t.dir('s1', 'big')!
    expect(page.entries).toHaveLength(L.dirFirstPage)
    expect([page.total, page.paged, page.truncated]).toEqual([N + 1, true, false])
    expect(page.entries.slice(0, 4).map((e) => e.name)).toEqual(['zz-dir', 'f0.txt', 'f1.txt', 'f2.txt']) // the first page of the sorted whole
    expect(page.entries[L.dirFirstPage - 1]?.name).toBe(`f${L.dirFirstPage - 2}.txt`)
    expect(await t.call('files.showAll', { sessionId: 's1', path: 'big' })).toEqual({ ok: true })
    const all = t.dir('s1', 'big')!
    expect([all.entries.length, all.total, all.paged]).toEqual([N + 1, N + 1, false])
    expect(all.entries.at(-1)?.name).toBe(`f${N - 1}.txt`)
    // a change inside keeps "all" shown
    fs.writeFileSync(path.join(big, 'f-new.txt'), '')
    await until('the new entry', () => t!.dir('s1', 'big')?.total === N + 2)
    expect(t.dir('s1', 'big')?.paged).toBe(false)

    // A second directory that would take the cache past its cap pushes the first out
    const more = path.join(root, 'more')
    fs.mkdirSync(more)
    const M = L.dirCacheEntriesMax - N + 10
    for (let i = 0; i < M; i++) fs.writeFileSync(path.join(more, `g${i}`), '')
    await until('the root to list it', () => t!.names('s1').includes('more'))
    expect(await t.call('files.expand', { sessionId: 's1', path: 'more' })).toEqual({ ok: true })
    expect(t.dir('s1', 'more')?.total).toBe(M)
    expect(t.dir('s1', 'big')).toBeUndefined() // expanded longest ago: dropped, asked for again when wanted
    expect(t.files.counts.entries).toBeLessThanOrEqual(L.dirCacheEntriesMax)
    expect(t.dir('s1')).toBeDefined() // never the root
  })

  it.runIf(watching)('I-FT-8 · a folder that is not a git repository: the tree works and follows changes; the git store says `notGit` and holds no entries', async () => {
    const root = tempDir()
    write(root, 'notes/todo.md')
    write(root, 'main.py')
    t = await startFiles()
    t.session('s1', root)
    t.show('s1')
    await t.ready('s1')
    expect(t.treeHead('s1')).toEqual({ git: false, live: true, missing: false })
    expect(t.head('s1')).toMatchObject({ state: 'notGit', scope: 'branch', base: null })
    expect(t.entries('s1')).toEqual({})
    expect(t.dir('s1')?.entries).toEqual([
      { name: 'notes', kind: 'dir', ignored: false },
      { name: 'main.py', kind: 'file', ignored: false },
    ])
    await until('the stream to be live', () => t?.watcher?.followed()[0]?.mode === 'live')
    write(root, 'new.py')
    await until('the new file', () => t!.names('s1').includes('new.py'))
    expect(t.statusRuns('s1')).toBe(0) // no status ran (a folder that becomes a repository: I-FT-29)
    expect(await t.files.base('s1', 'branch')).toBeNull()
    expect(t.files.entry('s1', 'new.py')).toBeNull()
    // the finder works from a walk of the folder
    const found = await t.call<{ hits: { path: string }[]; total: number }>('files.find', { sessionId: 's1', query: 'todo' })
    expect(found.hits.map((h) => h.path)).toEqual(['notes/todo.md'])
    expect(found.total).toBe(3)
    // a working directory that does not exist
    t.session('s2', path.join(root, 'gone'))
    t.show('s2')
    await t.ready('s2')
    expect(t.treeHead('s2')).toEqual({ git: false, live: true, missing: true })
    expect(t.head('s2')?.state).toBe('notGit')
  })

  it.runIf(watching)('I-FT-29 · a folder on screen that becomes a repository (`git init` in its terminal) is one with no other trigger: the tree and Changes show what git says, then `git add` and `git commit`; its stream opens again once, leaving `.git` out; git is asked again only when `.git` changed on disk. The same for a folder made a repository while hidden and for a `.git` that is a file; a `.git` that is no repository opens the stream again once and stays out of the finder; a folder whose `.git` is removed is a plain folder again; its project becoming a repository is a reason to look', async () => {
    const asked = countingRevParse()
    const native = countingNative()
    const plain = tempDir()
    write(plain, 'main.py')
    write(plain, 'notes/todo.md')
    t = await startFiles({ watcher: { native: native.native } })
    const u = t
    const followed = (root: string) => u.watcher?.followed().find((f) => f.root === root)
    const live = (root: string) => until(`the stream on ${root} to be live`, () => followed(root)?.mode === 'live')
    type Found = { hits: { path: string }[] }
    const found = async (id: string, query: string): Promise<string[]> => (await u.call<Found>('files.find', { sessionId: id, query })).hits.map((h) => h.path)

    u.session('s1', plain)
    u.show('s1')
    await u.ready('s1')
    await live(plain)
    expect(u.treeHead('s1')).toEqual({ git: false, live: true, missing: false })
    expect(followed(plain)?.excluded).not.toContain(path.join(plain, '.git')) // heard when it is made
    expect(asked(plain)).toBe(1)
    // a change, with no `.git`: git is not asked again
    write(plain, 'new.py')
    await until('the new file', () => u.names('s1').includes('new.py'))
    await u.idle('s1')
    expect(asked(plain)).toBe(1)
    expect(await found('s1', 'todo')).toEqual(['notes/todo.md']) // the finder's index, from a walk of the folder

    gitIn(plain, 'init', '-q')
    await until('the folder to be a repository', () => u.treeHead('s1')?.git === true && u.codes('s1')['main.py'] === 'U')
    expect(u.codes('s1')).toEqual({ 'main.py': 'U', 'new.py': 'U', 'notes/todo.md': 'U' })
    await until('the stream to leave `.git` out', () => followed(plain)?.mode === 'live' && followed(plain)?.excluded.includes(path.join(plain, '.git')) === true)
    expect(native.opened(plain)).toBe(2)
    expect((await found('s1', 'config')).filter((p) => p.startsWith('.git/'))).toEqual([]) // built again, from git
    gitIn(plain, 'add', '-A')
    await until('the files to be added', () => u.codes('s1')['main.py'] === 'A')
    gitIn(plain, 'commit', '-qm', 'first')
    await until('the work tree to be clean', () => u.head('s1')?.state === 'ok' && Object.keys(u.codes('s1')).length === 0)
    expect(native.opened(plain)).toBe(2)

    // made a repository while hidden: the stream opens again without anyone looking, the session finds it when shown
    const hidden = tempDir()
    write(hidden, 'a.md')
    u.session('s2', hidden)
    u.show('s2')
    await u.ready('s2')
    await live(hidden)
    u.show(null)
    gitIn(hidden, 'init', '-q')
    await until('the hidden stream to leave `.git` out', () => followed(hidden)?.excluded.includes(path.join(hidden, '.git')) === true)
    expect(native.opened(hidden)).toBe(2)
    expect(asked(hidden)).toBe(1)
    u.show('s2')
    await until('the shown folder to be a repository', () => u.treeHead('s2')?.git === true && u.codes('s2')['a.md'] === 'U')
    expect(asked(hidden)).toBe(2)

    // `.git` a file (`git init --separate-git-dir`): its git dir is followed elsewhere
    const linked = tempDir()
    const elsewhere = path.join(tempDir(), 'repo.git')
    write(linked, 'b.md')
    u.session('s3', linked)
    u.show('s3')
    await u.ready('s3')
    await live(linked)
    gitIn(linked, 'init', '-q', `--separate-git-dir=${elsewhere}`)
    await until('the folder with a `.git` file to be a repository', () => u.treeHead('s3')?.git === true && u.codes('s3')['b.md'] === 'U')
    gitIn(linked, 'add', '-A')
    await until('the file to be added', () => u.codes('s3')['b.md'] === 'A')

    // a `.git` that is no repository: the stream opens again once to leave it out; git is not asked at each change
    const bad = tempDir()
    write(bad, 'c.md')
    u.session('s4', bad)
    u.show('s4')
    await u.ready('s4')
    await live(bad)
    expect(await found('s4', 'c')).toEqual(['c.md'])
    write(bad, '.git/config', '[core]\n')
    await until('the stream to leave the bad `.git` out', () => followed(bad)?.mode === 'live' && followed(bad)?.excluded.includes(path.join(bad, '.git')) === true)
    write(bad, 'd.md')
    await until('the next file', () => u.names('s4').includes('d.md'))
    await u.idle('s4')
    expect(native.opened(bad)).toBe(2)
    expect(asked(bad)).toBe(2)
    expect(u.treeHead('s4')?.git).toBe(false)
    expect(await found('s4', 'config')).toEqual([])

    // `.git` removed: a plain folder again, and `.git` is heard if it comes back
    u.show('s1')
    await u.ready('s1')
    fs.rmSync(path.join(plain, '.git'), { recursive: true, force: true })
    await until('the folder to be plain again', () => u.treeHead('s1')?.git === false && u.head('s1')?.state === 'notGit')
    expect(u.entries('s1')).toEqual({})
    await until('the stream to hear `.git` again', () => followed(plain)?.mode === 'live' && followed(plain)?.excluded.includes(path.join(plain, '.git')) === false)

    // the project made a repository (Initialise git…) is a reason to look again, also where nothing is heard
    await u.dispose()
    t = await startFiles({ watcher: false })
    const v = t
    const quiet = tempDir()
    write(quiet, 'e.md')
    v.session('s5', quiet)
    v.show('s5')
    await v.ready('s5')
    gitIn(quiet, 'init', '-q')
    await v.idle('s5')
    expect(v.treeHead('s5')?.git).toBe(false) // no watch service: nothing heard
    v.projects.set('p1', { id: 'p1', settings: {}, isGit: true } as Project)
    await until('the session to be a repository', () => v.treeHead('s5')?.git === true && v.codes('s5')['e.md'] === 'U')
  })

  it.runIf(watching)('I-FT-2 ·60 000 files written under `node_modules`: no tree update, at most 3 status runs, the event queue within L.watchRescanThreshold; the same for an ignored folder the kernel does not exclude', async () => {
    const r = repo()
    fs.writeFileSync(path.join(r.root, '.gitignore'), 'node_modules/\n.cache/\n')
    gitIn(r.root, 'commit', '-qam', 'ignore the cache')
    t = await startFiles()
    t.session('s1', r.root)
    t.show('s1')
    await t.ready('s1')
    await until('the stream to be live', () => t?.watcher?.followed()[0]?.mode === 'live')
    await t.idle('s1')
    const before = { tree: t.s('s1').stats.treeUpdates, runs: t.statusRuns('s1'), listings: t.s('s1').stats.listings }
    // `pnpm install`: 60 000 files in 600 packages (the directory does not exist when the stream starts)
    const nm = path.join(r.root, 'node_modules')
    for (let p = 0; p < 600; p++) {
      const dir = path.join(nm, `pkg-${p}`, 'lib')
      fs.mkdirSync(dir, { recursive: true })
      for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(dir, `m${f}.js`), '')
    }
    // a marker written last, outside: once it is in the status, everything before it has been through the watcher
    write(r.root, 'marker.txt')
    await until('the marker', () => t!.codes('s1')['marker.txt'] === 'U')
    await t.idle('s1')
    expect(t.names('s1')).toContain('node_modules') // the folder itself appeared
    await until('the folder to be flagged ignored', () => t!.dir('s1')?.entries.find((e) => e.name === 'node_modules')?.ignored === true)
    expect(t.s('s1').stats.treeUpdates - before.tree).toBeLessThanOrEqual(3) // the root only: the folder, the marker, the folder's ignored flag
    expect(t.statusRuns('s1') - before.runs).toBeLessThanOrEqual(3)
    expect(t.watcher?.counts.peakPendingEvents).toBeLessThanOrEqual(L.watchRescanThreshold)
    expect(t.watcher?.counts.pendingEvents).toBe(0)
    expect(t.codes('s1')).toEqual({ 'marker.txt': 'U' })

    // an ignored folder that is not one of the kernel's eight: its events arrive and are dropped after delivery
    const mid = { runs: t.statusRuns('s1'), ignored: t.s('s1').stats.ignoredEvents, tree: t.s('s1').stats.treeUpdates }
    const cache = path.join(r.root, '.cache')
    fs.mkdirSync(cache)
    await until('the folder to be known as ignored', () => t!.dir('s1')?.entries.find((e) => e.name === '.cache')?.ignored === true)
    await t.idle('s1')
    const afterMkdir = t.statusRuns('s1')
    for (let f = 0; f < 5_000; f++) fs.writeFileSync(path.join(cache, `blob-${f}`), '')
    write(r.root, 'marker-2.txt')
    await until('the second marker', () => t!.codes('s1')['marker-2.txt'] === 'U')
    await t.idle('s1')
    expect(t.s('s1').stats.ignoredEvents - mid.ignored).toBeGreaterThan(1_000) // they did arrive
    expect(t.statusRuns('s1') - afterMkdir).toBeLessThanOrEqual(2) // the marker's, and at most one more
    expect(t.statusRuns('s1') - mid.runs).toBeLessThanOrEqual(3)
    expect(t.s('s1').stats.treeUpdates - mid.tree).toBeLessThanOrEqual(3)
    expect(t.watcher?.counts.peakPendingEvents).toBeLessThanOrEqual(L.watchRescanThreshold)
  })

  it.runIf(watching)('I-FT-22 · a tracked folder named like a kernel exclusion (`build/`, `dist/`) is followed live: a file added there with nothing else changing is in Changes and in its expanded listing without a focus or any other trigger; a folder git ignores whole is still left to the kernel; a folder that stops being ignored whole (its rule removed from `.gitignore`, or a file added to it with `git add -f`) is heard from then on', async () => {
    const r = repo()
    // build scripts and a committed `dist/`, as many repositories have; `out/` is ignored
    write(r.root, 'build/release.sh', '#!/bin/sh\necho release\n')
    write(r.root, 'dist/index.js', 'export {}\n')
    fs.writeFileSync(path.join(r.root, '.gitignore'), 'node_modules/\nout/\n')
    gitIn(r.root, 'add', '-A')
    gitIn(r.root, 'commit', '-qm', 'tracked build and dist folders')
    const wt = linkedWorktree(r.root, 'wt-truth')
    t = await startFiles()
    t.session('s1', wt, { baseBranch: 'main' })
    t.show('s1')
    await t.ready('s1')
    await t.call('files.expand', { sessionId: 's1', path: 'build' })
    await until('the stream to be live', () => t?.watcher?.followed()[0]?.mode === 'live')
    await t.idle('s1')
    const excluded = (): string[] => (t?.watcher?.followed()[0]?.excluded ?? []).map((p) => path.relative(wt, p)).sort()
    // what git ignores whole, and nothing git may report from (a linked worktree's `.git` is a file: never excluded)
    expect(excluded()).toEqual(['node_modules', 'out'])
    expect(t.treeHead('s1')?.live).toBe(true)

    // only a file inside tracked `build/` is written, and nothing else
    const runs = t.statusRuns('s1')
    write(wt, 'build/second.sh', 'second\n')
    await until('Changes to list the new file', () => t!.codes('s1')['build/second.sh'] === 'U')
    await until('the expanded folder to list it', () => t!.names('s1', 'build').includes('second.sh'))
    expect(t.statusRuns('s1')).toBeGreaterThan(runs)
    write(wt, 'dist/index.js', 'export const x = 1\n')
    await until('the edit in tracked dist/', () => t!.codes('s1')['dist/index.js'] === 'M')
    await t.idle('s1')

    // an ignored folder is still the kernel's: nothing written there arrives (the marker after it does)
    const ignoredBefore = t.s('s1').stats.ignoredEvents
    for (let i = 0; i < 200; i++) write(wt, `out/gen-${i}.js`)
    write(wt, 'marker.txt')
    await until('the marker', () => t!.codes('s1')['marker.txt'] === 'U')
    await t.idle('s1')
    expect(t.s('s1').stats.ignoredEvents - ignoredBefore, 'no event from out/ reached core').toBe(0)
    expect(Object.keys(t.codes('s1')).filter((p) => p.startsWith('out/'))).toEqual([])

    // `out/` stops being ignored (its rule goes): the stream is opened again without it, and its files are changes
    fs.writeFileSync(path.join(wt, '.gitignore'), 'node_modules/\n')
    await until('out/ to be followed', () => !excluded().includes('out') && t?.watcher?.followed()[0]?.mode === 'live')
    await until('its files to be listed', () => t!.codes('s1')['out/gen-0.js'] === 'U')
    await t.idle('s1')
    write(wt, 'out/later.js')
    await until('a file written there later', () => t!.codes('s1')['out/later.js'] === 'U')

    // a file added with `-f` inside an ignored folder: git now reports from it, so it is followed too
    await t.call('files.setScope', { sessionId: 's1', scope: 'uncommitted' })
    write(wt, 'node_modules/kept/index.js', 'export const kept = 1\n')
    gitIn(wt, 'add', '-f', 'node_modules/kept/index.js')
    await until('node_modules/ to be followed', () => !excluded().includes('node_modules') && t?.watcher?.followed()[0]?.mode === 'live')
    gitIn(wt, 'add', '-A')
    gitIn(wt, 'commit', '-qm', 'keep it')
    await until('nothing uncommitted', () => t!.head('s1')?.state === 'ok' && Object.keys(t!.codes('s1')).length === 0)
    await t.idle('s1')
    write(wt, 'node_modules/kept/index.js', 'export const kept = 2\n')
    await until('the edit of the tracked file under node_modules/', () => t!.codes('s1')['node_modules/kept/index.js'] === 'M')
    expect(excluded()).toEqual([])
  })

  it.runIf(watching)('I-FT-9 · poll-only: activation, window focus, a finished tool and each poll are one refresh apiece, and the panel is told live updates are off; with a working watcher nothing at all runs over 60 s of idling', async () => {
    const r = repo()
    // the watcher cannot start: every worktree is poll-only
    const broken: NativeWatcher = { subscribe: () => Promise.reject(new Error('FSEvents is not available')), unsubscribe: () => Promise.resolve() }
    const clock = new ManualClock()
    t = await startFiles({ watcher: { native: broken, clock } })
    t.session('s1', r.root)
    const runs = (): number => t!.s('s1').stats.refreshes
    const settled = async (n: number, what: string): Promise<void> => {
      await until(`${what}: refresh #${n}`, () => runs() >= n && t!.s('s1').scheduler.idle)
      expect(runs(), what).toBe(n)
      expect(t!.statusRuns('s1'), what).toBe(n)
    }
    t.show('s1')
    await t.ready('s1')
    await settled(1, 'activation')
    expect(t.treeHead('s1')).toEqual({ git: true, live: false, missing: false }) // "live updates unavailable"
    expect(t.watcher?.counts).toMatchObject({ polls: 1, streams: 0 })
    t.files.focus()
    await settled(2, 'window focus')
    t.files.toolFinished('s1')
    await settled(3, 'a finished tool')
    t.files.toolFinished('other-session') // not shown: nothing
    clock.advance(L.watchPollMs)
    await settled(4, 'the poll')
    clock.advance(L.watchPollMs - 1)
    await settled(4, 'before the next poll')
    clock.advance(1)
    await settled(5, 'the next poll')
    // a change on disk is seen at the next poll, not before: nothing told core
    write(r.root, 'src/polled.js')
    await t.call('files.expand', { sessionId: 's1', path: 'src' })
    fs.rmSync(path.join(r.root, 'src', 'polled.js'))
    write(r.root, 'src/polled-2.js')
    expect(t.names('s1', 'src')).toContain('polled.js')
    clock.advance(L.watchPollMs)
    await settled(6, 'the poll after a change')
    await until('the tree to follow', () => t!.names('s1', 'src').includes('polled-2.js') && !t!.names('s1', 'src').includes('polled.js'))
    expect(t.codes('s1')).toEqual({ 'src/polled-2.js': 'U' })
    // hidden: no poll, no refresh
    t.show(null)
    expect(t.watcher?.counts.polls).toBe(0)
    clock.advance(L.watchPollMs * 3)
    expect(runs()).toBe(6)
    await t.dispose()

    // a working watcher: after the activation's refresh, 60 s of idling run nothing: no poll, no timer, no git
    const clock2 = new ManualClock()
    t = await startFiles({ watcher: { clock: clock2 } })
    t.session('s1', r.root)
    t.show('s1')
    await t.ready('s1')
    await until('the stream to be live', () => t?.watcher?.followed()[0]?.mode === 'live')
    await until('the ignored list', () => t!.s('s1').ignore?.loaded === true)
    await t.idle('s1')
    expect(t.treeHead('s1')?.live).toBe(true)
    const idleRuns = t.s('s1').stats.refreshes
    expect(idleRuns).toBe(1) // the activation's: the stream was open before it began
    for (let s = 0; s < 60; s++) clock2.advance(1000)
    expect(t.s('s1').stats.refreshes).toBe(idleRuns)
    expect(t.watcher?.counts).toMatchObject({ polls: 0, restarts: 0, pendingEvents: 0 })
    expect(t.watcher?.scope.size).toBe(0) // not one timer armed in the watch service
    expect(t.files.counts).toMatchObject({ timers: 0, statusRunning: 0, statusPending: 0 })
  })

  it.runIf(watching)('I-FT-12 · a linked worktree (`.git` is a file): its git dir is found through git, and a commit, a checkout and a stash made in it each refresh the status', async () => {
    const r = repo()
    const wt = linkedWorktree(r.root, 'wt-a')
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true)
    t = await startFiles()
    t.session('s1', wt, { baseBranch: 'main' })
    t.show('s1')
    await t.ready('s1')
    const s = t.s('s1')
    expect(s.repo).toMatchObject({ gitDir: path.join(r.root, '.git', 'worktrees', 'wt-a'), commonDir: path.join(r.root, '.git'), linked: true })
    expect(t.names('s1')).not.toContain('.git') // the file is hidden like the directory
    expect(t.watcher?.followed()).toMatchObject([{ root: wt, commonDir: path.join(r.root, '.git') }])
    await until('the streams to be live', () => t?.watcher?.followed()[0]?.mode === 'live')
    expect(t.watcher?.counts).toMatchObject({ worktrees: 1, commonDirs: 1, streams: 2 }) // the worktree and the common dir; no third for the git dir
    expect(t.head('s1')).toMatchObject({ state: 'ok', branch: 'kea/wt-a', baseBranch: 'main', ahead: 0, behind: 0 })

    // the agent edits and commits: the file leaves Uncommitted and stays in Branch
    write(wt, 'src/feature.js', 'export const f = 1\n')
    await until('the new file', () => t!.codes('s1')['src/feature.js'] === 'U')
    await t.idle('s1')
    let runs = t.statusRuns('s1')
    gitIn(wt, 'add', '-A')
    gitIn(wt, 'commit', '-qm', 'feature')
    await until('the commit to be seen', () => t!.head('s1')?.ahead === 1 && t!.codes('s1')['src/feature.js'] === 'A')
    expect(t.statusRuns('s1')).toBeGreaterThan(runs)
    expect(t.entries('s1')['src/feature.js']).toMatchObject({ code: 'A', added: 1, removed: 0 })
    // a checkout of another branch in the worktree
    await t.idle('s1')
    runs = t.statusRuns('s1')
    gitIn(wt, 'checkout', '-q', '-b', 'kea/other')
    await until('the checkout to be seen', () => t!.head('s1')?.branch === 'kea/other')
    expect(t.statusRuns('s1')).toBeGreaterThan(runs)
    // a stash: the working change goes (the files change and so does `refs/stash`)
    write(wt, 'README.md', '# changed\n')
    await until('the edit', () => t!.codes('s1')['README.md'] === 'M')
    await t.idle('s1')
    runs = t.statusRuns('s1')
    gitIn(wt, 'stash', '-q')
    await until('the stash to be seen', () => t!.codes('s1')['README.md'] === undefined)
    expect(t.statusRuns('s1')).toBeGreaterThan(runs)
    // a commit on the base branch, made in the main checkout: this worktree is now behind (the shared common-dir stream)
    await t.idle('s1')
    write(r.root, 'base.txt')
    gitIn(r.root, 'add', '-A')
    gitIn(r.root, 'commit', '-qm', 'on main')
    await until('the base branch’s commit to be seen', () => t!.head('s1')?.behind === 1)
    // Kea's own status never writes to the repository: no `index.lock`, and its runs are not events (no loop)
    await t.idle('s1')
    const quiet = t.statusRuns('s1')
    t.files.focus()
    await until('the focus refresh', () => t!.statusRuns('s1') === quiet + 1 && t!.s('s1').scheduler.idle)
    await until('the watcher to have nothing pending', () => t!.watcher?.counts.pendingEvents === 0)
    expect(t.statusRuns('s1')).toBe(quiet + 1)
  })

  it.runIf(watching)('I-FT-13 · the finder’s index is built from `git ls-files` in a worker thread, patched by watcher events, and answers while core’s own thread stays free; the latest query wins', async () => {
    const m = mediumRepo()
    later(() => m.dispose())
    write(m.root, 'untracked-notes.md')
    t = await startFiles()
    t.session('s1', m.root)
    t.show('s1')
    await t.ready('s1')
    await until('the stream to be live', () => t?.watcher?.followed()[0]?.mode === 'live')
    type Found = { hits: { path: string; matched: number[]; changed: boolean }[]; total: number; truncated: boolean; superseded: boolean }
    const find = (query: string, recent?: string[]): Promise<Found> => t!.call<Found>('files.find', { sessionId: 's1', query, ...(recent ? { recent } : {}) })
    expect(t.files.counts).toMatchObject({ finderIndexes: 0, finderWorkers: 0 }) // nothing until the first query
    const tracked = Number(gitIn(m.root, 'ls-files').split('\n').length)
    const first = await find('untracked')
    expect(first.total).toBe(tracked + 1) // tracked and untracked, not ignored
    expect(first.hits[0]).toMatchObject({ path: 'untracked-notes.md', changed: true })
    expect(first.hits[0]?.matched.slice(0, 3)).toEqual([0, 1, 2])
    expect(t.files.counts).toMatchObject({ finderIndexes: 1, finderWorkers: 1, finderPaths: tracked + 1 })
    expect(t.s('s1').finder?.builds).toBe(1)

    // matching happens in the worker: core's thread is busy only with passing messages
    const queries = ['f001', 'src/m', 'label', 'mod12f', 'ts', 'index', 'zzzz-nothing', 'f1', 'src', 'module-3/f0']
    const loop = performance.eventLoopUtilization()
    const t0 = performance.now()
    for (const q of queries) for (let i = 1; i <= q.length; i++) expect((await find(q.slice(0, i))).hits.length).toBeLessThanOrEqual(L.finderResults)
    const wall = performance.now() - t0
    const used = performance.eventLoopUtilization(loop)
    const n = queries.reduce((a, q) => a + q.length, 0)
    const perQueryActive = (used.active / n)
    expect(perQueryActive, `core's thread was busy ${perQueryActive.toFixed(2)} ms per query (${n} queries in ${Math.round(wall)} ms)`).toBeLessThan(5)
    expect(t.s('s1').finder?.builds).toBe(1)
    expect(t.s('s1').finder?.queries).toBe(n + 1)

    // patched by watcher events: a new file is found, a deleted one is not
    write(m.root, 'src/brand-new-widget.ts')
    await until('the new file to be found', async () => (await find('brandnewwidget')).hits[0]?.path === 'src/brand-new-widget.ts')
    const victim = (await find('f000')).hits[0]?.path as string
    fs.rmSync(path.join(m.root, victim))
    await until('the deleted file to be gone', async () => !(await find(victim)).hits.some((h) => h.path === victim))
    expect(t.s('s1').finder?.builds).toBe(1) // patched, not rebuilt
    expect((await find('untracked')).total).toBe(tracked + 1) // one in, one out

    // the latest query wins: of three typed in a burst, the middle one gives way
    const burst = await Promise.all([find('a'), find('ab'), find('readme')])
    expect(burst.map((b) => b.superseded)).toEqual([true, true, false]) // typed in one go: only the last is answered
    expect(burst[1]?.hits).toEqual([])
    expect(burst[2]?.hits[0]?.path).toBe('README.md')
    // one already being matched finishes; of those that arrive meanwhile only the last is answered
    const asked = t.s('s1').finder?.queries as number
    const running = find('f0')
    await until('the query to be with the worker', () => t!.s('s1').finder?.queries === asked + 1)
    const [second, third] = await Promise.all([find('f00'), find('f001')])
    expect([(await running).superseded, second?.superseded, third?.superseded]).toEqual([false, true, false])
    // recent and changed files lead an empty query
    const empty = await find('', ['README.md', 'does/not/exist.ts'])
    expect(empty.hits[0]?.path).toBe('README.md')
    expect(empty.hits.map((h) => h.path)).toContain('untracked-notes.md')

    // hidden: the index and its worker go with the wait the last query started, not at once (I-FT-17)
    t.show(null)
    expect(t.files.counts).toMatchObject({ finderIndexes: 1, finderWorkers: 1 })
    t.s('s1').dropFinder()
    expect(t.files.counts).toMatchObject({ finderIndexes: 0, finderWorkers: 0, finderPaths: 0 })
  })
  // A new file the batcher hands on as `update`: made, removed and made again inside one L.watchBatchMs window
  // (create→delete is a delete, delete→create an update), or removed in one of the watcher's batches (made and removed
  // there, which Kea's patched @parcel/watcher reports as a removal) and made in its next. A finder that took only a
  // `create` as new would leave the file out of Quick Open until a rebuild. A hand-driven watcher puts the events in one
  // window on every system.
  it('I-FT-28 · a file the window reports as an update because it was made, removed and made again (or the watcher reported it removed, then made) joins the finder’s index; a file only saved is still there once', async () => {
    const subs: { dir: string; fn: NativeCallback }[] = []
    const native: NativeWatcher = {
      subscribe: (dir, fn) => (subs.push({ dir, fn }), Promise.resolve(null)),
      unsubscribe: (dir, fn) => {
        const i = subs.findIndex((x) => x.dir === dir && x.fn === fn)
        if (i >= 0) subs.splice(i, 1)
        return Promise.resolve()
      },
    }
    const r = repo()
    t = await startFiles({ watcher: { native } })
    t.session('s1', r.root)
    t.show('s1')
    await t.ready('s1')
    await until('the stream to be live', () => t?.watcher?.followed()[0]?.mode === 'live')
    const root = fs.realpathSync(r.root)
    const emit = (events: [string, NativeEvent['type']][]) => {
      for (const x of subs.filter((x) => x.dir === root)) x.fn(null, events.map(([p, type]) => ({ path: path.join(root, p), type })))
    }
    type Found = { hits: { path: string }[]; total: number }
    const find = (query: string): Promise<Found> => t!.call<Found>('files.find', { sessionId: 's1', query })
    const total = (await find('x')).total // builds the index
    const saved = (await find('readme')).hits[0]?.path as string
    expect(saved).toBeTruthy()

    write(r.root, 'made-again.ts')
    emit([['made-again.ts', 'create']])
    emit([['made-again.ts', 'delete']])
    emit([['made-again.ts', 'create']])
    write(r.root, 'reported-gone.ts')
    emit([['reported-gone.ts', 'delete']])
    emit([['reported-gone.ts', 'create'], [saved, 'update']])
    await until('both new files to be found', async () => (await find('madeagain')).hits[0]?.path === 'made-again.ts' && (await find('reportedgone')).hits[0]?.path === 'reported-gone.ts')
    expect((await find('x')).total).toBe(total + 2) // the saved file is not counted twice
    expect(t.s('s1').finder?.builds).toBe(1) // patched, not rebuilt
  })

  it('I-FT-17 · the finder’s index and its worker go a set time after the finder was last used, also while the session stays on screen: each query starts the wait again, hiding the session or showing it again does not, and the next query builds a new index', async () => {
    const r = repo()
    later(() => r.dispose())
    write(r.root, 'src/alpha.ts')
    write(r.root, 'src/beta.ts')
    const dropMs = 400 // the delay under test (the app's is L.finderDropMs)
    // libuv's timers run on its millisecond loop clock, read at the start of each turn of the loop: one can fire up to a
    // millisecond before performance.now() has the delay passed (seen in the Linux VM: 399.77 ms)
    const loopClockMs = 1
    t = await startFiles({ files: { finderDropMs: dropMs } })
    t.session('s1', r.root)
    t.show('s1')
    await t.ready('s1')
    const find = (query: string): Promise<{ hits: { path: string }[] }> => t!.call('files.find', { sessionId: 's1', query })
    const gone = (): boolean => t!.files.counts.finderIndexes === 0 && t!.files.counts.finderWorkers === 0

    // used for longer than the delay: the index is the first one throughout, and it outlives the last query by the delay
    const t0 = performance.now()
    expect((await find('alpha')).hits[0]?.path).toBe('src/alpha.ts')
    const first = t.s('s1').finder
    let last = t0
    while (performance.now() - t0 < dropMs * 1.5) {
      last = performance.now()
      await find('beta')
      expect(t.s('s1').finder, 'a query within the delay keeps the index').toBe(first)
    }
    await until('the index to go while the session is still on screen', gone)
    expect(performance.now() - last).toBeGreaterThanOrEqual(dropMs - loopClockMs)
    expect(t.s('s1').visible).toBe(true)

    // the next query builds it again
    const used = performance.now()
    expect((await find('beta')).hits[0]?.path).toBe('src/beta.ts')
    expect(t.s('s1').finder).not.toBe(first)
    expect(t.s('s1').finder?.builds).toBe(1)
    expect(t.files.counts).toMatchObject({ finderIndexes: 1, finderWorkers: 1 })

    // hidden and shown again without a query: the wait is neither stopped nor started again
    t.show(null)
    expect(t.files.counts).toMatchObject({ finderIndexes: 1, finderWorkers: 1 }) // not at once
    t.show('s1')
    await until('the index to go, though the session was shown again', gone)
    expect(performance.now() - used).toBeGreaterThanOrEqual(dropMs - loopClockMs)

    // hidden with an index: gone within the delay, and no timer is left for it
    await find('alpha')
    t.show(null)
    await until('the index of the hidden session to go', gone)
    expect(t.files.counts.finderPaths).toBe(0)
  })
  it('I-FT-20 · the panel’s state saved for a session the window has just left is kept (its scroll position at the moment of the switch), and comes back with `files.open` when the session is shown again; for a session nothing is held for, the save answers that it was not kept', async () => {
    const a = repo('a')
    const b = repo('b')
    t = await startFiles()
    t.session('s1', a.root)
    t.session('s2', b.root)
    t.show('s1')
    await t.ready('s1')
    await t.call('files.saveUi', { sessionId: 's1', ui: { files: { top: 48 } } })
    t.show('s2') // the window moved on; what it had of s1 is saved after core heard of the switch
    expect(await t.call('files.saveUi', { sessionId: 's1', ui: { files: { top: 960, sel: 'src/math.js' } } })).toEqual({ ok: true })
    await t.ready('s2')
    t.show('s1')
    expect(await t.call('files.open', { sessionId: 's1' })).toMatchObject({ ui: { files: { top: 960, sel: 'src/math.js' } } })
    // a session core holds nothing for
    expect(await t.call('files.saveUi', { sessionId: 'never-shown', ui: { files: { top: 1 } } })).toEqual({ ok: false })
  })
  it.runIf(watching)('I-FT-16 · a session on screen in one window keeps its stream while another window moves through more sessions than L.watchWorktreesLru; with more sessions on screen than the cap, the one left without a stream says it is not live, is read again at a refresh, and is followed again when next shown', async () => {
    const r = repo()
    t = await startFiles()
    const ft = t
    const w = ft.watcher as NonNullable<FilesUnderTest['watcher']>
    const ids = Array.from({ length: L.watchWorktreesLru + 3 }, (_, i) => `s${i}`)
    ids.forEach((id, i) => ft.session(id, linkedWorktree(r.root, `wt-${i}`), { baseBranch: 'main' }))
    const rootOf = (id: string): string => ft.sessions.get(id)?.cwd as string
    const followed = (id: string): boolean => w.followed().some((f) => f.root === rootOf(id))

    // window 0 stays on s0; window 1 moves through every other session
    ft.show('s0', 0)
    await ft.ready('s0')
    for (const id of ids.slice(1)) {
      ft.show(id, 1)
      await ft.ready(id)
      expect(followed('s0'), `s0 is still followed after window 1 showed ${id}`).toBe(true)
      expect(w.counts.worktrees).toBeLessThanOrEqual(L.watchWorktreesLru)
    }
    expect(ft.treeHead('s0')).toMatchObject({ live: true })
    write(rootOf('s0'), 'seen.txt')
    await until('a change in the session that stayed on screen', () => ft.names('s0').includes('seen.txt') && ft.codes('s0')['seen.txt'] === 'U')

    // one more session on screen than worktrees are followed: each window its own
    const many = ids.slice(0, L.watchWorktreesLru + 1)
    many.forEach((id, i) => ft.show(id, i))
    for (const id of many) await ft.ready(id)
    await until('one of them to be left without a stream, and to say so', () => many.filter((id) => !followed(id)).length === 1 && many.filter((id) => ft.treeHead(id)?.live === false).length === 1)
    const out = many.find((id) => !followed(id)) as string
    expect(ft.treeHead(out)).toMatchObject({ live: false })
    // never the session that was on screen with its stream before the others came (I-FT-24 tests this on its own)
    expect(out).not.toBe('s0')
    expect(ft.treeHead('s0')).toMatchObject({ live: true })
    expect(w.counts.worktrees).toBe(L.watchWorktreesLru)
    // it is not told of changes, and does not take a stream back from another by itself; a refresh reads it again
    write(rootOf(out), 'unseen.txt')
    const streams = w.counts.evictions
    await ft.call('files.refresh', { sessionId: out })
    await until('the refresh to show the change', () => ft.names(out).includes('unseen.txt') && ft.codes(out)['unseen.txt'] === 'U')
    expect(w.counts.evictions, 'the refresh released nobody else').toBe(streams)
    expect(followed(out)).toBe(false)
    // shown again once a slot is free: followed and live
    many.filter((id) => id !== out).forEach((_, i) => ft.show(null, many.indexOf(many.filter((id) => id !== out)[i] as string)))
    ft.show(null, many.indexOf(out))
    ft.show(out, 0)
    await ft.ready(out)
    await until('it to be followed again', () => followed(out) && ft.treeHead(out)?.live === true)
    write(rootOf(out), 'seen-again.txt')
    await until('a change after that', () => ft.names(out).includes('seen-again.txt'))
  })
  it('I-FT-25 · a session archived or deleted while it is on screen is let go of as soon as it leaves the screen: nothing is held for it and its worktree is no longer followed, as for one archived while hidden', async () => {
    const r = repo()
    t = await startFiles()
    const ft = t
    const w = ft.watcher as NonNullable<FilesUnderTest['watcher']>
    const followed = (id: string): boolean => w.followed().some((f) => f.root === ft.sessions.get(id)?.cwd)
    for (const [i, lifecycle] of (['archived', 'deleted'] as const).entries()) {
      const id = `s${i}`
      ft.session(id, linkedWorktree(r.root, `wt-${i}`), { baseBranch: 'main' })
      ft.show(id)
      await ft.ready(id)
      await until('its worktree to be followed', () => followed(id))
      // archived (or deleted) while a window still shows it: it stays as it is on screen
      ft.sessions.set(id, { ...ft.sessions.get(id), lifecycle } as never)
      expect(ft.files.session(id), `${lifecycle}: still shown`).toBeDefined()
      // the window moves on
      ft.show(null)
      expect(ft.files.session(id), `${lifecycle}: nothing is held once it is hidden`).toBeUndefined()
      expect(followed(id), `${lifecycle}: its worktree is no longer followed`).toBe(false)
    }
    await until('the released streams to close', () => w.counts.worktrees === 0)
  })

})
