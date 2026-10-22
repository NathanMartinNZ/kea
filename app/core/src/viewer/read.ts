// Reading a file for the viewer: where a path really leads, then a capped read.
//
// A path arrives relative to a session's working directory (already checked for `..`, protocol files.ts). It is
// resolved there and its real path must stay inside the directory's real path, so a symlink in the worktree cannot make
// the viewer show a file from elsewhere: a link that leads outside is reported with its target and never read. The file
// is then opened by its real path, without following a link put there since and without waiting (`O_NONBLOCK`: a FIFO
// in a file's place must not hold core), and only a regular file is read.
//
// Nothing read here is kept: the bytes are handed to the caller, which sends them and lets go.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { imageExtension, L, type FileRead } from '@kea/protocol'
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
  return n === max ? buf : Buffer.from(buf.subarray(0, n))
}

const empty = (kind: FileRead['kind'], link: string | null = null): FileRead => ({ kind, size: 0, mtimeMs: 0, link, text: null, image: null, openable: false })

/**
 * `viewer.read`. `source`: read an image type as text (the SVG `Source` toggle). `maxBytes`: the load limit,
 * L.viewerMaxBytes when not given; a diff's side passes the diff's.
 */
export async function readFile(cwd: string, rel: string, o: { source?: boolean; maxBytes?: number } = {}): Promise<FileRead> {
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
    const d = detect(bytes)
    if (d.binary) return { ...base, kind: 'binary', openable }
    return { ...base, kind: 'text', text: { bytes, encoding: d.encoding, invalid: d.invalid, eol: d.eol }, openable }
  } finally {
    await fh.close().catch(() => undefined)
  }
}
