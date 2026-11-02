// Reading a file for the viewer: where a path really leads, then a capped read.
//
// A path arrives relative to a session's working directory (already checked for `..`, protocol files.ts). It is
// resolved there and its real path must stay inside the directory's real path, so a symlink in the worktree cannot make
// the viewer show a file from elsewhere: a link that leads outside is reported with its target and never read. The file
// is then opened by its real path, without following a link put there since and without waiting (`O_NONBLOCK`: a FIFO
// in a file's place must not hold core), and only a regular file is read.
//
// A file tab's read (`edit`) also says what a save needs: the version of the bytes sent (their SHA-256), the file's
// permission bits, and whether a save could write it (save.ts writes by the same rules). A file that still hashes to
// the version the window has is answered `same`, without its bytes but with those two, which change without them.
//
// Nothing read here is kept: the bytes are handed to the caller, which sends them and lets go.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { hasGitSegment, imageExtension, L, type FileRead, type FileReadResult, type Writable } from '@kea/protocol'
import { sessionFs, type FsModule } from '../files/fsImpl.ts'
import { detect } from './detect.ts'
import { imagePixelSize } from './image.ts'
import { opensSafely } from './openable.ts'

export interface Resolved {
  /** `ok`: `real` is a path inside the working directory. `missing`: nothing is there. `outside`: it leads out. */
  state: 'ok' | 'missing' | 'outside'
  /** The real path (`ok`). */
  real: string
  /** FileRead's `link`. */
  link: string | null
}

const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep)

/** Where `rel` leads from the working directory `cwd`. Never throws for what the file system holds. */
export async function resolveInside(cwd: string, rel: string): Promise<Resolved> {
  let root: string
  try {
    root = await fsp.realpath(cwd)
  } catch {
    return { state: 'missing', real: '', link: null }
  }
  const abs = path.join(cwd, rel)
  let real: string
  try {
    real = await fsp.realpath(abs)
  } catch {
    // nothing there, or a link to nothing: say where such a link points when that is outside
    const target = await fsp.readlink(abs).catch(() => null)
    if (target !== null) {
      const to = path.resolve(path.dirname(abs), target)
      if (!inside(root, to) && !inside(path.resolve(cwd), to)) return { state: 'outside', real: '', link: to }
    }
    return { state: 'missing', real: '', link: null }
  }
  if (!inside(root, real)) return { state: 'outside', real: '', link: real }
  return { state: 'ok', real, link: real === path.join(root, rel) ? null : path.relative(root, real) }
}

export interface Opened {
  fh: fsp.FileHandle
  stat: fs.Stats
}

/**
 * Open `real` for reading: no link followed at its last step, no waiting on a special file. Null when it is gone or
 * not readable. The caller closes the handle.
 */
export async function openForRead(real: string): Promise<Opened | null> {
  let fh: fsp.FileHandle
  try {
    fh = await fsp.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    return { fh, stat: await fh.stat() }
  } catch {
    await fh.close().catch(() => undefined)
    return null
  }
}

/** Up to `max` bytes from the start of an open file, in a buffer of its own (never a slice of Node's pool). */
export async function readUpTo(fh: fsp.FileHandle, max: number): Promise<Buffer<ArrayBuffer>> {
  const buf = Buffer.allocUnsafeSlow(max)
  let n = 0
  while (n < max) {
    const { bytesRead } = await fh.read(buf, n, max - n, n)
    if (bytesRead === 0) break
    n += bytesRead
  }
  if (n === max) return buf
  const out = Buffer.allocUnsafeSlow(n)
  buf.copy(out, 0, 0, n)
  return out
}

const empty = (kind: FileRead['kind'], link: string | null = null): FileRead => ({ kind, size: 0, mtimeMs: 0, link, text: null, image: null, openable: false })

/** A version of a file's contents: the SHA-256 of exactly its bytes, in hex. */
export const versionOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** The user core runs as; a file of another owner is never replaced by a rename. */
export const userId = (): number => process.getuid?.() ?? -1

/** The groups a file of the user's can be given: theirs. A file of another group is never replaced by a rename. */
export const userGroups = (): ReadonlySet<number> => new Set([...(process.getgroups?.() ?? []), ...(process.getegid ? [process.getegid()] : [])])

/** Who a save writes as: the user core runs as, and their groups. */
export interface SaveUser {
  uid: number
  groups: ReadonlySet<number>
}

/** The path asked for, or where a link on it leads inside the working directory (`where` is `ok`), passes through `.git`. */
export const inGitDir = (rel: string, where: Resolved): boolean => hasGitSegment(rel) || (where.link !== null && hasGitSegment(where.link))

const accessible = (f: FsModule, p: string, mode: number): Promise<boolean> => f.promises.access(p, mode).then(() => true, () => false)

