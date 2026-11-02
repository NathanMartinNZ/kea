// Saving a file from the file view: the user's text written back over exactly the bytes it was edited from.
//
// A save names the version it replaces (the SHA-256 of the bytes the window read) and writes only while the file still
// hashes to it; otherwise it answers `changed` with what the file holds now, and the window merges that and asks again.
// The text is encoded as the file is: its encoding, its byte-order mark, its one line ending.
//
// Two ways to write. By rename: a new file beside it (`.kea-save-<uuid>`, given the file's mode and group, synced) is
// renamed over it, so a reader, or a crash, finds the old bytes or the new, never a mix. A rename keeps no xattrs,
// Finder tags or ACLs, and breaks a hard link (the other names keep the old bytes). It is used when the file is the
// user's, its group one of theirs and its folder the user's to write in. Otherwise, or when the new file cannot be made
// or given the group, or the rename is refused, the file is written in place (truncated, then written): its owner,
// group, xattrs and other names stay; a write that fails part-way puts the previous bytes back, but a crash can leave
// the file torn; never through a hard link, whose other names would change too, nor where the disk refused the new file
// for want of space or by failing. A file made again that cannot be written is removed.
//
// Each new file is written down in the save journal (`<KEA_HOME>/save-journal.json`) before it is made and taken off
// once it is renamed or removed; at launch core removes what a save cut short left behind (`SaveJournal.sweep`).
//
// A save is one of the session's file operations: it holds the slot a tree operation or a discard takes, so none of
// them overlap. The moment between the last look at the file and `rename(2)` or the truncate is open to another writer;
// agents run as the same user, so that gives them nothing they lack. Nothing of the text or the bytes is kept after the
// answer.

import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getSystemErrorMessage } from 'node:util'
import { atomicWrite, type Logger } from '@kea/kit'
import { hasGitSegment, L, type LineEnding, type SaveArgs, type SaveRefusal, type SaveResult, type TextEncoding } from '@kea/protocol'
import type { FsModule } from '../files/fsImpl.ts'
import { bomEncoding, detect } from './detect.ts'
import { inGitDir, readUpTo, resolveInside, savesByRename, versionOf } from './read.ts'

const TEMP_PREFIX = '.kea-save-'
/** A new file's name: the prefix and a UUID. The sweep removes nothing else. */
const TEMP_NAME = /^\.kea-save-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code

/** What an error from the file system means to the user, where the system's own words say it less plainly. */
const WORDS: Readonly<Record<string, string>> = {
  EACCES: 'permission denied',
  EPERM: 'the system does not permit it',
  EROFS: 'the volume is read-only',
  ENOSPC: 'the disk is full',
  EDQUOT: 'the disk quota is used up',
  EIO: 'the disk could not be read or written',
  EBUSY: 'it is in use',
  ENAMETOOLONG: 'the name is too long for this volume',
  ESTALE: 'the network volume no longer has the file',
  ENOTSUP: 'the volume does not support it',
  EOPNOTSUPP: 'the volume does not support it',
}

/** Words for an errno the system's table does not name. */
const UNNAMED = 'the file system refused it'

const ERRNO = os.constants.errno as Readonly<Record<string, number | undefined>>

/**
 * The words an `io` refusal carries: the errno's, in plain words (never its code, nor the message, which names paths).
 * None for an error that is not the file system's: its text is not the user's to read.
 */
export function ioDetail(e: unknown): string | undefined {
  const err = typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException) : null
  const code = err?.code
  const plain = code !== undefined ? WORDS[code] : undefined
  if (plain !== undefined) return plain
  const errno = typeof err?.errno === 'number' ? err.errno : code !== undefined ? ERRNO[code] : undefined
  if (errno === undefined || errno === 0) return undefined
  try {
    // libuv's words, which Node's errors carry before the path; an errno libuv has none for is "Unknown system error"
    const words = getSystemErrorMessage(-Math.abs(errno))
    return words.startsWith('Unknown system error') ? UNNAMED : words
  } catch {
    return UNNAMED
  }
}

const refused = (reason: SaveRefusal, detail?: string): SaveResult => (detail ? { kind: 'refused', reason, detail: detail.slice(0, L.viewerSaveDetailMaxChars) } : { kind: 'refused', reason })

const io = (e: unknown): SaveResult => refused('io', ioDetail(e))

/**
 * A new file that cannot be made beside the file for these is not written in place either: writing in place truncates
 * the file first, so a full disk, a used-up quota or a failing disk could leave it torn.
 */
const TEARS_IN_PLACE: readonly string[] = ['ENOSPC', 'EDQUOT', 'EIO']

