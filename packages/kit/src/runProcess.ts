// How Kea spawns a child process. The only other children are the Linux instance lock's one synchronous
// `flock` at start (os/linux.ts) and the Electron utility processes main runs core and ptyhost in.
//
// · argv only: `spawn(file, args, { shell: false })` — no shell ever parses a string.
// · own process group: children start with `detached: true` (setsid), so a timeout, a cancellation
//   or a byte cap kills the whole group (SIGTERM, then SIGKILL after L.processKillGraceMs).
// · bounded output: stdout is streamed to `onStdout` or collected up to a byte cap; stderr is kept up
//   to L.processStderrMaxBytes; the rest is drained and dropped.
// · concurrency pools: `git` / `ports` / `other` (L.poolGit / L.poolPorts / L.poolOther); waiting
//   requests are served FIFO and a request cancelled while queued never spawns.
// · always reaped: the promise settles only after the child has exited and its pipes have closed.
// · never rejects for a non-zero exit (callers decide what a status means); rejects for spawn
//   failures (`SpawnError`), a full pool queue (`PoolFullError`) or an exception thrown by `onStdout`.
// · `launchDetached` is the one exception to "killed when no longer needed, always waited for": an app the user
//   keeps (a terminal app on Linux) is started in a session of its own with no pipes and let go once it runs.

import { spawn } from 'node:child_process'
import type { ChildProcess, StdioOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { L } from '@kea/protocol/limits'
import { monotonicMs } from './clock.ts'
import { registerSingletonGauge } from './resources.ts'

export type Pool = 'git' | 'ports' | 'other'

export const POOL_LIMITS: Readonly<Record<Pool, number>> = Object.freeze({
  git: L.poolGit,
  ports: L.poolPorts,
  other: L.poolOther,
})

export interface RunProcessOptions {
  /** Concurrency pool. */
  pool: Pool
  cwd?: string
  /** The child's complete environment (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>
  /** Kill the process group this long after spawn (time waiting for a pool slot does not count). */
  timeoutMs?: number
  /**
   * Stdout byte cap. Exceeding it delivers / keeps exactly `maxBytes` bytes, kills the process group
   * and marks the result `truncated`. Default when collecting: L.processStdoutMaxBytes; when only
   * streaming to `onStdout`: no cap.
   */
  maxBytes?: number
  /** Streaming parser hook. When given, stdout is not accumulated unless `collect: true`. */
  onStdout?: (chunk: Buffer) => void
  /** Accumulate stdout into `result.stdout` (default: true unless `onStdout` is given). */
  collect?: boolean
  /** Written to the child's stdin, which is then closed. Without it stdin is /dev/null. */
  stdin?: string | Uint8Array
  /** Abort → kill the process group (or never spawn, if still queued); result `cancelled: true`. */
  signal?: AbortSignal
  /** Stderr bytes kept (default L.processStderrMaxBytes). */
  stderrMaxBytes?: number
  /** SIGTERM → SIGKILL grace when killing the group (default L.processKillGraceMs). */
  killGraceMs?: number
}

export interface ProcessResult {
  /** Exit code, or null when the child died from a signal (or never spawned). */
  code: number | null
  signal: NodeJS.Signals | null
  /** Collected stdout (only when collecting). */
  stdout?: Buffer
  /** Up to `stderrMaxBytes` of stderr, decoded as UTF-8. */
  stderr: string
  /** Stdout bytes delivered or collected (≤ maxBytes). */
  stdoutBytes: number
  /** Stdout exceeded `maxBytes`; the group was killed. */
  truncated: boolean
  /** `timeoutMs` elapsed; the group was killed. */
  timedOut: boolean
  /** The signal aborted; the group was killed, or the request never left the queue. */
  cancelled: boolean
  /** Spawn to close, monotonic. */
  durationMs: number
  /** Time spent waiting for a pool slot. */
  queuedMs: number
  pid: number | undefined
}

export type SpawnFailure = 'not-found' | 'cwd-missing' | 'permission' | 'other'

/** The child could not be started (missing binary or cwd, permissions, fd exhaustion, …). */
export class SpawnError extends Error {
  /** errno code, e.g. 'ENOENT'. */
  readonly code: string | undefined
  readonly reason: SpawnFailure
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string | undefined

  constructor(cause: unknown, file: string, args: readonly string[], cwd: string | undefined) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code
    let reason: SpawnFailure = 'other'
    if (code === 'ENOENT') reason = cwd !== undefined && !existsSync(cwd) ? 'cwd-missing' : 'not-found'
    else if (code === 'EACCES' || code === 'EPERM') reason = 'permission'
    super(`spawn ${file} failed (${code ?? 'unknown'}${reason === 'cwd-missing' ? `, cwd ${cwd} does not exist` : ''})`, { cause })
    this.name = 'SpawnError'
    this.code = code
    this.reason = reason
    this.file = file
    this.args = args
    this.cwd = cwd
  }
}

