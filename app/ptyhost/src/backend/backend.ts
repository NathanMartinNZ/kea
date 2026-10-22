// How holders are started. Detached by default. When detaching is refused (the launcher's `posix_spawn` fails,
// its daemon dies before it is ready, or `BackendConfig.detach` says this machine does not allow it), the same helper
// runs non-detached as ptyhost's child, with the same protocol; a banner says sessions will not survive
// quitting Kea. When the helper cannot run at all (missing, not executable, not a binary), terminals are unavailable
// and a banner gives the diagnostics and the fix. A launch that hits a resource limit (EMFILE, ENFILE,
// EAGAIN, ENOMEM, from either spawn) is neither: that one launch fails, saying which limit and what frees it, with no
// banner, and terminals and detaching stay as they were. On Linux a holder that detached into a session of
// its own rather than a systemd scope (its state json's `detach`) raises one banner: sessions may end if the
// desktop stops Kea (core shows it once per KEA_HOME). There is no second PTY implementation.

import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '@kea/kit'
import type { PtyhostNote } from '@kea/protocol'
import { HolderLaunchError, installCurrentHelper, launchHolder, type LaunchRequest } from '../holder/launch.ts'
import { launchHeld, type HeldHolder } from './held.ts'

export interface BackendConfig {
  home: string
  /** The helper binary shipped with this build (copied to `<home>/bin/current/` before use). */
  helperSource: string
  keaVersion: string
  dev: boolean
  /** False when this machine does not let holders detach, so every holder runs non-detached. */
  detach: boolean
}

export interface BackendDeps {
  log: Logger
  notify(note: PtyhostNote): void
  /** Test seams: the detached launcher and the non-detached one. */
  launchDetached?: (r: LaunchRequest) => Promise<{ pid: number; childPid: number }>
  launchHeld?: (r: LaunchRequest) => Promise<HeldHolder>
}

export interface LaunchedHolder {
  pid: number
  childPid: number
  /** false: a non-detached holder, which ends with ptyhost. */
  detached: boolean
}

/** The session-mode banner: the window shows it once per KEA_HOME (core). */
export const SESSION_MODE_BANNER = "Sessions may end if your desktop stops Kea — no systemd user manager gave terminals a scope of their own (details in Settings › About)."

/**
 * How a holder detached, as its state json records it: `scope` or `session` on Linux; null where the system records
 * none (macOS) or the file cannot be read.
 */
