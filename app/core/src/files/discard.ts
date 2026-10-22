// Discard Changes: the file panel's one mutating action, for one file of a session's working directory. The window has
// asked first; this looks at the file again and does only what the confirmation named (`expect`):
//
//   restore   git tracks the file and the commit the active scope compares against has it: put it back as it is
//             there, in the index and the working tree (`git checkout <base> -- <path>`)
//   trash     a file git does not track, or one that commit does not have (added since): move it to the trash with the
//             system's tool (macOS `trash`, Linux `gio trash`), then take it out of the index. Never an unlink: without
//             the tool nothing is done
//   restoreStaged
//             a file that commit does not have and the disk does not have either, but git's index does (added to
//             git, then deleted from disk): put it back in the working tree as the index has it
//             (`git checkout -- <path>`). Its row then reads as added, and a second discard moves it to the Trash
//
// A change is what the working tree has that the base has not, and also what only the index has (a staged edit whose
// file was written back, a staged file deleted from disk): `git status` lists those in Uncommitted, and so does Kea.
//
// A file git does not track is never overwritten, also where the base has a file at its path (the session deleted
// that one and wrote another): it goes to the Trash, the path then reads as deleted, and a second discard restores.
//
// It refuses everything else and then touches nothing: a path that is not a change (an ignored file above all), a
// folder, a submodule, an unmerged path, a path that leaves the working directory through a symlinked folder, an
// expectation that no longer holds. Whether the scope and its base are still the ones the confirmation named is the
// caller's check (`SessionFiles.discard`), made before this runs.

import fs from 'node:fs'
import path from 'node:path'
import { fileName, git, runProcess, type ProcessResult } from '@kea/kit'
import { isAvailable, L, type DiscardAction, type DiscardResult } from '@kea/protocol'
import { coreOs } from '../os/index.ts'
import type { Env } from './status.ts'

export interface DiscardRequest {
  /** The session's working directory, canonical (`SessionFiles.root`). */
  root: string
  /** Relative to `root` (a `zWorktreePath`). */
  rel: string
  /** The commit the active scope compares against; null when there is none (a repository with no commit). */
  base: string | null
  expect: DiscardAction
  env: Env
  /** Where the `trash` tool is looked for (the OS layer's `trash`); null, or no executable there: there is none. */
  trashTool: string | null
}

/** The tool's arguments for `file` and what a refusal adds when there is none: the system's (the OS layer's `trash`). */
function trashUse(): { args: (file: string) => string[]; missing: string | null } {
  return isAvailable(coreOs.trash) ? coreOs.trash : { args: (file) => [file], missing: null }
}

/** An ordinary record of `git status --porcelain=v2`: `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`, the path last. */
const STATUS_PATH_FIELD = 8

function executable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Where core looks for the `trash` tool: this system's (the OS layer's `trash`: macOS `/usr/bin/trash`, Linux GLib's
 * `gio`; null where it has none). A dev build run by the test harness, which names the run's own folder (core main.ts,
 * as for editors: editor/host.ts), looks only for `<sandbox>/bin/trash`, given the system's arguments, so a test never
 * reaches the real Trash. Whether one is there is looked at when a file is to be moved: without it the discard is
 * refused.
 */
export function trashToolFor(sandbox: string | null): string | null {
  if (sandbox !== null) return path.join(sandbox, 'bin', 'trash')
  return isAvailable(coreOs.trash) ? coreOs.trash.tool : null
}

const refuse = (refused: Exclude<DiscardResult, { ok: true }>['refused'], detail?: string): DiscardResult =>
  detail ? { ok: false, refused, detail: detail.slice(0, L.discardDetailMaxChars) } : { ok: false, refused }

/** The last line a failed run wrote (what the toast shows). */
function said(r: ProcessResult): string {
  if (r.timedOut) return 'timed out'
  const lines = r.stderr.trim().split('\n')
  return (lines[lines.length - 1] ?? '').trim() || `exit ${r.code ?? r.signal ?? '?'}`
}

function lstat(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file)
  } catch {
    return null
  }
}

/** The folder a path lies in must itself lie inside `root` once symlinks are resolved. */
function leadsInside(root: string, abs: string): boolean {
  let dir = path.dirname(abs)
  for (;;) {
    let real: string
    try {
      real = fileName(fs.realpathSync.native(dir))
    } catch {
      // a folder that is gone (a deleted file's): its nearest existing ancestor decides
      const up = path.dirname(dir)
      if (up === dir) return false
      dir = up
      continue
    }
    return real === root || real.startsWith(root + path.sep)
  }
}

