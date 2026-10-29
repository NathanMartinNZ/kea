// Git status in core: the `git:<sessionId>` store from real git in temp repositories, both scopes, the refresh
// scheduler, and the git facts the rest of core reads. Harness: core-files-support.ts.

import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { POOL_LIMITS, setGitBinary } from '@kea/kit'
import { changesOrder, isAvailable, L, type GitRow, type Project } from '@kea/protocol'
import { stopFsmonitor } from '@kea/core/src/worktrees/ops.ts'
import { fixtureGitEnv } from '@kea-tools/repo-factory/src/index.ts'
import { until } from '../support/holders.ts'
import { cleanup, gitEnv, gitIn, later, linkedWorktree, repo, startFiles, tempDir, write, type FilesUnderTest } from './core-files-support.ts'
import { coreOs } from '../../app/core/src/os/index.ts'

// Live updates need the native watcher: FSEvents on macOS, inotify through Kea's patched build on Linux.
const watching = isAvailable(coreOs.watcher)

let t: FilesUnderTest | null = null
afterEach(async () => {
  await t?.dispose()
  t = null
  cleanup()
})

const realGit = execFileSync('/usr/bin/which', ['git'], { env: fixtureGitEnv() }).toString().trim() // os-ok: in /usr/bin on both systems

/** This git has its fsmonitor daemon (macOS's; Linux's git has none), so the project's setting takes effect. */
const gitDaemon = /^feature: fsmonitor--daemon$/m.test(execFileSync(realGit, ['version', '--build-options']).toString())

/** A `git` that is a script: `body` runs with the real git's path in `$REAL`. Core uses it until the test ends. */
function stubGit(body: string): string {
  const dir = tempDir('kea-git-stub-')
  const file = path.join(dir, 'git')
  fs.writeFileSync(file, `#!/bin/sh\nREAL='${realGit}'\n${body}\n`, { mode: 0o755 })
  setGitBinary(file)
  return file
}

/**
 * git as an agent runs it in a loop. Without background maintenance: this git loses objects when its auto-maintenance
 * races a tight commit loop (the repository is corrupted with no Kea process near it), which is not what a test of
 * Kea's own git calls is about.
 */
const AGENT_GIT_ENV = { ...fixtureGitEnv(), GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' }

function gitAsync(dir: string, ...args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => execFile(realGit, ['-C', dir, ...args], { env: AGENT_GIT_ENV }, (err, _out, stderr) => resolve({ ok: !err, stderr: String(stderr) })))
}

const refreshed = async (id: string, from: number): Promise<void> => {
  await until(`a status after #${from}`, () => (t as FilesUnderTest).statusRuns(id) > from && (t as FilesUnderTest).s(id).scheduler.idle)
}

