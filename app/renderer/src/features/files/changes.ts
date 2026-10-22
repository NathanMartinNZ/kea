// What the Changes view and the header's diff stat say, as text and data from the git facts of `git:<sessionId>`. Pure:
// the components (Changes.svelte, DiffStat.svelte) only lay it out.

import type { DiffScope, DiscardAction, GitCode, GitEntry, GitHead, GitOperation, LineChanges } from '@kea/protocol'
import { classOf, type StatusClass } from './rollup.ts'

/** U+2212, the minus of `+182 −40`. */
const MINUS = '−'

export interface ChangeRow {
  path: string
  /** The status letter; `S` for a submodule. */
  letter: string
  cls: StatusClass
  /** The file's name; for a rename `old → new` (the old one with its folder when it came from another). */
  name: string
  /** The folder it is in, dim; '' at the top level. */
  dir: string
  /** Deleted files are struck through. */
  struck: boolean
  /**
   * `+12` and `−3`; null where there is no count (a binary file, a file too big to count, an untracked file's removed
   * lines) and where the count is of nothing: an entry with no changed line (a pure rename, an empty new file) shows
   * none, never `+0 −0`.
   */
  added: string | null
  removed: string | null
}

/** What a status letter stands for (the letter's tooltip: status is never colour or a letter alone). */
export const LETTER_NAMES: Readonly<Record<string, string>> = { M: 'Modified', A: 'Added', U: 'Untracked', D: 'Deleted', R: 'Renamed', '!': 'Conflicted', S: 'Submodule' }

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/** No line was counted on either side: there is nothing to show. */
const noLines = (added: number | null, removed: number | null): boolean => !added && !removed

export function changeRow(e: GitEntry): ChangeRow {
  const dir = dirName(e.path)
  let name = baseName(e.path)
  if (e.origPath !== null) name = `${dirName(e.origPath) === dir ? baseName(e.origPath) : e.origPath} → ${name}`
  const none = noLines(e.added, e.removed)
  return {
    path: e.path,
    letter: e.submodule ? 'S' : e.code,
    cls: classOf(e.code),
    name,
    dir,
    struck: e.code === 'D',
    added: none || e.added === null ? null : `+${e.added}`,
    removed: none || e.removed === null ? null : `${MINUS}${e.removed}`,
  }
}

/**
 * A folder's path in two parts, for a cut in its middle (a path is cut in the middle, a title at its end):
 * `head` gives way when there is not room and ends in the ellipsis; `tail`, the last folder with its `/`, stays whole.
 * A path of one folder is all tail. The two put together are the path again.
 */