export function holderDetach(stateDir: string, ptyId: string): string | null {
  // the session folder is the agent's to write: a link there is not followed, and a FIFO is not waited on
  let fd: number | null = null
  try {
    fd = fs.openSync(path.join(stateDir, `${ptyId}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    if (!fs.fstatSync(fd).isFile()) return null
    const v = JSON.parse(fs.readFileSync(fd, 'utf8')) as { detach?: unknown }
    return typeof v.detach === 'string' ? v.detach : null
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

export class HolderBackend {
  private readonly cfg: BackendConfig
  private readonly deps: BackendDeps
  /** Why holders cannot detach, once known; from then on every holder runs non-detached. */
  private notDetachedBecause: string | null = null
  /** What is wrong with the helper while it cannot run; cleared by the next launch that works. */
  private helperProblem: string | null = null
  /** The session-mode banner was raised by this ptyhost. */
  private sessionModeSaid = false
  private readonly held = new Map<string, HeldHolder>() // bounded: one per live non-detached PTY (L.heldChildrenMax)
  private helper: string | null = null
  private disposed = false

  constructor(cfg: BackendConfig, deps: BackendDeps) {
    this.cfg = cfg
    this.deps = deps
    if (!cfg.detach) this.refuseDetach('this Mac does not let them run in the background')
  }

  /** Holders are being launched detached, or non-detached. */
  get detaching(): boolean {
    return this.notDetachedBecause === null
  }

  /** Diagnostics while the helper cannot run, else null. */
  get unavailable(): string | null {
    return this.helperProblem
  }

  /** Non-detached holders still running. */
  get heldCount(): number {
    return this.held.size
  }

  /** Start a holder for `r`; resolves once it listens on `r.sock`. */
  async launch(r: Omit<LaunchRequest, 'helper' | 'noDetach'>): Promise<LaunchedHolder> {
    let helper: string
    try {
      helper = this.helperPath()
    } catch (e) {
      throw this.helperFailed(e as Error)
    }
    const req: LaunchRequest = { ...r, helper }
    if (this.detaching) {
      try {
        const h = await (this.deps.launchDetached ?? launchHolder)(req)
        this.helperWorks()
        if (holderDetach(req.stateDir, req.ptyId) === 'session') this.sessionMode()
        return { ...h, detached: true }
      } catch (e) {
        if (!(e instanceof HolderLaunchError)) throw e
        if (e.kind === 'helper') throw this.helperFailed(e)
        // a refusal or a resource limit fails this launch only: no banner, no fallback, detaching stays on
        if (e.kind !== 'detach') throw e
        // The same helper, non-detached. It becomes the way holders start only if it works.
        this.deps.log.warn('holder could not detach; trying it non-detached', { ptyId: r.ptyId, error: e.message })
        const h = await this.startHeld(req)
        this.refuseDetach(`macOS did not let kea-helper run on its own (${e.message})`)
        return h
      }
    }
    return this.startHeld(req)
  }

  /** The PTY is gone from ptyhost: a non-detached holder ends its child's tree and exits. */
  release(ptyId: string): void {
    this.held.get(ptyId)?.release()
  }

  /** Ptyhost is going: every non-detached holder ends with it. Detached holders are untouched. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const h of this.held.values()) h.release()
  }

  // ── internals ─────────────────────────────────────────────────────────────────────

  private async startHeld(req: LaunchRequest): Promise<LaunchedHolder> {
    let h: HeldHolder
    try {
      h = await (this.deps.launchHeld ?? launchHeld)(req)
    } catch (e) {
      if (e instanceof HolderLaunchError && e.kind === 'helper') throw this.helperFailed(e)
      throw e // a refusal or a resource limit fails this launch only
    }
    this.helperWorks()
    this.held.set(req.ptyId, h)
    const forget = () => {
      if (this.held.get(req.ptyId) === h) this.held.delete(req.ptyId)
    }
    h.exited.then(forget, forget)
    if (this.disposed) h.release()
    return { pid: h.pid, childPid: h.childPid, detached: false }
  }

  private refuseDetach(because: string): void {
    if (this.notDetachedBecause !== null) return
    this.notDetachedBecause = because
    this.deps.log.warn('holders run non-detached', { because })
    this.deps.notify({ m: 'pty.banner', a: { kind: 'notDetached', message: `Sessions won't survive quitting Kea — terminals run as Kea's own processes because ${because}.` } })
  }

  /** A holder detached into a session of its own, not a systemd scope; one banner per ptyhost. */
  private sessionMode(): void {
    if (this.sessionModeSaid) return
    this.sessionModeSaid = true
    this.deps.log.warn('holders run in session mode: no systemd user manager gave them a scope')
    this.deps.notify({ m: 'pty.banner', a: { kind: 'sessionMode', message: SESSION_MODE_BANNER } })
  }

  /** Terminals are unavailable; the banner (once per episode) says what is wrong and how to fix it. */
  private helperFailed(e: Error): HolderLaunchError {
    const fix = this.cfg.dev ? 'Build it with `pnpm helper:build`, then open the terminal again.' : 'Reinstall Kea to restore it, then open the terminal again.'
    const message = `Terminals are unavailable: ${e.message}. ${fix}`
    if (this.helperProblem !== message) {
      this.helperProblem = message
      this.deps.log.error('kea-helper cannot run', { helper: this.cfg.helperSource, error: e.message })
      this.deps.notify({ m: 'pty.banner', a: { kind: 'helperMissing', message } })
    }
    return e instanceof HolderLaunchError ? e : new HolderLaunchError(e.message, 'helper')
  }

  private helperWorks(): void {
    this.helperProblem = null
  }

  private helperPath(): string {
    if (this.helper && fs.existsSync(this.helper)) return this.helper
    if (!fs.existsSync(this.cfg.helperSource)) throw new Error(`kea-helper not found at ${this.cfg.helperSource}`)
    // holders start from the newest helper's one stable path; the agents' hooks run this build's own copy, which
    // core installs
    this.helper = installCurrentHelper(this.cfg.helperSource, this.cfg.home)
    return this.helper
  }
}
