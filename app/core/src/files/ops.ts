// The file tree's operations in a session's folder: New File and New Folder, Rename, a move or a copy (a drag, Paste),
// Move to Trash, a drop from another app, and Undo of the last move or rename. `SessionFiles` runs one at a time and
// reads the tree again before it answers; these are the operations themselves, on the session's canonical folder.
//
// Every path is walked from the session's folder one segment at a time with `lstat`: each folder on the way must be a
// plain directory whose real path is itself, so a symlinked folder anywhere on the way refuses (`outside`). A typed
// segment that names an entry under another spelling (a volume blind to case or normalisation) is taken in the
// volume's spelling, once it is shown to be the same entry. The entry acted on is taken as itself: a link is renamed,
// moved, copied or trashed as a link, never followed. Nothing is written over: a new entry is made with
// `open(…, 'wx')`, `mkdir`, `copyFile` with `COPYFILE_EXCL` or `symlink`, all of which refuse a taken name, and a rename
// or a move looks at its destination first (the moment between the look and `rename(2)` is open to another writer;
// agents run as the same user, so that gives them nothing they lack). Never the session's folder itself, nothing at or
// below `.git` in any spelling git reads as `.git`, never a submodule, and never across volumes.

import type { Dir, Stats } from 'node:fs'
import path from 'node:path'
import { fileName, git, runProcess, type ProcessResult } from '@kea/kit'
import { checkName, hasGitSegment, isGitSegment, L, sizeText, type FileOpRefusal, type FileOpRefused, type UndoKind } from '@kea/protocol'
import { executable, said, trashUse } from './discard.ts'
import { sessionFs as fs } from './fsImpl.ts'
import { ZRecords } from './records.ts'
import type { Env } from './status.ts'
import { childPath, parentPath } from './tree.ts'

export const refuse = (refused: FileOpRefusal, detail?: string): FileOpRefused => (detail ? { ok: false, refused, detail: detail.slice(0, L.discardDetailMaxChars) } : { ok: false, refused })

const isRefused = (x: object): x is FileOpRefused => (x as { ok?: unknown }).ok === false

/** What an error from the file system means to the person. */
const ERRNO: Readonly<Record<string, readonly [FileOpRefusal, string?]>> = {
  EEXIST: ['exists'],
  ENOTEMPTY: ['exists'],
  ENOENT: ['missing'],
  ENOTDIR: ['missing'],
  EXDEV: ['crossDevice'],
  EACCES: ['failed', 'permission denied'],
  EPERM: ['failed', 'the system does not permit it'],
  EROFS: ['failed', 'the volume is read-only'],
  ENOSPC: ['failed', 'the disk is full'],
  ENAMETOOLONG: ['failed', 'the name is too long for this volume'],
  EBUSY: ['failed', 'it is in use'],
}

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code

export function errnoRefusal(e: unknown): FileOpRefused {
  const code = codeOf(e)
  const known = code !== undefined ? ERRNO[code] : undefined
  if (known) return refuse(known[0], known[1])
  return refuse('failed', code ?? (e instanceof Error ? e.message : String(e)))
}

async function lstatOrNull(abs: string): Promise<Stats | null> {
  try {
    return await fs.promises.lstat(abs)
  } catch {
    return null
  }
}

/** A folder reached by the walk: its absolute path and its path in the session, both in the volume's spelling. */
export interface Place {
  abs: string
  rel: string
}

/** What an operation did: the entry's path now, the folders whose listing changed, the new paths made. */
export interface Done {
  rel: string
  dir: boolean
  /** Where the entry was, for a move, a rename or an undo. */
  from?: string
  /** Folders whose listing changed (read again before the answer). */
  touched: string[]
  /** Paths that are new rows (git is asked whether it ignores them). */
  made: string[]
  /** The entry's identity, for the undo entry of a move or a rename. */
  dev?: number
  ino?: number
  /** Nothing changed (a rename to the same name, a move into the folder it is in). */
  same?: boolean
}

/** The undo entry: the last move or rename of a session's tree, `from` → `to`, and the entry's identity. */
export interface UndoEntry {
  kind: UndoKind
  from: string
  to: string
  dev: number
  ino: number
}

