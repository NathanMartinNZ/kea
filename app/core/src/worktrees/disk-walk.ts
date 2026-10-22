// The disk-usage walk: what a worktree takes on disk, as the sum of the allocated blocks (`st_blocks`) of
// everything in it.
//
//   - Symbolic links are never followed: a link counts as itself, so nothing outside the worktree is ever counted (or
//     even looked at), and a link to a folder cannot make the walk go round.
//   - Another volume mounted inside the worktree is not entered.
//   - Nothing is deduplicated: a cloned file (APFS, or a reflink on Linux), or one of several hard links (pnpm's
//     store), counts in full each time it is met. The sum is therefore an upper bound on what deleting the worktree
//     would free, and the UI says so.
//   - The part inside the rebuildable folders (given, as paths in the worktree) is summed by the same walk. A
//     folder among them that holds a `.git` entry at any depth is not rebuildable: its bytes are left out.
//   - It stops at `timeoutMs` (the walk's cap) on the clock it is given, looked at once per directory: what it
//     had counted by then is returned, marked `capped`.
//   - An entry that cannot be read (it went meanwhile, or permission is denied) counts nothing and stops nothing.
//
// The git look (`scanForGit`) is here too: whether a build folder holds a git repository of its own, asked right
// before the folder would be removed. Same rules: no link followed, no other volume entered, stopped at its cap.
//
// Synchronous on purpose: it runs on a worker thread of its own (files/finder-worker.ts), where blocking calls hold up
// nobody and never use libuv's thread pool, which core's own file reads share. Node built-ins only: the built app runs
// it inside the worker's bundle.

import fs from 'node:fs'

export interface DiskWalkRequest {
  /** The worktree. */
  root: string
  /** The rebuildable folders, as paths in the worktree (`node_modules`, `packages/web/dist`). */
  rebuildable: readonly string[]
  /** The walk's cap. */
  timeoutMs: number
}

export interface DiskWalkResult {
  /** Allocated bytes of everything met. */
  bytes: number
  /** Of those, the bytes inside the rebuildable folders. */
  rebuildableBytes: number
  /** The walk stopped at the cap: `bytes` is what it had counted. */
  capped: boolean
  /** Files, folders and links met. */
  entries: number
  /** How long it took, on the clock given. */
  ms: number
}

/** What the walk asks of the file system (a test counts and fakes). */
export interface WalkFs {
  lstatSync(p: string): { blocks: number; dev: number; isDirectory(): boolean }
  readdirSync(p: string): string[]
}

/** `st_blocks` counts 512-byte units whatever the volume's block size (stat(2)). */
const BLOCK = 512

/** What marks a git repository's working tree: a directory (a clone) or a file (a linked worktree, a submodule) of this name, in any case (the volume may not tell cases apart). */
const isGitEntry = (name: string): boolean => name.length === 4 && name.toLowerCase() === '.git'

export function walkDisk(req: DiskWalkRequest, now: () => number = () => performance.now(), io: WalkFs = fs): DiskWalkResult {
  const t0 = now()
  const out: DiskWalkResult = { bytes: 0, rebuildableBytes: 0, capped: false, entries: 0, ms: 0 }
  const rebuildable = new Set(req.rebuildable.map((r) => r.replace(/\/+$/, '')))
  // one sum per rebuildable folder met (≤ those given): it counts only if the folder holds no `.git` entry
  const shares: { bytes: number; git: boolean }[] = []
  const done = (): DiskWalkResult => {
    for (const s of shares) if (!s.git) out.rebuildableBytes += s.bytes
    out.ms = now() - t0
    return out
  }
  let top: ReturnType<WalkFs['lstatSync']>
  try {
    top = io.lstatSync(req.root)
  } catch {
    return done()
  }
  out.entries++
  out.bytes += top.blocks * BLOCK
  if (!top.isDirectory()) return done()
  // depth first: what waits is one folder's subfolders per level, never a whole level of the tree
  const stack: { abs: string; rel: string; share: { bytes: number; git: boolean } | null }[] = [{ abs: req.root, rel: '', share: null }]
  while (stack.length) {
    if (now() - t0 >= req.timeoutMs) {
      out.capped = true
      break
    }
    const dir = stack.pop()!
    let names: string[]
    try {
      names = io.readdirSync(dir.abs)
    } catch {
      continue
    }
    for (const name of names) {
      const abs = `${dir.abs}/${name}`
      let st: ReturnType<WalkFs['lstatSync']>
      try {
        st = io.lstatSync(abs)
      } catch {
        continue
      }
      const rel = dir.rel ? `${dir.rel}/${name}` : name
      let share = dir.share
      if (!share && rebuildable.has(rel)) shares.push((share = { bytes: 0, git: false }))
      const bytes = st.blocks * BLOCK
      out.entries++
      out.bytes += bytes
      if (share) {
        share.bytes += bytes
        if (isGitEntry(name)) share.git = true
      }
      // lstat: a link to a folder is not a folder here
      if (st.isDirectory() && st.dev === top.dev) stack.push({ abs, rel, share })
    }
  }
  return done()
}

