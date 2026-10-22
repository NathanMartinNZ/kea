// Starting a holder: run the `kea-helper pty` launcher, which daemonises the holder and prints one JSON line. Also
// where the helper binary is run from (`installCurrentHelper`) and the client requirement holders admit. The
// non-detached fallback runs the same argv plus `--no-detach`: see `backend/held.ts`. Why a launch failed is classified
// here (LaunchFailure), for both paths.

import fs from 'node:fs'
import { constants } from 'node:os'
import path from 'node:path'
import { ensurePrivateDir, HeldLimitError, PoolFullError, runProcess, SpawnError, type ProcessResult } from '@kea/kit'
import { L, need, type PtyKind, type SpawnSpec } from '@kea/protocol'
import { ptyhostOs, type ClientOption } from '../os/index.ts'

export interface LaunchRequest {
  helper: string
  ptyId: string
  sessionId: string
  kind: PtyKind
  stateDir: string
  sock: string
  cols: number
  rows: number
  /** Whom the holder admits: the OS layer's `clientRequirement`. */
  client: ClientOption
  ringBytes: number
  keaVersion: string
  spec: SpawnSpec
  /** Run the holder in the started process itself, not daemonised: the fallback when daemonising fails. */
  noDetach?: boolean
}

/**
 * Why a launch failed:
 * · `helper` — the helper binary cannot run at all: missing, not executable, not a binary, or it died without a
 *   result line (the message carries the diagnostics);
 * · `detach` — the holder could not be daemonised: the launcher's `posix_spawn` failed for a reason other than a
 *   resource limit, or the daemon died before it was ready (the same helper may still run non-detached);
 * · `resource` — the launch hit a resource limit (open files, processes, memory, terminal devices): ptyhost's spawn of
 *   the helper or the launcher's `posix_spawn` failed with EMFILE, ENFILE, EAGAIN or ENOMEM, or the helper met one
 *   before that spawn or inside the holder as it started (helperLimit) (only this launch fails, and the
 *   message names the limit and what frees it). One of Kea's own limits on its children is the same kind: the
 *   launcher's queue is full, or there are as many non-detached holders as Kea keeps;
 * · `refused` — the helper refused the request (arguments, an unsafe socket directory, a bad client option);
 * · `timeout` / `cancelled`.
 */
export type LaunchFailure = 'helper' | 'detach' | 'resource' | 'refused' | 'timeout' | 'cancelled'

export class HolderLaunchError extends Error {
  readonly kind: LaunchFailure
  constructor(message: string, kind: LaunchFailure = 'refused') {
    super(message)
    this.name = 'HolderLaunchError'
    this.kind = kind
  }
}

/**
 * Launcher errors that mean "could not daemonise" (`native/kea-helper/src/launch.rs`: `posix_spawn <exe>: …` when the
 * spawn fails, "the holder exited before it was ready" when the daemon dies first). Anything else the helper reports
 * would fail non-detached too. A `posix_spawn` that hit a resource limit is tested first (helperLimit).
 */
const DETACH_ERRORS = [/^posix_spawn /, /exited before it was ready/]

/**
 * The resource limits a spawn can hit, by errno: what ran out and what frees it. No build or reinstall
 * advice: the helper is fine, and the next launch may work.
 */
const RESOURCE_LIMITS: Readonly<Record<string, { what: string; frees: string }>> = {
  EMFILE: { what: 'too many open files', frees: 'Close some sessions or terminals' },
  ENFILE: { what: 'too many open files on this Mac', frees: 'Close some sessions, terminals or other apps' },
  EAGAIN: { what: 'too many processes', frees: 'Close some sessions, terminals or other apps' },
  ENOMEM: { what: 'not enough memory', frees: 'Close some sessions, terminals or other apps' },
}

/** One launch failed at a resource limit (the errno stays in the text); null for any other errno. */
function limitError(code: string | undefined): HolderLaunchError | null {
  if (code === undefined || !Object.hasOwn(RESOURCE_LIMITS, code)) return null
  const l = RESOURCE_LIMITS[code]!
  return new HolderLaunchError(`Couldn't start the terminal: ${l.what} (${code}). ${l.frees}, then try again.`, 'resource')
}

/** No terminal device is left (macOS keeps `kern.tty.ptmx_max` of them for every app together): `openpty` says ENXIO. */
const NO_TERMINALS = "Couldn't start the terminal: this Mac has no terminal devices left (ENXIO). Close some terminals, here or in other apps, then try again."
/** The same on Linux (`kernel.pty.max`): `openpty` says ENOSPC. */
const NO_TERMINALS_LEFT = "Couldn't start the terminal: no terminal devices are left (ENOSPC). Close some terminals, here or in other apps, then try again."