// ── the journal ────────────────────────────────────────────────────────────────────────────────────────────────────

interface JournalEntry {
  /** The new file's path. */
  file: string
  /** Its folder's identity when it was written down, as decimal strings (an inode number can pass 2^53). */
  dev: string
  ino: string
}

const isEntry = (x: unknown): x is JournalEntry => {
  const e = x as Partial<JournalEntry> | null
  return typeof e === 'object' && e !== null && typeof e.file === 'string' && typeof e.dev === 'string' && typeof e.ino === 'string'
}

export interface SaveJournalOptions {
  /** `<KEA_HOME>/save-journal.json`. */
  file: string
  log: Logger
  /** The `fs` for paths in a session's folder (files/fsImpl.ts). */
  fs: FsModule
  /** The user core runs as: the sweep removes only files of theirs. */
  uid: number
}

/**
 * The save journal: the new files saves have made and not yet renamed or removed. One per `KEA_HOME`, held by its one
 * core. What it held at launch (saves cut short) stays in it until `sweep` has removed those files.
 */
export class SaveJournal {
  private readonly o: SaveJournalOptions
  // bounded: one per save between making its new file and renaming or removing it; a save holds its session's
  // file-operation slot, so one per session at most
  private readonly entries = new Map<string, JournalEntry>()
  // bounded: L.viewerSaveJournalMax entries of what the journal held at launch (the rest dropped), emptied by `sweep`
  private left: JournalEntry[]
  private onDisk: boolean
  private writing: Promise<void> = Promise.resolve()

  constructor(o: SaveJournalOptions) {
    this.o = o
    let text: string | null = null
    try {
      text = o.fs.readFileSync(o.file, 'utf8')
    } catch (e) {
      if (codeOf(e) !== 'ENOENT') o.log.warn('save journal unreadable', { error: codeOf(e) ?? String(e) })
    }
    this.onDisk = text !== null
    let parsed: unknown = []
    try {
      parsed = text === null ? [] : JSON.parse(text)
    } catch {
      o.log.warn('save journal is not JSON: its entries are dropped')
    }
    const left = Array.isArray(parsed) ? parsed.filter(isEntry) : []
    if (left.length > L.viewerSaveJournalMax) o.log.warn('save journal over its cap: the rest are dropped', { dropped: left.length - L.viewerSaveJournalMax })
    this.left = left.slice(0, L.viewerSaveJournalMax)
  }

  /** The new files written down now: saves' in flight, and until the sweep what the journal held at launch. */
  get size(): number {
    return this.entries.size + this.left.length
  }

  /** Write down a new file before it is made, with its folder's identity. Rejects when the journal cannot be written. */
  async add(file: string, folder: BigIntStats): Promise<void> {
    this.entries.set(file, { file, dev: String(folder.dev), ino: String(folder.ino) })
    try {
      await this.write()
    } catch (e) {
      this.entries.delete(file)
      throw e
    }
  }

  /** The new file is renamed or removed. A journal that cannot be written keeps the entry for the next sweep. */
  async drop(file: string): Promise<void> {
    if (!this.entries.delete(file)) return
    await this.write().catch((e: unknown) => this.o.log.warn('save journal not written', { error: codeOf(e) ?? String(e) }))
  }

  /**
   * At launch: remove each new file a save cut short left (its folder still the one written down, its name a new
   * file's, a regular file of the user's), then empty the journal of them. Never rejects.
   */
  async sweep(): Promise<void> {
    const left = this.left
    let removed = 0
    for (const e of left) {
      try {
        if (!TEMP_NAME.test(path.basename(e.file))) continue
        const dir = await this.o.fs.promises.lstat(path.dirname(e.file), { bigint: true })
        if (!dir.isDirectory() || String(dir.dev) !== e.dev || String(dir.ino) !== e.ino) continue
        const st = await this.o.fs.promises.lstat(e.file, { bigint: true })
        if (!st.isFile() || Number(st.uid) !== this.o.uid) continue
        await this.o.fs.promises.unlink(e.file)
        removed++
      } catch {
        // gone already, or its folder is: nothing to remove
      }
    }
    this.left = []
    if (left.length > 0) this.o.log.info('save journal swept', { entries: left.length, removed })
    if (this.onDisk || this.entries.size > 0) await this.write().catch((e: unknown) => this.o.log.warn('save journal not emptied', { error: codeOf(e) ?? String(e) }))
  }

  /** One write at a time, each of everything written down when it runs. */
  private write(): Promise<void> {
    const next = this.writing.then(async () => {
      await atomicWrite(this.o.file, JSON.stringify([...this.left, ...this.entries.values()]), { mode: 0o600 })
      this.onDisk = true
    })
    this.writing = next.catch(() => undefined)
    return next
  }
}

