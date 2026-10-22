// Copy untracked files into a new worktree: with a `.worktreeinclude` (gitignore syntax), every file of the
// main checkout that matches it and is git-ignored; otherwise the project's "Files to copy" (default
// DEFAULT_FILES_TO_COPY), each only if it is not tracked. Never anything tracked, `.git`, or `node_modules` unless a
// pattern names it. Directories that match are cloned whole. Files are copied as a clone where the volume allows
// (`COPYFILE_FICLONE`: an APFS clone, a reflink on Linux), else as a plain copy. The creation log lists names only,
// never contents.
//
// The candidates come from git: ignored entries with whole ignored directories collapsed (`--directory`, so a big
// `node_modules` is one entry and is never walked) plus every untracked, not-ignored file. A pattern that would only
// match inside a wholly ignored directory (`config/.env` when `config/` is ignored) is not looked for.

import fs from 'node:fs'
import path from 'node:path'
import { gitText } from '@kea/kit'
import { DEFAULT_FILES_TO_COPY } from '@kea/protocol'
import { compileRules, matches, type IgnoreRule } from './ignore.ts'

export const WORKTREE_INCLUDE = '.worktreeinclude'

export interface CopyPlan {
  /** Paths relative to the main checkout; a directory has no trailing slash. */
  entries: { rel: string; dir: boolean }[]
  /** Where the patterns came from. */
  source: 'worktreeinclude' | 'settings' | 'default'
}

const namesNodeModules = (rules: readonly IgnoreRule[]) => rules.some((r) => !r.negate && /(^|\/)node_modules$/.test(r.source))

/**
 * Pure selection (U-WT-7): `ignored` and `untracked` as `git ls-files -z` lists them (directories end with `/`).
 * With `.worktreeinclude` only ignored entries qualify.
 */
export function selectCopies(o: { ignored: readonly string[]; untracked: readonly string[]; patterns: readonly string[]; ignoredOnly: boolean }): { rel: string; dir: boolean }[] {
  const rules = compileRules(o.patterns)
  const allowNodeModules = namesNodeModules(rules)
  const seen = new Set<string>()
  const picked: { rel: string; dir: boolean }[] = []
  const candidates = o.ignoredOnly ? o.ignored : [...o.ignored, ...o.untracked]
  for (const c of candidates) {
    const dir = c.endsWith('/')
    const rel = c.replace(/\/+$/, '')
    if (!rel || seen.has(rel)) continue
    const parts = rel.split('/')
    if (parts.includes('.git')) continue
    if (!allowNodeModules && parts.includes('node_modules')) continue
    if (!matches(rules, rel, dir)) continue
    seen.add(rel)
    picked.push({ rel, dir })
  }
  // a directory copied whole carries everything inside it
  const dirs = picked.filter((p) => p.dir).map((p) => `${p.rel}/`)
  return picked.filter((p) => !dirs.some((d) => p.rel.startsWith(d))).sort((a, b) => a.rel.localeCompare(b.rel))
}

const split0 = (s: string) => s.split('\0').filter(Boolean)

/** What would be copied from `root` (the main checkout). */
export async function planCopies(root: string, filesToCopy: readonly string[] | undefined, env?: Record<string, string | undefined>): Promise<CopyPlan> {
  const opts = { cwd: root, readOnly: true, ...(env ? { env } : {}) }
  let include: string | null = null
  try {
    include = await fs.promises.readFile(path.join(root, WORKTREE_INCLUDE), 'utf8')
  } catch {
    include = null
  }
  const ignored = split0(await gitText(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], opts))
  if (include !== null) return { entries: selectCopies({ ignored, untracked: [], patterns: include.split(/\r?\n/), ignoredOnly: true }), source: 'worktreeinclude' }
  const untracked = split0(await gitText(['ls-files', '-z', '--others', '--exclude-standard'], opts))
  const patterns = filesToCopy ?? DEFAULT_FILES_TO_COPY
  return { entries: selectCopies({ ignored, untracked, patterns, ignoredOnly: false }), source: filesToCopy ? 'settings' : 'default' }
}

/**
 * Copy `entries` from `from` to `to` (clone where possible); existing files are replaced (re-sync). The new worktree
 * comes from another commit than the main checkout and can hold tracked symlinks, so nothing is ever written through
 * one, which could lead anywhere outside the worktree: an entry whose parent directories under `to` include a
 * symlink, whose destination is a symlink, or whose parent resolves outside `to` is refused and named, and the others
 * are copied.
 */
export async function copyEntries(from: string, to: string, entries: readonly { rel: string; dir: boolean }[]): Promise<{ copied: string[]; refused: { rel: string; why: string }[] }> {
  const copied: string[] = []
  const refused: { rel: string; why: string }[] = []
  const realTo = await fs.promises.realpath(to)
  for (const e of entries) {
    const name = e.dir ? `${e.rel}/` : e.rel
    const src = path.join(from, e.rel)
    const dst = path.join(to, e.rel)
    if (!dst.startsWith(`${to}/`)) {
      refused.push({ rel: name, why: 'outside the worktree' })
      continue
    }
    const why = await symlinkOnTheWay(to, e.rel)
    if (why) {
      refused.push({ rel: name, why })
      continue
    }
    await fs.promises.mkdir(path.dirname(dst), { recursive: true })
    const parent = await fs.promises.realpath(path.dirname(dst))
    if (parent !== realTo && !parent.startsWith(`${realTo}/`)) {
      refused.push({ rel: name, why: 'its folder resolves outside the worktree' })
      continue
    }
    await fs.promises.cp(src, dst, { recursive: e.dir, force: true, errorOnExist: false, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true, preserveTimestamps: true })
    copied.push(name)
  }
  return { copied, refused }
}

/** Why writing `rel` under `root` would pass through a symlink (a component of it, or the entry itself), or null. */
async function symlinkOnTheWay(root: string, rel: string): Promise<string | null> {
  const parts = rel.split('/').filter(Boolean)
  let cur = root
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]!)
    let st: fs.Stats
    try {
      st = await fs.promises.lstat(cur)
    } catch {
      return null // not there yet: mkdir makes real directories from here on
    }
    if (st.isSymbolicLink()) return `${parts.slice(0, i + 1).join('/')} is a symlink in the worktree`
    if (i < parts.length - 1 && !st.isDirectory()) return `${parts.slice(0, i + 1).join('/')} is not a folder in the worktree`
  }
  return null
}
