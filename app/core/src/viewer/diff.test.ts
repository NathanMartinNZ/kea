import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gitText } from '@kea/kit'
import { L, type GitEntry } from '@kea/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readChanges, readDiff, type DiffFacts } from './diff.ts'

let tmp: string
let repo: string
let mergeBase: string
let head: string
/** Hermetic git: no user or system config. */
const env = { PATH: process.env.PATH, HOME: '', LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Kea Test', GIT_AUTHOR_EMAIL: 'test@kea.invalid', GIT_COMMITTER_NAME: 'Kea Test', GIT_COMMITTER_EMAIL: 'test@kea.invalid' }
const g = (...args: string[]) => gitText(args, { cwd: repo, env })
const write = (rel: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), data)
}
const entry = (p: string, code: GitEntry['code'], origPath: string | null = null): GitEntry => ({ path: p, code, added: null, removed: null, origPath })
const text = (side: { text: { bytes: Uint8Array } | null }) => (side.text ? Buffer.from(side.text.bytes).toString() : null)

const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`)

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-viewer-diff-')))
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  await g('init', '-q', '-b', 'main')
  write('src/a.ts', `${LINES.join('\n')}\n`)
  write('gone.txt', 'will be deleted\n')
  write('old-name.txt', `${LINES.join('\n')}\nkept\n`)
  write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  write('data.bin', Buffer.from([1, 0, 2]))
  await g('add', '-A')
  await g('commit', '-q', '-m', 'base')
  mergeBase = (await g('rev-parse', 'HEAD')).trim()
  // the session's branch: one commit on top of the base, then uncommitted work
  await g('checkout', '-q', '-b', 'kea/session')
  const committed = [...LINES]
  committed[1] = 'line 2 (committed)'
  write('src/a.ts', `${committed.join('\n')}\n`)
  write('added.ts', 'export const added = 1\n')
  await g('add', '-A')
  await g('commit', '-q', '-m', 'session work')
  head = (await g('rev-parse', 'HEAD')).trim()
  const working = [...committed]
  working[6] = 'line 7 (uncommitted)'
  working.splice(9, 2) // lines 10 and 11 removed
  working.push('line 13', 'line 14')
  write('src/a.ts', `${working.join('\n')}\n`)
  write('untracked.ts', 'one\ntwo\n')
  fs.rmSync(path.join(repo, 'gone.txt'))
  await g('mv', 'old-name.txt', 'new-name.txt')
  fs.appendFileSync(path.join(repo, 'new-name.txt'), 'appended\n')
  write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]))
  write('data.bin', Buffer.from([1, 0, 2, 3, 4]))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("a diff's two sides and the gutter's ranges", () => {
  it('U-DF-1 · the old side is the file at the scope’s base (the merge base, or HEAD), a rename’s old path; untracked files are fully added, deleted ones fully removed; over the limits nothing is sent', async () => {
    const run = { cwd: repo, env }
    const branch = (e: GitEntry | null): DiffFacts => ({ scope: 'branch', base: mergeBase, entry: e })
    const uncommitted = (e: GitEntry | null): DiffFacts => ({ scope: 'uncommitted', base: head, entry: e })

    // Branch: against the merge base, so the committed change and the uncommitted one both show
    const b = await readDiff(run, 'src/a.ts', branch(entry('src/a.ts', 'M')))
    expect(b).toMatchObject({ kind: 'text', scope: 'branch', base: mergeBase, code: 'M', origPath: null })
    expect(text(b.old)).toBe(`${LINES.join('\n')}\n`)
    expect(text(b.new)).toContain('line 2 (committed)')
    expect(text(b.new)).toContain('line 7 (uncommitted)')
    expect(b.old).toMatchObject({ exists: true, text: { encoding: 'utf8', invalid: false, eol: 'lf' } })
    expect((await readChanges(run, 'src/a.ts', branch(entry('src/a.ts', 'M')))).changes).toEqual([
      { kind: 'modified', from: 2, to: 2 },
      { kind: 'modified', from: 7, to: 7 },
      { kind: 'deleted', from: 9, to: 9 },
      { kind: 'added', from: 11, to: 12 },
    ])

    // Uncommitted: against HEAD, so the committed change is on both sides
    const u = await readDiff(run, 'src/a.ts', uncommitted(entry('src/a.ts', 'M')))
    expect(u).toMatchObject({ kind: 'text', scope: 'uncommitted', base: head })
    expect(text(u.old)).toContain('line 2 (committed)')
    expect(text(u.old)).not.toContain('uncommitted')
    expect((await readChanges(run, 'src/a.ts', uncommitted(entry('src/a.ts', 'M')))).changes).toEqual([
      { kind: 'modified', from: 7, to: 7 },
      { kind: 'deleted', from: 9, to: 9 },
      { kind: 'added', from: 11, to: 12 },
    ])

    // a file the branch added: nothing at the merge base; in Uncommitted it is unchanged (no entry)
    const added = await readDiff(run, 'added.ts', branch(entry('added.ts', 'A')))
    expect(added.old).toEqual({ exists: false, size: 0, text: null, image: null })
    expect(text(added.new)).toBe('export const added = 1\n')
    expect((await readChanges(run, 'added.ts', branch(entry('added.ts', 'A')))).changes).toEqual([{ kind: 'added', from: 1, to: 1 }])
    const same = await readDiff(run, 'added.ts', uncommitted(null))
    expect(same).toMatchObject({ kind: 'text', code: null })
    expect(text(same.old)).toBe(text(same.new))
    expect(await readChanges(run, 'added.ts', uncommitted(null))).toMatchObject({ changes: [], whole: false, truncated: false })

    // untracked: fully added, and the gutter marks the whole file without asking git
    const untracked = await readDiff(run, 'untracked.ts', branch(entry('untracked.ts', 'U')))
    expect(untracked).toMatchObject({ kind: 'text', code: 'U', old: { exists: false }, new: { exists: true } })
    expect(text(untracked.new)).toBe('one\ntwo\n')
    expect(await readChanges(run, 'untracked.ts', branch(entry('untracked.ts', 'U')))).toMatchObject({ changes: [], whole: true })

    // deleted: fully removed
    const gone = await readDiff(run, 'gone.txt', branch(entry('gone.txt', 'D')))
    expect(gone).toMatchObject({ kind: 'text', code: 'D', old: { exists: true }, new: { exists: false, text: null } })
    expect(text(gone.old)).toBe('will be deleted\n')

    // renamed: the old side is the old path's file, and the gutter shows only what changed in the content
    const renamed = await readDiff(run, 'new-name.txt', branch(entry('new-name.txt', 'R', 'old-name.txt')))
    expect(renamed).toMatchObject({ kind: 'text', code: 'R', origPath: 'old-name.txt' })
    expect(text(renamed.old)).toBe(`${LINES.join('\n')}\nkept\n`)
    expect(text(renamed.new)).toBe(`${LINES.join('\n')}\nkept\nappended\n`)
    expect((await readChanges(run, 'new-name.txt', branch(entry('new-name.txt', 'R', 'old-name.txt')))).changes).toEqual([{ kind: 'added', from: 14, to: 14 }])

    // no base at all: no old side (which lines the gutter marks then is U-DF-5's)
    const fresh = await readDiff(run, 'src/a.ts', { scope: 'branch', base: null, entry: null })
    expect(fresh).toMatchObject({ kind: 'text', base: null, old: { exists: false }, new: { exists: true } })
    // a base that is not an object id is never given to git
    expect(await readDiff(run, 'src/a.ts', { scope: 'branch', base: '--output=/tmp/x', entry: null })).toMatchObject({ base: null, old: { exists: false } })
    // a base git does not have: no old side, no markers, no error
    const unknown = 'f'.repeat(40)
    expect(await readDiff(run, 'src/a.ts', { scope: 'branch', base: unknown, entry: null })).toMatchObject({ old: { exists: false } })
    expect(await readChanges(run, 'src/a.ts', { scope: 'branch', base: unknown, entry: null })).toMatchObject({ changes: [], whole: false })

    // Binary → sizes only; an image → the old side's bytes for the side-by-side view
    const bin = await readDiff(run, 'data.bin', branch(entry('data.bin', 'M')))
    expect(bin).toMatchObject({ kind: 'binary', old: { exists: true, size: 3, text: null }, new: { exists: true, size: 5, text: null } })
    const img = await readDiff(run, 'logo.png', branch(entry('logo.png', 'M')))
    expect(img).toMatchObject({ kind: 'image', old: { exists: true, size: 7, text: null }, new: { exists: true, size: 8, text: null, image: null } })
    expect([...(img.old.image as Uint8Array)]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

    // A side over the byte limit, or over the line limit, and nothing is sent
    write('big.txt', 'x\n')
    await g('add', 'big.txt')
    await g('commit', '-q', '-m', 'big')
    const tip = (await g('rev-parse', 'HEAD')).trim()
    fs.truncateSync(path.join(repo, 'big.txt'), L.diffMaxBytes + 1)
    const large = await readDiff(run, 'big.txt', { scope: 'uncommitted', base: tip, entry: entry('big.txt', 'M') })
    expect(large).toMatchObject({ kind: 'large', old: { exists: true, text: null }, new: { exists: true, size: L.diffMaxBytes + 1, text: null } })
    write('big.txt', '\n'.repeat(L.diffMaxLines + 1))
    expect(await readDiff(run, 'big.txt', { scope: 'uncommitted', base: tip, entry: entry('big.txt', 'M') })).toMatchObject({ kind: 'large', new: { text: null } })
    write('big.txt', '\n'.repeat(L.diffMaxLines))
    expect(await readDiff(run, 'big.txt', { scope: 'uncommitted', base: tip, entry: entry('big.txt', 'M') })).toMatchObject({ kind: 'text' })
    // the old side over the limit: committed large, then made small
    write('big.txt', Buffer.alloc(L.diffMaxBytes + 1, 0x61))
    await g('add', 'big.txt')
    await g('commit', '-q', '-m', 'bigger')
    const bigTip = (await g('rev-parse', 'HEAD')).trim()
    write('big.txt', 'small again\n')
    expect(await readDiff(run, 'big.txt', { scope: 'uncommitted', base: bigTip, entry: entry('big.txt', 'M') })).toMatchObject({ kind: 'large', old: { exists: true, text: null }, new: { text: null } })

    // the gutter's caps: more ranges than it keeps, and no markers are shown rather than some
    const many = Array.from({ length: (L.viewerChangeRangesMax + 1) * 2 }, (_, i) => `row ${i}`)
    write('many.txt', `${many.join('\n')}\n`)
    await g('add', 'many.txt')
    await g('commit', '-q', '-m', 'many')
    const manyTip = (await g('rev-parse', 'HEAD')).trim()
    write('many.txt', `${many.map((l, i) => (i % 2 === 0 ? `${l} changed` : l)).join('\n')}\n`)
    expect(await readChanges(run, 'many.txt', { scope: 'uncommitted', base: manyTip, entry: entry('many.txt', 'M') })).toMatchObject({ changes: [], truncated: true })
  })
  it('U-DF-2 · the gutter’s ranges are those of the one file asked for, whatever it is called: a file named `*` is not every file, and one named `:x` is not read as a pathspec with magic (git would drop the colon and answer for `x`)', async () => {
    const run = { cwd: repo, env }
    const names: [string, number][] = [['*', 3], [':x', 5], ['x', 7], ['other.txt', 9]]
    for (const [name] of names) write(name, `${LINES.join('\n')}\n`)
    await g('add', '-A')
    await g('commit', '-q', '-m', 'odd names')
    const base = (await g('rev-parse', 'HEAD')).trim()
    // each file changes one line of its own
    for (const [name, line] of names) write(name, `${LINES.map((l, i) => (i === line - 1 ? `${l} (changed)` : l)).join('\n')}\n`)
    const facts = (p: string): DiffFacts => ({ scope: 'uncommitted', base, entry: entry(p, 'M') })
    for (const [name, line] of names) expect((await readChanges(run, name, facts(name))).changes, name).toEqual([{ kind: 'modified', from: line, to: line }])
  })

  it('U-DF-5 · with nothing to compare against, the gutter marks only a file the status lists: no entry (a folder that is not a repository, an ignored file, a status not read yet) marks nothing; an untracked file, or one added before the first commit, is marked whole', async () => {
    const run = { cwd: repo, env }
    for (const scope of ['branch', 'uncommitted'] as const) {
      expect(await readChanges(run, 'src/a.ts', { scope, base: null, entry: null }), scope).toMatchObject({ changes: [], whole: false })
      expect(await readChanges(run, 'untracked.ts', { scope, base: null, entry: entry('untracked.ts', 'U') }), scope).toMatchObject({ changes: [], whole: true })
      expect(await readChanges(run, 'added.ts', { scope, base: null, entry: entry('added.ts', 'A') }), scope).toMatchObject({ changes: [], whole: true })
    }
    // with a base, an untracked file is still whole without asking git
    expect(await readChanges(run, 'untracked.ts', { scope: 'uncommitted', base: head, entry: entry('untracked.ts', 'U') })).toMatchObject({ changes: [], whole: true })
  })

  it('U-DF-4 · a file added to git and then deleted from disk (the row marked as the index’s alone): the base has no such file, so the old side is the file as git’s index has it, shown as fully removed, in either scope and whatever the file is called; an unmarked row of a path the base lacks still has no old side', async () => {
    const run = { cwd: repo, env }
    const tip = (await g('rev-parse', 'HEAD')).trim()
    // `2:odd.txt`: `:2:odd.txt` would name a conflict's stage, not this file; `-n.txt`: not an option
    const names = ['staged/draft.ts', '2:odd.txt', '-n.txt', 'staged.png']
    const content = (name: string): Buffer => (name.endsWith('.png') ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 2]) : Buffer.from(`only in the index: ${name}\nsecond line\n`))
    for (const name of names) write(name, content(name))
    await g('add', '--', ...names)
    for (const name of names) fs.rmSync(path.join(repo, name))
    const marked = (p: string): GitEntry => ({ ...entry(p, 'D'), indexOnly: true })
    for (const facts of [(p: string): DiffFacts => ({ scope: 'uncommitted', base: tip, entry: marked(p) }), (p: string): DiffFacts => ({ scope: 'branch', base: mergeBase, entry: marked(p) })]) {
      for (const name of names) {
        const d = await readDiff(run, name, facts(name))
        expect(d.new, name).toEqual({ exists: false, size: 0, text: null, image: null })
        expect(d.old.exists, `${name}: the old side`).toBe(true)
        expect(d.old.size, name).toBe(content(name).length)
        if (name.endsWith('.png')) expect(d).toMatchObject({ kind: 'image', code: 'D', old: { image: content(name) } })
        else {
          expect(d).toMatchObject({ kind: 'text', code: 'D' })
          expect(text(d.old), name).toBe(content(name).toString())
        }
      }
    }
    // not marked (a diff that was cut short does not say): the base has no such file, so there is no old side
    expect((await readDiff(run, 'staged/draft.ts', { scope: 'uncommitted', base: tip, entry: entry('staged/draft.ts', 'D') })).old.exists).toBe(false)
    // marked, but the index has no such file any more (unstaged in between): no old side, no error
    await g('rm', '--cached', '-q', '--', '-n.txt')
    expect(await readDiff(run, '-n.txt', { scope: 'uncommitted', base: tip, entry: marked('-n.txt') })).toMatchObject({ kind: 'text', old: { exists: false }, new: { exists: false } })
    // over the limit the index's side is not sent either
    write('big.txt', Buffer.alloc(L.diffMaxBytes + 1, 0x61))
    await g('add', '--', 'big.txt')
    fs.rmSync(path.join(repo, 'big.txt'))
    expect(await readDiff(run, 'big.txt', { scope: 'uncommitted', base: tip, entry: marked('big.txt') })).toMatchObject({ kind: 'large', old: { exists: true, text: null }, new: { exists: false } })
  })
})