/**
 * A save replaces the file at `real` by renaming a new file over it when the file is the user's, its group one of
 * theirs (the new file can be given it) and its folder the user's to write in; otherwise it writes the file in place.
 */
export async function savesByRename(f: FsModule, real: string, st: { uid: number; gid: number }, user: SaveUser): Promise<boolean> {
  return st.uid === user.uid && user.groups.has(st.gid) && (await accessible(f, path.dirname(real), fs.constants.W_OK | fs.constants.X_OK))
}

/** Whether a save could write the file at `where`: by the path, the user's permission, and a hard link written in place. */
export async function writableOf(f: FsModule, rel: string, where: Resolved, st: { uid: number; gid: number; nlink: number }, user: SaveUser): Promise<Writable> {
  if (inGitDir(rel, where)) return 'git'
  if (!(await accessible(f, where.real, fs.constants.W_OK))) return 'permission'
  if (st.nlink > 1 && !(await savesByRename(f, where.real, st, user))) return 'hard-linked'
  return 'yes'
}

export interface ReadOptions {
  /** Read an image type as text (the SVG `Source` toggle). */
  source?: boolean
  /** The load limit: L.viewerMaxBytes when not given; a diff's side passes the diff's. */
  maxBytes?: number
}

/** A file tab's read, which the user may edit: `ifNotVersion` is the version the window has. */
export interface EditRead {
  ifNotVersion?: string | undefined
}

/** `viewer.read` without `edit`, and a diff's sides. */
export function readFile(cwd: string, rel: string, o: ReadOptions = {}): Promise<FileRead> {
  return read(cwd, rel, o, null) as Promise<FileRead>
}

/** `viewer.read` with `edit`: a text read adds `version`, `writable` and `mode`; a file still at `ifNotVersion` is `same`, with the last two. */
export function readForEdit(cwd: string, rel: string, edit: EditRead, o: ReadOptions = {}): Promise<FileReadResult> {
  return read(cwd, rel, o, edit)
}

async function read(cwd: string, rel: string, o: ReadOptions, edit: EditRead | null): Promise<FileReadResult> {
  const where = await resolveInside(cwd, rel)
  if (where.state === 'outside') return empty('outside', where.link)
  if (where.state === 'missing') return empty('missing')
  const opened = await openForRead(where.real)
  if (!opened) return empty('missing', where.link)
  const { fh, stat } = opened
  try {
    const base = { size: stat.size, mtimeMs: stat.mtimeMs, link: where.link, text: null, image: null }
    if (stat.isDirectory()) return { ...base, kind: 'directory', size: 0, openable: false }
    // a FIFO, a socket, a device: never read
    if (!stat.isFile()) return empty('missing', where.link)
    // not executable, and of no type that opening runs, follows or installs — by the name it has here and
    // by the name of the file a link leads to (that one is what `open` is given)
    const openable = (stat.mode & 0o111) === 0 && opensSafely(rel) && opensSafely(where.real)
    const ext = imageExtension(rel)
    if (ext && !o.source) {
      const header = await readUpTo(fh, Math.min(stat.size, L.imageHeaderBytes))
      const px = imagePixelSize(header, ext)
      // a vector image has no pixel count; an icon's sizes are at most 256 a side; any other type must state its size
      const vector = ext === 'svg'
      const decodable = stat.size <= L.imageMaxBytes && (vector || (px !== null && px.width * px.height <= L.imageMaxPixels))
      return { ...base, kind: 'image', image: { width: px?.width ?? null, height: px?.height ?? null, decodable }, openable }
    }
    if (stat.size > (o.maxBytes ?? L.viewerMaxBytes)) return { ...base, kind: 'large', openable }
    const bytes = await readUpTo(fh, stat.size)
    // hashed only for a file the window may edit (within the full-feature size) or already has a version of
    const ifNot = edit?.ifNotVersion
    const version = edit && (ifNot !== undefined || stat.size <= L.viewerFullBytes) ? versionOf(bytes) : undefined
    const writableNow = () => writableOf(sessionFs, rel, where, stat, { uid: userId(), groups: userGroups() })
    const mode = stat.mode & 0o7777
    if (version !== undefined && version === ifNot) return { kind: 'same', writable: await writableNow(), mode }
    const d = detect(bytes)
    if (d.binary) return { ...base, kind: 'binary', openable }
    const text = { bytes, encoding: d.encoding, invalid: d.invalid, eol: d.eol }
    if (!edit) return { ...base, kind: 'text', text, openable }
    return { ...base, kind: 'text', text, openable, ...(version !== undefined ? { version } : {}), writable: await writableNow(), mode }
  } finally {
    await fh.close().catch(() => undefined)
  }
}