export async function discardFile(q: DiscardRequest): Promise<DiscardResult> {
  const abs = path.join(q.root, q.rel)
  if (!leadsInside(q.root, abs)) return refuse('outside')
  const st = lstat(abs)
  if (st?.isDirectory()) return refuse('directory')

  // pathspecs are the path itself, never a pattern (a file may be named `*`)
  const env: Env = { ...q.env, GIT_LITERAL_PATHSPECS: '1' }
  const read = (args: string[]): Promise<ProcessResult> => git(args, { cwd: q.root, env, readOnly: true, collect: true, timeoutMs: L.gitStatusTimeoutMs })
  const write = (args: string[]): Promise<ProcessResult> => git(args, { cwd: q.root, env, collect: true, timeoutMs: L.gitStatusTimeoutMs })

  // what git says of the path now
  const status = await read(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames', '--', q.rel])
  if (status.code !== 0) return refuse('failed', said(status))
  let untracked = false
  let listed = false // the status has a tracked change at this very path (the index or the working tree differs from HEAD)
  for (const rec of (status.stdout ?? Buffer.alloc(0)).toString('utf8').split('\0')) {
    if (rec.startsWith('u ')) return refuse('conflict')
    if (rec.startsWith('1 ')) {
      const f = rec.split(' ')
      if (f[2]?.startsWith('S')) return refuse('submodule')
      if (f.slice(STATUS_PATH_FIELD).join(' ') === q.rel) listed = true
    }
    if (rec === `? ${q.rel}`) untracked = true
  }

  // what the base has there
  let atBase = false
  if (q.base !== null) {
    const tree = await read(['ls-tree', '-z', q.base, '--', q.rel])
    if (tree.code !== 0) return refuse('failed', said(tree))
    const rec = (tree.stdout ?? Buffer.alloc(0)).toString('utf8').split('\0')[0] ?? ''
    const kind = rec.split('\t')[0]?.split(' ')[1]
    if (kind === 'commit') return refuse('submodule')
    if (kind === 'tree') return refuse('directory')
    atBase = kind === 'blob'
  }

  // is it a change at all? (an ignored file is neither untracked, nor listed by the status, nor different from the
  // base). What the status lists is one also where the working tree reads as the base: the index holds the change
  if (!untracked && !listed) {
    if (q.base === null) return refuse('unchanged')
    const diff = await read(['diff', '--quiet', '--no-ext-diff', q.base, '--', q.rel])
    if (diff.code === 0) return refuse('unchanged')
    if (diff.code !== 1) return refuse('failed', said(diff))
  }

  // what git does not track goes to the Trash whatever the base has there: a checkout would write over it for good.
  // A tracked path the base does not have: on disk it is a new file, for the Trash; gone from disk, the index has
  // the only copy, and that is what can be put back
  const action: DiscardAction = untracked ? 'trash' : atBase ? 'restore' : st === null ? 'restoreStaged' : 'trash'
  if (action !== q.expect) return refuse('changed')

  if (action === 'restore') {
    const r = await write(['checkout', q.base as string, '--', q.rel])
    return r.code === 0 ? { ok: true, did: 'restore' } : refuse('failed', said(r))
  }
  if (action === 'restoreStaged') {
    const r = await write(['checkout', '--', q.rel])
    return r.code === 0 ? { ok: true, did: 'restoreStaged' } : refuse('failed', said(r))
  }

  if (st) {
    const use = trashUse()
    if (q.trashTool === null || !executable(q.trashTool)) return use.missing === null ? refuse('noTrash') : refuse('noTrash', use.missing)
    let r: ProcessResult
    try {
      r = await runProcess(q.trashTool, use.args(abs), { pool: 'other', collect: true, timeoutMs: L.discardTrashTimeoutMs, env: q.env })
    } catch (e) {
      return refuse('failed', String(e))
    }
    if (r.code !== 0) return refuse('failed', said(r))
    if (lstat(abs)) return refuse('failed', 'the file is still there')
  }
  if (!untracked) {
    const r = await write(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', q.rel])
    if (r.code !== 0) return refuse('failed', said(r))
  }
  return { ok: true, did: 'trash' }
}
