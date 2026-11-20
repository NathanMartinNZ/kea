// Where Antigravity CLI keeps its configuration, transcripts and user settings under HOME, plus the bounded non-blocking
// check for an active user-defined `statusLine` in `~/.gemini/antigravity-cli/settings.json`.

import fs from 'node:fs'
import path from 'node:path'
import { L } from '@kea/protocol'
import type { Env } from '../types.ts'
import { CONFIG, SETTINGS_KEYS } from './contract.ts'

/** The configuration directory in `env`: `<HOME>/.gemini/antigravity-cli`, or null when `HOME` is unset or relative. */
export function configDir(env: Readonly<Env>): string | null {
  return env.HOME && path.isAbsolute(env.HOME) ? path.join(env.HOME, ...CONFIG.dir) : null
}

/** The user's `settings.json` path in `env`: `<HOME>/.gemini/antigravity-cli/settings.json`, or null. */
export function settingsFile(env: Readonly<Env>): string | null {
  const dir = configDir(env)
  return dir ? path.join(dir, CONFIG.settingsFile) : null
}

/** The directory under which Antigravity CLI stores conversation brains and transcripts: `<configDir>/brain`, or null. */
export function brainDir(env: Readonly<Env>): string | null {
  const dir = configDir(env)
  return dir ? path.join(dir, CONFIG.brainSubdir) : null
}

/** The legacy brain path emitted in `statusLine` payloads (`<HOME>/.gemini/antigravity/brain`), or null. */
export function legacyBrainDir(env: Readonly<Env>): string | null {
  return env.HOME && path.isAbsolute(env.HOME) ? path.join(env.HOME, ...CONFIG.legacyBrainDir) : null
}

const TOO_LARGE = Symbol('too large')

/**
 * Reads a regular file up to `max` bytes without blocking on a FIFO (`O_NONBLOCK`). Returns null when the file is
 * missing, not a regular file, or unreadable; returns `TOO_LARGE` when its size exceeds `max`.
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

/**
 * Whether a `settings.json` payload defines an active custom status-line command. In Antigravity CLI, `/statusline off`
 * leaves `command` in place with `"enabled": false`, and a boolean `statusLine` runs no script; only an object with
 * `enabled !== false` and a non-empty string `command` is active. A file larger than `L.settingsInlineMaxBytes` fails
 * safe to true so Kea never overrides a configuration it refused to read whole.
 */
export function definesActiveStatusLine(text: string | null | typeof TOO_LARGE): boolean {
  if (text === TOO_LARGE) return true
  if (text === null) return false
  try {
    const v = JSON.parse(text) as unknown
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
    const line = (v as Record<string, unknown>)[SETTINGS_KEYS.statusLine]
    if (line === null || typeof line !== 'object' || Array.isArray(line)) return false
    const obj = line as Record<string, unknown>
    if (obj[SETTINGS_KEYS.statusLineEnabled] === false) return false
    const cmd = obj[SETTINGS_KEYS.statusLineCommand]
    return typeof cmd === 'string' && cmd.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Whether the user's `~/.gemini/antigravity-cli/settings.json` defines an active status-line command. Inline
 * `--settings` replaces a user's custom status line even when `stack_with_default` is true, so Kea suppresses its own
 * status-line injection when the user's is active.
 */
export function ownStatusLine(env: Readonly<Env>): boolean {
  const file = settingsFile(env)
  return file !== null && definesActiveStatusLine(readSmall(file))
}