/** More than L.poolQueueMax requests are already waiting for this pool. */
export class PoolFullError extends Error {
  readonly pool: Pool
  constructor(pool: Pool) {
    super(`runProcess: pool "${pool}" has ${L.poolQueueMax} requests waiting (L.poolQueueMax) — refusing more`)
    this.name = 'PoolFullError'
    this.pool = pool
  }
}

// ── pools ───────────────────────────────────────────────────────────────────────

interface Waiter {
  grant(): void
}

interface PoolState {
  active: number
  // bounded: L.poolQueueMax waiters; cancelled waiters leave at once
  readonly queue: Set<Waiter>
}

const pools: Record<Pool, PoolState> = {
  git: { active: 0, queue: new Set() },
  ports: { active: 0, queue: new Set() },
  other: { active: 0, queue: new Set() },
}

/** Children running (or about to spawn) in `pool`. */
export function activeCount(pool: Pool): number {
  return pools[pool].active
}

/** Requests waiting for a slot in `pool`. */
export function queuedCount(pool: Pool): number {
  return pools[pool].queue.size
}

/** Children started with `runHeld` that have not been reaped yet. */
let heldActive = 0

registerSingletonGauge('kit.children', () => {
  const out: Record<string, number> = {}
  for (const p of Object.keys(pools) as Pool[]) {
    out[`${p}.active`] = pools[p].active
    out[`${p}.queued`] = pools[p].queue.size
  }
  out['held.active'] = heldActive
  return out
})

/** Children started with `runHeld` that are still running (or not yet reaped). */
export function heldCount(): number {
  return heldActive
}

function acquire(pool: Pool, signal: AbortSignal | undefined): Promise<boolean> {
  const st = pools[pool]
  if (signal?.aborted) return Promise.resolve(false)
  if (st.active < POOL_LIMITS[pool] && st.queue.size === 0) {
    st.active++
    return Promise.resolve(true)
  }
  if (st.queue.size >= L.poolQueueMax) return Promise.reject(new PoolFullError(pool))
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      st.queue.delete(waiter)
      resolve(false)
    }
    const waiter: Waiter = {
      grant() {
        signal?.removeEventListener('abort', onAbort)
        st.active++
        resolve(true)
      },
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    st.queue.add(waiter)
  })
}

function release(pool: Pool): void {
  const st = pools[pool]
  st.active--
  while (st.active < POOL_LIMITS[pool] && st.queue.size > 0) {
    const next = st.queue.values().next().value as Waiter
    st.queue.delete(next)
    next.grant()
  }
}

// ── runProcess ──────────────────────────────────────────────────────────────────

function wantsCollect(opts: Pick<RunProcessOptions, 'collect' | 'onStdout'>): boolean {
  return opts.collect ?? opts.onStdout === undefined
}

function notSpawned(opts: Pick<RunProcessOptions, 'collect' | 'onStdout'>, queuedMs: number): ProcessResult {
  return {
    code: null,
    signal: null,
    ...(wantsCollect(opts) ? { stdout: Buffer.alloc(0) } : {}),
    stderr: '',
    stdoutBytes: 0,
    truncated: false,
    timedOut: false,
    cancelled: true,
    durationMs: 0,
    queuedMs,
    pid: undefined,
  }
}

