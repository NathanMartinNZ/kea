// Real holders for the cross-process suites: the debug `kea-helper` built with cargo, a temp KEA_HOME short enough for
// socket paths, the client requirement this Node process satisfies, and ptyhost's PtyManager running in plain Node
// against them. Every holder a harness starts is cleaned up: TERMINATE, then RELEASE, and SIGKILL only as a last
// resort, only for a pid whose start time and name match the holder's own state file (tools/perf/src/holders.ts).
// Holders this process did not start are never touched.
//
// Used by tests/integration, tests/memory and tests/chaos (ptyhost-*, holder-*); core's suites may use it too:
//
//   const h = await ptyhostHarness()                       // a PtyManager in a fresh KEA_HOME
//   const pty = await h.spawn({ argv: ['/bin/cat'] })      // a real holder running `cat`
//   …
//   await h.dispose()                                      // every holder ended, the home removed

import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMemoryLogger, ptyId as newPtyId, runDir, runProcess, type Clock, type MemoryLogger } from '@kea/kit'
import { L, need, PTY_ID_PATTERN, type PtyhostNote, type PtyKind } from '@kea/protocol'
import { HolderConnection } from '../../app/ptyhost/src/holder/connection.ts'
import { ptyhostOs, type ClientOption } from '../../app/ptyhost/src/os/index.ts'
import { PtyManager, type ManagerDeps } from '../../app/ptyhost/src/manager.ts'
import type { Pty } from '../../app/ptyhost/src/pty.ts'

/** A holder's state file, `<ptyId>.json`. */
const STATE_FILE = new RegExp(`^${PTY_ID_PATTERN}\\.json$`)
import { isSameHolder, parentPid } from '../../tools/perf/src/holders.ts'
import { resolveCargo } from '../../tools/cargo.ts'
import { runHomePrefix } from './helpers.ts'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MANIFEST = path.join(REPO_ROOT, 'native/kea-helper/Cargo.toml')
/** Where `cargo build` (and `cargo test`, for its integration tests) puts the debug helper. */
export const DEBUG_HELPER = path.join(REPO_ROOT, 'native/kea-helper/target/debug/kea-helper')
/** The release helper (`pnpm helper:build`): what the app ships, so what the performance budgets are measured on. */
export const RELEASE_HELPER = path.join(REPO_ROOT, 'native/kea-helper/target/release/kea-helper')

/** Harness bounds, not product limits: a cold debug build, and any wait on a condition under a loaded machine. */
export const BUILD_TIMEOUT_MS = 600_000
export const BUILD_OUTPUT_MAX_BYTES = 1 << 20
/** Builds a copy may wait through when another build replaces the binary while it is read (harness bound). */
const COPY_ATTEMPTS = 5
/** The copies the harness hands out (helperBinary): one per distinct build, never replaced; `cargo clean` removes them. */
const STABLE_DIR = path.join(REPO_ROOT, 'native/kea-helper/target/test-helper')
export const WAIT_MS = 30_000
const POLL_MS = 5

const built = new Map<'debug' | 'release', Promise<string>>() // bounded: the two profiles

/**
 * The debug `kea-helper` (or with `'release'`, the release one), built with cargo once per test process
 * (`tools/cargo.ts` finds cargo even when it is not on PATH). Cargo's own lock serialises parallel workers; an
 * up-to-date build costs a fraction of a second. What is handed out is a copy named after its content (`STABLE_DIR`),
 * never cargo's output itself: every `cargo build` (one per test file, and one per concurrent suite) replaces
 * `target/<profile>/kea-helper` with a new file even when nothing changed, so a holder started from that path meanwhile
 * would fail with "kea-helper not found".
 */