// ── saving ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SaveDeps {
  /** The `fs` for paths in a session's folder (files/fsImpl.ts). */
  fs: FsModule
  /** The user core runs as: a file of another owner is written in place. */
  uid: number
  /** The user's groups: a file of another group is written in place. */
  groups: ReadonlySet<number>
  journal: SaveJournal
  /** Take the session's file-operation slot: its release, or null while another operation holds it. */
  slot(): (() => void) | null
  /** The file was written: the session reads its tree and status again where nothing watching would tell it. */
  wrote(): void
}

export type SaveRequest = Pick<SaveArgs, 'path' | 'text' | 'base' | 'eol' | 'create'>

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16BE_BOM = Buffer.from([0xfe, 0xff])

/**
 * `text` as bytes in `encoding`, with its byte-order mark when `bom`. In a buffer of its own: `Buffer.from` and
 * `Buffer.concat` put a small file's bytes in Node's shared pool, whose slab is reused but never cleared, so the
 * text would stay in core after the save.
 */
export function encodeText(text: string, encoding: TextEncoding, bom: boolean): Buffer {
  const mark = !bom ? null : encoding === 'utf8' ? UTF8_BOM : encoding === 'utf16le' ? UTF16LE_BOM : UTF16BE_BOM
  const as = encoding === 'utf8' ? 'utf8' : 'utf16le'
  const at = mark?.length ?? 0
  const out = Buffer.allocUnsafeSlow(at + Buffer.byteLength(text, as))
  mark?.copy(out, 0)
  out.write(text, at, as)
  if (encoding === 'utf16be') out.subarray(at).swap16()
  return out
}

/** `text` holds no line ending other than `eol`. */
export function onlyEnding(text: string, eol: LineEnding): boolean {
  switch (eol) {
    case 'lf':
      return !text.includes('\r')
    case 'cr':
      return !text.includes('\n')
    case 'crlf':
      return !/\r(?!\n)|(?<!\r)\n/.test(text)
    case 'mixed':
      return false
  }
}

const O_READ = (f: FsModule) => f.constants.O_RDONLY | f.constants.O_NOFOLLOW | f.constants.O_NONBLOCK
const sameFile = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs

type Current = { kind: 'gone' } | { kind: 'denied' } | { kind: 'other' } | { kind: 'large' } | { kind: 'file'; st: BigIntStats; bytes: Buffer<ArrayBuffer>; version: string }

/** What is at `real` now: a regular file within L.viewerMaxBytes read whole, or why not. */
async function current(f: FsModule, real: string): Promise<Current> {
  let fh: FileHandle
  try {
    fh = await f.promises.open(real, O_READ(f))
  } catch (e) {
    const code = codeOf(e)
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'gone' }
    // anything else is not a file a save writes: a link put there since (ELOOP), a socket
    return code === 'EACCES' || code === 'EPERM' ? { kind: 'denied' } : { kind: 'other' }
  }
  try {
    const st = await fh.stat({ bigint: true })
    if (!st.isFile()) return { kind: 'other' }
    if (st.size > BigInt(L.viewerMaxBytes)) return { kind: 'large' }
    const bytes = await readUpTo(fh, Number(st.size))
    return { kind: 'file', st, bytes, version: versionOf(bytes) }
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/** `changed`, with what is there now when it is text the viewer reads. */
function changed(cur: Current): SaveResult {
  if (cur.kind === 'gone') return { kind: 'missing' }
  if (cur.kind !== 'file') return { kind: 'changed', current: null }
  const d = detect(cur.bytes)
  return { kind: 'changed', current: d.binary ? null : { bytes: cur.bytes, encoding: d.encoding, invalid: d.invalid, eol: d.eol, version: cur.version } }
}

async function writeAll(fh: FileHandle, bytes: Uint8Array): Promise<void> {
  let n = 0
  while (n < bytes.length) n += (await fh.write(bytes, n, bytes.length - n, n)).bytesWritten
}

/** Sync a folder, so a rename in it lasts; a volume that cannot sync a folder leaves the rename as it is. */
async function syncFolder(f: FsModule, dir: string): Promise<void> {
  try {
    const fh = await f.promises.open(dir, f.constants.O_RDONLY)
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }
  } catch {
    // the rename is done either way
  }
}

/**
 * How one way of writing ended: written; not written, and what comes next (`in-place`: write in place instead; `moved`:
 * the file is not the one compared, so it is read again); or not written, with the answer.
 */
