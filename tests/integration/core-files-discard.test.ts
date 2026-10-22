// Discard Changes in core (`files.discard`, app/core/src/files/discard.ts): what it does to a file, and everything it
// refuses. Real git in temp repositories. The Trash is a folder of the test's own: the `trash` tool core is given is a
// script that moves its arguments there, so nothing here reaches the system's Trash. Harness: core-files-support.ts.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitStoreName, isAvailable, need, type DiffScope, type DiscardResult } from '@kea/protocol'
import { until } from '../support/holders.ts'
import { readDiff } from '@kea/core/src/viewer/diff.ts'
import { coreOs } from '../../app/core/src/os/index.ts'
import { cleanup, gitEnv, gitIn, linkedWorktree, repo, startFiles, tempDir, write, type FilesUnderTest } from './core-files-support.ts'

let t: FilesUnderTest | null = null
afterEach(async () => {
  await t?.dispose()
  t = null
  cleanup()
})

/**
 * A stand-in for the system's trash tool: moves the files it is given into `dir`. It takes either system's arguments
 * (macOS `trash -s <file>`, Linux `gio trash -- <file>`). Returns the tool and the folder.
 */
function fakeTrash(): { tool: string; dir: string } {
  const home = tempDir('kea-trash-')
  const dir = path.join(home, 'moved')
  fs.mkdirSync(dir)
  const tool = path.join(home, 'trash')
  fs.writeFileSync(tool, `#!/bin/sh\n[ "$1" = "-s" ] && shift\n[ "$1" = "trash" ] && shift\n[ "$1" = "--" ] && shift\nexec /bin/mv -- "$@" '${dir}/'\n`, { mode: 0o755 })
  return { tool, dir }
}

/** What the sheet was written for and the request carries: the scope, and the commit it compares against. */
interface Said {
  scope: DiffScope
  base: string | null
}

/** What a sheet opened now would say: the scope and the base of the status on screen (`git:<sessionId>`'s head). */
function said(f: FilesUnderTest, id = 's1'): Said {
  const h = f.stores.get(gitStoreName(id)) ? f.head(id) : undefined
  return { scope: h?.scope ?? 'branch', base: h?.base ?? null }
}

const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')
const exists = (root: string, rel: string): boolean => fs.existsSync(path.join(root, rel))