/** The call a result line of the helper ends with, when it names one: `posix_spawn <exe>: …`, `…: fork: …`, `…: openpty: …`. */
const FAILED_CALL = /(?:^(posix_spawn) .*|(?:^|: )(fork|openpty)): [^:]*$/

/**
 * The helper's result line is a resource limit: met by the launcher (its `pipe`, its `posix_spawn` of the
 * daemon) or inside the holder as it starts (the ring, the terminal device, the child's `fork`, the socket, the state
 * file). The helper prints what failed and Rust's `io::Error`, which ends `(os error <errno>)`, e.g.
 * "cannot start the child: fork: Resource temporarily unavailable (os error 35)". The errno alone says "open files" and
 * "memory"; EAGAIN is the process limit only from a call that makes a process, and ENXIO (macOS) or ENOSPC (Linux)
 * means "no terminal device left" only from `openpty` (elsewhere they are a socket that would block, a device
 * that is not there and a full disk).
 */
function helperLimit(error: string): HolderLaunchError | null {
  const n = /\(os error (\d+)\)$/.exec(error)?.[1]
  if (n === undefined) return null
  const call = FAILED_CALL.exec(error)
  const made = call?.[1] ?? call?.[2]
  if (Number(n) === constants.errno.ENXIO) return made === 'openpty' ? new HolderLaunchError(NO_TERMINALS, 'resource') : null
  if (Number(n) === constants.errno.ENOSPC) return made === 'openpty' ? new HolderLaunchError(NO_TERMINALS_LEFT, 'resource') : null
  if (Number(n) === constants.errno.EAGAIN && made !== 'posix_spawn' && made !== 'fork') return null
  return limitError(Object.keys(RESOURCE_LIMITS).find((c) => constants.errno[c as keyof typeof constants.errno] === Number(n)))
}

export function launchArgs(r: LaunchRequest): string[] {
  return [
    'pty',
    '--id', r.ptyId,
    '--session', r.sessionId,
    '--kind', r.kind,
    '--dir', r.stateDir,
    '--sock', r.sock,
    '--cwd', r.spec.cwd,
    '--cols', String(r.cols),
    '--rows', String(r.rows),
    r.client.option, r.client.value,
    '--ring-bytes', String(r.ringBytes),
    '--kea-version', r.keaVersion,
    ...(r.noDetach ? ['--no-detach'] : []),
    '--',
    r.spec.file,
    ...r.spec.args,
  ]
}

/** Parse the launcher's one JSON line (`{"pid","childPid"}` or `{"error"}`). */
export function parseLaunchOutput(stdout: string): { pid: number; childPid: number } {
  const line = stdout.split('\n').find((l) => l.trim().startsWith('{'))
  if (!line) throw new HolderLaunchError(`kea-helper printed no result${stdout ? `: ${stdout.slice(0, 200)}` : ''}`)
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    throw new HolderLaunchError(`kea-helper printed bad JSON: ${line.slice(0, 200)}`)
  }
  const o = v as Record<string, unknown>
  if (typeof o.error === 'string') throw helperLimit(o.error) ?? new HolderLaunchError(o.error, DETACH_ERRORS.some((re) => re.test(o.error as string)) ? 'detach' : 'refused')
  if (Number.isInteger(o.pid) && Number.isInteger(o.childPid)) return { pid: o.pid as number, childPid: o.childPid as number }
  throw new HolderLaunchError(`kea-helper printed an unexpected result: ${line.slice(0, 200)}`)
}

/** Create the state directory and check the socket's (never a symlinked, shared or foreign run directory). */
export function prepareLaunch(r: LaunchRequest): void {
  fs.mkdirSync(r.stateDir, { recursive: true, mode: 0o700 })
  ensurePrivateDir(path.dirname(r.sock))
}

/**
 * Kea's own limits on the children it starts, read like the system's limits: the helper is fine, this
 * one launch fails, and the message says what was hit and what to do. Null for anything else.
 */
function ownLimit(e: unknown): HolderLaunchError | null {
  // more than L.poolQueueMax launches wait for a slot of the launcher's pool: they start as the ones ahead finish
  if (e instanceof PoolFullError) return new HolderLaunchError(`Couldn't start the terminal: too many terminals are starting at once (${L.poolQueueMax} waiting). Wait for them to start, then try again.`, 'resource')
  // non-detached holders are ptyhost's own children, L.heldChildrenMax at most
  if (e instanceof HeldLimitError) return new HolderLaunchError(`Couldn't start the terminal: too many terminals are open (${L.heldChildrenMax}). Close some sessions or terminals, then try again.`, 'resource')
  return null
}