// ── does a build folder hold a git repository? ─────────────────────────────────────────────────────

export interface GitScanRequest {
  /** The folder, absolute. */
  dir: string
  /** The cap of the look, on its clock. */
  timeoutMs: number
}

export interface GitScanResult {
  /** The first `.git` entry met, as a path in the folder (`.git`, `src/pkg/.git`); null: none was met. */
  git: string | null
  /**
   * The look did not cover the whole folder, so it is not known to hold none: it reached its cap, a folder in it could
   * not be read, or another volume is mounted in it (never entered). The caller keeps such a folder.
   */
  unchecked: 'cap' | 'unreadable' | 'volume' | null
  /** Entries looked at. */
  entries: number
  ms: number
}

/** What the look asks of the file system (a test fakes it). Entries come with their kind as the directory says it: no link is followed. */
export interface ScanFs {
  lstatSync(p: string): { dev: number; isDirectory(): boolean }
  readdirSync(p: string): { name: string; isDirectory(): boolean }[]
}

const SCAN_FS: ScanFs = { lstatSync: (p) => fs.lstatSync(p), readdirSync: (p) => fs.readdirSync(p, { withFileTypes: true }) }
const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code

/**
 * Whether `dir` holds a `.git` entry at any depth. A folder that is not there, or is not a real folder (a link),
 * holds none: the removal moves only real folders. It stops at the first one found.
 */
export function scanForGit(req: GitScanRequest, now: () => number = () => performance.now(), io: ScanFs = SCAN_FS): GitScanResult {
  const t0 = now()
  const out: GitScanResult = { git: null, unchecked: null, entries: 0, ms: 0 }
  const done = (): GitScanResult => {
    out.ms = now() - t0
    return out
  }
  let top: ReturnType<ScanFs['lstatSync']>
  try {
    top = io.lstatSync(req.dir)
  } catch (e) {
    if (errno(e) !== 'ENOENT') out.unchecked = 'unreadable'
    return done()
  }
  if (!top.isDirectory()) return done()
  // depth first, as the size walk
  const stack: { abs: string; rel: string }[] = [{ abs: req.dir, rel: '' }]
  while (stack.length) {
    if (now() - t0 >= req.timeoutMs) {
      out.unchecked = 'cap'
      break
    }
    const dir = stack.pop()!
    let entries: ReturnType<ScanFs['readdirSync']>
    try {
      entries = io.readdirSync(dir.abs)
    } catch (e) {
      // one that went meanwhile holds nothing; one that cannot be read may hold anything
      if (errno(e) !== 'ENOENT') out.unchecked ??= 'unreadable'
      continue
    }
    for (const e of entries) {
      out.entries++
      const rel = dir.rel ? `${dir.rel}/${e.name}` : e.name
      if (isGitEntry(e.name)) {
        out.git = rel
        out.unchecked = null
        return done()
      }
      if (!e.isDirectory()) continue
      const abs = `${dir.abs}/${e.name}`
      try {
        if (io.lstatSync(abs).dev !== top.dev) out.unchecked ??= 'volume'
        else stack.push({ abs, rel })
      } catch (err) {
        if (errno(err) !== 'ENOENT') out.unchecked ??= 'unreadable'
      }
    }
  }
  return done()
}
