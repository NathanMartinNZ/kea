// Claude's usage limits through a status line of the session's own (`agents.claude.usageLimits`, on by default).
// Claude has no exec form for `statusLine`: it runs `command` through a shell, so the command is the one shell string
// Kea builds, every word single-quoted (`shellWord`). It runs `kea-helper statusline`, which keeps only the
// projection's fields (the usage windows and the session id), hands them to core as a hook's envelope, and prints
// nothing: Claude's footer gains no line. With any status line set Claude no longer shows its "esc to interrupt" hint
// (Esc still interrupts), which the setting's help says, so it can be turned off. A status line in the inline settings
// replaces the user's own, so none is added when their user, project or local settings define one (read here, never
// written).

import fs from 'node:fs'
import path from 'node:path'
import { L } from '@kea/protocol'
import type { AgentSettingsLike, Env } from '../types.ts'
import { configDir } from './config.ts'
import { CONFIG_DIR_NAME, LOCAL_SETTINGS_FILE, SETTINGS_FILE, SETTINGS_STATUS_LINE, STATUS_LINE_FIELDS } from './contract.ts'

/** The setting that turns the status line on. */
export const USAGE_LIMITS_KEY = 'usageLimits'

/** `agents.claude.usageLimits`: on unless it is `false` (its default is on). */
export function usageLimitsOn(settings: Pick<AgentSettingsLike, string>): boolean {
  return settings[USAGE_LIMITS_KEY] !== false
}

/** The status line's `--project`, generated from the contract: the usage windows and the session id, kept as is. */
export function statusLineProjection(): { keep: string[]; count: string[]; summarise: string[] } {
  return { keep: Object.values(STATUS_LINE_FIELDS), count: [], summarise: [] }
}

// ── the one shell string ───────────────────────────────────────────────────────────────────────────────

/** One word for a POSIX shell: single-quoted, each `'` written `'\''`; nothing inside single quotes is interpreted. */
export function shellWord(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/**
 * The words of a command `shellWord` built and joined with single spaces, or null for any other text: a status line
 * Kea did not make is never read as one of its own.
 */
export function shellWords(command: string): string[] | null {
  const out: string[] = []
  let i = 0
  while (i < command.length) {
    if (out.length > 0) {
      if (command[i] !== ' ') return null
      i++
    }
    if (command[i] !== "'") return null
    let word = ''
    for (;;) {
      const end = command.indexOf("'", i + 1)
      if (end < 0) return null
      word += command.slice(i + 1, end)
      i = end + 1
      // `'\''`: a quote inside the word, then the quoting goes on
      if (!command.startsWith(`\\''`, i)) break
      word += "'"
      i += 2
    }
    out.push(word)
  }
  return out.length > 0 ? out : null
}

// ── the user's own status line ─────────────────────────────────────────────────────────────────────────

const TOO_LARGE = Symbol('too large')

/**
 * A small file's text, opened without waiting (a FIFO in its place never blocks core) and read whole if it is a
 * regular file (through symlinks: settings are often linked from elsewhere) of at most `max` bytes. Null when it is
 * absent or not a regular file; TOO_LARGE above `max`.
 */
function readSmall(file: string, max: number = L.settingsInlineMaxBytes): string | null | typeof TOO_LARGE {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    const st = fs.fstatSync(fd)
    if (!st.isFile()) return null
    if (st.size > max) return TOO_LARGE
    const buf = Buffer.alloc(st.size)
    let got = 0
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got)
      if (n <= 0) break
      got += n
    }
    return buf.subarray(0, got).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** Whether a settings file's text defines a status line. One too large to read whole might: it counts as one. */
function definesStatusLine(text: string | null | typeof TOO_LARGE): boolean {
  if (text === TOO_LARGE) return true
  if (text === null) return false
  try {
    const v = JSON.parse(text) as unknown
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
    const line = (v as Record<string, unknown>)[SETTINGS_STATUS_LINE]
    return line !== undefined && line !== null
  } catch {
    return false // Claude does not use a settings file it cannot parse either
  }
}

/**
 * The main checkout of the git worktree at `dir` (its `.git` a file naming the worktree's git folder, whose `commondir`
 * leads to the main checkout's `.git`), or null for a main checkout, a bare repository or no repository.
 */
function mainCheckout(dir: string): string | null {
  const dotGit = readSmall(path.join(dir, '.git'))
  if (typeof dotGit !== 'string') return null
  const m = /^gitdir: (.+)$/m.exec(dotGit)
  if (!m) return null
  const gitDir = path.resolve(dir, m[1]!.trim())
  const common = readSmall(path.join(gitDir, 'commondir'))
  if (typeof common !== 'string' || common.trim() === '') return null
  const commonDir = path.resolve(gitDir, common.trim())
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null
}

/**
 * Whether the user's own settings define a status line for an agent started in `cwd` with `env`: the user's settings
 * in the config folder, the project's and the local settings in `cwd`, and the local settings of the main checkout
 * when `cwd` is a worktree (Claude shares them from there). Kea's would replace theirs, so it adds none then.
 */
export function ownStatusLine(env: Readonly<Env>, cwd: string): boolean {
  const files: string[] = []
  const dir = configDir(env)
  if (dir) files.push(path.join(dir, SETTINGS_FILE))
  files.push(path.join(cwd, CONFIG_DIR_NAME, SETTINGS_FILE), path.join(cwd, CONFIG_DIR_NAME, LOCAL_SETTINGS_FILE))
  const main = mainCheckout(cwd)
  if (main && main !== cwd) files.push(path.join(main, CONFIG_DIR_NAME, LOCAL_SETTINGS_FILE))
  return files.some((f) => definesStatusLine(readSmall(f)))
}