/** Run `file` with `args` (argv, never a shell string) in a pool. See the module comment. */
export async function runProcess(file: string, args: readonly string[], opts: RunProcessOptions): Promise<ProcessResult> {
  if (typeof file !== 'string' || file.length === 0) throw new TypeError('runProcess: file must be a non-empty string')
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new TypeError('runProcess: args must be an array of strings')
  if (!(opts.pool in pools)) throw new TypeError(`runProcess: unknown pool ${String(opts.pool)}`)

  const requested = monotonicMs()
  const granted = await acquire(opts.pool, opts.signal)
  const queuedMs = monotonicMs() - requested
  if (!granted) return notSpawned(opts, queuedMs)
  try {
    if (opts.signal?.aborted) return notSpawned(opts, queuedMs)
    return await execute(file, args, opts, queuedMs)
  } finally {
    release(opts.pool)
  }
}

/** More than L.heldChildrenMax children started with `runHeld` are alive. */
export class HeldLimitError extends Error {
  constructor() {
    super(`runHeld: ${L.heldChildrenMax} held children are alive (L.heldChildrenMax) — refusing more`)
    this.name = 'HeldLimitError'
  }
}

export type HeldOptions = Omit<RunProcessOptions, 'pool' | 'stdin'> & {
  /** Called once the child runs. `closeStdin()` ends its stdin (EOF); it also closes when this process exits. */
  onSpawn(child: { pid: number; closeStdin(): void }): void
}

/**
 * Run a child that lives as long as this process wants it: argv only, own process group, bounded output, cancellable
 * and always reaped, like `runProcess` — but its stdin is a pipe held open until `closeStdin()` (or this process's
 * exit), so EOF on it tells the child its parent is gone (`kea-helper pty --no-detach`). No pool: at most
 * L.heldChildrenMax at once, and one more is refused at once with `HeldLimitError`. Settles when the child has exited
 * and its pipes have closed.
 */
export async function runHeld(file: string, args: readonly string[], opts: HeldOptions): Promise<ProcessResult> {
  if (typeof file !== 'string' || file.length === 0) throw new TypeError('runHeld: file must be a non-empty string')
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new TypeError('runHeld: args must be an array of strings')
  if (heldActive >= L.heldChildrenMax) throw new HeldLimitError()
  if (opts.signal?.aborted) return notSpawned(opts, 0)
  heldActive++
  try {
    return await execute(file, args, opts, 0, opts.onSpawn)
  } finally {
    heldActive--
  }
}

export interface LaunchOptions {
  /** Concurrency pool held while the child is being started. */
  pool: Pool
  cwd?: string
  /** The child's complete environment (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>
}

/**
 * Start an app the person keeps (a terminal app on Linux) and let it go: argv only, in a session of its own
 * (`setsid`), stdin, stdout and stderr on `/dev/null`. Resolves with its pid once it has started; rejects with a
 * `SpawnError` when it could not be. It is never killed, waited for or counted after that (it is the person's app, not
 * Kea's child: nothing it does reaches Kea, and it outlives Kea); the system reaps it when it exits. A pool slot is
 * held only while it starts.
 */
export async function launchDetached(file: string, args: readonly string[], opts: LaunchOptions): Promise<{ pid: number }> {
  if (typeof file !== 'string' || file.length === 0) throw new TypeError('launchDetached: file must be a non-empty string')
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new TypeError('launchDetached: args must be an array of strings')
  if (!(opts.pool in pools)) throw new TypeError(`launchDetached: unknown pool ${String(opts.pool)}`)
  await acquire(opts.pool, undefined)
  try {
    return await new Promise<{ pid: number }>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(file, [...args], { cwd: opts.cwd, env: opts.env ?? process.env, shell: false, detached: true, stdio: 'ignore', windowsHide: true })
      } catch (e) {
        reject(new SpawnError(e, file, args, opts.cwd))
        return
      }
      // after the start no error of the child's may reach this process (an unhandled 'error' would end it)
      child.on('error', (err) => {
        if (child.pid === undefined) reject(new SpawnError(err, file, args, opts.cwd))
      })
      child.once('spawn', () => {
        child.unref()
        resolve({ pid: child.pid as number })
      })
    })
  } finally {
    release(opts.pool)
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signalGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, sig)
  } catch {
    // ESRCH: the group is already gone.
  }
}