type Attempt = { done: true } | { done: false; next: 'in-place' | 'moved' } | { done: false; result: SaveResult }

/** By rename: a new file beside `real`, then renamed over it. */
async function byRename(d: SaveDeps, real: string, was: BigIntStats, bytes: Buffer): Promise<Attempt> {
  const f = d.fs
  const folder = path.dirname(real)
  const temp = path.join(folder, `${TEMP_PREFIX}${randomUUID()}`)
  try {
    await d.journal.add(temp, await f.promises.lstat(folder, { bigint: true }))
  } catch (e) {
    return { done: false, result: io(e) }
  }
  let made = false
  try {
    let fh: FileHandle
    try {
      fh = await f.promises.open(temp, f.constants.O_CREAT | f.constants.O_EXCL | f.constants.O_WRONLY | f.constants.O_NOFOLLOW, 0o600)
    } catch (e) {
      // a new file that cannot be made here (an ACL, a name too long for the volume) is written in place instead
      const code = codeOf(e)
      return code !== undefined && TEARS_IN_PLACE.includes(code) ? { done: false, result: io(e) } : { done: false, next: 'in-place' }
    }
    made = true
    try {
      await writeAll(fh, bytes)
      // the group first: a change of group can clear the set-id bits the mode then puts back
      try {
        await fh.chown(-1, Number(was.gid))
      } catch (e) {
        if (codeOf(e) === 'EPERM') return { done: false, next: 'in-place' }
        throw e
      }
      await fh.chmod(Number(was.mode) & 0o7777)
      await fh.sync()
    } finally {
      await fh.close().catch(() => undefined)
    }
    // still the file whose bytes were compared
    let now: BigIntStats | null = null
    try {
      now = await f.promises.lstat(real, { bigint: true })
    } catch {
      // gone
    }
    if (!now || !sameFile(now, was)) return { done: false, next: 'moved' }
    try {
      await f.promises.rename(temp, real)
    } catch (e) {
      const code = codeOf(e)
      return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' ? { done: false, next: 'in-place' } : { done: false, result: io(e) }
    }
    made = false
    await syncFolder(f, folder)
    return { done: true }
  } catch (e) {
    return { done: false, result: io(e) }
  } finally {
    if (made) await f.promises.unlink(temp).catch(() => undefined)
    await d.journal.drop(temp)
  }
}

/**
 * In place: the same file truncated and written. A write that fails once the file is truncated puts `before` (the bytes
 * compared) back where it can, so the file is not left torn: the window would read a cut file as the file's own change
 * and drop the lines after the cut from the document.
 */