/** `name`, a child of the plain folder `dir`, as a plain folder in the volume's spelling; `missing`; or why not. */
async function plainChild(dir: Place, name: string): Promise<Place | 'missing' | FileOpRefused> {
  const abs = path.join(dir.abs, name)
  let st: Stats
  try {
    st = await fs.promises.lstat(abs)
  } catch (e) {
    return codeOf(e) === 'ENOENT' ? 'missing' : errnoRefusal(e)
  }
  const shown = childPath(dir.rel, name)
  if (st.isSymbolicLink()) return refuse('outside', `“${shown}” is a link`)
  if (!st.isDirectory()) return refuse('exists', `“${shown}” is a file`)
  // the real path names the entry in the volume's own spelling (macOS); it must lie in `dir` itself
  let real: string
  try {
    real = await fs.promises.realpath(abs)
  } catch (e) {
    return errnoRefusal(e)
  }
  if (fileName(path.dirname(real)) !== fileName(dir.abs)) return refuse('outside')
  const spelt = fileName(path.basename(real))
  if (spelt !== fileName(name)) {
    const same = await lstatOrNull(path.join(dir.abs, spelt))
    if (!same || same.dev !== st.dev || same.ino !== st.ino) return refuse('outside')
  }
  return { abs: path.join(dir.abs, spelt), rel: childPath(dir.rel, spelt) }
}

/**
 * Walk `segments` down from the plain folder `from`: each must be a plain folder. `missingOk`: a segment that is not
 * there ends the walk, and it and the ones after it are `rest` (a nested New makes them); otherwise it refuses.
 */
export async function walk(from: Place, segments: readonly string[], missingOk: boolean): Promise<{ at: Place; rest: string[] } | FileOpRefused> {
  let at = from
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as string
    const next = await plainChild(at, seg)
    if (next === 'missing') return missingOk ? { at, rest: segments.slice(i) } : refuse('missing', `“${childPath(at.rel, seg)}” is not there`)
    if (isRefused(next)) return next
    at = next
  }
  return { at, rest: [] }
}

const split = (rel: string): string[] => (rel === '' ? [] : rel.split('/'))

/** A folder of the session (`''`: the folder itself), walked; it must be there. */
export async function folderAt(root: string, rel: string): Promise<Place | FileOpRefused> {
  if (hasGitSegment(rel)) return refuse('gitDir')
  const w = await walk({ abs: root, rel: '' }, split(rel), false)
  return isRefused(w) ? w : w.at
}

interface Entry {
  parent: Place
  name: string
  abs: string
  rel: string
  st: Stats
}

/** The entry at `rel`, not followed, its folder walked. */
async function entryAt(root: string, rel: string): Promise<Entry | FileOpRefused> {
  if (rel === '') return refuse('root')
  if (hasGitSegment(rel)) return refuse('gitDir')
  const segs = split(rel)
  const name = segs.pop() as string
  const w = await walk({ abs: root, rel: '' }, segs, false)
  if (isRefused(w)) return w
  const abs = path.join(w.at.abs, name)
  let st: Stats
  try {
    st = await fs.promises.lstat(abs)
  } catch (e) {
    return codeOf(e) === 'ENOENT' ? refuse('missing', `“${rel}” is not there`) : errnoRefusal(e)
  }
  return { parent: w.at, name, abs, rel: childPath(w.at.rel, name), st }
}

/**
 * In a repository: whether `rel` is, or holds, a submodule (git's index has an entry of mode 160000 there). Read as a
 * stream and ended at the first one; only a listing that ran to its end says no. Null: git did not say.
 */
export async function holdsSubmodule(root: string, rel: string, env: Env): Promise<boolean | null> {
  const ac = new AbortController()
  let found = false
  const recs = new ZRecords((rec) => {
    if (rec.subarray(0, 7).toString('latin1') !== '160000 ') return true
    found = true
    return false
  })
  let r: ProcessResult
  try {
    r = await git(['ls-files', '-z', '--stage', '--', rel], {
      cwd: root,
      env: { ...env, GIT_LITERAL_PATHSPECS: '1' },
      readOnly: true,
      timeoutMs: L.gitStatusTimeoutMs,
      signal: ac.signal,
      onStdout: (c) => {
        if (!recs.push(c)) ac.abort()
      },
    })
  } catch {
    return null
  }
  recs.end()
  if (found) return true
  return r.code === 0 && !r.truncated && !r.timedOut && !r.cancelled && !recs.overlong ? false : null
}

