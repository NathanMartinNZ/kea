// git's fsmonitor for one worktree, written and taken back. Never implicit: only the project's setting, which the
// person turns on, leads here.
//
// What is written, and where:
//   the worktree's own config    `core.fsmonitor` and `core.untrackedCache` (`git config --worktree`), nothing else.
//                                A value the worktree had for a key is handed back by `on` and put back by `off`
//   the repository's shared      `extensions.worktreeConfig = true`, the one write there: git reads a worktree's own
//   config                       config only with it. Written only when it is not on already; what was there before is
//                                recorded first (`ExtensionRecord`), and put back by the `off` after which no worktree
//                                of the repository has a setting of its own left — Kea's or anyone else's: with
//                                another's setting there (a sparse checkout keeps its own that way) the extension is in
//                                use and stays
//
// Every write is checked: one that fails ends the step, is logged, and what the step had written is taken back. The
// writes of one repository run one after another (two worktrees turned on at once, an off beside an on), so a check
// and the write that follows it see the same config.
//
// A git built without the daemon (Linux's: git has no fsmonitor daemon there) is asked once, by its build options
// (`feature: fsmonitor--daemon`): with none, the setting is not offered, the hint never shows, and nothing is written
// (I-GS-16).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { git, type Logger, type ProcessResult } from '@kea/kit'
import { L } from '@kea/protocol'
import { canonical } from '../worktrees/git.ts'
import type { Env } from './status.ts'

export const FSMONITOR_KEYS = ['core.fsmonitor', 'core.untrackedCache'] as const
const EXTENSION = 'extensions.worktreeConfig'
/** `git config --unset` for a key that is not there. */
const NOT_SET = 5
/** `git config --get` for a key that is not there. */
const NO_VALUE = 1
/** The line `git version --build-options` prints when git was built with its fsmonitor daemon. */
const DAEMON_FEATURE = /^feature: fsmonitor--daemon$/m

/** A worktree, as `git rev-parse` names it (real paths). */
export interface WorktreePlace {
  root: string
  gitDir: string
  commonDir: string
}

/** The values a worktree's own config had for Kea's keys before Kea wrote them (usually none). */
export type PriorValues = Readonly<Record<string, string>>

/** Where Kea remembers that it turned a repository's `extensions.worktreeConfig` on, and what was there before. */
export interface ExtensionRecord {
  /** Whether there is a record for any repository at all. */
  any(): boolean
  get(commonDir: string): { prior: string | null } | null
  set(commonDir: string, r: { prior: string | null }): void
  delete(commonDir: string): void
}

export interface FsmonitorOptions {
  env: () => Promise<Env>
  record: ExtensionRecord
  log?: Logger | undefined
  timeoutMs?: number | undefined
}

type Run = (args: string[]) => Promise<ProcessResult>

const text = (r: ProcessResult): string => (r.stdout ?? Buffer.alloc(0)).toString('utf8').replace(/\n$/, '')
const done = (r: ProcessResult): boolean => r.code === 0 && !r.timedOut && !r.truncated && !r.cancelled
/** Git's own words on a failure, cut as they are for a refused discard. */
const why = (r: ProcessResult): string => (r.stderr.trim() || (r.timedOut ? 'timed out' : `exit ${r.code}`)).slice(0, L.discardDetailMaxChars)

export class Fsmonitor {
  private readonly o: FsmonitorOptions
  // bounded: one entry per repository with a write under way; it goes when that
  // repository's last write ends
  private readonly queues = new Map<string, Promise<void>>()
  private waiting = 0
  /** Whether git has its fsmonitor daemon: asked once (null until it answers). */
  private daemon: Promise<boolean> | null = null
  /** The answer once it came. */
  hasDaemon: boolean | null = null

  constructor(o: FsmonitorOptions) {
    this.o = o
  }

  /** Writes under way or waiting for their repository's turn (the resource report). */
  get writes(): number {
    return this.waiting
  }

  /** Git was built with its fsmonitor daemon (`git version --build-options`). A git that does not answer is asked again next time. */
  supported(): Promise<boolean> {
    this.daemon ??= (async () => {
      const r = await git(['version', '--build-options'], { cwd: os.tmpdir(), env: await this.o.env(), readOnly: true, collect: true, timeoutMs: this.o.timeoutMs ?? L.gitStatusTimeoutMs })
      if (!done(r)) throw new Error(why(r))
      this.hasDaemon = DAEMON_FEATURE.test(text(r))
      return this.hasDaemon
    })().catch((e: unknown) => {
      this.daemon = null
      this.o.log?.debug('git build options unread', { error: String(e) })
      return false
    })
    return this.daemon
  }

