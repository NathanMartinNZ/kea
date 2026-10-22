// The finder's worker thread: it owns the prepared fuzzysort targets and does the matching, so a keystroke on a large
// repository never holds up core's event loop. Core feeds it `git ls-files -z` output as it arrives (raw chunks,
// transferred), patches from watcher events, and one query at a time.
//
// Imports only node built-ins, finder-match.ts and finder-rank.ts (and through them `fuzzysort`): the built app runs
// this file as its own bundle.
//
// The disk service's size walk runs on this thread too (worktrees/disk-walk.ts, node built-ins only): core starts an
// instance of its own for it (worktrees/disk.ts), which holds no index and does one walk per `disk` message, and one
// look into a build folder for a git repository per `git` message.

import { parentPort, workerData } from 'node:worker_threads'
import { scanForGit, walkDisk, type DiskWalkRequest, type DiskWalkResult, type GitScanRequest, type GitScanResult } from '../worktrees/disk-walk.ts'
import { PathIndex } from './finder-match.ts'
import type { RankContext } from './finder-rank.ts'

export interface FinderWorkerData {
  /** L.finderPathsMax. */
  maxPaths: number
  /**
   * Names are kept as stored (Linux): a path is matched by its NFC key and answered as stored, so a query typed in NFC
   * finds a name stored decomposed and the answer opens it. False (macOS): paths are NFC.
   */
  asStored?: boolean
}

export type ToWorker =
  | { t: 'reset' }
  /** A chunk of NUL-separated paths (any cut). */
  | { t: 'chunk'; buf: Uint8Array }
  | { t: 'end' }
  | { t: 'patch'; add: string[]; del: string[]; delBelow: string[] }
  | { t: 'query'; id: number; query: string; limit: number; changed: string[]; recent: string[] }
  /** Walk one worktree and answer its size (the walk holds this thread until it is done or capped). */
  | { t: 'disk'; id: number; walk: DiskWalkRequest }
  /** Look into one build folder for a git repository, right before it would be removed. */
  | { t: 'git'; id: number; scan: GitScanRequest }

export type FromWorker =
  | { t: 'loaded'; total: number; truncated: boolean }
  | { t: 'result'; id: number; hits: { path: string; matched: number[] }[]; total: number; truncated: boolean; ms: number }
  | { t: 'disk'; id: number; size: DiskWalkResult }
  | { t: 'git'; id: number; found: GitScanResult }

const data = workerData as FinderWorkerData
const index = new PathIndex(data.maxPaths)
let rest: Buffer | null = null
const NON_ASCII = /[^\x00-\x7f]/
// bounded: one entry per indexed path whose stored name is not its NFC key (≤ L.finderPathsMax, the index's own
// cap); empty unless names are kept as stored (Linux)
const storedOf = new Map<string, string>()

/** The key a path is indexed and matched by: NFC (a normalised copy only for a name that is not ASCII). */
function keyOf(p: string): string {
  return NON_ASCII.test(p) ? p.normalize('NFC') : p
}

/** Index `p` (`git ls-files` output) by its key; on Linux remember the stored path behind a key that differs from it. */
function addPath(p: string): void {
  const key = keyOf(p)
  if (data.asStored && key !== p && storedOf.size < data.maxPaths) storedOf.set(key, p)
  index.add(key) // a normalised copy costs more memory than the path as read
}

/** A patch's path as the index holds it: its key where names are kept as stored, else as given (macOS). */
const patchKey = (p: string): string => (data.asStored ? keyOf(p) : p)

function chunk(buf: Uint8Array): void {
  let b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (rest) {
    b = Buffer.concat([rest, b])
    rest = null
  }
  let from = 0
  for (let nul = b.indexOf(0, from); nul >= 0; nul = b.indexOf(0, from)) {
    const p = b.toString('utf8', from, nul)
    addPath(p)
    from = nul + 1
  }
  if (from < b.length) rest = Buffer.from(b.subarray(from))
}

function query(m: Extract<ToWorker, { t: 'query' }>): FromWorker {
  const t0 = performance.now()
  const key = data.asStored ? keyOf : (p: string): string => p
  const ctx: RankContext = { changed: new Set(m.changed.map(key)), recent: new Map(m.recent.map((p, i) => [key(p), i])) }
  const found = index.query(m.query, m.limit, ctx)
  const hits = storedOf.size ? found.map((h) => ({ ...h, path: storedOf.get(h.path) ?? h.path })) : found
  return { t: 'result', id: m.id, hits, total: index.size, truncated: index.truncated, ms: performance.now() - t0 }
}

parentPort?.on('message', (m: ToWorker) => {
  switch (m.t) {
    case 'reset':
      index.clear()
      storedOf.clear()
      rest = null
      break
    case 'chunk':
      chunk(m.buf)
      break
    case 'end':
      rest = null // an unfinished last path (output cut at the byte cap) is not a path
      parentPort?.postMessage({ t: 'loaded', total: index.size, truncated: index.truncated } satisfies FromWorker)
      break
    case 'patch':
      for (const p of m.del) {
        index.delete(patchKey(p))
        storedOf.delete(patchKey(p))
      }
      for (const dir of m.delBelow) {
        index.deleteBelow(patchKey(dir))
        const below = `${patchKey(dir)}/`
        for (const k of storedOf.keys()) if (k.startsWith(below)) storedOf.delete(k)
      }
      for (const p of m.add) {
        if (data.asStored) addPath(p)
        else index.add(p)
      }
      break
    case 'query':
      parentPort?.postMessage(query(m))
      break
    case 'disk':
      parentPort?.postMessage({ t: 'disk', id: m.id, size: walkDisk(m.walk) } satisfies FromWorker)
      break
    case 'git':
      parentPort?.postMessage({ t: 'git', id: m.id, found: scanForGit(m.scan) } satisfies FromWorker)
      break
  }
})