async function noSubmodule(root: string, rel: string, env: Env | null): Promise<FileOpRefused | null> {
  if (env === null) return null
  const sub = await holdsSubmodule(root, rel, env)
  if (sub === null) return refuse('failed', 'git could not say whether it holds a submodule')
  return sub ? refuse('submodule') : null
}

/** In a repository: the paths of `rels` git ignores. Null: git did not say. */
export async function ignoredOf(root: string, rels: readonly string[], env: Env): Promise<Set<string> | null> {
  if (rels.length === 0) return new Set()
  const hit = new Set<string>()
  const recs = new ZRecords((rec) => void hit.add(rec.toString('utf8')))
  const r = await git(['check-ignore', '-z', '--stdin'], { cwd: root, env, readOnly: true, stdin: `${rels.join('\0')}\0`, maxBytes: L.gitStatusCapBytes, timeoutMs: L.gitStatusTimeoutMs, onStdout: (c) => void recs.push(c) }).catch(() => null)
  recs.end()
  return r && (r.code === 0 || r.code === 1) ? hit : null
}

// ── New File, New Folder ──────────────────────────────────────────────────────────────────────────

/**
 * Make `name` in the folder `dir`: a file (empty) or a folder. `name` may hold `/`: the folders on the way that are not
 * there are made one `mkdir` at a time; those that are must be plain folders.
 */
export async function createEntry(root: string, dir: string, name: string, kind: 'file' | 'dir'): Promise<Done | FileOpRefused> {
  const named = checkName(name, { nested: true, dir })
  if (!named.ok) return refuse('name', named.reason)
  const top = await folderAt(root, dir)
  if (isRefused(top)) return top
  const segs = named.segments
  const last = segs.pop() as string
  const mid = await walk(top, segs, true)
  if (isRefused(mid)) return mid
  let at = mid.at
  const made: string[] = []
  const stopped = (e: unknown): FileOpRefused => {
    const r = errnoRefusal(e)
    return made.length === 0 ? r : refuse(r.refused, `${r.detail ?? 'it could not be made'}; the folders made on the way stay (“${made.at(-1)}”)`)
  }
  for (const seg of mid.rest) {
    const abs = path.join(at.abs, seg)
    try {
      await fs.promises.mkdir(abs)
    } catch (e) {
      return stopped(e)
    }
    at = { abs, rel: childPath(at.rel, seg) }
    made.push(at.rel)
  }
  const abs = path.join(at.abs, last)
  const rel = childPath(at.rel, last)
  try {
    if (kind === 'dir') await fs.promises.mkdir(abs)
    else await (await fs.promises.open(abs, 'wx')).close()
  } catch (e) {
    return stopped(e)
  }
  made.push(rel)
  return { rel, dir: kind === 'dir', touched: [parentPath(made[0] as string)], made }
}

// ── Rename ────────────────────────────────────────────────────────────────────────────────────────

/** Give the entry at `rel` the one-segment `name`, in its folder. `env`: git's, in a repository (null: none). */
export async function renameEntry(root: string, rel: string, name: string, env: Env | null): Promise<Done | FileOpRefused> {
  const e = await entryAt(root, rel)
  if (isRefused(e)) return e
  const named = checkName(name, { nested: false, dir: e.parent.rel })
  if (!named.ok) return refuse('name', named.reason)
  const dir = e.st.isDirectory()
  if (fileName(name) === fileName(e.name)) return { rel: e.rel, dir, touched: [], made: [], same: true }
  const dest = path.join(e.parent.abs, name)
  // taken, unless by the entry itself under another spelling (a case-only rename where case is not told apart)
  const taken = await lstatOrNull(dest)
  if (taken && !(taken.dev === e.st.dev && taken.ino === e.st.ino)) return refuse('exists')
  const sub = await noSubmodule(root, e.rel, env)
  if (sub) return sub
  try {
    await fs.promises.rename(e.abs, dest)
  } catch (err) {
    return errnoRefusal(err)
  }
  const to = childPath(e.parent.rel, fileName(name))
  return { rel: to, from: e.rel, dir, touched: [e.parent.rel], made: [to], dev: e.st.dev, ino: e.st.ino }
}