export function midPath(dir: string): { head: string; tail: string } {
  const cut = Math.max(0, dir.lastIndexOf('/'))
  return { head: dir.slice(0, cut), tail: dir.slice(cut) }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * `7 files  +182 −40`: the header's totals in the active scope. Null while there is no status, and while nothing has
 * changed ("No changes yet." says it; `0 files +0 −0` above it says nothing more). Files with no changed line among
 * them (renames only) are counted alone: `2 files`.
 */
export function totalsText(head: GitHead | null): { files: string; added: string | null; removed: string | null } | null {
  const t = head?.totals
  if (!head || !t || t.files === 0 || (head.state ?? 'ok') === 'loading') return null
  const none = noLines(t.added, t.removed)
  return { files: plural(t.files, 'file', 'files'), added: none ? null : `+${t.added}`, removed: none ? null : `${MINUS}${t.removed}` }
}

/**
 * The header's diff stat `+182 −40`: only while the session has changes. Where no line was counted (only renames or
 * binary files changed) it says how many files instead (`files`), never `+0 −0`.
 */
export function diffStat(head: GitHead | null): { added: string | null; removed: string | null; files: string; label: string } | null {
  const t = head?.totals
  const state = head?.state ?? 'ok'
  if (!head || !t || t.files === 0 || (state !== 'ok' && state !== 'unavailable')) return null
  const files = plural(t.files, 'file', 'files')
  if (noLines(t.added, t.removed)) return { added: null, removed: null, files, label: `${plural(t.files, 'changed file', 'changed files')}, no line counted: show Changes` }
  return { added: `+${t.added}`, removed: `${MINUS}${t.removed}`, files, label: `${plural(t.files, 'changed file', 'changed files')}, ${plural(t.added, 'line', 'lines')} added, ${t.removed} removed: show Changes` }
}

export interface LineCounts {
  added: number
  removed: number
}

/**
 * A diff's header says a status letter and `+n −n`, and the two say one thing. The status's entry for the path
 * gives both: its letter, and git's counts (a file git or Kea did not count is counted from the diff on screen). A path
 * the status has no entry for (too many changes to track, so no file has one) gets both from the diff on screen
 * (`shown`: which sides are there, and the lines that differ; null before it is read, counts null where it is not
 * text): added or deleted by the side that is not there, modified when lines differ. Where nothing says the file
 * changed there is no letter, and then no counts; and a count of nothing is not shown (a pure rename).
 */
export function diffHeader(entry: GitEntry | null, shown: { old: boolean; new: boolean; counts: LineCounts | null } | null): { letter: GitCode | null; counts: LineCounts | null } {
  const some = (c: LineCounts | null): LineCounts | null => (c && !noLines(c.added, c.removed) ? c : null)
  if (entry) return { letter: entry.code, counts: some(entry.added !== null && entry.removed !== null ? { added: entry.added, removed: entry.removed } : (shown?.counts ?? null)) }
  if (!shown) return { letter: null, counts: null }
  const letter: GitCode | null = shown.old !== shown.new ? (shown.new ? 'A' : 'D') : some(shown.counts) ? 'M' : null
  return { letter, counts: letter ? some(shown.counts) : null }
}

const OPERATION: Record<GitOperation['kind'], string> = { rebase: 'REBASING', merge: 'MERGING', 'cherry-pick': 'CHERRY-PICKING', revert: 'REVERTING', bisect: 'BISECTING' }

export interface BranchLine {
  /** The branch, or a detached HEAD's short id. */
  name: string
  detached: boolean
  /** `← main`: what the Branch scope compares with; null when the session has no base branch. */
  base: string | null
  /** `↑3`: commits since the base. */
  ahead: string | null
  /** "behind 12": the base has moved on. */
  behind: string | null
  /** `REBASING 2/5`, `MERGING`. */
  operation: string | null
}

/** The branch line `kea/fix-auth ← main  ↑3`. Null until git has said where HEAD is. */
export function branchLine(head: GitHead | null): BranchLine | null {
  if (!head) return null
  const name = head.branch ?? head.detached ?? null
  if (name === null) return null
  const op = head.operation ?? null
  return {
    name,
    detached: !head.branch,
    base: head.baseBranch ?? null,
    ahead: head.ahead ? `↑${head.ahead}` : null,
    behind: head.behind ? `behind ${head.behind}` : null,
    operation: op ? `${OPERATION[op.kind]}${op.step !== null && op.total !== null ? ` ${op.step}/${op.total}` : ''}` : null,
  }
}

/** The branch line as one string (the accessible name, and what tests read). */
export function branchText(b: BranchLine): string {
  return [b.operation, b.name, b.base ? `← ${b.base}` : null, b.ahead, b.behind].filter(Boolean).join(' ')
}

/** The changed paths as text, one per line, in the list's order (`files.copyChangedList`). */
export function changedList(entries: readonly GitEntry[]): string {
  return entries.map((e) => e.path).join('\n')
}

// ── Discard Changes… ─────────────────────────────────────────────────────────────────────────────────────

export interface DiscardStep {
  path: string
  expect: DiscardAction
}

export interface DiscardPlan {
  /** What core is asked to do, in order; it does each only if the file is still as this says. */
  steps: DiscardStep[]
  /**
   * What the sentence was written for: the scope on screen, and the commit it compared against (the status's head).
   * Every request carries them, and core refuses when either is no longer so at the click.
   */
  scope: DiffScope
  base: string | null
  /** The sheet's sentence. */
  text: string
  /** The destructive button. */
  button: string
}

/** Why a changed entry cannot be discarded from here; null when it can. */
export function discardBlocked(e: GitEntry): string | null {
  if (e.submodule) return 'A submodule’s changes are discarded inside it'
  if (e.code === '!') return 'Resolve the conflict first'
  return null
}

/**
 * What discarding `e` means, said before it is done, for the status `head` describes: a file the comparison base has
 * is put back as it is there; one it does not have (added) goes to the Trash, and so does every file git does not
 * track (`U` says nothing of the base, and what git does not track is never written over). A rename is both: the old
 * file back, the new one to the Trash. A deleted file the base does not have (added to git, then deleted from disk)
 * is put back as git's index has it: its row then reads as added.
 */
export function discardPlan(e: GitEntry, head: GitHead): DiscardPlan {
  const name = baseName(e.path)
  const base = baseLabel(head)
  const said = { scope: head.scope, base: head.base }
  switch (e.code) {
    case 'U':
      return { ...said, steps: [{ path: e.path, expect: 'trash' }], text: `Move ${name} to the Trash? It is a new file that git does not track.`, button: 'Move to Trash' }
    case 'A':
      return { ...said, steps: [{ path: e.path, expect: 'trash' }], text: `Move ${name} to the Trash? It is a new file: ${base} does not have it.`, button: 'Move to Trash' }
    case 'R': {
      const old = e.origPath ?? e.path
      return {
        ...said,
        steps: [
          { path: e.path, expect: 'trash' },
          { path: old, expect: 'restore' },
        ],
        text: `Undo the rename of ${baseName(old)} to ${name}? ${baseName(old)} is put back as it is in ${base}, and ${name} moves to the Trash.`,
        button: 'Discard Changes',
      }
    }
    case 'D':
      // added to git and then deleted from disk: the base has no such file, git's index has the only copy (`indexOnly`)
      if (e.indexOnly) return { ...said, steps: [{ path: e.path, expect: 'restoreStaged' }], text: `Restore ${name}? It was added to git and then deleted from disk, and ${base} does not have it: it is put back as it was added.`, button: 'Restore' }
      return { ...said, steps: [{ path: e.path, expect: 'restore' }], text: `Restore ${name}? It is put back as it is in ${base}.`, button: 'Restore' }
    default:
      return { ...said, steps: [{ path: e.path, expect: 'restore' }], text: `Discard the changes to ${name}? It is put back as it is in ${base}; the changes cannot be brought back.`, button: 'Discard Changes' }
  }
}

/** The `files.discard` calls a confirmed plan makes, in order: each says what the sheet said, the scope and its base too. */
export function discardRequests(sessionId: string, plan: DiscardPlan): { sessionId: string; path: string; expect: DiscardAction; scope: DiffScope; base: string | null }[] {
  return plan.steps.map((step) => ({ sessionId, path: step.path, expect: step.expect, scope: plan.scope, base: plan.base }))
}

/** What the comparison base is called in the sheet: the base branch (Branch scope) or the last commit. */
export function baseLabel(head: GitHead | null): string {
  if (head?.scope === 'uncommitted') return 'the last commit'
  return head?.baseBranch ? `${head.baseBranch} (where this branch started)` : 'the commit this session started from'
}

/** Core's refusals as the toast says them (`DISCARD_REFUSALS`). */
export const DISCARD_REFUSED: Readonly<Record<string, string>> = {
  unchanged: 'The file has no changes to discard any more',
  changed: 'The file, or what it is compared with, changed since you were asked; nothing was discarded',
  directory: 'Kea discards one file at a time, not a folder',
  submodule: 'A submodule’s changes are discarded inside it',
  conflict: 'Resolve the conflict first',
  outside: 'The file is outside the session’s folder',
  notGit: 'This folder is not a git repository',
  noTrash: 'This Mac has no `trash` tool (macOS 15 or later); the file was left alone',
  failed: 'Git could not discard the changes',
}

/**
 * The toast for a refused discard: its sentence, then core's detail. A missing trash tool that core names itself
 * (Linux: no `gio` and no trash folder) is that sentence alone, since the macOS one would be wrong there.
 */
export function refusalMessage(refused: string, detail?: string): string {
  if (refused === 'noTrash' && detail) return detail
  const why = DISCARD_REFUSED[refused] ?? 'The changes could not be discarded'
  return detail ? `${why}: ${detail}` : why
}

/**
 * Where Open in Editor lands for a file opened from the Changes list: its first changed line, from the file's changed
 * ranges (`viewer.changes`). A file that is new as a whole starts at line 1; where the first change only removed
 * lines, it is the line they were removed after (the line the viewer's gutter marks), or line 1 when they were the
 * file's first. Null: no position (nothing changed in the text, or more ranges than are read).
 */
export function firstChangedLine(c: LineChanges): number | null {
  if (c.whole) return 1
  const first = c.changes[0]
  return c.truncated || !first ? null : Math.max(1, first.from)
}