async function inPlace(d: SaveDeps, real: string, was: BigIntStats, bytes: Buffer, before: Buffer): Promise<Attempt> {
  const f = d.fs
  // refused before the file is opened to write, and again below on the file as opened
  if (Number(was.nlink) > 1) return { done: false, result: refused('hard-linked') }
  let fh: FileHandle
  try {
    fh = await f.promises.open(real, f.constants.O_WRONLY | f.constants.O_NOFOLLOW | f.constants.O_NONBLOCK)
  } catch (e) {
    const code = codeOf(e)
    if (code === 'EACCES' || code === 'EPERM') return { done: false, result: refused('permission') }
    // something else is there since: read again
    return code === 'ENOENT' || code === 'ELOOP' || code === 'ENXIO' || code === 'EISDIR' ? { done: false, next: 'moved' } : { done: false, result: io(e) }
  }
  let touched = false
  try {
    const now = await fh.stat({ bigint: true })
    if (!sameFile(now, was)) return { done: false, next: 'moved' }
    // a second name made since the comparison moves neither the size nor the modification time
    if (Number(now.nlink) > 1) return { done: false, result: refused('hard-linked') }
    touched = true
    await fh.truncate(0)
    await writeAll(fh, bytes)
    await fh.sync()
    return { done: true }
  } catch (e) {
    if (touched) {
      try {
        await writeAll(fh, before)
        await fh.truncate(before.length)
        await fh.sync()
      } catch {
        // the answer is the failure either way
      }
    }
    return { done: false, result: io(e) }
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/** Replace the file at `real`, which must still hash to `base`. */
async function replace(d: SaveDeps, real: string, req: SaveRequest): Promise<SaveResult> {
  // the file changing between the comparison and the write is looked at once more; a second time is `changed`
  let again = false
  for (;;) {
    const cur = await current(d.fs, real)
    if (cur.kind === 'gone') return { kind: 'missing' }
    if (cur.kind === 'denied') return refused('permission')
    if (cur.kind === 'other') return refused('not-text')
    if (cur.kind === 'large' || cur.version !== req.base) return changed(cur)
    const det = detect(cur.bytes)
    if (det.binary || det.invalid) return refused('not-text')
    if (det.eol === 'mixed' || det.eol !== req.eol || !onlyEnding(req.text, req.eol)) return refused('line-endings')
    const bytes = encodeText(req.text, det.encoding, bomEncoding(cur.bytes) !== null)
    if (bytes.length > L.viewerMaxBytes) return refused('too-large')
    if (bytes.equals(cur.bytes)) return { kind: 'saved', version: cur.version, size: bytes.length }
    if (!(await d.fs.promises.access(real, d.fs.constants.W_OK).then(() => true, () => false))) return refused('permission')
    let r: Attempt = (await savesByRename(d.fs, real, { uid: Number(cur.st.uid), gid: Number(cur.st.gid) }, d)) ? await byRename(d, real, cur.st, bytes) : { done: false, next: 'in-place' }
    if (!r.done && 'next' in r && r.next === 'in-place') r = await inPlace(d, real, cur.st, bytes, cur.bytes)
    if (r.done) {
      d.wrote()
      return { kind: 'saved', version: versionOf(bytes), size: bytes.length }
    }
    if ('result' in r) return r.result
    if (again) return changed(await current(d.fs, real))
    again = true
  }
}

/** Make the file again where nothing is, in its folder inside the working directory; removed again when it cannot be written. */
async function create(d: SaveDeps, cwd: string, req: SaveRequest & { create: NonNullable<SaveRequest['create']> }): Promise<SaveResult> {
  const f = d.fs
  const slash = req.path.lastIndexOf('/')
  const dirRel = slash < 0 ? '' : req.path.slice(0, slash)
  const name = req.path.slice(slash + 1)
  const folder = await resolveInside(cwd, dirRel)
  if (folder.state === 'outside') return refused('outside')
  if (folder.state === 'missing') return refused('no-folder')
  if (folder.link !== null && hasGitSegment(folder.link)) return refused('git')
  const isDir = await f.promises.lstat(folder.real).then((st) => st.isDirectory(), () => false)
  if (!isDir) return refused('no-folder')
  if (req.eol === 'mixed' || !onlyEnding(req.text, req.eol)) return refused('line-endings')
  const bytes = encodeText(req.text, req.create.encoding, req.create.bom)
  if (bytes.length > L.viewerMaxBytes) return refused('too-large')
  const real = path.join(folder.real, name)
  let fh: FileHandle
  try {
    fh = await f.promises.open(real, f.constants.O_CREAT | f.constants.O_EXCL | f.constants.O_WRONLY | f.constants.O_NOFOLLOW | f.constants.O_NONBLOCK, req.create.mode)
  } catch (e) {
    const code = codeOf(e)
    // something is there now (a link to nothing included)
    if (code === 'EEXIST') return changed(await current(f, real))
    if (code === 'EACCES' || code === 'EPERM') return refused('permission')
    return code === 'ENOENT' || code === 'ENOTDIR' ? refused('no-folder') : io(e)
  }
  try {
    // the mode exactly, whatever the umask took from it
    await fh.chmod(req.create.mode)
    await writeAll(fh, bytes)
    await fh.sync()
  } catch (e) {
    // a file this save made and could not write is removed, unless another file is at its path by now
    try {
      const mine = await fh.stat({ bigint: true })
      const there = await f.promises.lstat(real, { bigint: true })
      if (there.dev === mine.dev && there.ino === mine.ino) await f.promises.unlink(real)
    } catch {
      // the answer is the failure either way
    }
    return io(e)
  } finally {
    await fh.close().catch(() => undefined)
  }
  d.wrote()
  return { kind: 'saved', version: versionOf(bytes), size: bytes.length }
}

/** `viewer.save` for the working directory `cwd`. Never rejects for what the file system does. */
export async function saveFile(cwd: string, req: SaveRequest, d: SaveDeps): Promise<SaveResult> {
  if (hasGitSegment(req.path)) return refused('git')
  const where = await resolveInside(cwd, req.path)
  if (where.state === 'outside') return refused('outside')
  if (where.state === 'ok' && inGitDir(req.path, where)) return refused('git')
  if (where.state === 'missing' && !req.create) return { kind: 'missing' }
  // one change to the session's files at a time: a save, a file operation or a discard
  const release = d.slot()
  if (!release) return refused('busy')
  try {
    return req.create ? await create(d, cwd, { ...req, create: req.create }) : await replace(d, where.real, req)
  } catch (e) {
    return io(e)
  } finally {
    release()
  }
}