// ── Move to Trash ─────────────────────────────────────────────────────────────────────────────────

/**
 * Move the entry at `rel` to the Trash with the system's tool (`tool`; null or not there: refused, never deleted).
 * `dir`: what the confirmation named; a path that is now the other kind is refused `changed`.
 */
export async function trashEntry(root: string, rel: string, dir: boolean, env: Env, isRepo: boolean, tool: string | null): Promise<Done | FileOpRefused> {
  const e = await entryAt(root, rel)
  if (isRefused(e)) return e
  if (e.st.isDirectory() !== dir) return refuse('changed', dir ? 'it is a file now' : 'it is a folder now')
  const sub = await noSubmodule(root, e.rel, isRepo ? env : null)
  if (sub) return sub
  const use = trashUse()
  if (tool === null || !executable(tool)) return use.missing === null ? refuse('noTrash') : refuse('noTrash', use.missing)
  let r: ProcessResult
  try {
    r = await runProcess(tool, use.args(e.abs), { pool: 'other', collect: true, timeoutMs: L.fileTrashTimeoutMs, env })
  } catch (err) {
    return refuse('failed', String(err))
  }
  if (r.timedOut) return refuse('failed', 'the trash tool took too long; a part of it may be in the Trash')
  if (r.code !== 0) return refuse('failed', said(r))
  if (await lstatOrNull(e.abs)) return refuse('failed', 'it is still there')
  return { rel: e.rel, dir, touched: [e.parent.rel], made: [] }
}

// ── copies ────────────────────────────────────────────────────────────────────────────────────────

/** One entry of a copy's source, in the order it is made (a folder before what it holds). */
interface Item {
  src: string
  /** Its path below the source (`''`: the source itself). */
  sub: string
  kind: 'file' | 'dir' | 'link'
  mode: number
}

/** What a copy would make: the entries of each source, how many in all and how many bytes their files hold. */
export interface Measured {
  sources: Item[][]
  entries: number
  bytes: number
}

/**
 * Walk each source with `lstat`, following no link, before anything is written: refused past L.fileCopyEntriesMax
 * entries or L.fileCopyBytesMax bytes (`tooLarge`), for an entry that is not a file, folder or link (`unsupported`)
 * and for a `.git` anywhere inside (`gitDir`: a copied repository or submodule checkout would share its git data).
 */
export async function measureCopy(sources: readonly string[]): Promise<Measured | FileOpRefused> {
  const out: Item[][] = []
  let entries = 0
  let bytes = 0
  const tooLarge = (): FileOpRefused => refuse('tooLarge', `more than ${L.fileCopyEntriesMax.toLocaleString('en-GB')} items or ${sizeText(L.fileCopyBytesMax)}`)
  for (const source of sources) {
    if (isGitSegment(path.basename(source))) return refuse('gitDir')
    const items: Item[] = []
    // depth first, a folder before its entries
    const stack: { abs: string; sub: string }[] = [{ abs: source, sub: '' }]
    while (stack.length > 0) {
      const { abs, sub } = stack.pop() as { abs: string; sub: string }
      let st: Stats
      try {
        st = await fs.promises.lstat(abs)
      } catch (e) {
        return codeOf(e) === 'ENOENT' ? refuse('missing', `“${path.basename(source)}” is not there`) : errnoRefusal(e)
      }
      if (++entries > L.fileCopyEntriesMax) return tooLarge()
      if (st.isSymbolicLink()) items.push({ src: abs, sub, kind: 'link', mode: st.mode })
      else if (st.isFile()) {
        bytes += st.size
        if (bytes > L.fileCopyBytesMax) return tooLarge()
        items.push({ src: abs, sub, kind: 'file', mode: st.mode })
      } else if (st.isDirectory()) {
        items.push({ src: abs, sub, kind: 'dir', mode: st.mode })
        let dir: Dir
        try {
          dir = await fs.promises.opendir(abs)
        } catch (e) {
          return errnoRefusal(e)
        }
        const names: string[] = []
        try {
          for await (const d of dir) {
            if (isGitSegment(d.name)) return refuse('gitDir', `“${childPath(sub, d.name)}” is git’s own folder`)
            names.push(d.name)
            if (entries + stack.length + names.length > L.fileCopyEntriesMax) return tooLarge()
          }
        } catch (e) {
          return errnoRefusal(e)
        }
        for (const n of names.reverse()) stack.push({ abs: path.join(abs, n), sub: childPath(sub, n) })
      } else return refuse('unsupported', `“${childPath(path.basename(source), sub)}” is not a file, folder or link`)
    }
    out.push(items)
  }
  return { sources: out, entries, bytes }
}

