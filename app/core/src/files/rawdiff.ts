// `git diff --raw --numstat -z -M <ref>` as a stream of records: every changed path's status letter and its line
// counts from one process. git prints the raw records first, then the numstat records:
//
//   raw       `:<mode> <mode> <oid> <oid> <letter>[score]` NUL `<path>` NUL            (rename, copy: two paths, old then new)
//   numstat   `<added>` TAB `<removed>` TAB `<path>` NUL                               (binary: `-` TAB `-`)
//             `<added>` TAB `<removed>` TAB NUL `<old path>` NUL `<new path>` NUL      (rename, copy)
//
// The two are paired by (new) path. An entry whose numstat record never came (the output was cut) has no counts.

import type { GitCode } from '@kea/protocol'
import { L } from '@kea/protocol'

export interface DiffEntry {
  path: string
  code: GitCode
  /** null: binary, or no numstat record arrived. */
  added: number | null
  removed: number | null
  origPath: string | null
  submodule: boolean
}

/** A raw record's letter as Kea's: a copy is a new file, a type change is a modification, unmerged is a conflict. */
export function diffCode(letter: string): GitCode {
  switch (letter) {
    case 'A':
    case 'C':
      return 'A'
    case 'D':
      return 'D'
    case 'R':
      return 'R'
    case 'U':
      return '!'
    default:
      return 'M'
  }
}

const SUBMODULE_MODE = '160000'

export class DiffParser {
  // bounded: L.gitStatusEntriesMax entries (one more stops the parse)
  readonly entries = new Map<string, DiffEntry>()
  tooMany = false
  private state: 'record' | 'raw-path' | 'raw-old' | 'raw-new' | 'num-old' | 'num-new' = 'record'
  private letter = ''
  private submodule = false
  private old = ''
  private added: number | null = null
  private removed: number | null = null
  private readonly max: number

  constructor(maxEntries: number = L.gitStatusEntriesMax) {
    this.max = maxEntries
  }

  /**
   * One NUL-terminated record. False: stop, at L.gitStatusEntriesMax entries. A record that makes no sense is skipped,
   * never thrown on.
   */
  record(rec: Buffer): boolean {
    const text = rec.toString('utf8')
    switch (this.state) {
      case 'raw-path':
        this.state = 'record'
        return this.add(text, null)
      case 'raw-old':
        this.old = text
        this.state = 'raw-new'
        return true
      case 'raw-new':
        this.state = 'record'
        return this.add(text, this.old)
      case 'num-old':
        this.state = 'num-new'
        return true
      case 'num-new':
        this.state = 'record'
        this.count(text)
        return true
      default:
        break
    }
    if (text.startsWith(':')) {
      // `:100644 100644 <oid> <oid> M` or `… R100`
      const f = text.split(' ')
      const status = f[4] ?? ''
      if (f.length < 5 || status === '') return true
      this.letter = status[0] as string
      this.submodule = f[0] === `:${SUBMODULE_MODE}` || f[1] === SUBMODULE_MODE
      this.state = this.letter === 'R' || this.letter === 'C' ? 'raw-old' : 'raw-path'
      return true
    }
    const t1 = text.indexOf('\t')
    const t2 = t1 < 0 ? -1 : text.indexOf('\t', t1 + 1)
    if (t2 < 0) return true
    const a = text.slice(0, t1)
    const r = text.slice(t1 + 1, t2)
    this.added = /^\d+$/.test(a) ? Number(a) : null
    this.removed = /^\d+$/.test(r) ? Number(r) : null
    const p = text.slice(t2 + 1)
    if (p === '') this.state = 'num-old'
    else this.count(p)
    return true
  }

  private add(p: string, orig: string | null): boolean {
    if (p === '') return true
    if (!this.entries.has(p) && this.entries.size >= this.max) {
      this.tooMany = true
      return false
    }
    const code = diffCode(this.letter)
    this.entries.set(p, { path: p, code, added: null, removed: null, origPath: code === 'R' ? orig : null, submodule: this.submodule })
    return true
  }

  private count(p: string): void {
    const e = this.entries.get(p)
    if (!e) return
    e.added = this.added
    e.removed = this.removed
  }
}
