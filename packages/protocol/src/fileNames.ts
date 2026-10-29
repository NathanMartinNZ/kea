// The names the person types in the file tree: one segment for a rename, a `/`-separated path for a new file or folder
// (`src/lib/a.ts` makes the folders on the way). The window checks a name before it asks, and core checks it again
// before it acts; both use this one rule. Also a size as the copy sheet and core's refusals write it.

import { L } from './generated/limits.ts'
import { hasControlCharacter } from './terminal.ts'

export type NameCheck = { ok: true; segments: string[] } | { ok: false; reason: string }

/**
 * The code points git's own check of a `.git` name skips on HFS+ (`is_hfs_dotgit`): the volume ignores them, so
 * `.g‌it` names the repository's own folder there.
 */
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g

/** A segment git treats as `.git`: any case, with or without the code points the volume ignores. */
export function isGitSegment(segment: string): boolean {
  return segment.replace(HFS_IGNORABLE, '').toLowerCase() === '.git'
}

/** Does the relative path pass through, or name, a segment git treats as `.git`? */
export function hasGitSegment(rel: string): boolean {
  return rel.split('/').some(isGitSegment)
}

const utf8 = new TextEncoder()
const bytes = (s: string): number => utf8.encode(s).length

/**
 * Is `name` a name the file tree may give? `nested`: a new entry's name, where `/` separates folders to make on the
 * way; otherwise one segment (a rename). `dir`: the folder it goes in (`''`, the session's folder), counted in the
 * path's length. The reason is written for the place under the field.
 */
export function checkName(name: string, o: { nested: boolean; dir?: string }): NameCheck {
  if (name === '') return { ok: false, reason: 'Type a name' }
  if (hasControlCharacter(name)) return { ok: false, reason: 'A name cannot hold a control character' }
  if (!o.nested && name.includes('/')) return { ok: false, reason: 'A name cannot hold “/”' }
  const segments = name.split('/')
  for (const seg of segments) {
    if (seg === '') return { ok: false, reason: 'A name cannot begin or end with “/”, or hold “//”' }
    if (seg === '.' || seg === '..') return { ok: false, reason: '“.” and “..” are not names' }
    if (seg.trim() !== seg) return { ok: false, reason: 'A name cannot begin or end with a space' }
    if (isGitSegment(seg)) return { ok: false, reason: '“.git” is git’s own folder' }
    if (bytes(seg) > L.fileNameMaxBytes) return { ok: false, reason: `A name is at most ${L.fileNameMaxBytes} bytes long` }
  }
  const full = o.dir ? `${o.dir}/${name}` : name
  if (bytes(full) > L.filePathMaxBytes) return { ok: false, reason: `A path is at most ${L.filePathMaxBytes} bytes long` }
  return { ok: true, segments }
}

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const

/** A size as Finder writes it, in decimal units: `512 bytes`, `12 MB`, `1.5 GB`. */
export function sizeText(n: number): string {
  if (n < 1000) return `${n} ${n === 1 ? 'byte' : 'bytes'}`
  let v = n / 1000
  let u = 0
  while (v >= 1000 && u < UNITS.length - 1) {
    v /= 1000
    u++
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${UNITS[u]}`
}