/**
 * The names a copy of `name` tries, Finder's way: `name` itself first when `keep` (another folder), then `a copy.txt`,
 * `a copy 2.txt`, … A folder's name has no extension; a copy of a copy counts on (`a copy.txt` → `a copy 2.txt`).
 */
export function* copyNames(name: string, isDir: boolean, keep: boolean): Generator<string> {
  if (keep) yield name
  const dot = isDir ? -1 : name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  const base = (dot > 0 ? name.slice(0, dot) : name).replace(/ copy( \d+)?$/, '')
  yield `${base} copy${ext}`
  for (let n = 2; ; n++) yield `${base} copy ${n}${ext}`
}

/** Make the first entry of a copy under the first free name `copyNames` gives (a taken one moves on). */
async function claim(into: Place, item: Item, name: string, keep: boolean): Promise<Place | FileOpRefused> {
  let tries = 0
  for (const n of copyNames(name, item.kind === 'dir', keep)) {
    if (tries++ >= L.fileCopyNameTries) break
    const abs = path.join(into.abs, n)
    try {
      await makeItem(item, abs)
      return { abs, rel: childPath(into.rel, n) }
    } catch (e) {
      if (codeOf(e) !== 'EEXIST') return errnoRefusal(e)
    }
  }
  return refuse('exists', `no free name for a copy of “${name}”`)
}

/** Make one entry of a copy: a folder (writable until its contents are in), a file's copy with its mode, a link. */
async function makeItem(item: Item, abs: string): Promise<void> {
  if (item.kind === 'dir') await fs.promises.mkdir(abs, { mode: 0o700 })
  else if (item.kind === 'file') {
    await fs.promises.copyFile(item.src, abs, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE)
    await fs.promises.chmod(abs, item.mode & 0o777)
  } else await fs.promises.symlink(await fs.promises.readlink(item.src), abs)
}

/**
 * Copy one measured source into the folder `into` under the first free name. Each folder's mode is set once its
 * contents are in, deepest first, so a read-only source folder is copied whole. A copy that stops partway leaves what
 * it made and says so.
 */
async function copyItems(items: Item[], into: Place, name: string, keep: boolean): Promise<Place | FileOpRefused> {
  const first = items[0]
  if (!first) return refuse('missing')
  const top = await claim(into, first, name, keep)
  if (isRefused(top)) return top
  const dirs: { abs: string; mode: number; depth: number }[] = first.kind === 'dir' ? [{ abs: top.abs, mode: first.mode, depth: 0 }] : []
  try {
    for (const item of items.slice(1)) {
      const abs = path.join(top.abs, item.sub)
      await makeItem(item, abs)
      if (item.kind === 'dir') dirs.push({ abs, mode: item.mode, depth: item.sub.split('/').length })
    }
    for (const d of dirs.sort((a, b) => b.depth - a.depth)) await fs.promises.chmod(d.abs, d.mode & 0o777)
  } catch (e) {
    const r = errnoRefusal(e)
    return refuse('failed', `${r.detail ?? r.refused}; the copy stopped partway and what was copied stays (“${top.rel}”)`)
  }
  return top
}

// ── a move or a copy in the tree ──────────────────────────────────────────────────────────────────

/**
 * Move the entry at `rel` into the folder `toDir`, or copy it there (`copy`; a taken name gets "copy"). A move keeps
 * its name and refuses a taken one; into the folder it is in, it does nothing.
 */