describe('Discard Changes in core', () => {
  it('I-FT-18 · Discard Changes puts a changed or deleted file back as the commit the scope compares against has it (index and working tree), and moves a file that commit does not have (untracked, or added since) to the Trash and out of the index; the Changes list follows at once, and the two scopes discard against their own base', async () => {
    const r = repo()
    const fork = gitIn(r.root, 'rev-parse', 'HEAD')
    const wt = linkedWorktree(r.root, 'wt-discard')
    // committed on the branch: an edit, a new file, a deletion
    write(wt, 'src/math.js', 'export const add = (a, b) => a + b\n')
    write(wt, 'src/added.js', 'export const added = 1\n')
    fs.rmSync(path.join(wt, 'src/hello.js'))
    gitIn(wt, 'add', '-A')
    gitIn(wt, 'commit', '-q', '-m', 'work')
    // not committed: an edit on top, a staged new file, an untracked one (with a name git would read as a pattern)
    write(wt, 'src/math.js', 'export const add = (a, b) => b + a\n')
    write(wt, 'src/staged.js', 'export const staged = 1\n')
    gitIn(wt, 'add', 'src/staged.js')
    write(wt, 'notes [draft]*.md', 'a note\n')
    write(wt, 'src/counter.js', 'let x = 100\n')

    const trash = fakeTrash()
    t = await startFiles({ files: { trashTool: trash.tool } })
    t.session('s1', wt, { baseBranch: 'main', baseCommit: fork })
    t.show('s1')
    await t.ready('s1')
    const discard = (p: string, expect: 'restore' | 'trash'): Promise<DiscardResult> => t!.call('files.discard', { sessionId: 's1', path: p, expect, ...said(t!) })
    expect(t.codes('s1')).toEqual({ 'notes [draft]*.md': 'U', 'src/added.js': 'A', 'src/counter.js': 'M', 'src/hello.js': 'D', 'src/math.js': 'M', 'src/staged.js': 'A' })

    // Branch scope: back to the fork point, also what was committed since
    expect(await discard('src/math.js', 'restore')).toEqual({ ok: true, did: 'restore' })
    expect(read(wt, 'src/math.js')).toBe(read(r.root, 'src/math.js'))
    expect(gitIn(wt, 'diff', '--name-only', fork, '--', 'src/math.js')).toBe('')
    expect(gitIn(wt, 'diff', '--cached', '--name-only', fork, '--', 'src/math.js')).toBe('') // the index too
    // a deleted file comes back
    expect(await discard('src/hello.js', 'restore')).toEqual({ ok: true, did: 'restore' })
    expect(read(wt, 'src/hello.js')).toBe(read(r.root, 'src/hello.js'))
    // an untracked file goes to the Trash, whole
    expect(await discard('notes [draft]*.md', 'trash')).toEqual({ ok: true, did: 'trash' })
    expect(exists(wt, 'notes [draft]*.md')).toBe(false)
    expect(fs.readFileSync(path.join(trash.dir, 'notes [draft]*.md'), 'utf8')).toBe('a note\n')
    // a file added since the base (committed, or only staged) goes to the Trash and out of the index
    expect(await discard('src/added.js', 'trash')).toEqual({ ok: true, did: 'trash' })
    expect(await discard('src/staged.js', 'trash')).toEqual({ ok: true, did: 'trash' })
    expect(fs.readdirSync(trash.dir).sort()).toEqual(['added.js', 'notes [draft]*.md', 'staged.js'])
    expect(gitIn(wt, 'ls-files', '--', 'src/added.js', 'src/staged.js')).toBe('')
    // the list follows without waiting for the watcher's debounce to be asked for
    await until('the Changes list to hold what is left', () => JSON.stringify(t!.codes('s1')) === JSON.stringify({ 'src/counter.js': 'M' }))
    expect(read(wt, 'src/counter.js')).toBe('let x = 100\n') // what was not discarded is untouched

    // Uncommitted scope: back to HEAD, not to the fork point
    write(wt, 'README.md', '# changed on the branch\n')
    gitIn(wt, 'add', '-A')
    gitIn(wt, 'commit', '-q', '-m', 'more work')
    write(wt, 'README.md', '# changed again, not committed\n')
    await t.call('files.setScope', { sessionId: 's1', scope: 'uncommitted' })
    await until('the uncommitted scope', () => t!.head('s1')?.scope === 'uncommitted' && t!.codes('s1')['README.md'] === 'M')
    expect(await discard('README.md', 'restore')).toEqual({ ok: true, did: 'restore' })
    expect(read(wt, 'README.md')).toBe('# changed on the branch\n')
    await until('nothing uncommitted', () => Object.keys(t!.codes('s1')).length === 0)
  })

  it('I-FT-19 · Discard Changes refuses, and touches nothing: a file that is not a change (an ignored file, an unchanged one), a folder, a submodule, an unmerged path, a path through a symlinked folder that leaves the working directory, an action other than the one confirmed, a session that is not shown, a folder that is not a repository, and a file for the Trash when there is no `trash` tool or it fails', async () => {
    const r = repo()
    const fork = gitIn(r.root, 'rev-parse', 'HEAD')
    // a second repository to be a submodule, and a branch that conflicts with main
    const sub = repo('sub')
    gitIn(r.root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.root, 'vendor/sub')
    gitIn(r.root, 'commit', '-q', '-m', 'add a submodule')
    const base = gitIn(r.root, 'rev-parse', 'HEAD')
    gitIn(r.root, 'checkout', '-q', '-b', 'other', fork)
    write(r.root, 'src/hello.js', 'export const greet = () => "other"\n')
    gitIn(r.root, 'commit', '-qam', 'other')
    gitIn(r.root, 'checkout', '-q', 'main')
    write(r.root, 'src/hello.js', 'export const greet = () => "main"\n')
    gitIn(r.root, 'commit', '-qam', 'main')
    const head = gitIn(r.root, 'rev-parse', 'HEAD')
    expect(() => gitIn(r.root, 'merge', '-q', 'other')).toThrow() // left unmerged
    // changes of each kind that must stay as they are
    write(r.root, 'node_modules/pkg/index.js', 'ignored\n')
    write(r.root, '.env', 'SECRET=1\n')
    fs.appendFileSync(path.join(r.root, '.git/info/exclude'), '.env\n')
    write(r.root, 'src/math.js', 'changed\n')
    write(r.root, 'untracked.txt', 'new\n')
    write(r.root, 'src/new/inner.txt', 'new\n')
    const outside = tempDir('kea-outside-')
    write(outside, 'precious.txt', 'not yours\n')
    fs.symlinkSync(outside, path.join(r.root, 'link-out'))
    write(path.join(r.root, 'vendor/sub'), 'README.md', 'changed in the submodule\n')

    const trash = fakeTrash()
    t = await startFiles({ files: { trashTool: trash.tool } })
    t.session('s1', r.root, { baseCommit: head })
    t.show('s1')
    await t.ready('s1')
    const discard = (p: string, expect: 'restore' | 'trash', sessionId = 's1'): Promise<DiscardResult> => t!.call('files.discard', { sessionId, path: p, expect, ...said(t!) })
    const before = gitIn(r.root, 'status', '--porcelain=v1', '--ignored')

    // not a change: an ignored file is never moved, whichever way it is ignored; nor is a file like its base
    expect(await discard('.env', 'trash')).toEqual({ ok: false, refused: 'unchanged' })
    expect(await discard('node_modules/pkg/index.js', 'trash')).toEqual({ ok: false, refused: 'unchanged' })
    expect(await discard('README.md', 'restore')).toEqual({ ok: false, refused: 'unchanged' })
    expect(await discard('no/such/file.txt', 'trash')).toEqual({ ok: false, refused: 'unchanged' })
    // one file at a time
    expect(await discard('src', 'restore')).toEqual({ ok: false, refused: 'directory' })
    expect(await discard('src/new', 'trash')).toEqual({ ok: false, refused: 'directory' })
    expect(await discard('vendor/sub', 'restore')).toMatchObject({ ok: false, refused: expect.stringMatching(/^(directory|submodule)$/) })
    // an unmerged path
    expect(await discard('src/hello.js', 'restore')).toEqual({ ok: false, refused: 'conflict' })
    // through a symlinked folder to somewhere else
    expect(await discard('link-out/precious.txt', 'trash')).toEqual({ ok: false, refused: 'outside' })
    // not what was confirmed
    expect(await discard('src/math.js', 'trash')).toEqual({ ok: false, refused: 'changed' })
    expect(await discard('untracked.txt', 'restore')).toEqual({ ok: false, refused: 'changed' })
    // not a path at all (the protocol's schema refuses these before core's handler; here: the handler's own answers)
    await expect(discard('src/math.js', 'restore', 'nobody')).rejects.toThrow(/not shown/)

    expect(gitIn(r.root, 'status', '--porcelain=v1', '--ignored')).toBe(before)
    expect(fs.readdirSync(trash.dir)).toEqual([])
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('not yours\n')
    expect(read(r.root, '.env')).toBe('SECRET=1\n')
    expect(base).not.toBe(head)

    // a submodule that is not checked out is still a submodule
    await t.dispose()
    gitIn(r.root, 'merge', '--abort')
    gitIn(r.root, 'checkout', '-q', '--', 'src/math.js')
    fs.rmSync(path.join(r.root, 'vendor/sub'), { recursive: true, force: true })
    // no tool (a Mac before macOS 15; Linux without gio, whose refusal names it): nothing is deleted in its place; a
    // tool that fails: the file stays
    const missing = need(coreOs.trash).missing
    const noTrash = missing === null ? { ok: false, refused: 'noTrash' } : { ok: false, refused: 'noTrash', detail: missing }
    const failing = path.join(tempDir('kea-trash-'), 'trash')
    fs.writeFileSync(failing, '#!/bin/sh\necho "trash: cannot move it" >&2\nexit 1\n', { mode: 0o755 })
    const absent = path.join(tempDir('kea-trash-'), 'bin', 'trash')
    for (const [tool, want] of [[null, noTrash], [absent, noTrash], [failing, { ok: false, refused: 'failed', detail: 'trash: cannot move it' }]] as const) {
      t = await startFiles({ files: { trashTool: tool } })
      t.session('s1', r.root, { baseCommit: fork })
      t.show('s1')
      await t.ready('s1')
      expect(await discard('untracked.txt', 'trash')).toEqual(want)
      expect(read(r.root, 'untracked.txt')).toBe('new\n')
      expect(await discard('vendor/sub', 'restore')).toEqual({ ok: false, refused: 'submodule' })
      await t.dispose()
    }

    // a folder that is not a repository
    const plain = tempDir('kea-plain-')
    write(plain, 'a.txt')
    t = await startFiles({ files: { trashTool: trash.tool } })
    t.session('s1', plain)
    t.show('s1')
    await until('the folder to be read', () => t!.treeHead('s1')?.git === false)
    expect(await discard('a.txt', 'trash')).toEqual({ ok: false, refused: 'notGit' })
    expect(exists(plain, 'a.txt')).toBe(true)
    expect(fs.readdirSync(trash.dir)).toEqual([])
  })

  it('I-FT-23 · Discard Changes does only what the sheet said, in the scope and against the commit it said it for: asked in one scope and clicked in the other, or clicked after the commit the scope compares against has moved, it refuses `changed`, touches nothing and reads the list again; a file git does not track goes to the Trash even where the base has a file at its path (never overwritten), and the path then reads as deleted and is restored by a second discard', async () => {
    const r = repo()
    const fork = gitIn(r.root, 'rev-parse', 'HEAD')
    const wt = linkedWorktree(r.root, 'wt-said')
    const committed = 'export const add = (a, b) => a + b // committed on the branch\n'
    const edited = 'export const add = (a, b) => b + a // not committed\n'
    write(wt, 'src/math.js', committed)
    gitIn(wt, 'commit', '-qam', 'work')
    const head1 = gitIn(wt, 'rev-parse', 'HEAD')
    write(wt, 'src/math.js', edited)

    const trash = fakeTrash()
    t = await startFiles({ files: { trashTool: trash.tool } })
    t.session('s1', wt, { baseBranch: 'main', baseCommit: fork })
    t.show('s1')
    await t.ready('s1')
    const discard = (p: string, expect: 'restore' | 'trash', sheet: Said): Promise<DiscardResult> => t!.call('files.discard', { sessionId: 's1', path: p, expect, ...sheet })
    const scope = async (s: 'branch' | 'uncommitted', base: string): Promise<void> => {
      await t!.call('files.setScope', { sessionId: 's1', scope: s })
      await until(`the ${s} scope against ${base.slice(0, 7)}`, () => t!.head('s1')?.scope === s && t!.head('s1')?.state === 'ok' && t!.head('s1')?.base === base)
    }
    expect(said(t)).toEqual({ scope: 'branch', base: fork })

    // the sheet was read in Uncommitted ("as it is in the last commit"); the scope is Branch at the click
    await scope('uncommitted', head1)
    const inUncommitted = said(t)
    await t.call('files.setScope', { sessionId: 's1', scope: 'branch' })
    expect(await discard('src/math.js', 'restore', inUncommitted)).toEqual({ ok: false, refused: 'changed' })
    expect(read(wt, 'src/math.js')).toBe(edited) // not put back as the branch point has it
    expect(gitIn(wt, 'diff', '--cached', '--name-only')).toBe('')
    // and the other way round
    await scope('branch', fork)
    const inBranch = said(t)
    await t.call('files.setScope', { sessionId: 's1', scope: 'uncommitted' })
    expect(await discard('src/math.js', 'restore', inBranch)).toEqual({ ok: false, refused: 'changed' })
    expect(read(wt, 'src/math.js')).toBe(edited)

    // the same scope, but "the last commit" is another one at the click: the agent committed in between
    await scope('uncommitted', head1)
    const before = said(t)
    gitIn(wt, 'commit', '-qam', 'the agent commits')
    const head2 = gitIn(wt, 'rev-parse', 'HEAD')
    const again = 'export const add = (a, b) => a + b + 0 // edited after the commit\n'
    write(wt, 'src/math.js', again)
    expect(await discard('src/math.js', 'restore', before)).toEqual({ ok: false, refused: 'changed' })
    expect(read(wt, 'src/math.js')).toBe(again)
    expect(gitIn(wt, 'rev-parse', 'HEAD')).toBe(head2)
    expect(gitIn(wt, 'diff', '--cached', '--name-only')).toBe('')
    // the list is read again after the refusal, so the next sheet says what holds now, and that is done
    await until('the list against the new commit', () => t!.head('s1')?.base === head2 && t!.codes('s1')['src/math.js'] === 'M')
    expect(await discard('src/math.js', 'restore', said(t))).toEqual({ ok: true, did: 'restore' })
    expect(read(wt, 'src/math.js')).toBe(edited)

    // git does not track the file, and the base has one at its path (the session deleted it, then wrote another)
    await scope('branch', fork)
    gitIn(wt, 'rm', '-q', 'src/hello.js')
    gitIn(wt, 'commit', '-qm', 'drop hello')
    const fresh = 'a new file where the old one was\n'
    write(wt, 'src/hello.js', fresh)
    await until('the new file to be listed as untracked', () => t!.codes('s1')['src/hello.js'] === 'U')
    expect(said(t)).toEqual({ scope: 'branch', base: fork })
    // never overwritten by the base's file
    expect(await discard('src/hello.js', 'restore', said(t))).toEqual({ ok: false, refused: 'changed' })
    expect(read(wt, 'src/hello.js')).toBe(fresh)
    // to the Trash, as the sheet says of an untracked file
    expect(await discard('src/hello.js', 'trash', said(t))).toEqual({ ok: true, did: 'trash' })
    expect(exists(wt, 'src/hello.js')).toBe(false)
    expect(fs.readFileSync(path.join(trash.dir, 'hello.js'), 'utf8')).toBe(fresh)
    // what is left is the session's deletion of the base's file, which a second discard puts back
    await until('the path to read as deleted', () => t!.codes('s1')['src/hello.js'] === 'D')
    expect(await discard('src/hello.js', 'restore', said(t))).toEqual({ ok: true, did: 'restore' })
    expect(read(wt, 'src/hello.js')).toBe(read(r.root, 'src/hello.js'))
  })

  it('I-FT-26 · a change that only git’s index holds is listed, shown and discarded for what it is: a file added to git and then deleted from disk is a `D` row marked as the index’s alone, which the last commit cannot restore: it is put back as it was added, then reads `A` and goes to the Trash like any new file; a staged edit whose file reads as the last commit again is put back in the index too; with no commit yet, a staged file goes to the Trash and one deleted from disk comes back', async () => {
    const r = repo()
    const wt = linkedWorktree(r.root, 'wt-index')
    const head = gitIn(wt, 'rev-parse', 'HEAD')
    const gone = 'src/staged gone.js'
    const added = 'export const staged = 1\n'
    // added to git, then deleted from disk: the index has the only copy
    write(wt, gone, added)
    gitIn(wt, 'add', gone)
    fs.rmSync(path.join(wt, gone))
    // an edit staged, then the file written back as the last commit has it: only the index differs
    const was = read(wt, 'src/math.js')
    write(wt, 'src/math.js', 'export const add = (a, b) => b + a\n')
    gitIn(wt, 'add', 'src/math.js')
    write(wt, 'src/math.js', was)
    // beside them, the ordinary deleted file: the last commit has it
    fs.rmSync(path.join(wt, 'src/hello.js'))

    const trash = fakeTrash()
    t = await startFiles({ files: { trashTool: trash.tool } })
    t.session('s1', wt, { baseBranch: 'main', baseCommit: head })
    t.show('s1')
    await t.ready('s1')
    /** Letters by path, with the mark a row carries when only the index holds its file. */
    const rows = (id: string): Record<string, string> =>
      Object.fromEntries(
        Object.entries(t!.entries(id))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([p, e]) => [p, e.indexOnly === true ? `${e.code} (index only)` : e.code]),
      )
    const discard = (id: string, p: string, expect: string): Promise<DiscardResult> => t!.call('files.discard', { sessionId: id, path: p, expect, ...said(t!, id) })
    // Branch compares the working tree with the branch point: what only the index holds is no row there
    expect(rows('s1')).toEqual({ 'src/hello.js': 'D' })
    await t.call('files.setScope', { sessionId: 's1', scope: 'uncommitted' })
    await until('the uncommitted scope', () => t!.head('s1')?.scope === 'uncommitted' && t!.head('s1')?.state === 'ok' && Object.keys(t!.codes('s1')).length === 3)
    expect(rows('s1')).toEqual({ 'src/hello.js': 'D', 'src/math.js': 'M', [gone]: 'D (index only)' })
    // its diff, read as the viewer reads it (the row's entry from the git facts): the old side is what the index
    // holds, the file Restore would put back; the ordinary deleted file's is the commit's
    const diffOf = (p: string) => readDiff({ cwd: wt, env: gitEnv() }, p, { scope: 'uncommitted', base: head, entry: t!.files.entry('s1', p) })
    const shown = await diffOf(gone)
    expect(shown).toMatchObject({ kind: 'text', code: 'D', old: { exists: true }, new: { exists: false } })
    expect(Buffer.from(shown.old.text?.bytes ?? []).toString()).toBe(added)
    expect(Buffer.from((await diffOf('src/hello.js')).old.text?.bytes ?? []).toString()).toBe(gitIn(wt, 'show', 'HEAD:src/hello.js') + '\n')

    // the file added and then deleted: the last commit has none to put back, and nothing is there for the Trash
    expect(await discard('s1', gone, 'restore')).toEqual({ ok: false, refused: 'changed' })
    expect(await discard('s1', gone, 'trash')).toEqual({ ok: false, refused: 'changed' })
    expect(exists(wt, gone)).toBe(false)
    expect(gitIn(wt, 'ls-files', '--', gone)).toBe(gone) // still in the index
    // Restore, as the sheet says it for this row: back as it was added
    expect(await discard('s1', gone, 'restoreStaged')).toEqual({ ok: true, did: 'restoreStaged' })
    expect(read(wt, gone)).toBe(added)
    await until('its row to read as a new file', () => rows('s1')[gone] === 'A')
    // … and a new file goes to the Trash and out of the index, as ever
    expect(await discard('s1', gone, 'trash')).toEqual({ ok: true, did: 'trash' })
    expect(fs.readFileSync(path.join(trash.dir, 'staged gone.js'), 'utf8')).toBe(added)
    expect(gitIn(wt, 'ls-files', '--', gone)).toBe('')

    // the staged edit: "put back as it is in the last commit" is the index's entry
    expect(await discard('s1', 'src/math.js', 'restore')).toEqual({ ok: true, did: 'restore' })
    expect(gitIn(wt, 'diff', '--cached', '--name-only')).toBe('')
    expect(read(wt, 'src/math.js')).toBe(was)
    // the ordinary deleted file comes back from the commit, as before
    expect(await discard('s1', 'src/hello.js', 'restore')).toEqual({ ok: true, did: 'restore' })
    await until('nothing uncommitted', () => Object.keys(t!.codes('s1')).length === 0)
    expect(gitIn(wt, 'status', '--porcelain')).toBe('')

    // a repository with no commit: there is nothing to compare with, and everything git tracks is new
    const fresh = tempDir('kea-nocommit-')
    gitIn(fresh, 'init', '-q')
    write(fresh, 'kept.txt', 'kept\n')
    write(fresh, 'deleted.txt', 'deleted\n')
    gitIn(fresh, 'add', '.')
    fs.rmSync(path.join(fresh, 'deleted.txt'))
    t.session('s2', fresh)
    t.show('s2')
    await t.ready('s2')
    expect(said(t, 's2').base).toBeNull()
    expect(rows('s2')).toEqual({ 'deleted.txt': 'D (index only)', 'kept.txt': 'A' })
    expect(await discard('s2', 'deleted.txt', 'restoreStaged')).toEqual({ ok: true, did: 'restoreStaged' })
    expect(read(fresh, 'deleted.txt')).toBe('deleted\n')
    expect(await discard('s2', 'kept.txt', 'trash')).toEqual({ ok: true, did: 'trash' })
    expect(exists(fresh, 'kept.txt')).toBe(false)
    expect(fs.readFileSync(path.join(trash.dir, 'kept.txt'), 'utf8')).toBe('kept\n')
    expect(gitIn(fresh, 'ls-files')).toBe('deleted.txt')
  })

  it.runIf(coreOs.system === 'linux' && isAvailable(coreOs.trash) && fs.existsSync(need(coreOs.trash).tool))('I-PLT-10 · Linux: Discard Changes moves an untracked file and one added since the base through GLib’s real `gio trash` into the freedesktop trash of the session’s HOME (each file with its .trashinfo), and the added one out of the index', async () => {
    const r = repo()
    const fork = gitIn(r.root, 'rev-parse', 'HEAD')
    write(r.root, 'notes draft.md', 'a note\n')
    write(r.root, 'src/added.js', 'export const added = 1\n')
    gitIn(r.root, 'add', 'src/added.js')
    // the trash of a HOME of the test's own (on the repository's file system, so gio uses the home trash): never the
    // real user's
    const home = tempDir('kea-gio-home-')
    const data = path.join(home, 'data')
    t = await startFiles({ files: { trashTool: need(coreOs.trash).tool, env: async () => ({ ...gitEnv(), HOME: home, XDG_DATA_HOME: data }) } })
    t.session('s1', r.root, { baseCommit: fork })
    t.show('s1')
    await t.ready('s1')
    const discard = (p: string): Promise<DiscardResult> => t!.call('files.discard', { sessionId: 's1', path: p, expect: 'trash', ...said(t!) })
    expect(await discard('notes draft.md')).toEqual({ ok: true, did: 'trash' })
    expect(await discard('src/added.js')).toEqual({ ok: true, did: 'trash' })
    expect([exists(r.root, 'notes draft.md'), exists(r.root, 'src/added.js')]).toEqual([false, false])
    expect(gitIn(r.root, 'ls-files', '--', 'src/added.js')).toBe('')

    const trash = path.join(data, 'Trash')
    expect(fs.readdirSync(path.join(trash, 'files')).sort()).toEqual(['added.js', 'notes draft.md'])
    expect(fs.readFileSync(path.join(trash, 'files', 'notes draft.md'), 'utf8')).toBe('a note\n')
    for (const [name, from] of [['notes draft.md', 'notes draft.md'], ['added.js', 'src/added.js']] as const) {
      const info = fs.readFileSync(path.join(trash, 'info', `${name}.trashinfo`), 'utf8')
      expect(info).toMatch(/^\[Trash Info\]\nPath=.+\nDeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/)
      expect(decodeURIComponent(/^Path=(.*)$/m.exec(info)![1]!)).toBe(path.join(r.root, from))
    }
  })
})
