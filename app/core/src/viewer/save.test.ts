import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMemoryLogger } from '@kea/kit'
import { L, type LineEnding, type SaveResult } from '@kea/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FsModule } from '../files/fsImpl.ts'
import { readForEdit, readUpTo, resolveInside, userGroups, versionOf, writableOf } from './read.ts'
import { encodeText, ioDetail, saveFile, SaveJournal, type SaveDeps, type SaveRequest } from './save.ts'

let tmp: string
let cwd: string
let home: string
const me = process.getuid?.() ?? -1

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-viewer-save-')))
  cwd = path.join(tmp, 'work')
  home = path.join(tmp, 'home')
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
  fs.mkdirSync(home)
})

afterAll(() => {
  // folders made read-only by a case are made writable again so they can be removed
  for (const d of fs.readdirSync(cwd, { recursive: true, withFileTypes: true })) if (d.isDirectory()) fs.chmodSync(path.join(d.parentPath, d.name), 0o755)
  fs.rmSync(tmp, { recursive: true, force: true })
})

const at = (rel: string): string => path.join(cwd, rel)
const bytesOf = (rel: string): Buffer => fs.readFileSync(at(rel))
const put = (rel: string, data: string | Uint8Array, mode = 0o644): void => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true })
  fs.writeFileSync(at(rel), data, { mode })
  fs.chmodSync(at(rel), mode)
}
const temps = (dir: string): string[] => fs.readdirSync(dir).filter((n) => n.startsWith('.kea-save-'))

/** What `fs` calls a save makes, with some replaced: `open` and `rename` of the file system the test runs on. */
function fsWith(over: Partial<FsModule['promises']>): FsModule {
  return { ...fs, promises: { ...fs.promises, ...over } } as FsModule
}

function harness(o: { fs?: FsModule; uid?: number; groups?: ReadonlySet<number>; journal?: string } = {}) {
  const log = createMemoryLogger({ process: 'core' })
  const journalFile = o.journal ?? path.join(home, 'save-journal.json')
  const f = o.fs ?? fs
  const journal = new SaveJournal({ file: journalFile, log, fs: f, uid: me })
  let held = false
  let wrote = 0
  const deps: SaveDeps = {
    fs: f,
    uid: o.uid ?? me,
    groups: o.groups ?? userGroups(),
    journal,
    slot: () => {
      if (held) return null
      held = true
      return () => void (held = false)
    },
    wrote: () => void wrote++,
  }
  const save = (rel: string, text: string, more: Partial<SaveRequest> = {}): Promise<SaveResult> => {
    const base = fs.existsSync(at(rel)) ? versionOf(bytesOf(rel)) : '0'.repeat(64)
    return saveFile(cwd, { path: rel, text, base, eol: 'lf', ...more }, deps)
  }
  return {
    deps,
    journal,
    journalFile,
    log,
    save,
    get held() {
      return held
    },
    hold: () => void (held = true),
    let: () => void (held = false),
    get wrote() {
      return wrote
    },
  }
}