export function helperBinary(profile: 'debug' | 'release' = 'debug'): Promise<string> {
  let b = built.get(profile)
  if (b) return b
  b = (async () => {
    const cargo = resolveCargo()
    if (!cargo) throw new Error('cargo not found: install Rust with `brew install rustup && rustup default stable`')
    const dir = path.dirname(cargo)
    const build = async () => {
      const r = await runProcess(cargo, ['build', '--quiet', ...(profile === 'release' ? ['--release'] : []), '--manifest-path', MANIFEST], {
        pool: 'other',
        env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` },
        timeoutMs: BUILD_TIMEOUT_MS,
        maxBytes: BUILD_OUTPUT_MAX_BYTES,
      })
      if (r.code !== 0) throw new Error(`cargo build of kea-helper failed (${r.timedOut ? 'timed out' : `exit ${r.code}`}): ${r.stderr.slice(-2000)}`)
    }
    await build()
    for (let attempt = 1; ; attempt++) {
      try {
        return stableCopy(profile === 'release' ? RELEASE_HELPER : DEBUG_HELPER, profile)
      } catch (e) {
        // another build is replacing it right now: the next build waits for that one's lock, then it is there again
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= COPY_ATTEMPTS) throw e
        await build()
      }
    }
  })()
  built.set(profile, b)
  b.catch(() => built.delete(profile))
  return b
}

/** `src` copied once to `STABLE_DIR/<profile>-<content hash>/kea-helper` (written aside, then renamed into place). */
function stableCopy(src: string, profile: string): string {
  const bytes = fs.readFileSync(src)
  const dest = path.join(STABLE_DIR, `${profile}-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`, 'kea-helper')
  if (fs.existsSync(dest)) return dest
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, bytes, { mode: 0o755 })
  fs.renameSync(tmp, dest)
  return dest
}

let req: Promise<ClientOption> | null = null

/**
 * Whom test holders admit: this Node binary. macOS, its designated requirement (`codesign -d -r-` on
 * `process.execPath`; Homebrew's node is ad-hoc signed, so it is its `cdhash`); Linux, `--client-exe-unchecked` of it
 * (it is no utility process of Kea's). Every Vitest worker runs the same binary, so a holder started by one is admitted
 * by another. The release requirement is never weakened for this.
 */
export function testClientRequirement(): Promise<ClientOption> {
  req ??= need(ptyhostOs.clientRequirement).unchecked(process.execPath)
  req.catch(() => (req = null))
  return req
}

/**
 * A fresh KEA_HOME under /tmp (canonical `/private/tmp/kea-test-<tag>-…`, mode 0700): short enough that
 * `<home>/run/<ptyId>.sock` fits the socket path limit, and named after this Vitest invocation, so its own
 * teardown can tell its strays from everyone else's holders (tests/support/helpers.ts `runHomePrefix`).
 */
export function shortKeaHome(): { home: string; dispose(): void } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', runHomePrefix())))
  fs.chmodSync(home, 0o700)
  return { home, dispose: () => fs.rmSync(home, { recursive: true, force: true }) }
}

/** Wait until `cond` holds, re-checking every few ms; fails after `ms` naming `what`. Never a fixed sleep. */
export async function until(what: string, cond: () => boolean | Promise<boolean>, ms = WAIT_MS, tick?: () => void): Promise<void> {
  const end = performance.now() + ms
  for (;;) {
    if (await cond()) return
    if (performance.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    tick?.()
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

/** A minimal, deterministic environment for a test PTY (the helper's environment is the child's). */
export function testEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '/', TERM: 'xterm-256color', LANG: 'en_US.UTF-8', ...extra }
}

/** The argv that runs `argv` in raw mode with echo off (`stty raw -echo`), so bytes pass the tty unchanged. */
export function rawTty(argv: string[]): string[] {
  return ['/bin/sh', '-c', 'stty raw -echo && exec "$0" "$@"', ...argv]
}

export interface SpawnOptions {
  argv: string[]
  ptyId?: string
  sessionId?: string
  kind?: PtyKind
  cols?: number
  rows?: number
  ringBytes?: number
  env?: Record<string, string>
  cwd?: string
}

export interface HarnessOptions {
  /** Default: a fresh short KEA_HOME, removed by `dispose`. */
  home?: string
  clock?: Clock
  helperSource?: string
  detach?: boolean
  launchDetached?: ManagerDeps['launchDetached']
  launchHeld?: ManagerDeps['launchHeld']
}

export interface Harness {
  readonly home: string
  /** The current ptyhost; `restart()` replaces it. */
  readonly manager: PtyManager
  readonly notes: PtyhostNote[]
  readonly log: MemoryLogger
  readonly helper: string
  readonly client: ClientOption
  /** Every ptyId this harness spawned (cleanup ends each one). */
  readonly spawned: Set<string>
  spawn(o: SpawnOptions): Promise<Pty>
  /** Ptyhost restart: this manager goes (holders survive), a fresh one adopts them. */
  restart(o?: { visible?: string[]; adopt?: boolean; clock?: Clock }): Promise<PtyManager>
  /** Shut ptyhost down without a new one (holders keep running, as when Kea quits). */
  stop(): void
  /** End every holder spawned here (TERMINATE, RELEASE, SIGKILL last), dispose ptyhost, remove the home. */
  dispose(): Promise<void>
}

/** A PtyManager under plain Node, with the real helper, in a short temp KEA_HOME. */
export async function ptyhostHarness(o: HarnessOptions = {}): Promise<Harness> {
  const helper = o.helperSource ?? (await helperBinary())
  const client = await testClientRequirement()
  const own = o.home ? null : shortKeaHome()
  const home = o.home ?? own!.home
  const notes: PtyhostNote[] = []
  const log = createMemoryLogger({ process: 'ptyhost' })
  const spawned = new Set<string>() // bounded: the PTYs one test spawns
  const make = (clock: Clock | undefined) =>
    new PtyManager(
      { home, helperSource: helper, keaVersion: 'test', dev: true, client, ...(o.detach === undefined ? {} : { detach: o.detach }) },
      {
        log,
        notify: (n) => notes.push(n),
        ...(clock ? { clock } : {}),
        ...(o.launchDetached ? { launchDetached: o.launchDetached } : {}),
        ...(o.launchHeld ? { launchHeld: o.launchHeld } : {}),
      },
    )
  let manager = make(o.clock)
  const h: Harness = {
    home,
    get manager() {
      return manager
    },
    notes,
    log,
    helper,
    client,
    spawned,
    async spawn(s) {
      const id = s.ptyId ?? newPtyId()
      spawned.add(id)
      await manager.spawn({
        ptyId: id,
        sessionId: s.sessionId ?? 's1',
        kind: s.kind ?? 'shell',
        spec: { file: s.argv[0]!, args: s.argv.slice(1), env: s.env ?? testEnv(), cwd: s.cwd ?? home },
        cols: s.cols ?? 80,
        rows: s.rows ?? 24,
        ringBytes: s.ringBytes ?? L.ringBytesDefault,
        keaVersion: 'test',
      })
      return manager.get(id)!
    },
    async restart(r = {}) {
      manager.dispose()
      manager = make(r.clock ?? o.clock)
      if (r.visible) manager.setVisible(r.visible)
      if (r.adopt !== false) await manager.adoptAll()
      return manager
    },
    stop() {
      manager.dispose()
    },
    async dispose() {
      try {
        await endHolders(home, spawned, manager)
      } finally {
        manager.dispose()
        if (own) {
          // the home is this harness's: any holder still alive in it is a leftover of this test (verified kill)
          for (const id of holdersIn(home)) if (holderAlive(home, id)) killHolder(home, id)
          own.dispose()
        }
      }
    },
  }
  return h
}

/** The state file of a holder, if any. */
export function holderState(home: string, ptyId: string): { pid?: number; pidStartTime?: number; childPid?: number; exited?: boolean } | null {
  const sessions = path.join(home, 'sessions')
  for (const s of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
    try {
      return JSON.parse(fs.readFileSync(path.join(sessions, s, `${ptyId}.json`), 'utf8'))
    } catch {
      // not in this session
    }
  }
  return null
}

/** Every ptyId with a state file in `home` (all of a test home's holders, whoever started them). */
export function holdersIn(home: string): string[] {
  const sessions = path.join(home, 'sessions')
  const out: string[] = []
  for (const s of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
    const dir = path.join(sessions, s)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir)) if (STATE_FILE.test(f)) out.push(f.slice(0, -5))
  }
  return out
}

/**
 * End every holder still alive in a test home whose ptyhost is gone (a crashed worker, a failed test): adopted by a
 * fresh ptyhost and ended as `dispose` ends them, SIGKILL (verified) as the last resort. Does not remove the home.
 */
export async function endHoldersIn(home: string): Promise<void> {
  const alive = holdersIn(home).filter((id) => holderAlive(home, id))
  if (!alive.length) return
  try {
    const h = await ptyhostHarness({ home })
    for (const id of alive) h.spawned.add(id)
    await h.restart()
    await h.dispose()
  } finally {
    for (const id of alive) if (holderAlive(home, id)) killHolder(home, id)
  }
}

/** The holder process recorded for `ptyId` is still running (pid, start time and name all match). */
export function holderAlive(home: string, ptyId: string): boolean {
  const j = holderState(home, ptyId)
  return j !== null && isSameHolder(j)
}

/**
 * Send `signal` to a holder a test started in its own home: only after its pid, start time and name match its state
 * file, so a reused pid is never signalled. Throws, signalling nothing, when they do not.
 */
export function signalHolder(home: string, ptyId: string, signal: NodeJS.Signals): void {
  const j = holderState(home, ptyId)
  if (!j || !isSameHolder(j)) throw new Error(`holder ${ptyId} is not the process its state file names: not signalled`)
  process.kill(j.pid!, signal)
}

/** The PTY child a holder started is still running and still that holder's child. */
export function holderChildAlive(home: string, ptyId: string): boolean {
  const j = holderState(home, ptyId)
  return j !== null && !!j.childPid && isSameHolder(j) && parentPid(j.childPid) === j.pid
}

/**
 * End the holders a harness spawned: through ptyhost when it still has them (TERMINATE, wait for the exit, RELEASE),
 * else over a fresh connection to their socket; any that is still alive after that is SIGKILLed, child first, only
 * when its pid, start time and name match its state file.
 */
async function endHolders(home: string, ids: Set<string>, manager: PtyManager): Promise<void> {
  const sock = (id: string) => path.join(runDir(home), `${id}.sock`)
  await Promise.all(
    [...ids].map(async (id) => {
      try {
        const p = manager.get(id)
        if (p && !p.isDisposed) {
          if (p.isRunning) p.terminate(0)
          await until(`${id} to exit`, () => p.isDisposed || !p.isRunning, L.holderLaunchTimeoutMs)
          p.release()
        } else if (fs.existsSync(sock(id))) {
          const { conn, hello } = await HolderConnection.open(sock(id))
          try {
            if (!hello.exited) conn.terminate(0)
            await new Promise<void>((resolve) => {
              conn.attach('latest', 0, { output: () => {}, exit: () => resolve(), error: () => {}, close: () => resolve() })
              if (hello.exited) resolve()
            })
            conn.release()
            await until(`${id} to go`, () => !fs.existsSync(sock(id)), L.holderLaunchTimeoutMs)
          } finally {
            conn.destroy()
          }
        }
        await until(`${id}'s holder to exit`, () => !holderAlive(home, id), L.holderLaunchTimeoutMs)
      } catch {
        killHolder(home, id)
      }
    }),
  )
}

/** Last resort: SIGKILL a holder (and its child, while still its own) whose pid, start time and name are verified. */
export function killHolder(home: string, ptyId: string): boolean {
  const j = holderState(home, ptyId)
  if (!j || !isSameHolder(j)) return false
  try {
    if (j.childPid && !j.exited && parentPid(j.childPid) === j.pid) process.kill(j.childPid, 'SIGKILL')
  } catch {
    // already gone
  }
  try {
    process.kill(j.pid!, 'SIGKILL')
    return true
  } catch {
    return false
  }
}