export async function moveEntry(root: string, rel: string, toDir: string, copy: boolean, env: Env | null): Promise<Done | FileOpRefused> {
  const e = await entryAt(root, rel)
  if (isRefused(e)) return e
  const into = await folderAt(root, toDir)
  if (isRefused(into)) return into
  const dir = e.st.isDirectory()
  if (dir && (into.rel === e.rel || into.rel.startsWith(`${e.rel}/`))) return refuse('intoItself')
  if (copy) {
    const m = await measureCopy([e.abs])
    if (isRefused(m)) return m
    const made = await copyItems(m.sources[0] as Item[], into, e.name, into.rel !== e.parent.rel)
    if (isRefused(made)) return made
    return { rel: made.rel, dir, touched: [into.rel], made: [made.rel] }
  }
  if (into.rel === e.parent.rel) return { rel: e.rel, dir, touched: [], made: [], same: true }
  if (await lstatOrNull(path.join(into.abs, e.name))) return refuse('exists', `“${childPath(into.rel, e.name)}” is taken`)
  const sub = await noSubmodule(root, e.rel, env)
  if (sub) return sub
  try {
    await fs.promises.rename(e.abs, path.join(into.abs, e.name))
  } catch (err) {
    return errnoRefusal(err)
  }
  const to = childPath(into.rel, e.name)
  return { rel: to, from: e.rel, dir, touched: [e.parent.rel, into.rel], made: [to], dev: e.st.dev, ino: e.st.ino }
}

// ── a drop from another app ───────────────────────────────────────────────────────────────────────

/** The dropped sources a copy into `into` may take: none is the folder or holds it (a folder into itself). */
async function intoNone(sources: readonly string[], into: Place): Promise<FileOpRefused | null> {
  const target = fileName(into.abs)
  for (const s of sources) {
    let real: string
    try {
      real = fileName(await fs.promises.realpath(s))
    } catch {
      continue // measured next: a link left as it is, or a path that is gone
    }
    const st = await lstatOrNull(s)
    if (st?.isSymbolicLink()) continue
    if (target === real || target.startsWith(`${real}/`)) return refuse('intoItself')
  }
  return null
}

/** What a drop of `sources` into `toDir` would copy, counted (nothing is written). */
export async function measureDrop(root: string, sources: readonly string[], toDir: string): Promise<Measured | FileOpRefused> {
  const into = await folderAt(root, toDir)
  if (isRefused(into)) return into
  return (await intoNone(sources, into)) ?? measureCopy(sources)
}

/** Copy the dropped `sources` into `toDir`, each under its own name or the first free "copy" name. */
export async function copyIn(root: string, sources: readonly string[], toDir: string): Promise<{ ok: true; paths: string[]; touched: string[] } | (FileOpRefused & { paths?: string[] })> {
  const into = await folderAt(root, toDir)
  if (isRefused(into)) return into
  const loop = await intoNone(sources, into)
  if (loop) return loop
  const m = await measureCopy(sources)
  if (isRefused(m)) return m
  const paths: string[] = []
  for (const [i, items] of m.sources.entries()) {
    const made = await copyItems(items, into, fileName(path.basename(sources[i] as string)), true)
    if (isRefused(made)) return paths.length ? { ...made, paths } : made
    paths.push(made.rel)
  }
  return { ok: true, paths, touched: [into.rel] }
}

// ── Undo ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Take back the last move or rename: the entry goes from `to` back to `from`, with the same checks as a move. Refused
 * `changed` when the entry at `to` is not the one moved (same device and inode) or `from` is taken, and `missing` when
 * the folder `from` was in is gone.
 */
export async function undoMove(root: string, u: UndoEntry): Promise<Done | FileOpRefused> {
  const e = await entryAt(root, u.to)
  if (isRefused(e)) return e.refused === 'missing' ? refuse('changed', `“${u.to}” is not there any more`) : e
  if (e.st.dev !== u.dev || e.st.ino !== u.ino) return refuse('changed', `“${u.to}” is another file or folder now`)
  const name = path.posix.basename(u.from)
  const back = await folderAt(root, parentPath(u.from))
  if (isRefused(back)) return back.refused === 'missing' ? refuse('missing', `the folder “${parentPath(u.from)}” is gone`) : back
  const dest = path.join(back.abs, name)
  const taken = await lstatOrNull(dest)
  if (taken && !(taken.dev === u.dev && taken.ino === u.ino)) return refuse('changed', `“${u.from}” is taken`)
  try {
    await fs.promises.rename(e.abs, dest)
  } catch (err) {
    return errnoRefusal(err)
  }
  const to = childPath(back.rel, name)
  return { rel: to, from: e.rel, dir: e.st.isDirectory(), touched: [e.parent.rel, back.rel], made: [to] }
}