const eperm = (): NodeJS.ErrnoException => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
/** An error as Node's file system gives one: its code, its (negative) errno, and a message that names a path. */
const sysError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: refused, open '/Users/someone/secret/path'`), { code, errno: -(os.constants.errno as Record<string, number>)[code]! })

/** A save whose new file beside the file cannot be made, for `code`. */
const noNewFile = (code: string) =>
  harness({
    fs: fsWith({
      open: (async (p: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
        if (path.basename(String(p)).startsWith('.kea-save-')) throw sysError(code)
        return fs.promises.open(p, flags, mode)
      }) as FsModule['promises']['open'],
    }),
  })

describe('saving a file from the file view', () => {
  it('U-FV-27 · a save writes only over the version it names, by rename when it keeps the owner and group and in place otherwise (never through a hard link), keeps encoding, byte-order mark, line ending and mode, takes the session’s file-operation slot, writes its new files down in the journal and the sweep removes what a cut-short save left', async () => {
    // the groups each new file is given, as the save asks for them
    const given: number[] = []
    const h = harness({
      fs: fsWith({
        open: (async (p: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
          const fh = await fs.promises.open(p, flags, mode)
          const chown = fh.chown.bind(fh)
          if (path.basename(String(p)).startsWith('.kea-save-')) fh.chown = (uid: number, gid: number) => (given.push(gid), chown(uid, gid))
          return fh
        }) as FsModule['promises']['open'],
      }),
    })

    // ── by rename: the bytes, the mode and the group kept; a new inode; nothing left beside it ──
    put('src/a.ts', 'one\ntwo\n', 0o640)
    // another group of the user's, where one can be given: the new file then starts in another group than the file's
    // (its folder's or the user's) and must be given the file's. A user with one group has no other to give, and there
    // the group the save asks for is what shows it keeps the file's
    for (const g of process.getgroups?.() ?? []) {
      if (g === fs.statSync(at('src/a.ts')).gid) continue
      try {
        fs.chownSync(at('src/a.ts'), -1, g)
        break
      } catch {
        // a group the system does not let the user give
      }
    }
    const before = fs.statSync(at('src/a.ts'))
    const saved = await h.save('src/a.ts', 'one\n2\n')
    expect(saved).toEqual({ kind: 'saved', version: versionOf(Buffer.from('one\n2\n')), size: 6 })
    expect(bytesOf('src/a.ts').toString()).toBe('one\n2\n')
    const after = fs.statSync(at('src/a.ts'))
    expect(after.ino).not.toBe(before.ino)
    expect(after.mode & 0o7777).toBe(0o640)
    expect(given).toEqual([before.gid])
    expect(after.gid).toBe(before.gid)
    expect(temps(at('src'))).toEqual([])
    expect(h.wrote).toBe(1)
    expect(h.held).toBe(false)

    // the same bytes: nothing written, the same version
    const still = fs.statSync(at('src/a.ts'))
    expect(await h.save('src/a.ts', 'one\n2\n')).toEqual({ kind: 'saved', version: versionOf(Buffer.from('one\n2\n')), size: 6 })
    expect(fs.statSync(at('src/a.ts'))).toMatchObject({ ino: still.ino, mtimeMs: still.mtimeMs })
    expect(h.wrote).toBe(1)

    // ── changed: any difference from the named version, with what the file holds now ──
    put('src/b.ts', 'agent wrote this\r\n')
    const stale = await saveFile(cwd, { path: 'src/b.ts', text: 'mine\r\n', base: versionOf(Buffer.from('what the window read\r\n')), eol: 'crlf' }, h.deps)
    expect(stale.kind).toBe('changed')
    const cur = (stale as Extract<SaveResult, { kind: 'changed' }>).current
    expect(cur).toMatchObject({ encoding: 'utf8', invalid: false, eol: 'crlf', version: versionOf(Buffer.from('agent wrote this\r\n')) })
    expect(Buffer.from(cur!.bytes).toString()).toBe('agent wrote this\r\n')
    expect(bytesOf('src/b.ts').toString()).toBe('agent wrote this\r\n')

    // …and a change between the comparison and the rename: the new file goes, the agent's bytes stay, `changed`
    put('src/race.ts', 'v1\n')
    let raced = false
    const racing = harness({
      fs: fsWith({
        lstat: (async (p: fs.PathLike, opts?: fs.StatOptions) => {
          if (!raced && p === at('src/race.ts')) {
            raced = true
            fs.writeFileSync(at('src/race.ts'), 'the agent, mid-save\n')
          }
          return fs.promises.lstat(p, opts)
        }) as FsModule['promises']['lstat'],
      }),
    })
    const r = await racing.save('src/race.ts', 'v2\n')
    expect(raced).toBe(true)
    expect(r).toMatchObject({ kind: 'changed', current: { version: versionOf(Buffer.from('the agent, mid-save\n')) } })
    expect(bytesOf('src/race.ts').toString()).toBe('the agent, mid-save\n')
    expect(temps(at('src'))).toEqual([])
    expect(JSON.parse(fs.readFileSync(racing.journalFile, 'utf8'))).toEqual([])

    // ── what is refused, with nothing written ──
    expect(await h.save('src/none.ts', 'x\n')).toEqual({ kind: 'missing' })
    const outside = path.join(tmp, 'elsewhere.txt')
    fs.writeFileSync(outside, 'not yours\n')
    fs.symlinkSync(outside, at('escape.txt'))
    expect(await saveFile(cwd, { path: 'escape.txt', text: 'x\n', base: versionOf(Buffer.from('not yours\n')), eol: 'lf' }, h.deps)).toEqual({ kind: 'refused', reason: 'outside' })
    expect(fs.readFileSync(outside, 'utf8')).toBe('not yours\n')
    // `.git`, by the path and by a link into it; the read says so too
    put('.git/config', '[core]\n')
    fs.symlinkSync('.git/config', at('cfg'))
    for (const p of ['.git/config', 'cfg', '.GIT/config']) expect(await h.save(p, '[core]\nx\n'), p).toEqual({ kind: 'refused', reason: 'git' })
    expect(await readForEdit(cwd, 'cfg', {})).toMatchObject({ kind: 'text', writable: 'git' })
    expect(bytesOf('.git/config').toString()).toBe('[core]\n')
    // no permission
    put('src/locked.ts', 'locked\n', 0o444)
    expect(await h.save('src/locked.ts', 'unlocked\n')).toEqual({ kind: 'refused', reason: 'permission' })
    expect(await readForEdit(cwd, 'src/locked.ts', {})).toMatchObject({ kind: 'text', writable: 'permission', mode: 0o444 })
    // binary now; a line ending other than the file's, or a text holding another
    put('src/blob.ts', Buffer.from([1, 0, 2]))
    expect(await h.save('src/blob.ts', 'text\n')).toEqual({ kind: 'refused', reason: 'not-text' })
    put('src/crlf.ts', 'a\r\nb\r\n')
    expect(await h.save('src/crlf.ts', 'a\r\nb\r\nc\r\n')).toEqual({ kind: 'refused', reason: 'line-endings' })
    expect(await h.save('src/crlf.ts', 'a\r\nb\nc\r\n', { eol: 'crlf' })).toEqual({ kind: 'refused', reason: 'line-endings' })
    expect(bytesOf('src/crlf.ts').toString()).toBe('a\r\nb\r\n')
    expect(h.wrote).toBe(1)

    // ── the slot: taken by another operation → busy, nothing written; held for the whole save, given back after ──
    h.hold()
    expect(await h.save('src/a.ts', 'busy\n')).toEqual({ kind: 'refused', reason: 'busy' })
    expect(bytesOf('src/a.ts').toString()).toBe('one\n2\n')
    h.let()
    let slotDuring: (() => void) | null | 'unseen' = 'unseen'
    let journalDuring: unknown = null
    const watching = harness({
      fs: fsWith({
        rename: (async (from: fs.PathLike, to: fs.PathLike) => {
          slotDuring = watching.deps.slot()
          journalDuring = JSON.parse(fs.readFileSync(watching.journalFile, 'utf8'))
          return fs.promises.rename(from, to)
        }) as FsModule['promises']['rename'],
      }),
    })
    put('src/slot.ts', 'before\n')
    expect(await watching.save('src/slot.ts', 'after\n')).toMatchObject({ kind: 'saved' })
    expect(slotDuring).toBeNull()
    expect(watching.held).toBe(false)
    // the journal held the new file, with its folder's identity, while it existed; it is empty after
    const folder = fs.statSync(at('src'), { bigint: true })
    expect(journalDuring).toEqual([{ file: expect.stringMatching(/\/src\/\.kea-save-[0-9a-f-]{36}$/), dev: String(folder.dev), ino: String(folder.ino) }])
    expect(JSON.parse(fs.readFileSync(watching.journalFile, 'utf8'))).toEqual([])

    // ── written in place: another owner, another group (`fchown` refused), a read-only folder, a refused rename ──
    const inPlace = async (rel: string, hh: ReturnType<typeof harness>, what: string): Promise<void> => {
      put(rel, `${what} before\n`)
      const ino = fs.statSync(at(rel)).ino
      expect(await hh.save(rel, `${what} after\n`), what).toMatchObject({ kind: 'saved' })
      expect(bytesOf(rel).toString(), what).toBe(`${what} after\n`)
      expect(fs.statSync(at(rel)).ino, what).toBe(ino)
      expect(temps(path.dirname(at(rel))), what).toEqual([])
    }
    await inPlace('src/owner.ts', harness({ uid: me + 1 }), 'another owner')
    const noChown = harness({
      fs: fsWith({
        open: (async (p: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
          const fh = await fs.promises.open(p, flags, mode)
          if (path.basename(String(p)).startsWith('.kea-save-')) fh.chown = () => Promise.reject(eperm())
          return fh
        }) as FsModule['promises']['open'],
      }),
    })
    await inPlace('src/group.ts', noChown, 'another group')
    await inPlace('src/renamed.ts', harness({ fs: fsWith({ rename: () => Promise.reject(eperm()) }) }), 'a refused rename')
    put('ro/file.ts', 'read-only folder before\n')
    fs.linkSync(at('ro/file.ts'), at('ro/other-name.ts'))
    put('ro/plain.ts', 'x\n')
    fs.chmodSync(at('ro'), 0o555)
    await inPlace('ro/plain.ts', h, 'a read-only folder')

    // ── a hard link: in place would change the other name too, so refused; by rename the other name keeps the old bytes ──
    expect(await readForEdit(cwd, 'ro/file.ts', {})).toMatchObject({ kind: 'text', writable: 'hard-linked' })
    expect(await h.save('ro/file.ts', 'changed\n')).toEqual({ kind: 'refused', reason: 'hard-linked' })
    expect(bytesOf('ro/other-name.ts').toString()).toBe('read-only folder before\n')
    fs.chmodSync(at('ro'), 0o755)
    expect(await readForEdit(cwd, 'ro/file.ts', {})).toMatchObject({ kind: 'text', writable: 'yes' })
    expect(await h.save('ro/file.ts', 'changed\n')).toMatchObject({ kind: 'saved' })
    expect(bytesOf('ro/file.ts').toString()).toBe('changed\n')
    expect(bytesOf('ro/other-name.ts').toString()).toBe('read-only folder before\n')

    // ── a symlink inside the folder: its target is written, the link stays a link ──
    put('src/target.ts', 'through a link\n')
    fs.symlinkSync('src/target.ts', at('link.ts'))
    expect(await h.save('link.ts', 'through a link, saved\n')).toMatchObject({ kind: 'saved' })
    expect(fs.lstatSync(at('link.ts')).isSymbolicLink()).toBe(true)
    expect(bytesOf('src/target.ts').toString()).toBe('through a link, saved\n')

    // ── encoding, byte-order mark and line ending kept, byte for byte ──
    const cases: { rel: string; bytes: Buffer; text: string; eol: LineEnding; want: Buffer }[] = [
      { rel: 'enc/le.txt', bytes: encodeText('a\r\nb\r\n', 'utf16le', true), text: 'a\r\nB\r\n', eol: 'crlf', want: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\r\nB\r\n', 'utf16le')]) },
      { rel: 'enc/be.txt', bytes: encodeText('é\n', 'utf16be', true), text: 'é\nü\n', eol: 'lf', want: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('é\nü\n', 'utf16le').swap16()]) },
      { rel: 'enc/bom.txt', bytes: Buffer.from('﻿a\rb\r', 'utf8'), text: 'a\rb\rc', eol: 'cr', want: Buffer.from('﻿a\rb\rc', 'utf8') },
      { rel: 'enc/plain.txt', bytes: Buffer.from('ü'), text: 'üü', eol: 'lf', want: Buffer.from('üü') },
    ]
    for (const c of cases) {
      put(c.rel, c.bytes)
      expect(await saveFile(cwd, { path: c.rel, text: c.text, base: versionOf(c.bytes), eol: c.eol }, h.deps), c.rel).toEqual({ kind: 'saved', version: versionOf(c.want), size: c.want.length })
      expect(bytesOf(c.rel).equals(c.want), c.rel).toBe(true)
    }

    // ── made again where the file was deleted: its mode exactly, its encoding; `changed` when something is there now ──
    const made = await h.save('src/new.ts', 'x\r\n', { create: { encoding: 'utf16le', bom: true, mode: 0o664 }, eol: 'crlf' })
    expect(made).toMatchObject({ kind: 'saved', size: 8 })
    expect(fs.statSync(at('src/new.ts')).mode & 0o7777).toBe(0o664)
    expect(bytesOf('src/new.ts').equals(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x\r\n', 'utf16le')]))).toBe(true)
    expect(await h.save('src/new.ts', 'y\n', { create: { encoding: 'utf8', bom: false, mode: 0o644 } })).toMatchObject({ kind: 'changed', current: { encoding: 'utf16le', eol: 'crlf' } })
    expect(await h.save('gone/new.ts', 'y\n', { create: { encoding: 'utf8', bom: false, mode: 0o644 } })).toEqual({ kind: 'refused', reason: 'no-folder' })

    // every write told the session once (the refresh where nothing watching sees it): src/a.ts, ro/plain.ts,
    // ro/file.ts, the link's target, the encodings and the file made again; refusals, `changed` and the same bytes did not
    expect(h.wrote).toBe(4 + cases.length + 1)
  })

  it('U-FV-27 · refused, with nothing written: text over the not-loaded size once encoded, a file that is no longer text (invalid UTF-8, a FIFO in its place), a file of mixed line endings', async () => {
    const h = harness()
    // within the protocol's length in code units, and over the size once encoded: two bytes a character in UTF-8
    put('refuse/big.txt', 'a\n')
    const wide = 'é'.repeat(Math.floor(L.viewerMaxBytes / 2) + 1)
    expect(await h.save('refuse/big.txt', wide)).toEqual({ kind: 'refused', reason: 'too-large' })
    expect(bytesOf('refuse/big.txt').toString()).toBe('a\n')
    // and made again: two bytes a code unit in UTF-16
    const long = 'x'.repeat(L.viewerMaxBytes / 2)
    expect(await h.save('refuse/made.txt', long, { create: { encoding: 'utf16le', bom: true, mode: 0o644 } })).toEqual({ kind: 'refused', reason: 'too-large' })
    expect(fs.existsSync(at('refuse/made.txt'))).toBe(false)

    // not valid UTF-8 (no NUL, so not binary)
    put('refuse/invalid.txt', Buffer.from([0x61, 0xff, 0xfe, 0x0a]))
    expect(await h.save('refuse/invalid.txt', 'a\n')).toEqual({ kind: 'refused', reason: 'not-text' })
    expect(bytesOf('refuse/invalid.txt').equals(Buffer.from([0x61, 0xff, 0xfe, 0x0a]))).toBe(true)
    // a FIFO where the file was: never opened to wait, never written
    execFileSync('/usr/bin/mkfifo', [at('refuse/pipe.txt')]) // os-ok: in /usr/bin on both systems
    expect(await saveFile(cwd, { path: 'refuse/pipe.txt', text: 'a\n', base: versionOf(Buffer.from('a\n')), eol: 'lf' }, h.deps)).toEqual({ kind: 'refused', reason: 'not-text' })
    expect(fs.lstatSync(at('refuse/pipe.txt')).isFIFO()).toBe(true)

    // mixed line endings: no one ending a save could keep
    put('refuse/mixed.txt', 'a\r\nb\nc\r\n')
    for (const eol of ['lf', 'crlf', 'mixed'] as const) expect(await h.save('refuse/mixed.txt', 'a\nb\n', { eol }), eol).toEqual({ kind: 'refused', reason: 'line-endings' })
    expect(bytesOf('refuse/mixed.txt').toString()).toBe('a\r\nb\nc\r\n')
    expect(h.wrote).toBe(0)
    expect(temps(at('refuse'))).toEqual([])
  })

  it('U-FV-27 · written in place, a file that changed after the comparison is read and compared once more: other bytes answer changed with them; a second change answers changed, nothing written either time', async () => {
    let opens = 0
    /** Another owner's file (so written in place), and what happens to it each time the save opens it to write. */
    const agent = (rel: string, meanwhile: () => void) =>
      harness({
        uid: me + 1,
        fs: fsWith({
          open: (async (p: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
            if (p === at(rel) && typeof flags === 'number' && (flags & fs.constants.O_WRONLY) !== 0) {
              opens++
              meanwhile()
            }
            return fs.promises.open(p, flags, mode)
          }) as FsModule['promises']['open'],
        }),
      })

    put('again/a.ts', 'v1\n')
    const r = await agent('again/a.ts', () => fs.writeFileSync(at('again/a.ts'), 'the agent’s\n')).save('again/a.ts', 'v2\n')
    expect(r).toMatchObject({ kind: 'changed', current: { version: versionOf(Buffer.from('the agent’s\n')) } })
    expect(bytesOf('again/a.ts').toString()).toBe('the agent’s\n')
    expect(opens).toBe(1)

    // the same bytes, touched each time: compared again, found the same, touched again, so `changed`
    opens = 0
    put('again/b.ts', 'v1\n')
    let day = 1
    const touched = await agent('again/b.ts', () => fs.utimesSync(at('again/b.ts'), new Date(2001, 0, day), new Date(2001, 0, day++))).save('again/b.ts', 'v2\n')
    expect(touched).toMatchObject({ kind: 'changed', current: { version: versionOf(Buffer.from('v1\n')) } })
    expect(bytesOf('again/b.ts').toString()).toBe('v1\n')
    expect(opens).toBe(2)
  })

  it('U-FV-27 · made again: refused permission in a folder the user may not write; refused git through a link to a folder inside .git, as is a save of a file there', async () => {
    const h = harness()
    fs.mkdirSync(at('locked'))
    fs.chmodSync(at('locked'), 0o555)
    expect(await h.save('locked/new.ts', 'x\n', { create: { encoding: 'utf8', bom: false, mode: 0o644 } })).toEqual({ kind: 'refused', reason: 'permission' })
    expect(fs.readdirSync(at('locked'))).toEqual([])

    put('nested/.git/HEAD', 'ref: refs/heads/main\n')
    fs.symlinkSync('nested/.git', at('gitdir'))
    expect(await h.save('gitdir/HEAD', 'ref: refs/heads/other\n')).toEqual({ kind: 'refused', reason: 'git' })
    expect(await h.save('gitdir/new', 'x\n', { create: { encoding: 'utf8', bom: false, mode: 0o644 } })).toEqual({ kind: 'refused', reason: 'git' })
    expect(bytesOf('nested/.git/HEAD').toString()).toBe('ref: refs/heads/main\n')
    expect(fs.readdirSync(at('nested/.git'))).toEqual(['HEAD'])
    expect(h.wrote).toBe(0)
  })

  it('U-FV-27 · a new file that cannot be made beside the file falls to writing in place, but a full disk, a used-up quota or a disk error answers io: writing in place truncates first and could leave the file torn', async () => {
    for (const code of ['ENAMETOOLONG', 'EACCES', 'EPERM', 'EINVAL', 'EEXIST']) {
      const rel = `fall/${code}.ts`
      put(rel, 'before\n')
      const ino = fs.statSync(at(rel)).ino
      const h = noNewFile(code)
      expect(await h.save(rel, 'after\n'), code).toMatchObject({ kind: 'saved' })
      expect(bytesOf(rel).toString(), code).toBe('after\n')
      expect(fs.statSync(at(rel)).ino, code).toBe(ino)
      expect(JSON.parse(fs.readFileSync(h.journalFile, 'utf8')), code).toEqual([])
    }
    for (const [code, words] of [['ENOSPC', 'the disk is full'], ['EDQUOT', 'the disk quota is used up'], ['EIO', 'the disk could not be read or written']] as const) {
      const rel = `fall/${code}.ts`
      put(rel, 'before\n')
      expect(await noNewFile(code).save(rel, 'after\n'), code).toEqual({ kind: 'refused', reason: 'io', detail: words })
      expect(bytesOf(rel).toString(), code).toBe('before\n')
    }
    expect(temps(at('fall'))).toEqual([])
  })

  it('U-FV-27 · a write the disk refuses part-way leaves no torn file: in place the file’s previous bytes are written back, a file made again is removed (not one put in its place meanwhile), and the answer is io with the disk’s words, even when the bytes cannot be put back', async () => {
    /**
     * A save whose writes to `rel` stop part-way: the first writes three bytes, the second fails with `code` (after
     * `meanwhile`), and the ones after it, which put the bytes back, fail with EIO unless `back`.
     */
    const cut = (rel: string, code: string, back: boolean, meanwhile = (): void => undefined) =>
      harness({
        // another owner's file, so written in place
        uid: me + 1,
        fs: fsWith({
          open: (async (p: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
            const fh = await fs.promises.open(p, flags, mode)
            if (p !== at(rel) || typeof flags !== 'number' || (flags & fs.constants.O_WRONLY) === 0) return fh
            const write = fh.write.bind(fh) as (b: Uint8Array, off: number, len: number, pos: number) => Promise<{ bytesWritten: number }>
            let calls = 0
            fh.write = (async (b: Uint8Array, off: number, len: number, pos: number) => {
              calls++
              if (calls === 1) return write(b, off, Math.min(len, 3), pos)
              if (calls === 2) {
                meanwhile()
                throw sysError(code)
              }
              if (!back) throw sysError('EIO')
              return write(b, off, len, pos)
            }) as FileHandle['write']
            return fh
          }) as FsModule['promises']['open'],
        }),
      })
    const full = { kind: 'refused', reason: 'io', detail: 'the disk is full' }

    // in place: the previous bytes back, at their length (shorter than what the cut write left)
    put('cut/a.ts', 'v\n')
    const ino = fs.statSync(at('cut/a.ts')).ino
    expect(await cut('cut/a.ts', 'ENOSPC', true).save('cut/a.ts', 'one\ntwo\nthree\n')).toEqual(full)
    expect(bytesOf('cut/a.ts').toString()).toBe('v\n')
    expect(fs.statSync(at('cut/a.ts')).ino).toBe(ino)
    // the bytes cannot be put back either: the answer is still the first refusal
    put('cut/b.ts', 'before\n')
    expect(await cut('cut/b.ts', 'ENOSPC', false).save('cut/b.ts', 'after, and longer\n')).toEqual(full)

    // made again: the file it made is removed, so the window still holds the only copy of the text
    const create = { create: { encoding: 'utf8', bom: false, mode: 0o644 } } as const
    expect(await cut('cut/new.ts', 'ENOSPC', true).save('cut/new.ts', 'made again\n', create)).toEqual(full)
    expect(fs.existsSync(at('cut/new.ts'))).toBe(false)
    // …but a file another writer put in its place meanwhile is theirs, and stays
    const theirs = () => {
      fs.writeFileSync(at('cut/agent.tmp'), 'the agent’s\n')
      fs.renameSync(at('cut/agent.tmp'), at('cut/other.ts'))
    }
    expect(await cut('cut/other.ts', 'ENOSPC', true, theirs).save('cut/other.ts', 'mine\n', create)).toEqual(full)
    expect(bytesOf('cut/other.ts').toString()).toBe('the agent’s\n')
  })

  it('U-FV-27 · an io refusal says what the file system said in plain words within the detail cap, never an errno’s code or a path; a failure with no errno carries no words', async () => {
    put('src/xdev.ts', 'x\n')
    const h = harness({ fs: fsWith({ rename: () => Promise.reject(sysError('EXDEV')) }) })
    expect(await h.save('src/xdev.ts', 'y\n')).toEqual({ kind: 'refused', reason: 'io', detail: 'cross-device link not permitted' })
    expect(bytesOf('src/xdev.ts').toString()).toBe('x\n')
    expect(temps(at('src'))).toEqual([])
    // every errno this system has: words, never its code, a path or libuv's "Unknown system error -n", within the cap
    for (const code of Object.keys(os.constants.errno)) {
      const words = ioDetail(sysError(code))
      expect(words, code).toBeTruthy()
      expect(words!.length, code).toBeLessThanOrEqual(L.viewerSaveDetailMaxChars)
      expect(words, code).not.toMatch(/\bE[A-Z0-9]{2,}\b|\/|Unknown system error/)
    }
    // a code alone, as a wrapped file system may give it, is put in words too
    expect(ioDetail(Object.assign(new Error('x'), { code: 'EXDEV' }))).toBe('cross-device link not permitted')
    // an error that is not the file system's: its message is not the user's to read
    const odd = harness({ fs: fsWith({ rename: () => Promise.reject(new Error('/Users/someone/secret: a bug')) }) })
    expect(await odd.save('src/xdev.ts', 'y\n')).toEqual({ kind: 'refused', reason: 'io' })
    expect(ioDetail('a string')).toBeUndefined()
  })

  it('U-FV-27 · a read says hard-linked exactly when a save refuses it: a file of the user’s whose group is not one of theirs is written in place, since a new file could not take that group; a second name made just before the write is refused too', async () => {
    put('grp/file.ts', 'linked\n')
    fs.linkSync(at('grp/file.ts'), at('grp/other-name.ts'))
    put('grp/single.ts', 'single\n')
    const gid = fs.statSync(at('grp/file.ts')).gid
    const notTheirs = { uid: me, groups: new Set([gid + 1]) }
    const theirs = { uid: me, groups: new Set([gid]) }
    const writable = async (rel: string, user: { uid: number; groups: ReadonlySet<number> }) => writableOf(fs, rel, await resolveInside(cwd, rel), fs.statSync(at(rel)), user)

    // not one of the user's groups: the read says hard-linked, and the save refuses it, the other name unchanged
    expect(await writable('grp/file.ts', notTheirs)).toBe('hard-linked')
    expect(await harness({ groups: notTheirs.groups }).save('grp/file.ts', 'changed\n')).toEqual({ kind: 'refused', reason: 'hard-linked' })
    expect(bytesOf('grp/file.ts').toString()).toBe('linked\n')
    // a file with one name is written in place, its inode and group kept
    expect(await writable('grp/single.ts', notTheirs)).toBe('yes')
    const ino = fs.statSync(at('grp/single.ts')).ino
    expect(await harness({ groups: notTheirs.groups }).save('grp/single.ts', 'single, saved\n')).toMatchObject({ kind: 'saved' })
    expect(fs.statSync(at('grp/single.ts'))).toMatchObject({ ino, gid })
    // a second name made between the comparison and the write (which moves neither size nor modification time):
    // refused all the same, both names unchanged
    put('grp/late.ts', 'late\n')
    const linking = harness({
      groups: notTheirs.groups,
      fs: fsWith({
        open: (async (p: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
          if (p === at('grp/late.ts') && typeof flags === 'number' && (flags & fs.constants.O_WRONLY) !== 0) fs.linkSync(at('grp/late.ts'), at('grp/late-other.ts'))
          return fs.promises.open(p, flags, mode)
        }) as FsModule['promises']['open'],
      }),
    })
    expect(await linking.save('grp/late.ts', 'late, saved\n')).toEqual({ kind: 'refused', reason: 'hard-linked' })
    expect(bytesOf('grp/late.ts').toString()).toBe('late\n')
    expect(bytesOf('grp/late-other.ts').toString()).toBe('late\n')
    // one of theirs: the read says yes, and the save renames, the other name keeping the old bytes
    expect(await writable('grp/file.ts', theirs)).toBe('yes')
    expect(await harness({ groups: theirs.groups }).save('grp/file.ts', 'changed\n')).toMatchObject({ kind: 'saved' })
    expect(bytesOf('grp/file.ts').toString()).toBe('changed\n')
    expect(bytesOf('grp/other-name.ts').toString()).toBe('linked\n')
  })

  it('U-FV-27 · the save journal: a save writes it before its new file exists, keeps what it held at launch (to its cap, counted in its size) until the sweep, and the sweep removes a new file a save cut short, leaving an entry whose folder changed and a name not a save’s', async () => {
    const dir = path.join(tmp, 'sweep')
    fs.mkdirSync(path.join(dir, 'kept'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'moved'))
    const journalFile = path.join(home, 'sweep-journal.json')
    const left = path.join(dir, 'kept', '.kea-save-0b6d3f1e-2f3a-4c5d-8e9f-0a1b2c3d4e5f')
    const notOurs = path.join(dir, 'kept', 'notes.txt')
    const inMoved = path.join(dir, 'moved', '.kea-save-1b6d3f1e-2f3a-4c5d-8e9f-0a1b2c3d4e5f')
    fs.writeFileSync(left, 'cut short')
    fs.writeFileSync(notOurs, 'the user’s')
    const kept = fs.statSync(path.join(dir, 'kept'), { bigint: true })
    const was = fs.statSync(path.join(dir, 'moved'), { bigint: true })
    // the folder of the third entry is another folder now, under the same name
    fs.rmSync(path.join(dir, 'moved'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'other-first'))
    fs.mkdirSync(path.join(dir, 'moved'))
    fs.writeFileSync(inMoved, 'someone else’s')
    expect(fs.statSync(path.join(dir, 'moved')).ino).not.toBe(Number(was.ino))
    const entries = [
      { file: left, dev: String(kept.dev), ino: String(kept.ino) },
      { file: notOurs, dev: String(kept.dev), ino: String(kept.ino) },
      { file: inMoved, dev: String(was.dev), ino: String(was.ino) },
    ]
    fs.writeFileSync(journalFile, JSON.stringify(entries))

    // a save before the sweep: the journal it writes still names what was there at launch, and its size counts them
    const h = harness({ journal: journalFile })
    expect(h.journal.size).toBe(entries.length)
    put('src/early.ts', 'early\n')
    expect(await h.save('src/early.ts', 'early, saved\n')).toMatchObject({ kind: 'saved' })
    expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toEqual(entries)
    expect(h.journal.size).toBe(entries.length)

    await h.journal.sweep()
    expect(fs.existsSync(left)).toBe(false)
    expect(fs.readFileSync(notOurs, 'utf8')).toBe('the user’s')
    expect(fs.readFileSync(inMoved, 'utf8')).toBe('someone else’s')
    expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toEqual([])
    expect(h.journal.size).toBe(0)

    // a journal that is not JSON is dropped, not trusted; none at all is not made by a sweep
    fs.writeFileSync(journalFile, '{ not json')
    await harness({ journal: journalFile }).journal.sweep()
    expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toEqual([])
    const fresh = path.join(home, 'never-written.json')
    await harness({ journal: fresh }).journal.sweep()
    expect(fs.existsSync(fresh)).toBe(false)

    // what it held at launch is kept up to its cap, the rest dropped with a warning
    const many = Array.from({ length: L.viewerSaveJournalMax + 3 }, (_, i) => ({ file: path.join(dir, `not-a-temp-${i}`), dev: '1', ino: String(i) }))
    fs.writeFileSync(journalFile, JSON.stringify(many))
    const capped = harness({ journal: journalFile })
    expect(capped.journal.size).toBe(L.viewerSaveJournalMax)
    expect(capped.log.entries).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'save journal over its cap: the rest are dropped', dropped: 3 }))
    await capped.journal.sweep()
    expect(capped.journal.size).toBe(0)
    expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toEqual([])
  })

  it('U-FV-27 · the bytes of a file read short and of a text encoded for a save are each a buffer of their own, so a file’s text never stays in Node’s shared pool', async () => {
    const own = (b: Buffer) => b.buffer.byteLength === b.length
    // a file that shrank after its size was taken: the read stops at its end
    const short = { read: async (buf: Buffer, off: number) => ({ bytesRead: off === 0 ? (buf.write('secret', 0), 6) : 0 }) }
    const got = await readUpTo(short as unknown as Parameters<typeof readUpTo>[0], 64)
    expect(got.toString()).toBe('secret')
    expect(own(got)).toBe(true)
    for (const [encoding, bom] of [['utf8', false], ['utf8', true], ['utf16le', true], ['utf16be', true]] as const) expect(own(encodeText('secret', encoding, bom)), `${encoding} ${bom}`).toBe(true)
  })
})
