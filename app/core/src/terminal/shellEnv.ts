// The user's login-shell environment, resolved once per launch and on demand ("Reload shell environment"):
// run `$SHELL -l -i -c` printing the environment between random markers, with stdin closed and a timeout; fall back
// to `-l -c` without `-i`, then to Kea's own environment plus the usual tool directories.

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { atomicWriteSync, runProcess } from '@kea/kit'
import { L, need, scrubSessionEnv } from '@kea/protocol'
import { coreOs } from '../os/index.ts'

export type Env = Record<string, string>
export type ShellEnvSource = 'login-interactive' | 'login' | 'fallback'

/**
 * The environment printed between `start` and `end` by `env -0` (NUL-separated, so values may contain newlines).
 * Anything an rc file prints before or after the markers is ignored. Returns null if the markers are missing.
 */
export function parseMarkedEnv(output: string, start: string, end: string): Env | null {
  const i = output.indexOf(start)
  if (i < 0) return null
  const j = output.indexOf(end, i + start.length)
  if (j < 0) return null
  const env: Env = {}
  for (const entry of output.slice(i + start.length, j).split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return Object.keys(env).length ? env : null
}

/** The script the shell runs: Kea's own constant text plus a random marker, never user input. */
export function markerScript(start: string, end: string): string {
  return `printf '%s' '${start}'; /usr/bin/env -0; printf '%s' '${end}'`
}

export function fallbackEnv(base: Readonly<Record<string, string | undefined>>, home: string = os.homedir()): Env {
  const env: Env = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v
  const defaults = need(coreOs.shellDefaults)
  const extra = defaults.extraPath(home)
  const path = (env.PATH ?? defaults.path).split(':')
  for (const d of extra) if (!path.includes(d)) path.push(d)
  env.PATH = path.join(':')
  return env
}

export async function resolveShellEnv(o: { shell?: string; base?: Readonly<Record<string, string | undefined>>; timeoutMs?: number } = {}): Promise<{ env: Env; source: ShellEnvSource; error?: string }> {
  const base = o.base ?? process.env
  const shell = o.shell ?? base.SHELL ?? need(coreOs.shellDefaults).shell
  const timeoutMs = o.timeoutMs ?? L.shellEnvTimeoutMs
  const errors: string[] = []
  for (const [flags, source] of [[['-l', '-i'], 'login-interactive'], [['-l'], 'login']] as const) {
    const tag = randomBytes(8).toString('hex')
    const start = `__KEA_ENV_START_${tag}__`
    const end = `__KEA_ENV_END_${tag}__`
    try {
      const res = await runProcess(shell, [...flags, '-c', markerScript(start, end)], { pool: 'other', env: base, timeoutMs, maxBytes: L.shellEnvOutputMaxBytes })
      const env = res.stdout ? parseMarkedEnv(res.stdout.toString('utf8'), start, end) : null
      if (env) {
        scrubSessionEnv(env) // a shell rc must not bring back a session's identity: a PTY gets only its own session's
        return { env, source }
      }
      errors.push(`${shell} ${flags.join(' ')}: ${res.timedOut ? 'timed out' : `no environment (exit ${res.code})`}`)
    } catch (e) {
      errors.push(`${shell} ${flags.join(' ')}: ${(e as Error).message}`)
    }
  }
  return { env: fallbackEnv(base), source: 'fallback', error: errors.join('; ') }
}

export type ShellEnvResult = { env: Env; source: ShellEnvSource; error?: string }

/** The last good resolution, kept between launches: `<KEA_HOME>/shell-env.json`, 0600, written atomically. */
export interface StoredShellEnv {
  read(): { shell: string; env: Env } | null
  write(shell: string, env: Env): void
}

export function fileShellEnv(file: string): StoredShellEnv {
  return {
    read() {
      try {
        const o = JSON.parse(fs.readFileSync(file, 'utf8')) as { v?: unknown; shell?: unknown; env?: unknown }
        if (o.v !== 1 || typeof o.shell !== 'string' || typeof o.env !== 'object' || o.env === null) return null
        const env: Env = {}
        for (const [k, v] of Object.entries(o.env)) if (typeof v === 'string') env[k] = v
        return Object.keys(env).length ? { shell: o.shell, env } : null
      } catch {
        return null
      }
    },
    write(shell, env) {
      atomicWriteSync(file, JSON.stringify({ v: 1, shell, env }), { mode: 0o600 })
    },
  }
}

/**
 * The one cached login-shell environment: resolved on first use, replaced by `reload()` ("Reload shell
 * environment"). Callers waiting meanwhile get the resolution in flight.
 * At launch, until the first resolution finishes, callers get the last run's environment at once if it was resolved
 * for the same shell; a fallback environment is never stored, and after a reload the stored one is never used.
 */
export class ShellEnvCache {
  private current: Promise<ShellEnvResult> | null = null
  private settled: ShellEnvResult | null = null
  private lastRun: Env | null | undefined // undefined: not read yet
  private reloaded = false
  private readonly resolve: () => Promise<ShellEnvResult>
  private readonly onResolved: (r: ShellEnvResult) => void
  private readonly stored: { store: StoredShellEnv; shell: string } | null

  constructor(
    resolve: () => Promise<ShellEnvResult> = () => resolveShellEnv(),
    onResolved: (r: ShellEnvResult) => void = () => {},
    stored: { store: StoredShellEnv; shell: string } | null = null,
  ) {
    this.resolve = resolve
    this.onResolved = onResolved
    this.stored = stored
  }

  async get(): Promise<Env> {
    const fresh = this.result()
    if (this.settled) return this.settled.env
    if (!this.reloaded) {
      const last = this.fromLastRun()
      if (last) return last
    }
    return (await fresh).env
  }

  async reload(): Promise<ShellEnvSource> {
    this.current = null
    this.settled = null
    this.reloaded = true
    return (await this.result()).source
  }

  private fromLastRun(): Env | null {
    if (this.lastRun === undefined) {
      const s = this.stored?.store.read() ?? null
      this.lastRun = s && s.shell === this.stored!.shell ? s.env : null
    }
    return this.lastRun
  }

  private result(): Promise<ShellEnvResult> {
    if (this.current) return this.current
    const p: Promise<ShellEnvResult> = this.resolve().then((r) => {
      if (this.current === p) this.settled = r
      if (r.source !== 'fallback' && this.stored) {
        try {
          this.stored.store.write(this.stored.shell, r.env)
        } catch {
          // the next launch resolves from scratch
        }
      }
      this.onResolved(r)
      return r
    })
    this.current = p
    return p
  }
}

/**
 * What every PTY gets on top of the resolved environment; session variables are added by the caller. LANG,
 * when the environment has none, is the system's default (`en_US.UTF-8`; on Linux `C.UTF-8` where that is not
 * installed).
 */
export function terminalEnv(resolved: Env, keaVersion: string): Env {
  const env: Env = { ...resolved, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Kea', TERM_PROGRAM_VERSION: keaVersion }
  if (!env.LANG) env.LANG = need(coreOs.shellDefaults).lang()
  return env
}