/**
 * Ptyhost could not start the helper: at a resource limit, the system's or one of Kea's own, the limit and
 * what frees it; otherwise the helper cannot run at all: say which binary, why, and what fixes it.
 */
export function helperSpawnError(helper: string, e: unknown): HolderLaunchError {
  const own = ownLimit(e)
  if (own) return own
  if (!(e instanceof SpawnError)) return new HolderLaunchError(`kea-helper ${helper}: ${(e as Error).message}`, 'helper')
  const limit = limitError(e.code)
  if (limit) return limit
  const why = e.reason === 'not-found' ? 'not found' : e.reason === 'permission' ? 'not executable' : `cannot be started (${e.code ?? 'unknown error'})`
  return new HolderLaunchError(`kea-helper at ${helper} ${why}`, 'helper')
}

/** A launcher that ran but printed no result line: a broken binary unless it was timed out or cancelled. */
export function noResultError(res: ProcessResult, cause: Error): HolderLaunchError {
  if (res.timedOut) return new HolderLaunchError('kea-helper pty timed out', 'timeout')
  if (res.cancelled) return new HolderLaunchError('kea-helper pty cancelled', 'cancelled')
  const how = res.signal ? `was killed by ${res.signal}` : `exited with code ${res.code}`
  const stderr = res.stderr.trim() ? ` (stderr: ${res.stderr.trim().slice(0, 300)})` : ''
  return new HolderLaunchError(`kea-helper ${how} without a result: ${cause.message}${stderr}`, 'helper')
}

/** Run the launcher; resolves once the holder is listening (the launcher waits for the daemon's READY). */
export async function launchHolder(r: LaunchRequest, signal?: AbortSignal): Promise<{ pid: number; childPid: number }> {
  prepareLaunch(r)
  let res: ProcessResult
  try {
    res = await runProcess(r.helper, launchArgs(r), {
      pool: 'other',
      env: r.spec.env, // the helper's environment is the child's
      timeoutMs: L.holderLaunchTimeoutMs,
      maxBytes: L.holderLaunchOutputMaxBytes,
      ...(signal ? { signal } : {}),
    })
  } catch (e) {
    throw helperSpawnError(r.helper, e)
  }
  const out = res.stdout?.toString('utf8') ?? ''
  if (res.timedOut) throw new HolderLaunchError('kea-helper pty timed out', 'timeout')
  if (res.cancelled) throw new HolderLaunchError('kea-helper pty cancelled', 'cancelled')
  try {
    return parseLaunchOutput(out)
  } catch (e) {
    if (!(e instanceof HolderLaunchError) || !out.includes('{')) throw noResultError(res, e as Error)
    if (res.code !== 0 && res.stderr) throw new HolderLaunchError(`${e.message} (stderr: ${res.stderr.slice(0, 300)})`, e.kind)
    throw e
  }
}

/** The folder in `<KEA_HOME>/bin` of the newest helper, the one holders start from. */
export const CURRENT_HELPER_DIR = 'current'

/**
 * Where holders start from: `<KEA_HOME>/bin/current/kea-helper`, one stable path whatever the build, never the
 * bundle. macOS keys an agent's privacy grant to the path of the program responsible for it, the holder (it disclaims
 * Kea's responsibility), so a new build's holders keep the grants the last build's were given (E-DST-4). Made a
 * copy of `source` (the helper this build ships) when it is not one: copied beside it and renamed over it, so a holder
 * already started from it keeps running the file it opened (an executable is never written in place) and an update
 * never changes a running holder. A link or anything but a regular file there is replaced, never followed. Returns its
 * path.
 */
export function installCurrentHelper(source: string, home: string): string {
  const dir = path.join(home, 'bin', CURRENT_HELPER_DIR)
  const dest = path.join(dir, 'kea-helper')
  if (sameFileContent(source, dest)) return dest
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${dest}.${process.pid}.tmp`
  fs.rmSync(tmp, { force: true })
  fs.copyFileSync(source, tmp)
  fs.chmodSync(tmp, 0o755)
  fs.renameSync(tmp, dest)
  return dest
}

/** `b` is a regular file (not a link) with the bytes of `a`. */
function sameFileContent(a: string, b: string): boolean {
  try {
    const sb = fs.lstatSync(b)
    if (!sb.isFile() || sb.size !== fs.statSync(a).size) return false
    return fs.readFileSync(a).equals(fs.readFileSync(b))
  } catch {
    return false
  }
}

/**
 * Whom holders admit: the OS layer's `clientRequirement` (macOS, `--client-req` from `codesign -d -r-`; Linux,
 * `--client-exe` or `--client-exe-unchecked`).
 */
export async function clientRequirement(execPath: string = process.execPath): Promise<ClientOption> {
  return need(ptyhostOs.clientRequirement).of(execPath)
}