function execute(
  file: string,
  args: readonly string[],
  opts: Omit<RunProcessOptions, 'pool'>,
  queuedMs: number,
  /** `runHeld`: stdin is a pipe kept open until the caller closes it. */
  held?: (child: { pid: number; closeStdin(): void }) => void,
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const collect = wantsCollect(opts)
    const onStdout = opts.onStdout
    const readStdout = collect || onStdout !== undefined
    const maxBytes = opts.maxBytes ?? (collect ? L.processStdoutMaxBytes : Number.POSITIVE_INFINITY)
    const stderrMax = opts.stderrMaxBytes ?? L.processStderrMaxBytes
    const graceMs = opts.killGraceMs ?? L.processKillGraceMs
    const signal = opts.signal

    const stdio: StdioOptions = [opts.stdin !== undefined || held ? 'pipe' : 'ignore', readStdout ? 'pipe' : 'ignore', 'pipe']
    const started = monotonicMs()
    let child: ChildProcess
    try {
      child = spawn(file, [...args], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false,
        detached: true,
        stdio,
        windowsHide: true,
      })
    } catch (e) {
      reject(new SpawnError(e, file, args, opts.cwd))
      return
    }

    // bounded: total ≤ maxBytes
    const chunks: Buffer[] = []
    let outBytes = 0
    // bounded: total ≤ stderrMax
    const errChunks: Buffer[] = []
    let errBytes = 0
    let truncated = false
    let timedOut = false
    let cancelled = false
    let parserError: { error: unknown } | undefined
    let killing = false
    let sigkillSent = false
    let closed = false
    let settled = false
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined

    const startKill = (): void => {
      if (killing) return
      killing = true
      signalGroup(child.pid, 'SIGTERM')
      graceTimer = setTimeout(() => {
        graceTimer = undefined
        sigkillSent = true
        signalGroup(child.pid, 'SIGKILL')
        maybeFinish()
      }, graceMs)
    }

    const onAbort = (): void => {
      if (settled) return
      cancelled = true
      startKill()
    }

    const cleanup = (): void => {
      settled = true
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    const maybeFinish = (): void => {
      if (settled || !closed) return
      // After a kill, settle only once the whole group is gone or has been sent SIGKILL.
      if (killing && !sigkillSent && child.pid !== undefined && groupAlive(child.pid)) return
      cleanup()
      if (parserError) {
        reject(parserError.error)
        return
      }
      resolve({
        code: exitCode,
        signal: exitSignal,
        ...(collect ? { stdout: Buffer.concat(chunks, outBytes) } : {}),
        stderr: Buffer.concat(errChunks, errBytes).toString('utf8'),
        stdoutBytes: outBytes,
        truncated,
        timedOut,
        cancelled,
        durationMs: monotonicMs() - started,
        queuedMs,
        pid: child.pid,
      })
    }

    child.once('error', (err) => {
      if (child.pid !== undefined || settled) return // only spawn failures matter; child.kill() is never used
      cleanup()
      reject(new SpawnError(err, file, args, opts.cwd))
    })
    child.once('exit', (code, sig) => {
      exitCode = code
      exitSignal = sig
    })
    child.once('close', (code, sig) => {
      if (child.pid === undefined) return // spawn failure, reported by 'error'
      closed = true
      exitCode ??= code
      exitSignal ??= sig
      maybeFinish()
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated || parserError) return // draining after a kill
      let piece = chunk
      if (outBytes + chunk.length > maxBytes) {
        piece = chunk.subarray(0, maxBytes - outBytes)
        truncated = true
      }
      outBytes += piece.length
      if (piece.length > 0) {
        if (onStdout) {
          try {
            onStdout(piece)
          } catch (e) {
            parserError = { error: e }
            startKill()
            return
          }
        }
        if (collect) chunks.push(piece)
      }
      if (truncated) startKill()
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes >= stderrMax) return
      const piece = chunk.subarray(0, stderrMax - errBytes)
      errChunks.push(piece)
      errBytes += piece.length
    })

    if (child.stdin) {
      child.stdin.on('error', () => {
        // EPIPE: the child exited without reading all of stdin — its exit status tells the story.
      })
      if (!held) child.stdin.end(opts.stdin)
    }

    if (child.pid !== undefined) {
      if (held) {
        const stdin = child.stdin
        try {
          held({ pid: child.pid, closeStdin: () => stdin?.end() })
        } catch (e) {
          parserError = { error: e }
          startKill()
        }
      }
      if (opts.timeoutMs !== undefined) {
        timeoutTimer = setTimeout(() => {
          timeoutTimer = undefined
          if (settled || closed) return
          timedOut = true
          startKill()
        }, opts.timeoutMs)
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    }
  })
}
