// Reading one directory: its entries as tree rows, sorted, never following a symlink and never showing `.git`, each
// name as file operations take it (NFC on macOS, as stored on Linux). The directory is read as a stream and at most
// L.dirCacheEntriesMax entries are taken (a directory with more is cut and says so), so one listing cannot outgrow the
// session's whole cache.

import fs from 'node:fs'
import { fileName } from '@kea/kit'
import { L, type TreeKind } from '@kea/protocol'
import { sortEntries } from './sort.ts'

export interface ListedEntry {
  name: string
  kind: TreeKind
}

export interface Listing {
  /** In display order. */
  entries: ListedEntry[]
  /** More entries exist than were read. */
  truncated: boolean
}

function kindOf(d: fs.Dirent): TreeKind {
  if (d.isSymbolicLink()) return 'symlink'
  if (d.isDirectory()) return 'dir'
  if (d.isFile()) return 'file'
  return 'other'
}

/** The directory's entries; null when it cannot be read as a directory (gone, a file now, no permission). */
export async function listDirectory(abs: string, max: number = L.dirCacheEntriesMax): Promise<Listing | null> {
  let dir: fs.Dir
  try {
    dir = await fs.promises.opendir(abs, { bufferSize: 1024 })
  } catch {
    return null
  }
  const entries: ListedEntry[] = []
  let truncated = false
  try {
    for await (const d of dir) {
      if (d.name === '.git') continue
      if (entries.length >= max) {
        truncated = true
        break
      }
      entries.push({ name: fileName(d.name), kind: kindOf(d) })
    }
  } catch {
    // the directory went away under the read: what was read stands, the watcher's event brings the rest
    truncated = entries.length > 0 ? truncated : false
  }
  return { entries: sortEntries(entries), truncated }
}