  /** `root`'s git dir and common dir; null when it is not there, is no repository, or git did not say. */
  async place(root: string): Promise<WorktreePlace | null> {
    try {
      const r = await git(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd: root, env: await this.o.env(), readOnly: true, collect: true, timeoutMs: this.o.timeoutMs ?? L.gitStatusTimeoutMs })
      if (!done(r)) return null
      const [gitDir, commonDir] = text(r).split('\n')
      if (!gitDir || !commonDir) return null
      // as the files session names them (session.ts `inspect`): the record is kept by common dir
      return { root, gitDir: canonical(gitDir), commonDir: canonical(commonDir) }
    } catch {
      return null
    }
  }

  /**
   * Turn it on for the worktree. Resolves with the values its own config had for the two keys (to hand to `off`), or
   * null when a write failed: nothing is then left written.
   */
  on(p: WorktreePlace): Promise<PriorValues | null> {
    return this.serial(p, async (run) => {
      // the shared config: only when the extension is not on already, and recorded first
      const enabled = await run(['config', '--local', '--type=bool', '--get', EXTENSION])
      if (!(done(enabled) && text(enabled) === 'true')) {
        const raw = await run(['config', '--local', '--get', EXTENSION])
        if (!done(raw) && raw.code !== NO_VALUE) return this.failed('fsmonitor could not be enabled', p, raw)
        this.o.record.set(p.commonDir, { prior: done(raw) ? text(raw) : null })
        const w = await run(['config', '--local', EXTENSION, 'true'])
        if (!done(w)) {
          this.o.record.delete(p.commonDir)
          return this.failed('fsmonitor could not be enabled', p, w)
        }
      }
      const prior: Record<string, string> = {}
      for (const key of FSMONITOR_KEYS) {
        const had = await run(['config', '--worktree', '--get', key])
        if (done(had)) prior[key] = text(had)
        const w = done(had) || had.code === NO_VALUE ? await run(['config', '--worktree', key, 'true']) : had
        if (!done(w)) {
          this.failed('fsmonitor could not be enabled', p, w)
          await this.takeBack(p, prior, run)
          return null
        }
      }
      return prior
    })
  }

  /**
   * Turn it off for the worktree: the two keys go from its own config (or get the values in `prior` back), its daemon
   * is stopped, and the shared config's extension is put back when Kea set it and nothing uses it any more. True:
   * neither key of Kea's is left.
   */
  off(p: WorktreePlace, prior: PriorValues = {}): Promise<boolean> {
    return this.serial(p, (run) => this.takeBack(p, prior, run))
  }

  /**
   * Put the shared config's extension back for the repository `dir` lies in, when Kea set it and no worktree has a
   * setting of its own left (a worktree that was removed while the setting was on took its config with it).
   */
  async settle(dir: string): Promise<void> {
    if (!this.o.record.any()) return
    const p = await this.place(dir)
    if (p) await this.serial(p, (run) => this.restore(p.commonDir, run))
  }

  private async takeBack(p: WorktreePlace, prior: PriorValues, run: Run): Promise<boolean> {
    let clean = true
    // by file, not `--worktree`: that needs the extension, and the keys are to go also where someone turned it off
    const file = path.join(p.gitDir, 'config.worktree')
    if (await exists(file)) {
      for (const key of FSMONITOR_KEYS) {
        const back = prior[key]
        const w = await run(back === undefined ? ['config', '--file', file, '--unset', key] : ['config', '--file', file, key, back])
        if (!done(w) && !(back === undefined && w.code === NOT_SET)) {
          clean = false
          this.failed('fsmonitor could not be turned off', p, w)
        }
      }
    }
    // this worktree's daemon, if one runs (git answers "not running" with a failure, which is no news)
    await run(['fsmonitor--daemon', 'stop'])
    if (clean) await this.restore(p.commonDir, run)
    return clean
  }

  private async restore(commonDir: string, run: Run): Promise<void> {
    const rec = this.o.record.get(commonDir)
    if (!rec) return // Kea did not set it: it is not Kea's to remove
    // still in use while any worktree has a setting of its own: Kea's (another session's) or anyone's
    for (const file of await ownConfigs(commonDir)) {
      const list = await run(['config', '--file', file, '--list'])
      if (!done(list) || text(list).trim() !== '') return
    }
    const now = await run(['config', '--local', '--type=bool', '--get', EXTENSION])
    if (done(now) && text(now) === 'true') {
      const w = await run(rec.prior === null ? ['config', '--local', '--unset', EXTENSION] : ['config', '--local', EXTENSION, rec.prior])
      if (!done(w) && w.code !== NOT_SET) return void this.o.log?.warn('fsmonitor: the shared config could not be put back', { commonDir, why: why(w) })
    }
    // (changed by someone since: theirs now)
    this.o.record.delete(commonDir)
  }

  private failed(msg: string, p: WorktreePlace, r: ProcessResult): null {
    this.o.log?.warn(msg, { root: p.root, why: why(r) })
    return null
  }

  /**
   * One repository's writes, one after another: `fn` never runs beside another for the same common dir. Its git runs
   * in the worktree (`--worktree` and the daemon are that worktree's; the shared config is the same from any of them).
   */
  private serial<T>(p: WorktreePlace, fn: (run: Run) => Promise<T>): Promise<T> {
    const { commonDir, root } = p
    this.waiting++
    const step = async (): Promise<T> => {
      const env = await this.o.env()
      return await fn((args) => git(args, { cwd: root, env, collect: true, timeoutMs: this.o.timeoutMs ?? L.gitStatusTimeoutMs }))
    }
    const run = (this.queues.get(commonDir) ?? Promise.resolve()).then(step)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(commonDir, tail)
    void tail.then(() => {
      this.waiting--
      if (this.queues.get(commonDir) === tail) this.queues.delete(commonDir)
    })
    return run
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.promises.stat(file).then(
    (st) => st.isFile(),
    () => false,
  )
}

/** Every worktree's own config file of the repository that exists: the main worktree's and each linked one's (git's layout). */
async function ownConfigs(commonDir: string): Promise<string[]> {
  const files = [path.join(commonDir, 'config.worktree')]
  const linked = await fs.promises.readdir(path.join(commonDir, 'worktrees')).catch(() => [] as string[])
  for (const name of linked) files.push(path.join(commonDir, 'worktrees', name, 'config.worktree'))
  const there = await Promise.all(files.map(exists))
  return files.filter((_, i) => there[i])
}