describe('git status in core', () => {
  it.runIf(watching)('I-GS-1 · modified, added, staged, deleted, renamed, untracked, conflicted and a changed submodule: each path has its letter and its counts, the head says what is going on', async () => {
    const r = repo()
    // a submodule, committed
    const lib = repo('lib')
    gitIn(r.root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib.root, 'vendor/lib')
    gitIn(r.root, 'commit', '-qm', 'add the library')
    // two branches that change the same line: the merge below conflicts
    gitIn(r.root, 'checkout', '-q', '-b', 'other')
    write(r.root, 'README.md', '# demo\n\nTheirs.\n')
    gitIn(r.root, 'commit', '-qam', 'theirs')
    gitIn(r.root, 'checkout', '-q', 'main')
    write(r.root, 'README.md', '# demo\n\nOurs.\n')
    gitIn(r.root, 'commit', '-qam', 'ours')
    const start = gitIn(r.root, 'rev-parse', 'HEAD')

    t = await startFiles()
    t.session('s1', r.root, { baseCommit: start }) // a session in the project's own checkout: no base branch
    t.show('s1')
    await t.ready('s1')
    expect(t.head('s1')).toMatchObject({ state: 'ok', scope: 'branch', base: start, branch: 'main', detached: null, baseBranch: null, operation: null, totals: { files: 0, added: 0, removed: 0 } })
    expect(t.entries('s1')).toEqual({})
    await until('the stream to be live', () => t?.watcher?.followed()[0]?.mode === 'live')

    expect(() => gitIn(r.root, 'merge', '-q', 'other')).toThrow() // conflict
    write(r.root, 'src/math.js', 'export function add(a, b) {\n  return a + b\n}\n\nexport const mul = (a, b) => a * b\n') // modified: `sub` (3 lines) out, `mul` (1 line) in
    write(r.root, 'src/added.js', 'export const added = true\n')
    gitIn(r.root, 'add', 'src/added.js') // added
    write(r.root, 'src/index.js', '// staged\n')
    gitIn(r.root, 'add', 'src/index.js')
    fs.appendFileSync(path.join(r.root, 'src/index.js'), '// and edited again\n') // staged and modified
    fs.rmSync(path.join(r.root, 'src/counter.js')) // deleted
    gitIn(r.root, 'mv', 'src/hello.js', 'src/greet.js') // renamed
    write(r.root, 'notes.txt', 'one\ntwo\nthree') // untracked, three lines
    write(r.root, 'logo.bin', Buffer.from([0, 1, 2, 3]).toString('latin1')) // untracked, binary
    write(lib.root, 'new-in-lib.txt')
    gitIn(lib.root, 'add', '-A')
    gitIn(lib.root, 'commit', '-qm', 'lib moves on')
    gitIn(path.join(r.root, 'vendor/lib'), '-c', 'protocol.file.allow=always', 'pull', '-q') // the submodule's commit changed

    const want = { 'README.md': '!', 'logo.bin': 'U', 'notes.txt': 'U', 'src/added.js': 'A', 'src/counter.js': 'D', 'src/greet.js': 'R', 'src/index.js': 'M', 'src/math.js': 'M', 'vendor/lib': 'M' }
    await until('the status to hold all nine', () => JSON.stringify(t!.codes('s1')) === JSON.stringify(want))
    await t.idle('s1')
    const e = t.entries('s1')
    expect(e['src/math.js']).toEqual({ path: 'src/math.js', code: 'M', added: 1, removed: 3, origPath: null })
    expect(e['src/added.js']).toMatchObject({ added: 1, removed: 0 })
    expect(e['src/index.js']).toMatchObject({ added: 2, removed: 4 })
    expect(e['src/counter.js']).toMatchObject({ added: 0, removed: 6 })
    expect(e['src/greet.js']).toMatchObject({ code: 'R', origPath: 'src/hello.js', added: 0, removed: 0 })
    expect(e['notes.txt']).toMatchObject({ added: 3, removed: null }) // counted by Kea: a last line without a newline is a line
    expect(e['logo.bin']).toMatchObject({ added: null, removed: null }) // binary: no count
    expect(e['vendor/lib']).toMatchObject({ code: 'M', submodule: true }) // one entry, never what is inside
    expect(Object.keys(e).some((p) => p.startsWith('vendor/lib/'))).toBe(false)
    expect(e['README.md']?.code).toBe('!')
    expect(t.head('s1')).toMatchObject({ state: 'ok', operation: { kind: 'merge', step: null, total: null }, totals: { files: 9 } })
    // conflicts first, then by path: the Changes list's order, and what the diff's `]` and `[` step through
    expect(changesOrder(new Map<string, GitRow>(t.git('s1').entries())).map((x) => x.path)).toEqual(['README.md', 'logo.bin', 'notes.txt', 'src/added.js', 'src/counter.js', 'src/greet.js', 'src/index.js', 'src/math.js', 'vendor/lib'])
    // the same from the git facts (what the viewer asks)
    expect(t.files.entry('s1', 'src/greet.js')).toMatchObject({ code: 'R', origPath: 'src/hello.js' })
    expect(t.files.entry('s1', 'package.json')).toBeNull()

    // a detached HEAD shows its short commit id; a rebase in progress its step
    gitIn(r.root, 'reset', '-q', '--hard', 'HEAD') // the merge is off, the changes gone
    gitIn(r.root, 'clean', '-fdq')
    gitIn(r.root, 'checkout', '-q', '--detach', 'HEAD')
    await until('the detached HEAD', () => t!.head('s1')?.detached === start.slice(0, 7) && t!.head('s1')?.branch === null && t!.head('s1')?.operation === null)
    gitIn(r.root, 'checkout', '-q', 'main')
    expect(() => gitIn(r.root, 'rebase', '-q', 'other')).toThrow()
    await until('the rebase', () => t!.head('s1')?.operation?.kind === 'rebase')
    expect(t.head('s1')?.operation).toEqual({ kind: 'rebase', step: 1, total: 1 })
    expect(t.codes('s1')['README.md']).toBe('!')
  })

  it.runIf(watching)('I-GS-2 · the agent commits half its work: Branch lists all of it, Uncommitted the rest, with the right totals; a refresh is one status and one diff, and the merge base is computed again only when `HEAD` or the base branch moves', async () => {
    const r = repo()
    const wt = linkedWorktree(r.root, 'wt-a')
    const fork = gitIn(r.root, 'rev-parse', 'main')
    t = await startFiles()
    const changes: string[] = []
    t.files.onChange((id) => void changes.push(id))
    t.session('s1', wt, { baseBranch: 'main', baseCommit: fork })
    t.show('s1')
    await t.ready('s1')
    await until('the stream to be live', () => t?.watcher?.followed()[0]?.mode === 'live')
    expect(t.files.scope('s1')).toBe('branch')
    // four changes; two of them committed
    write(wt, 'src/committed-new.js', 'a\nb\n')
    write(wt, 'src/math.js', 'export const add = (a, b) => a + b\n')
    gitIn(wt, 'add', '-A')
    gitIn(wt, 'commit', '-qm', 'half the work')
    const head = gitIn(wt, 'rev-parse', 'HEAD')
    write(wt, 'src/hello.js', "export const greet = (n) => `Hello, ${n}!`\n")
    write(wt, 'todo.md', 'later\n')
    const all = { 'src/committed-new.js': 'A', 'src/hello.js': 'M', 'src/math.js': 'M', 'todo.md': 'U' }
    await until('Branch to list all four', () => JSON.stringify(t!.codes('s1')) === JSON.stringify(all) && t!.head('s1')?.ahead === 1)
    await t.idle('s1')
    expect(t.head('s1')).toMatchObject({ scope: 'branch', base: fork, branch: 'kea/wt-a', baseBranch: 'main', ahead: 1, behind: 0, totals: { files: 4, added: 2 + 1 + 1 + 1, removed: 7 + 3 } })
    expect(await t.files.base('s1', 'branch')).toBe(fork)
    expect(await t.files.base('s1', 'uncommitted')).toBe(head)
    expect(changes).toContain('s1')

    // the other scope: only what `git status` shows, compared with HEAD
    changes.length = 0
    expect(await t.call('files.setScope', { sessionId: 's1', scope: 'uncommitted' })).toEqual({ ok: true })
    expect(t.head('s1')).toMatchObject({ scope: 'uncommitted', state: 'loading', base: null }) // at once: the other scope's rows are not this one's
    expect(t.entries('s1')).toEqual({})
    await until('Uncommitted', () => t!.head('s1')?.state === 'ok' && t!.s('s1').scheduler.idle)
    expect(t.codes('s1')).toEqual({ 'src/hello.js': 'M', 'todo.md': 'U' })
    expect(t.head('s1')).toMatchObject({ scope: 'uncommitted', base: head, baseBranch: 'main', ahead: 1, totals: { files: 2, added: 2, removed: 3 } })
    expect(t.files.scope('s1')).toBe('uncommitted')
    expect(changes).toContain('s1')
    await t.call('files.setScope', { sessionId: 's1', scope: 'branch' })
    await until('Branch again', () => t!.head('s1')?.state === 'ok' && Object.keys(t!.entries('s1')).length === 4)
    await t.idle('s1')

    // five refreshes with nothing moving: five statuses, five diffs, no merge-base at all
    const c = t.s('s1').statusCounters!
    const before = { ...c }
    for (let i = 0; i < 5; i++) {
      const n = c.status
      await t.call('files.refresh', { sessionId: 's1' })
      await refreshed('s1', n)
    }
    expect([c.status - before.status, c.diff - before.diff, c.mergeBase - before.mergeBase, c.revList - before.revList]).toEqual([5, 5, 0, 0])
    // HEAD moves (a commit): the base is asked for once more, and only once
    gitIn(wt, 'commit', '-qam', 'the rest')
    await until('the second commit', () => t!.head('s1')?.ahead === 2)
    await t.idle('s1')
    expect(c.mergeBase - before.mergeBase).toBe(1)
    expect(t.codes('s1')).toEqual(all) // committed or not, Branch still lists it
    const n = c.status
    await t.call('files.refresh', { sessionId: 's1' })
    await refreshed('s1', n)
    expect(c.mergeBase - before.mergeBase).toBe(1)
    // the base branch moves (someone commits on main): asked for again; the merge base itself is the same commit
    write(r.root, 'on-main.txt')
    gitIn(r.root, 'add', '-A')
    gitIn(r.root, 'commit', '-qm', 'main moves')
    await until('the base branch’s commit', () => t!.head('s1')?.behind === 1)
    expect(c.mergeBase - before.mergeBase).toBe(2)
    expect(t.head('s1')?.base).toBe(fork)
    // the base branch is deleted: the session's base commit stands in
    gitIn(r.root, 'checkout', '-q', '-b', 'trunk')
    gitIn(r.root, 'branch', '-qD', 'main')
    await until('the fallback', () => t!.head('s1')?.baseBranch === null && t!.head('s1')?.state === 'ok')
    expect(t.head('s1')).toMatchObject({ base: fork, ahead: 2, behind: null })
    expect(t.codes('s1')).toEqual(all)

    // the scope is kept per session: hidden and shown again, and after the caches are gone
    await t.call('files.setScope', { sessionId: 's1', scope: 'uncommitted' })
    await until('Uncommitted', () => t!.head('s1')?.state === 'ok' && JSON.stringify(t!.codes('s1')) === JSON.stringify({ 'todo.md': 'U' }))
    t.show(null)
    expect(t.stores.names()).not.toContain('git:s1')
    expect(t.files.entry('s1', 'todo.md')).toMatchObject({ code: 'U' }) // the cached snapshot still answers
    t.show('s1')
    expect(t.head('s1')?.scope).toBe('uncommitted') // on screen at once, from the cache
    expect(t.codes('s1')).toEqual({ 'todo.md': 'U' })
  })

  it('I-GS-3 · an agent running `git add` and `git commit` in a loop while Kea refreshes 200 times never sees an `index.lock` failure', async () => {
    const r = repo()
    const wt = linkedWorktree(r.root, 'wt-a')
    t = await startFiles()
    t.session('s1', wt, { baseBranch: 'main' })
    t.show('s1')
    await t.ready('s1')
    const start = t.statusRuns('s1')
    let failures: string[] = []
    let commits = 0
    let stop = false
    const agent = (async () => {
      for (let i = 0; !stop; i++) {
        write(wt, `src/gen-${i % 20}.js`, `export const v = ${i}\n`)
        const add = await gitAsync(wt, 'add', '-A')
        const commit = await gitAsync(wt, 'commit', '-qm', `step ${i}`)
        for (const x of [add, commit]) if (!x.ok) failures.push(x.stderr)
        if (commit.ok) commits++
      }
    })()
    // Kea refreshes as fast as it can: each refresh is a status and a diff against the merge base
    while (t.statusRuns('s1') - start < 200) {
      const n = t.statusRuns('s1')
      t.files.focus()
      await until('the next refresh', () => t!.statusRuns('s1') > n)
    }
    stop = true
    await agent
    failures = failures.filter((f) => f.trim() !== '')
    expect(failures.filter((f) => /index\.lock|Unable to create|another git process/i.test(f))).toEqual([])
    expect(failures).toEqual([])
    expect(commits).toBeGreaterThan(5)
    expect(fs.existsSync(path.join(r.root, '.git', 'worktrees', 'wt-a', 'index.lock'))).toBe(false)
    await until('the last commit to be seen', () => t!.head('s1')?.state === 'ok' && t!.head('s1')?.ahead === commits)
  })

  it.runIf(watching)('I-GS-4 · 100 changes in a burst are at most 3 status runs, and the last one shows the final state', async () => {
    const r = repo()
    t = await startFiles()
    t.session('s1', r.root)
    t.show('s1')
    await t.ready('s1')
    await until('the stream to be live', () => t?.watcher?.followed()[0]?.mode === 'live')
    await t.idle('s1')
    const start = t.statusRuns('s1')
    const triggers = t.s('s1').scheduler.triggers
    for (let i = 1; i <= 100; i++) {
      fs.appendFileSync(path.join(r.root, 'burst.log'), `line ${i}\n`)
      write(r.root, `burst/f${i}.txt`, 'x\n')
      await new Promise<void>((done) => setImmediate(done)) // let the watcher deliver between writes
    }
    await until('the final state', () => t!.entries('s1')['burst.log']?.added === 100 && Object.keys(t!.entries('s1')).length === 101)
    await t.idle('s1')
    expect(t.statusRuns('s1') - start).toBeLessThanOrEqual(3)
    expect(t.statusRuns('s1') - start).toBeGreaterThanOrEqual(1)
    expect(t.s('s1').scheduler.triggers).toBeGreaterThan(triggers)
    // 100 triggers at the scheduler itself, with a run in flight: one trailing run
    const mid = t.statusRuns('s1')
    await until('quiet since the last trigger', () => {
      t!.files.focus() // a run in flight
      return true
    })
    for (let i = 0; i < 100; i++) t.s('s1').scheduler.trigger()
    await until('the trailing run', () => t!.s('s1').scheduler.idle && t!.statusRuns('s1') >= mid + 2)
    expect(t.statusRuns('s1')).toBe(mid + 2)
  })

  it('I-GS-5 · five worktrees refreshed at once never run more git processes at a time than the git pool allows', async () => {
    const r = repo()
    const log = path.join(tempDir(), 'git.log')
    // every git Kea runs writes a line when it starts and when it ends
    stubGit(`[ -n "$KEA_TEST_GIT_LOG" ] && echo "s $$" >> "$KEA_TEST_GIT_LOG"\n"$REAL" "$@"\ncode=$?\n[ -n "$KEA_TEST_GIT_LOG" ] && echo "e $$" >> "$KEA_TEST_GIT_LOG"\nexit $code`)
    t = await startFiles({ files: { env: async () => ({ ...gitEnv(), KEA_TEST_GIT_LOG: log }) } })
    const ids = ['s1', 's2', 's3', 's4', 's5']
    ids.forEach((id, i) => {
      t!.session(id, linkedWorktree(r.root, `wt-${i}`), { baseBranch: 'main' })
      t!.show(id, i) // five windows
    })
    for (const id of ids) await t.ready(id)
    for (let round = 0; round < 4; round++) {
      const before = ids.map((id) => t!.statusRuns(id))
      t.files.focus() // all five at once
      await until('all five to have refreshed', () => ids.every((id, i) => t!.statusRuns(id) > (before[i] as number) && t!.s(id).scheduler.idle))
    }
    let running = 0
    let peak = 0
    let started = 0
    for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
      if (line.startsWith('s ')) {
        started++
        peak = Math.max(peak, ++running)
      } else if (line.startsWith('e ')) running--
    }
    expect(started).toBeGreaterThanOrEqual(5 * 2 * 5) // a status and a diff for each, each round
    expect(peak).toBeLessThanOrEqual(POOL_LIMITS.git)
    expect(peak).toBe(POOL_LIMITS.git) // and the pool was in fact used to its limit
    expect(running).toBe(0)
  })

  it.runIf(watching)('I-GS-6 · more untracked files than L.gitStatusEntriesMax: the status says `tooMany` with no rows, git is killed before it has listed them all, and the session is refreshed only when asked', async () => {
    const r = repo()
    const many = L.gitStatusEntriesMax * 3
    fs.mkdirSync(path.join(r.root, 'dump'))
    for (let i = 0; i < many; i++) fs.writeFileSync(path.join(r.root, 'dump', `untracked-file-with-a-long-name-${i}.txt`), '')
    const log = path.join(tempDir(), 'git.log')
    stubGit(`if [ "$1" = status ] && [ -n "$KEA_TEST_GIT_LOG" ]; then\n  "$REAL" "$@" | tee -a "$KEA_TEST_GIT_LOG"\nelse\n  exec "$REAL" "$@"\nfi`)
    t = await startFiles({ files: { env: async () => ({ ...gitEnv(), KEA_TEST_GIT_LOG: log }) } })
    t.session('s1', r.root)
    t.show('s1')
    await until('the status', () => t!.head('s1')?.state === 'tooMany')
    await t.idle('s1')
    expect(t.head('s1')).toMatchObject({ state: 'tooMany', manual: true, branch: 'main' })
    expect(t.entries('s1')).toEqual({})
    // killed early: what git got to print is a part of the list, not all of it
    const printed = fs.readFileSync(log).toString().split('\0').length
    expect(printed).toBeGreaterThan(L.gitStatusEntriesMax)
    expect(printed).toBeLessThan(many)
    // manual: a change on disk starts nothing
    await until('the stream to be live', () => t?.watcher?.followed()[0]?.mode === 'live')
    const runs = t.statusRuns('s1')
    write(r.root, 'one-more.txt')
    await until('the tree to show it', () => t!.names('s1').includes('one-more.txt'))
    t.files.toolFinished('s1')
    expect(t.statusRuns('s1')).toBe(runs)
    expect(t.s('s1').scheduler.idle).toBe(true)
    // Refresh asks again; once the files are gone the status is back and follows changes again
    await t.call('files.refresh', { sessionId: 's1' })
    await refreshed('s1', runs)
    expect(t.head('s1')?.state).toBe('tooMany')
    fs.rmSync(path.join(r.root, 'dump'), { recursive: true })
    const again = t.statusRuns('s1')
    expect(t.statusRuns('s1')).toBe(again)
    await t.call('files.refresh', { sessionId: 's1' })
    await until('the status to be back', () => t!.head('s1')?.state === 'ok' && t!.s('s1').scheduler.idle)
    expect(t.head('s1')?.manual).toBeUndefined()
    expect(t.codes('s1')).toEqual({ 'one-more.txt': 'U' })
    write(r.root, 'and-another.txt')
    await until('changes to be followed again', () => t!.codes('s1')['and-another.txt'] === 'U')
  })

  it('I-GS-7 · a git that hangs is killed at the timeout: the status is "unavailable" with the last good rows kept, nothing is left running, and the next trigger tries again', async () => {
    const r = repo()
    const dir = tempDir()
    const hang = path.join(dir, 'hang')
    const pids = path.join(dir, 'pids')
    stubGit(`if [ "$1" = status ] && [ -e '${hang}' ]; then\n  echo $$ >> '${pids}'\n  sleep 600\nfi\nexec "$REAL" "$@"`)
    t = await startFiles({ files: { statusTimeoutMs: 400 } })
    t.session('s1', r.root)
    write(r.root, 'kept.txt')
    t.show('s1')
    await t.ready('s1')
    expect(t.codes('s1')).toEqual({ 'kept.txt': 'U' })
    fs.writeFileSync(hang, '')
    const runs = t.statusRuns('s1')
    const t0 = performance.now()
    await t.call('files.refresh', { sessionId: 's1' })
    await until('the timeout', () => t!.head('s1')?.state === 'unavailable')
    expect(performance.now() - t0).toBeLessThan(400 + L.processKillGraceMs + 2000)
    await t.idle('s1')
    expect(t.statusRuns('s1')).toBe(runs + 1)
    expect(t.s('s1').statusCounters?.timeouts).toBe(1)
    expect(t.codes('s1')).toEqual({ 'kept.txt': 'U' }) // what was known stays on screen
    // the whole process group is gone: the script and its `sleep`
    const pid = Number(fs.readFileSync(pids, 'utf8').trim().split('\n').at(-1))
    await until('the hung git to be gone', () => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
    // (a busy machine's process list is longer than execFileSync's default 1 MiB)
    expect(execFileSync('/bin/ps', ['-axo', 'pgid=,command='], { maxBuffer: 64 << 20 }).toString().split('\n').filter((l) => l.trim().startsWith(`${pid} `))).toEqual([])
    // still hanging: the next trigger tries, and times out again; once git answers, so does the status
    await t.call('files.refresh', { sessionId: 's1' })
    await until('the second timeout', () => t!.s('s1').statusCounters?.timeouts === 2 && t!.s('s1').scheduler.idle)
    expect(t.head('s1')?.state).toBe('unavailable')
    fs.rmSync(hang)
    write(r.root, 'after.txt')
    await until('the status to be back', () => t!.head('s1')?.state === 'ok' && t!.codes('s1')['after.txt'] === 'U')
    expect(t.codes('s1')).toEqual({ 'after.txt': 'U', 'kept.txt': 'U' })
  })

  it.runIf(gitDaemon)('I-GS-8 · fsmonitor is never set by itself; the project’s setting writes `core.fsmonitor` and `core.untrackedCache` to that worktree’s config only, and turning it off (or removing the worktree) stops the daemon', async () => {
    const r = repo()
    const a = linkedWorktree(r.root, 'wt-a')
    const b = linkedWorktree(r.root, 'wt-b')
    const get = (dir: string, ...args: string[]): string => {
      try {
        return gitIn(dir, 'config', ...args)
      } catch {
        return ''
      }
    }
    const daemon = (dir: string): boolean => {
      try {
        gitIn(dir, 'fsmonitor--daemon', 'status')
        return true
      } catch {
        return false
      }
    }
    later(() => {
      for (const d of [a, b, r.root]) if (fs.existsSync(d) && daemon(d)) gitIn(d, 'fsmonitor--daemon', 'stop')
    })
    t = await startFiles()
    t.projects.set('p2', { id: 'p2', settings: {} } as Project)
    t.session('sa', a, { baseBranch: 'main', projectId: 'p1' })
    t.session('sb', b, { baseBranch: 'main', projectId: 'p2' })
    t.show('sa', 0)
    t.show('sb', 1)
    await t.ready('sa')
    await t.ready('sb')
    // never implicit: statuses ran, nothing was written
    for (const d of [r.root, a, b]) expect([get(d, '--get', 'core.fsmonitor'), get(d, '--get', 'core.untrackedCache'), get(d, '--get', 'extensions.worktreeConfig')]).toEqual(['', '', ''])
    expect(t.head('sa')?.slow).toBeUndefined()

    // the project's setting, on
    t.projects.set('p1', { id: 'p1', settings: { useFsmonitor: true } } as Project)
    await until('the setting to be written', () => get(a, '--worktree', '--get', 'core.fsmonitor') === 'true')
    await until('both keys', () => get(a, '--worktree', '--get', 'core.untrackedCache') === 'true')
    expect(get(a, '--get', 'core.fsmonitor')).toBe('true')
    // that worktree's config only: not the repository's shared config, not another worktree's
    expect(get(r.root, '--local', '--get', 'core.fsmonitor')).toBe('')
    expect(get(r.root, '--get', 'core.fsmonitor')).toBe('')
    expect(get(b, '--get', 'core.fsmonitor')).toBe('')
    expect(fs.readFileSync(path.join(r.root, '.git', 'config'), 'utf8')).not.toMatch(/fsmonitor|untrackedCache/i)
    expect(fs.readFileSync(path.join(r.root, '.git', 'worktrees', 'wt-a', 'config.worktree'), 'utf8')).toMatch(/fsmonitor = true/)
    // a status in it runs with the daemon (git starts it); the other worktree has none
    const n = t.statusRuns('sa')
    await t.call('files.refresh', { sessionId: 'sa' })
    await refreshed('sa', n)
    expect(t.head('sa')?.state).toBe('ok')
    expect(daemon(b)).toBe(false)

    // off again: the keys are removed and the daemon stopped
    t.projects.set('p1', { id: 'p1', settings: {} } as Project)
    await until('the setting to be removed', () => get(a, '--get', 'core.fsmonitor') === '' && get(a, '--get', 'core.untrackedCache') === '')
    await until('the daemon to be stopped', () => !daemon(a))
    // on once more, then the worktree is removed: its daemon is stopped first
    t.projects.set('p1', { id: 'p1', settings: { useFsmonitor: true } } as Project)
    await until('the setting to be written', () => get(a, '--get', 'core.fsmonitor') === 'true')
    const m = t.statusRuns('sa')
    await t.call('files.refresh', { sessionId: 'sa' })
    await refreshed('sa', m)
    t.show(null, 0)
    await stopFsmonitor({ env: gitEnv() as Record<string, string> }, a)
    expect(daemon(a)).toBe(false)
  })

  it.runIf(gitDaemon)('I-GS-9 · a status slower than the hint’s threshold marks the git head `slow` while the project does not use fsmonitor; turning the setting on takes the mark away at once, without waiting for another status, and no status marks it again while the setting is on', async () => {
    const r = repo()
    const a = linkedWorktree(r.root, 'wt-a')
    const daemon = (dir: string): boolean => {
      try {
        gitIn(dir, 'fsmonitor--daemon', 'status')
        return true
      } catch {
        return false
      }
    }
    later(() => {
      if (fs.existsSync(a) && daemon(a)) gitIn(a, 'fsmonitor--daemon', 'stop')
    })
    // every status counts as slow: the threshold itself (L.fsmonitorHintMs) is a second of git's time
    t = await startFiles({ files: { fsmonitorHintMs: 0 } })
    t.session('sa', a, { baseBranch: 'main', projectId: 'p1' })
    t.show('sa', 0)
    await t.ready('sa')
    expect(t.head('sa')?.slow, 'the hint is offered').toBe(true)

    // the hint's button: the project's setting. The mark goes with it, though nothing has changed on disk and no
    // status runs (the panel's hint would otherwise stay until the next save)
    const n = t.statusRuns('sa')
    t.projects.set('p1', { id: 'p1', settings: { useFsmonitor: true } } as Project)
    await until('the setting to be written', () => {
      try {
        return gitIn(a, 'config', '--worktree', '--get', 'core.fsmonitor') === 'true'
      } catch {
        return false
      }
    })
    await until('the mark to go', () => t!.head('sa')?.slow === undefined, 5000)
    expect(t.statusRuns('sa'), 'not because a status ran').toBe(n)
    // with the setting on, a status never marks it
    await t.call('files.refresh', { sessionId: 'sa' })
    await refreshed('sa', n)
    expect(t.head('sa')).toMatchObject({ state: 'ok' })
    expect(t.head('sa')?.slow).toBeUndefined()
    // off again: the next status that is slow says so again
    t.projects.set('p1', { id: 'p1', settings: {} } as Project)
    await until('the daemon to be stopped', () => !daemon(a))
    const m = t.statusRuns('sa')
    await t.call('files.refresh', { sessionId: 'sa' })
    await refreshed('sa', m)
    expect(t.head('sa')?.slow).toBe(true)
  })

  it.runIf(gitDaemon)('I-GS-10 · on a network volume git’s fsmonitor is not used: the project’s setting is not offered for a project whose folder lies on one, and for a session whose worktree lies on one a slow status brings no hint and the setting writes nothing', async () => {
    const r = repo()
    const a = linkedWorktree(r.root, 'wt-a')
    const b = linkedWorktree(r.root, 'wt-b')
    const get = (dir: string, ...args: string[]): string => {
      try {
        return gitIn(dir, 'config', ...args)
      } catch {
        return ''
      }
    }
    // the system's mount table with one worktree on a share and a project folder on another (a mount point with a
    // space and " on " in its name): macOS `mount`'s output, Linux `/proc/self/mountinfo` with its octal escapes
    const share = coreOs.system === 'darwin' ? '/Volumes/work on nfs' : '/mnt/work on nfs' // os-ok: test data
    const mounts =
      coreOs.system === 'darwin'
        ? ['/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)', `//user@nas/team on ${a} (smbfs, nodev, nosuid, mounted by user)`, `nas:/export on ${share} (nfs, nodev, nosuid, automounted)`, 'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)'].join('\n') // os-ok: test data
        : ['22 1 252:1 / / rw,relatime shared:1 - ext4 /dev/vda1 rw', `98 22 0:51 / ${a.replace(/ /g, '\\040')} rw,nosuid,nodev,relatime shared:60 - cifs //nas/team rw,vers=3.1.1`, `99 22 0:52 / ${share.replace(/ /g, '\\040')} rw,relatime shared:61 - nfs4 nas:/export rw,vers=4.2`, '100 22 0:53 / /home rw,relatime shared:62 - ext4 /dev/vda2 rw'].join('\n')
    t = await startFiles({ files: { fsmonitorHintMs: 0, mounts: async () => mounts } })
    t.projects.set('local', { id: 'local', rootPath: r.root, settings: {} } as Project)
    t.projects.set('shared', { id: 'shared', rootPath: `${share}/repo`, settings: {} } as Project)
    const offered = async (projectId: string): Promise<boolean> => (await t!.call<{ offered: boolean }>('files.fsmonitorOffered', { projectId })).offered
    expect(await offered('local')).toBe(true)
    expect(await offered('shared')).toBe(false)
    expect(await offered('no-such-project'), 'nothing is known against it').toBe(true)

    // the session on the share: read by polling, every status "slow" here, and still no hint
    t.session('sa', a, { baseBranch: 'main', projectId: 'p1' })
    t.session('sb', b, { baseBranch: 'main', projectId: 'p1' })
    t.show('sa', 0)
    t.show('sb', 1)
    await t.ready('sa')
    await t.ready('sb')
    expect(t.treeHead('sa')?.live, 'a network volume is poll-only').toBe(false)
    expect(t.head('sa')?.slow).toBeUndefined()
    expect(t.head('sb')?.slow, 'the session on a local disk is offered it').toBe(true)
    // the project's setting, on: written for the local worktree, never for the one on the share
    t.projects.set('p1', { id: 'p1', settings: { useFsmonitor: true } } as Project)
    await until('the setting to be written for the local worktree', () => get(b, '--worktree', '--get', 'core.fsmonitor') === 'true')
    await t.idle('sa')
    expect(get(a, '--get', 'core.fsmonitor')).toBe('')
    // off again, so no status of this test starts git's daemon
    t.projects.set('p1', { id: 'p1', settings: {} } as Project)
    await until('the setting to be removed', () => get(b, '--get', 'core.fsmonitor') === '')
  })

  it('I-GS-16 · where git has no fsmonitor daemon (Linux’s git; here a git whose build options leave it out): the project’s setting is not offered, a slow status brings no hint, and the setting turned on writes nothing to the worktree or to the repository’s shared config', async () => {
    const r = repo()
    const a = linkedWorktree(r.root, 'wt-a')
    stubGit(`case "$*" in *'version --build-options') "$REAL" version --build-options | grep -v '^feature: fsmonitor--daemon$'; exit 0;; esac\nexec "$REAL" "$@"`)
    const get = (dir: string, ...args: string[]): string => {
      try {
        return gitIn(dir, 'config', ...args)
      } catch {
        return ''
      }
    }
    t = await startFiles({ files: { fsmonitorHintMs: 0 } })
    t.projects.set('p1', { id: 'p1', rootPath: r.root, settings: {} } as Project)
    expect((await t.call<{ offered: boolean }>('files.fsmonitorOffered', { projectId: 'p1' })).offered).toBe(false)
    t.session('sa', a, { baseBranch: 'main', projectId: 'p1' })
    t.show('sa', 0)
    await t.ready('sa')
    const n = t.statusRuns('sa')
    await t.call('files.refresh', { sessionId: 'sa' })
    await refreshed('sa', n)
    expect(t.head('sa')).toMatchObject({ state: 'ok' })
    expect(t.head('sa')?.slow, 'every status is slow here, and no hint').toBeUndefined()
    // turned on anyway (a settings file from another machine): nothing is written
    t.projects.set('p1', { id: 'p1', rootPath: r.root, settings: { useFsmonitor: true } } as Project)
    const m = t.statusRuns('sa')
    await t.call('files.refresh', { sessionId: 'sa' })
    await refreshed('sa', m)
    await t.idle('sa')
    expect([get(a, '--get', 'core.fsmonitor'), get(a, '--get', 'core.untrackedCache'), get(r.root, '--local', '--get', 'extensions.worktreeConfig')]).toEqual(['', '', ''])
  })

  it('I-GS-11 · a rename that is not committed yet is one `R` row in Uncommitted as it is in Branch: its old path is not listed a second time as a deletion, and the totals count it once', async () => {
    const r = repo()
    const wt = linkedWorktree(r.root, 'wt-a')
    t = await startFiles()
    t.session('s1', wt, { baseBranch: 'main' })
    t.show('s1')
    await t.ready('s1')
    gitIn(wt, 'mv', 'src/hello.js', 'src/greet.js') // staged, as `git mv` leaves it
    fs.rmSync(path.join(wt, 'src/counter.js')) // a real deletion beside it
    const want = { 'src/counter.js': 'D', 'src/greet.js': 'R' }
    await until('Branch to list the rename and the deletion', () => JSON.stringify(t!.codes('s1')) === JSON.stringify(want))
    expect(t.head('s1')).toMatchObject({ scope: 'branch', totals: { files: 2 } })

    await t.call('files.setScope', { sessionId: 's1', scope: 'uncommitted' })
    await until('Uncommitted to be read', () => t!.head('s1')?.scope === 'uncommitted' && t!.head('s1')?.state === 'ok')
    await t.idle('s1')
    expect(t.codes('s1'), 'the same two rows: the old path is the rename’s origin, not a deletion of its own').toEqual(want)
    expect(t.entries('s1')['src/greet.js']).toMatchObject({ code: 'R', origPath: 'src/hello.js', added: 0, removed: 0 })
    expect(t.head('s1')).toMatchObject({ scope: 'uncommitted', totals: { files: 2, added: 0, removed: 6 } })
    // what only the status knows is still listed there: a change staged and then undone in the working tree
    const asInHead = fs.readFileSync(path.join(wt, 'src/math.js'), 'utf8')
    write(wt, 'src/math.js', 'export const staged = true\n')
    gitIn(wt, 'add', 'src/math.js')
    write(wt, 'src/math.js', asInHead)
    await until('the staged change to be listed', () => t!.codes('s1')['src/math.js'] !== undefined)
    expect(Object.keys(t.codes('s1')).sort()).toEqual(['src/counter.js', 'src/greet.js', 'src/math.js'])
  })

  it('I-GS-12 · around a rename, in Uncommitted as in Branch, each path is listed once and for what it is: a rename with an edit is one `R` row with its counts; a new file at the renamed file’s old path is its own row beside it; a rename onto a tracked file is that file modified and the other deleted; a copy is a new file and its source is untouched; a rename that was not staged is a deletion and an untracked file', async () => {
    const r = repo()
    const wt = linkedWorktree(r.root, 'wt-a')
    t = await startFiles()
    t.session('s1', wt, { baseBranch: 'main' })
    t.show('s1')
    await t.ready('s1')
    const hello = fs.readFileSync(path.join(wt, 'src/hello.js'), 'utf8')
    const both = async (label: string, want: Record<string, string>, check?: () => void): Promise<void> => {
      for (const scope of ['uncommitted', 'branch'] as const) {
        await t!.call('files.setScope', { sessionId: 's1', scope })
        await until(`${label}, ${scope}: ${JSON.stringify(want)}`, () => t!.head('s1')?.scope === scope && t!.head('s1')?.state === 'ok' && JSON.stringify(t!.codes('s1')) === JSON.stringify(want))
        await t!.idle('s1')
        expect(t!.codes('s1'), `${label}, ${scope}`).toEqual(want)
        expect(t!.head('s1')?.totals?.files, `${label}, ${scope}`).toBe(Object.keys(want).length)
        check?.()
      }
    }
    const reset = (): void => {
      gitIn(wt, 'reset', '-q', '--hard')
      gitIn(wt, 'clean', '-qfd')
    }

    // a rename and an edit of the renamed file, part staged and part not: one row, the rename's, with the edit's counts
    gitIn(wt, 'mv', 'src/hello.js', 'src/greet.js')
    write(wt, 'src/greet.js', `${hello}// one more line\n`)
    await both('rename + edit', { 'src/greet.js': 'R' }, () => expect(t!.entries('s1')['src/greet.js']).toMatchObject({ origPath: 'src/hello.js', added: 1, removed: 0 }))
    // a new, untracked file where the renamed one was: its own row; the rename keeps its origin
    write(wt, 'src/hello.js', 'export const again = true\n')
    await both('rename + a new file at the old path', { 'src/greet.js': 'R', 'src/hello.js': 'U' }, () => expect(t!.entries('s1')['src/greet.js']?.origPath).toBe('src/hello.js'))
    reset()

    // a rename onto a file that is tracked (deleted first): git has no rename there, and neither row is doubled
    gitIn(wt, 'rm', '-q', 'src/math.js')
    gitIn(wt, 'mv', 'src/hello.js', 'src/math.js')
    await both('rename over a deleted path', { 'src/hello.js': 'D', 'src/math.js': 'M' })
    reset()

    // a copy, staged: a new file; the file it was copied from has no row
    write(wt, 'src/hello-copy.js', hello)
    gitIn(wt, 'add', 'src/hello-copy.js')
    await both('copy', { 'src/hello-copy.js': 'A' }, () => expect(t!.entries('s1')['src/hello-copy.js']?.origPath).toBeNull())
    // the copy's source then renamed: one `R` for the rename, the copy still a new file of its own
    gitIn(wt, 'mv', 'src/hello.js', 'src/greet.js')
    await both('copy + rename of its source', { 'src/greet.js': 'R', 'src/hello-copy.js': 'A' })
    reset()

    // moved without telling git: the old path deleted, the new one untracked (git pairs them only once staged)
    fs.renameSync(path.join(wt, 'src/hello.js'), path.join(wt, 'src/greet.js'))
    await both('rename not staged', { 'src/greet.js': 'U', 'src/hello.js': 'D' })
  })

  it('I-GS-13 · a diff that fails is "git did not answer", not a shorter list: the status is `unavailable` with the last rows that worked kept, never the status’s own rows passed off as the whole answer with state `ok`; once the diff works, the list is right again', async () => {
    const r = repo()
    const wt = linkedWorktree(r.root, 'wt-a')
    const dir = tempDir()
    const broken = path.join(dir, 'broken')
    // `git diff` exits as it does on a damaged repository; every other git call is the real one
    stubGit(`if [ -e '${broken}' ]; then for a in "$@"; do if [ "$a" = diff ]; then echo 'fatal: bad object' >&2; exit 128; fi; done; fi\nexec "$REAL" "$@"`)
    t = await startFiles()
    t.session('s1', wt, { baseBranch: 'main' })
    t.show('s1')
    await t.ready('s1')
    // the branch's own work: one file committed, one edited and not committed
    write(wt, 'src/committed.js', 'export const committed = true\n')
    gitIn(wt, 'add', 'src/committed.js')
    gitIn(wt, 'commit', '-qm', 'the agent commits')
    write(wt, 'src/math.js', 'export const edited = true\n')
    const want = { 'src/committed.js': 'A', 'src/math.js': 'M' }
    await until('Branch to list both', () => JSON.stringify(t!.codes('s1')) === JSON.stringify(want) && t!.head('s1')?.state === 'ok')
    await t.idle('s1')

    for (const scope of ['branch', 'uncommitted'] as const) {
      await t.call('files.setScope', { sessionId: 's1', scope })
      await until(`${scope} to be read`, () => t!.head('s1')?.scope === scope && t!.head('s1')?.state === 'ok')
      await t.idle('s1')
      const before = t.entries('s1')
      const diffs = t.s('s1').statusCounters?.diff ?? 0
      fs.writeFileSync(broken, '')
      write(wt, 'src/another.js', 'export const another = true\n')
      gitIn(wt, 'add', 'src/another.js')
      await t.call('files.refresh', { sessionId: 's1' })
      await until(`${scope}: the failed diff to be answered`, () => (t!.s('s1').statusCounters?.diff ?? 0) > diffs && t!.s('s1').scheduler.idle)
      expect(t.head('s1'), scope).toMatchObject({ scope, state: 'unavailable' })
      expect(t.entries('s1'), `${scope}: the last rows that worked stay`).toEqual(before)
      fs.rmSync(broken)
      await t.call('files.refresh', { sessionId: 's1' })
      await until(`${scope}: the diff to work again`, () => t!.head('s1')?.state === 'ok' && t!.codes('s1')['src/another.js'] === 'A')
      gitIn(wt, 'rm', '-qf', 'src/another.js')
      await until(`${scope}: the file to be gone again`, () => t!.codes('s1')['src/another.js'] === undefined && t!.head('s1')?.state === 'ok')
    }
  })
  it.runIf(watching)('I-GS-14 · a status that cannot be run at all is "git did not answer": the head says `unavailable` over the last rows that worked, never those rows with state `ok`; a session folder deleted while it is shown leaves nothing of it on screen under "missing" — no tree row, no change — and once the folder is back the next refresh reads it again', async () => {
    const r = repo()
    const wt = linkedWorktree(r.root, 'wt-a')
    const stub = stubGit('exec "$REAL" "$@"')
    const script = fs.readFileSync(stub)
    t = await startFiles()
    t.session('s1', wt, { baseBranch: 'main' })
    t.show('s1')
    await t.ready('s1')
    write(wt, 'src/math.js', 'export const edited = true\n')
    write(wt, 'src/new.js', 'export const added = true\n')
    await until('both changes to be listed', () => Object.keys(t!.codes('s1')).join() === 'src/math.js,src/new.js' && t!.head('s1')?.state === 'ok')
    await t.idle('s1')
    const before = t.entries('s1')

    // ── git cannot be started (its binary is gone; a full pool and a vanished cwd reject the same way) ──
    fs.rmSync(stub)
    const refreshes = t.s('s1').stats.refreshes
    await t.call('files.refresh', { sessionId: 's1' })
    await until('the refresh that could not run git', () => t!.s('s1').stats.refreshes > refreshes && t!.s('s1').scheduler.idle)
    expect(t.head('s1')).toMatchObject({ state: 'unavailable' })
    expect(t.entries('s1'), 'the last rows that worked stay').toEqual(before)
    expect(t.treeHead('s1')).toEqual({ git: true, live: true, missing: false })
    fs.writeFileSync(stub, script, { mode: 0o755 })
    await t.call('files.refresh', { sessionId: 's1' })
    await until('git to answer again', () => t!.head('s1')?.state === 'ok' && t!.s('s1').scheduler.idle)
    expect(t.entries('s1')).toEqual(before)

    // ── the session's folder is deleted while it is on screen ──
    expect(t.names('s1').length).toBeGreaterThan(0)
    fs.rmSync(wt, { recursive: true, force: true })
    // (heard from the worktree's own stream: no focus or Refresh is needed)
    await until('the folder to be known missing', () => t!.treeHead('s1')?.missing === true && t!.s('s1').scheduler.idle)
    await until('nothing of the folder to be left on screen', () => [...t!.tree('s1').entries()].length === 1 && Object.keys(t!.entries('s1')).length === 0)
    expect([...t.tree('s1').entries()].map(([k]) => k)).toEqual(['head'])
    expect(t.treeHead('s1')).toEqual({ git: false, live: true, missing: true })
    expect(t.head('s1')?.state, 'no list is passed off as a status that worked').toBe('notGit')
    // more triggers change nothing while it is gone
    t.files.focus()
    await t.call('files.refresh', { sessionId: 's1' })
    await t.idle('s1')
    expect([...t.tree('s1').entries()].map(([k]) => k)).toEqual(['head'])
    expect(t.entries('s1')).toEqual({})

    // ── the folder is back (the worktree was added again): read again at the next trigger ──
    gitIn(r.root, 'worktree', 'prune')
    gitIn(r.root, 'worktree', 'add', '-q', wt, 'kea/wt-a')
    write(wt, 'src/back.js', 'export const back = true\n')
    t.files.focus()
    await until('the folder to be read again', () => t!.treeHead('s1')?.missing === false && t!.names('s1').includes('src') && t!.head('s1')?.state === 'ok' && Object.keys(t!.codes('s1')).join() === 'src/back.js')
    expect(t.treeHead('s1')).toMatchObject({ git: true, missing: false })
  })

  it.runIf(watching && gitDaemon)('I-GS-15 · turning the project’s fsmonitor setting off reaches every worktree of the project, also one whose session nothing is held for: its two keys go and its daemon is stopped. `extensions.worktreeConfig`, the one thing Kea writes to the repository’s shared config, is put back as it was once no worktree has a setting of its own left; it stays when the person had it on before, and while another worktree still uses it. A value the worktree had for a key is put back; a write that fails is not passed off as done', async () => {
    const r = repo()
    const [a, b, c] = ['wt-a', 'wt-b', 'wt-c'].map((n) => linkedWorktree(r.root, n)) as [string, string, string]
    const r2 = repo('other')
    const d = linkedWorktree(r2.root, 'wt-d')
    const marks = tempDir()
    const refuse = path.join(marks, 'refuse')
    // every git call is the real one, except the write to the shared config while `refuse` exists
    stubGit(`if [ -e '${refuse}' ]; then case "$*" in *'extensions.worktreeConfig true'*) echo 'error: could not lock config file .git/config: Permission denied' >&2; exit 255;; esac; fi\nexec "$REAL" "$@"`)
    const get = (dir: string, ...args: string[]): string => {
      try {
        return gitIn(dir, 'config', ...args)
      } catch {
        return ''
      }
    }
    const daemon = (dir: string): boolean => {
      try {
        gitIn(dir, 'fsmonitor--daemon', 'status')
        return true
      } catch {
        return false
      }
    }
    later(() => {
      for (const dir of [a, b, c, d, r.root, r2.root]) if (fs.existsSync(dir) && daemon(dir)) gitIn(dir, 'fsmonitor--daemon', 'stop')
    })
    const keys = (dir: string): string[] => [get(dir, '--worktree', '--get', 'core.fsmonitor'), get(dir, '--worktree', '--get', 'core.untrackedCache')]
    const extension = (root: string): string => get(root, '--local', '--get', 'extensions.worktreeConfig')
    const setting = (id: string, on: boolean): void => t!.projects.set(id, { id, settings: on ? { useFsmonitor: true } : {} } as Project)
    const view = (id: string): Record<string, unknown> => ({ ...t!.sessions.get(id) })

    // the person had the extension on in the other repository, and a value of their own for one key in its worktree
    gitIn(r2.root, 'config', 'extensions.worktreeConfig', 'true')
    gitIn(d, 'config', '--worktree', 'core.untrackedCache', 'keep')

    t = await startFiles()
    t.projects.set('p2', { id: 'p2', settings: {} } as Project)
    t.session('sa', a, { baseBranch: 'main' })
    t.session('sb', b, { baseBranch: 'main' })
    t.session('sc', c, { baseBranch: 'main' })
    t.session('sd', d, { baseBranch: 'main', projectId: 'p2' })
    t.show('sa', 0)
    t.show('sc', 1)
    t.show('sd', 2)
    for (const id of ['sa', 'sc', 'sd']) await t.ready(id)
    expect(extension(r.root)).toBe('')

    // ── on: the two keys in each shown worktree's own config; the extension in the shared config, once ──
    setting('p1', true)
    setting('p2', true)
    await until('the keys to be written', () => [a, c, d].every((dir) => keys(dir).join() === 'true,true'))
    expect(extension(r.root)).toBe('true')
    expect(keys(b)).toEqual(['', '']) // never shown: nothing written there
    // a status in `c` starts its daemon
    const n = t.statusRuns('sc')
    await t.call('files.refresh', { sessionId: 'sc' })
    await refreshed('sc', n)
    await until('the daemon of c to run', () => daemon(c))

    // ── nothing is held for `sc` any more (hidden, and let go of as an archived session is) ──
    t.show(null, 1)
    t.sessions.set('sc', { ...view('sc'), lifecycle: 'archived' } as never)
    t.sessions.set('sc', { ...view('sc'), lifecycle: 'live' } as never)
    expect(t.files.session('sc')).toBeUndefined()
    // someone else's setting in another worktree's own config: it needs the extension
    gitIn(b, 'config', '--worktree', 'user.name', 'Someone Else')

    // ── off: every worktree of the project, held or not ──
    setting('p1', false)
    await until('the keys to be gone from the shown worktree', () => keys(a).join() === ',')
    await until('the keys to be gone from the worktree nothing is held for', () => keys(c).join() === ',')
    await until('its daemon to be stopped', () => !daemon(c))
    // the extension stays: `b`'s own config is still read through it
    await until('the writes to end', () => t!.files.resourceCounts.fsmonitorWrites === 0)
    expect(extension(r.root)).toBe('true')
    expect(get(b, '--get', 'user.name')).toBe('Someone Else')
    // shown again, the session knows Kea's keys are gone: nothing is written for it
    t.show('sc', 1)
    await t.ready('sc')
    expect(t.s('sc').persisted().fsmonitor).toBeUndefined()
    expect(keys(c)).toEqual(['', ''])

    // ── on and off once more, with no other setting left in any worktree: the shared config is as it was ──
    gitIn(b, 'config', '--worktree', '--unset', 'user.name')
    setting('p1', true)
    await until('the keys to be written again', () => [a, c].every((dir) => keys(dir).join() === 'true,true'))
    setting('p1', false)
    await until('the extension to be put back', () => extension(r.root) === '' && [a, c].every((dir) => keys(dir).join() === ','))
    expect(fs.readFileSync(path.join(r.root, '.git', 'config'), 'utf8')).not.toMatch(/worktreeConfig|fsmonitor|untrackedCache/i)

    // ── the other repository: the person's own extension and their own value stay theirs ──
    setting('p2', false)
    await until('the worktree’s own value to be back', () => keys(d).join() === ',keep')
    await until('the writes to end', () => t!.files.resourceCounts.fsmonitorWrites === 0)
    expect(extension(r2.root)).toBe('true')

    // ── a write that fails: nothing more is written, nothing is recorded as set, and the log says so ──
    fs.writeFileSync(refuse, '')
    setting('p1', true)
    await until('the refused write to be reported', () => t!.log.entries.some((e) => e.msg === 'fsmonitor could not be enabled'))
    await until('the writes to end', () => t!.files.resourceCounts.fsmonitorWrites === 0)
    expect(extension(r.root)).toBe('')
    for (const dir of [a, c]) expect(fs.existsSync(path.join(r.root, '.git', 'worktrees', path.basename(dir), 'config.worktree')) ? gitIn(r.root, 'config', '--file', path.join(r.root, '.git', 'worktrees', path.basename(dir), 'config.worktree'), '--list') : '').toBe('')
    expect(t.s('sa').persisted().fsmonitor).toBeUndefined()
    // once the write works, the setting (still on) is applied when the session is next looked at
    fs.rmSync(refuse)
    setting('p1', false)
    setting('p1', true)
    await until('the keys to be written after all', () => keys(a).join() === 'true,true')
    setting('p1', false)
    await until('everything to be taken back', () => extension(r.root) === '' && keys(a).join() === ',' && t!.files.resourceCounts.fsmonitorWrites === 0)
  })

  it.runIf(watching)('I-GS-17 · the viewer’s gutter follows git: in a folder that is not a repository no line is marked; once it is one (`git init` in its terminal) an untracked or added file is new as a whole and its first commit clears it; an edit is marked until committed, a commit that changes no file clearing it; a worktree session’s commit stays marked in Branch, which compares with the fork, and is cleared in Uncommitted', async () => {
    const plain = tempDir()
    write(plain, 'main.py', 'a\nb\n')
    t = await startFiles()
    const u = t
    u.session('s1', plain)
    u.show('s1')
    await u.ready('s1')
    expect(await u.changes('s1', 'main.py')).toMatchObject({ base: null, changes: [], whole: false })
    gitIn(plain, 'init', '-q')
    await until('the folder to be a repository', () => u.codes('s1')['main.py'] === 'U')
    expect(await u.changes('s1', 'main.py')).toMatchObject({ changes: [], whole: true })
    gitIn(plain, 'add', '-A')
    await until('the file to be added', () => u.codes('s1')['main.py'] === 'A')
    expect(await u.changes('s1', 'main.py')).toMatchObject({ base: null, changes: [], whole: true })
    gitIn(plain, 'commit', '-qm', 'first')
    await until('the work tree to be clean', () => u.head('s1')?.state === 'ok' && u.head('s1')?.base !== null && Object.keys(u.codes('s1')).length === 0)
    expect(await u.changes('s1', 'main.py')).toMatchObject({ changes: [], whole: false })
    // an edit, then its commit
    write(plain, 'main.py', 'a\nB\n')
    await until('the edit', () => u.codes('s1')['main.py'] === 'M')
    expect((await u.changes('s1', 'main.py')).changes).toHaveLength(1)
    gitIn(plain, 'commit', '-qam', 'second')
    await until('the edit to be committed', () => Object.keys(u.codes('s1')).length === 0)
    expect(await u.changes('s1', 'main.py')).toMatchObject({ changes: [], whole: false })

    // a worktree session: Branch compares with the fork, Uncommitted with HEAD
    const r = repo()
    const wt = linkedWorktree(r.root, 'wt-a')
    const fork = gitIn(r.root, 'rev-parse', 'main')
    u.session('s2', wt, { baseBranch: 'main', baseCommit: fork })
    u.show('s2')
    await u.ready('s2')
    write(wt, 'src/math.js', 'export const add = (a, b) => a + b\n')
    gitIn(wt, 'commit', '-qam', 'the work')
    await until('Branch to list the commit', () => u.codes('s2')['src/math.js'] === 'M' && u.head('s2')?.ahead === 1)
    expect((await u.changes('s2', 'src/math.js')).changes.length).toBeGreaterThan(0)
    expect(await u.call('files.setScope', { sessionId: 's2', scope: 'uncommitted' })).toEqual({ ok: true })
    await until('Uncommitted to be empty', () => u.head('s2')?.scope === 'uncommitted' && u.head('s2')?.state === 'ok' && Object.keys(u.codes('s2')).length === 0)
    expect(await u.changes('s2', 'src/math.js')).toMatchObject({ scope: 'uncommitted', changes: [], whole: false })
  })
})
