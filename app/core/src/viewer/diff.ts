// A diff's two sides and the gutter's changed lines, through the `git` pool with byte caps.
//
// What to compare against is not decided here: the git scheduler's facts (files/facts.ts) give the session's active
// scope, the commit that scope compares against (the merge base for Branch, `HEAD` for Uncommitted) and the path's
// status entry, so the diff always agrees with the Changes list. The old side is the blob at `<base>:<path>` (a
// rename's old path), read with `git cat-file blob`: the stored bytes, with no textconv, filter or pager run on them. A
// path the base does not have (untracked, added) has no old side and shows as fully added; a file that is gone from the
// working tree has no new side and shows as fully removed. One row has neither in the base nor on disk: a file added to
// git and then deleted (`GitEntry.indexOnly`). Git's index has its only copy, and that is its old side (`:0:<path>`),
// so the diff shows what Discard would put back. Either side over the limits, and nothing of the diff is sent.

import { git } from '@kea/kit'
import { imageExtension, L, type DiffRead, type DiffScope, type DiffSide, type GitEntry, type LineChanges } from '@kea/protocol'
import { countLines, detect } from './detect.ts'
import { HunkParser } from './hunks.ts'
import { readFile } from './read.ts'

export interface DiffFacts {
  scope: DiffScope
  /** A full object id, or null: nothing to compare against. */
  base: string | null
  entry: GitEntry | null
}

export interface GitRun {
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  signal?: AbortSignal
}

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/

interface OldSide {
  exists: boolean
  /** Null: over `maxBytes` (its size is not known). */
  bytes: Buffer<ArrayBuffer> | null
}

/** The index's own entry of a path: stage 0, named in full so that a file called `2:x` is not read as a conflict's stage. */
const IN_INDEX = ':0'

/**
 * The blob at `<tree>:<path>`, up to `maxBytes`; `tree` is a commit, or `IN_INDEX`. A path the commit (or the index)
 * does not have is `exists: false`.
 */
async function readBlob(run: GitRun, tree: string, path: string, maxBytes: number): Promise<OldSide> {
  const r = await git(['cat-file', 'blob', `${tree}:${path}`], { ...run, readOnly: true, collect: true, maxBytes: maxBytes + 1 })
  if (r.cancelled) throw new Error('cancelled')
  // one byte more than the limit is asked for, so a blob of exactly the limit is not taken for a longer one
  if (r.truncated || r.stdoutBytes > maxBytes) return { exists: true, bytes: null }
  if (r.code !== 0 || r.timedOut) return { exists: false, bytes: Buffer.alloc(0) }
  const out = r.stdout ?? Buffer.alloc(0)
  // a buffer of its own: what `runProcess` collected may be a view of something larger
  return { exists: true, bytes: Buffer.from(out) as Buffer<ArrayBuffer> }
}

const noSide: DiffSide = { exists: false, size: 0, text: null, image: null }

/** `viewer.diff`. */
export async function readDiff(run: GitRun, rel: string, facts: DiffFacts): Promise<DiffRead> {
  const image = imageExtension(rel) !== null
  const limit = image ? L.imageMaxBytes : L.diffMaxBytes
  const base = facts.base !== null && OBJECT_ID.test(facts.base) ? facts.base : null
  const [fresh, old] = await Promise.all([
    // an image's new side is shown through kea-file://: only its size and date are needed here
    readFile(run.cwd, rel, { maxBytes: limit }),
    // the index's alone: the base has no such file, so what the index holds is what there is to show (and to restore)
    facts.entry?.indexOnly ? readBlob(run, IN_INDEX, rel, limit) : base ? readBlob(run, base, facts.entry?.origPath ?? rel, limit) : Promise.resolve<OldSide>({ exists: false, bytes: Buffer.alloc(0) }),
  ])
  const head = { scope: facts.scope, base, code: facts.entry?.code ?? null, origPath: facts.entry?.origPath ?? null, mtimeMs: fresh.mtimeMs }
  const newExists = fresh.kind !== 'missing' && fresh.kind !== 'outside' && fresh.kind !== 'directory'
  const newSide: DiffSide = newExists ? { exists: true, size: fresh.size, text: null, image: null } : noSide
  const oldSide: DiffSide = old.exists ? { exists: true, size: old.bytes?.length ?? 0, text: null, image: null } : noSide
  if (image) return { ...head, kind: 'image', old: { ...oldSide, image: old.exists ? old.bytes : null }, new: newSide }
  if (old.bytes === null || fresh.kind === 'large') return { ...head, kind: 'large', old: oldSide, new: newSide }
  const was = detect(old.bytes)
  if (was.binary || fresh.kind === 'binary') return { ...head, kind: 'binary', old: oldSide, new: newSide }
  const now = fresh.text
  if (countLines(old.bytes, L.diffMaxLines) > L.diffMaxLines || (now && countLines(now.bytes, L.diffMaxLines) > L.diffMaxLines)) return { ...head, kind: 'large', old: oldSide, new: newSide }
  return {
    ...head,
    kind: 'text',
    old: { ...oldSide, text: old.exists ? { bytes: old.bytes, encoding: was.encoding, invalid: was.invalid, eol: was.eol } : null },
    new: { ...newSide, text: now },
  }
}

/** `viewer.changes`: the hunk headers of `git diff -U0 <base> -- <path>`, read as they stream. */
export async function readChanges(run: GitRun, rel: string, facts: DiffFacts): Promise<LineChanges> {
  const base = facts.base !== null && OBJECT_ID.test(facts.base) ? facts.base : null
  const none = { scope: facts.scope, base, changes: [], whole: false, truncated: false }
  // a file the status lists as untracked, or with nothing to compare it against, is new as a whole; one it does not list
  // (a folder that is not a repository, an ignored file, a status not read yet) carries no markers
  if (base === null || facts.entry?.code === 'U') return { ...none, whole: facts.entry !== null }
  const parser = new HunkParser(L.viewerChangeRangesMax)
  const orig = facts.entry?.origPath ?? null
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', ...(orig ? ['-M'] : ['--no-renames']), base, '--', ...(orig ? [orig] : []), rel]
  // the paths are names, not patterns: a file called `*` is not every file, `:x` no pathspec magic
  const r = await git(args, { ...run, env: { ...run.env, GIT_LITERAL_PATHSPECS: '1' }, readOnly: true, collect: false, maxBytes: L.viewerChangesMaxBytes, onStdout: (chunk) => parser.push(chunk) })
  if (r.cancelled) throw new Error('cancelled')
  parser.end()
  if (r.truncated || parser.overflow) return { ...none, truncated: true }
  // exit 1 is not used without --exit-code; any failure (no such commit, not a repository) shows no markers
  if (r.code !== 0 || r.timedOut) return none
  return { ...none, changes: parser.changes }
}
