// Shared launch plumbing for every adapter: finding the CLI on the login-shell PATH, and the environment edits
// every agent gets (Electron and Node internals removed; nothing else scrubbed by kit).

import fs from 'node:fs'
import path from 'node:path'
import type { Env } from '../types.ts'

/** Variables Electron or Node set for their own children; an agent must not inherit them. */
const INTERNAL_PREFIXES = ['ELECTRON_'] as const
const INTERNAL_NAMES = new Set(['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID'])

/** The keys of `env` that are Electron/Node internals. */
export function internalKeys(env: Readonly<Env>): string[] {
  return Object.keys(env).filter((k) => INTERNAL_NAMES.has(k) || INTERNAL_PREFIXES.some((p) => k.startsWith(p)))
}

/**
 * `base` with `remove` (exact names) and the internals taken out and `set` laid over it; returns the result and the
 * keys removed (core's terminal layer drops them too).
 */
export function editEnv(base: Readonly<Env>, o: { remove: readonly string[]; set: Readonly<Env> }): { env: Env; unset: string[] } {
  const env: Env = { ...base }
  const unset: string[] = []
  for (const k of [...o.remove, ...internalKeys(base)]) {
    if (k in env && !(k in o.set)) {
      delete env[k]
      unset.push(k)
    }
  }
  Object.assign(env, o.set)
  return { env, unset }
}

/** Is `p` an executable regular file (following symlinks)? */
function executable(p: string): boolean {
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return false
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The CLI to run: the override when given (absolute, must be executable), else the first executable `name` on `PATH`
 * (the login shell's). Null when none.
 */
export function findOnPath(name: string, envPath: string | undefined, override: string | null = null): string | null {
  if (override) return path.isAbsolute(override) && executable(override) ? override : null
  for (const dir of (envPath ?? '').split(':')) {
    if (!dir || !path.isAbsolute(dir)) continue
    const p = path.join(dir, name)
    if (executable(p)) return p
  }
  return null
}

/** The basename of argv[0] (rebuild: which adapter started this PTY). */
export function commandName(argv: readonly string[]): string | null {
  const a = argv[0]
  return a ? path.basename(a) : null
}
