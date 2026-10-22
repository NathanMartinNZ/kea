// One status pipeline for one worktree: `git status` (what is uncommitted, the branch, conflicts,
// untracked files), the comparison base of the active scope, one `git diff --raw --numstat` against it (letters and
// line counts of every tracked change), and the line counts of untracked files. The result is the session's
// StatusSnapshot: a head and one entry per changed path.
//
// Every git call is read-only (`GIT_OPTIONAL_LOCKS=0`: no `index.lock`) and runs on the git pool. Each is parsed as a
// stream under a byte cap, has a timeout and ends when `signal` aborts.

import fs from 'node:fs'
import path from 'node:path'
import { git, LruCache, type ProcessResult } from '@kea/kit'
import { L, type DiffScope, type GitEntry, type GitHead, type GitOperation, type GitState } from '@kea/protocol'
import { BaseCache, type BaseInputs, type BaseResult } from './base.ts'
import { DiffParser, type DiffEntry } from './rawdiff.ts'
import { StatusParser, type StatusEntry, type StatusHeader } from './porcelain.ts'
import { ZRecords } from './records.ts'

export type Env = Readonly<Record<string, string | undefined>>

export interface StatusTarget {
  /** The session's working directory (canonical). */
  root: string
  /** The repository's work tree root, when the working directory lies below it (paths are then cut to the directory). */
  toplevel: string
  gitDir: string
  baseBranch: string | null
  baseCommit: string | null
}

export interface Snapshot {
  head: GitHead
  /** By path; empty unless the state is `ok` (or `unavailable`, where the caller keeps its last one). */
  entries: Map<string, GitEntry>
  /** `HEAD`'s commit as this status saw it; null before the first commit, or when the status did not get that far. */
  oid: string | null
}

/** `error`: git could not be run at all (no process started); the snapshot is then `unavailable`. */
export type StatusOutcome = { kind: 'done'; snapshot: Snapshot; ms: number; error?: string } | { kind: 'cancelled' }

export interface StatusCounters {
  status: number
  diff: number
  mergeBase: number
  revList: number
  /** Untracked files read for a line count (the others came from the cache). */
  counted: number
  timeouts: number
  truncated: number
}

interface CountedFile {
  size: number
  mtimeMs: number
  lines: number | null
}

/** What a line count costs to know: a file's newline count as `git diff --numstat` would give it for a new file. */
export function countLines(buf: Buffer, sniff: number = L.binarySniffBytes): number | null {
  if (buf.length === 0) return 0
  if (buf.subarray(0, sniff).includes(0)) return null // binary: git counts none
  let n = 0
  for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) n++
  return buf[buf.length - 1] === 10 ? n : n + 1
}

function operationIn(gitDir: string): GitOperation | null {
  const num = (f: string): number | null => {
    try {
      const n = Number(fs.readFileSync(path.join(gitDir, f), 'utf8').trim())
      return Number.isInteger(n) && n >= 0 ? n : null
    } catch {
      return null
    }
  }
  const has = (f: string): boolean => fs.existsSync(path.join(gitDir, f))
  if (has('rebase-merge')) return { kind: 'rebase', step: num('rebase-merge/msgnum'), total: num('rebase-merge/end') }
  if (has('rebase-apply')) return { kind: 'rebase', step: num('rebase-apply/next'), total: num('rebase-apply/last') }
  if (has('MERGE_HEAD')) return { kind: 'merge', step: null, total: null }
  if (has('CHERRY_PICK_HEAD')) return { kind: 'cherry-pick', step: null, total: null }
  if (has('REVERT_HEAD')) return { kind: 'revert', step: null, total: null }
  if (has('BISECT_LOG')) return { kind: 'bisect', step: null, total: null }
  return null
}

export class GitStatus {
  readonly counters: StatusCounters = { status: 0, diff: 0, mergeBase: 0, revList: 0, counted: 0, timeouts: 0, truncated: 0 }
  readonly base: BaseCache
  // bounded: L.gitStatusEntriesMax untracked files' line counts, by path (a status never has more entries)
  private readonly lines = new LruCache<string, CountedFile>({ maxEntries: L.gitStatusEntriesMax })
  private aheadBehind: { ahead: number | null; behind: number | null } = { ahead: null, behind: null }
  /** `HEAD`'s commit as the last status reported it. */
  private lastHead: string | null = null
  private target: StatusTarget
  private readonly env: () => Promise<Env>
  private readonly timeoutMs: number

  /** `timeoutMs`: the timeout for each git call (default L.gitStatusTimeoutMs, tests shorten it). */
  constructor(target: StatusTarget, env: () => Promise<Env>, timeoutMs: number = L.gitStatusTimeoutMs) {
    this.target = target
    this.env = env
    this.timeoutMs = timeoutMs
    this.base = new BaseCache((inputs) => this.computeBase(inputs))
  }

  /** The session's base branch or commit changed, or the worktree moved. */
  retarget(target: StatusTarget): void {
    const t = this.target
    if (t.baseBranch !== target.baseBranch || t.baseCommit !== target.baseCommit || t.root !== target.root) this.base.moved()
    this.target = target
  }

  get linesCached(): number {
    return this.lines.size
  }

  /** The directory's path below the work tree root, with a trailing slash; `''` when it is the root. */
  private get prefix(): string {
    const rel = path.relative(this.target.toplevel, this.target.root)
    return rel === '' || rel.startsWith('..') ? '' : `${rel.split(path.sep).join('/')}/`
  }

  private async run(args: readonly string[], o: { signal: AbortSignal; maxBytes: number; timeoutMs?: number; onStdout?: (b: Buffer) => void }): Promise<ProcessResult> {
    const r = await git(args, { cwd: this.target.root, env: await this.env(), readOnly: true, signal: o.signal, maxBytes: o.maxBytes, timeoutMs: o.timeoutMs ?? this.timeoutMs, ...(o.onStdout ? { onStdout: o.onStdout } : { collect: true }) })
    if (r.timedOut) this.counters.timeouts++
    if (r.truncated) this.counters.truncated++
    return r
  }

  /** Stop the child early without ending the caller's own signal. */
  private stoppable(outer: AbortSignal): { signal: AbortSignal; stop(): void; dispose(): void } {
    const ac = new AbortController()
    const onAbort = (): void => ac.abort()
    if (outer.aborted) ac.abort()
    else outer.addEventListener('abort', onAbort, { once: true })
    return { signal: ac.signal, stop: () => ac.abort(), dispose: () => outer.removeEventListener('abort', onAbort) }
  }

  private async computeBase(inputs: BaseInputs): Promise<BaseResult> {
    this.aheadBehind = { ahead: null, behind: null }
    if (inputs.head === null) return { base: null, branch: null }
    const never = new AbortController().signal
    const oid = (r: ProcessResult): string | null => {
      const s = (r.stdout ?? Buffer.alloc(0)).toString('utf8').trim()
      return r.code === 0 && /^[0-9a-f]{40,64}$/.test(s) ? s : null
    }
    if (inputs.baseBranch && !inputs.baseBranch.startsWith('-')) {
      this.counters.mergeBase++
      const base = oid(await this.run(['merge-base', 'HEAD', inputs.baseBranch], { signal: never, maxBytes: 4096 }))
      if (base) {
        this.counters.revList++
        const r = await this.run(['rev-list', '--left-right', '--count', `${inputs.baseBranch}...HEAD`], { signal: never, maxBytes: 4096 })
        const m = /^(\d+)\s+(\d+)/.exec((r.stdout ?? Buffer.alloc(0)).toString('utf8'))
        if (r.code === 0 && m) this.aheadBehind = { behind: Number(m[1]), ahead: Number(m[2]) }
        return { base, branch: inputs.baseBranch }
      }
    }
    // no base branch, or it was deleted: the commit the session started from
    if (inputs.baseCommit && /^[0-9a-f]{4,64}$/.test(inputs.baseCommit)) {
      this.counters.mergeBase++
      const base = oid(await this.run(['merge-base', 'HEAD', inputs.baseCommit], { signal: never, maxBytes: 4096 }))
      if (base) {
        this.counters.revList++
        const r = await this.run(['rev-list', '--count', `${base}..HEAD`], { signal: never, maxBytes: 4096 })
        const n = Number((r.stdout ?? Buffer.alloc(0)).toString('utf8').trim())
        if (r.code === 0 && Number.isInteger(n)) this.aheadBehind = { ahead: n, behind: null }
        return { base, branch: null }
      }
    }
    // nothing to compare the branch with: what is uncommitted
    return { base: inputs.head, branch: null }
  }

  /** The comparison base of `scope` as of `head`: the merge base, or `HEAD`'s commit. */
  async baseOf(scope: DiffScope, head: string | null): Promise<BaseResult> {
    if (scope === 'uncommitted' || head === null) return { base: head, branch: null }
    return this.base.get({ head, baseBranch: this.target.baseBranch, baseCommit: this.target.baseCommit })
  }

  /**
   * The base the next status will most likely compare against, known before it runs: the one that stood at the last
   * status, unless `HEAD` or a ref has moved since (`base.moved()`). Null: not known.
   */
  private standing(scope: DiffScope): { head: string; base: string } | null {
    const c = this.base.standing
    if (!c || c.head === null || this.lastHead !== c.head) return null
    if (scope === 'uncommitted') return { head: c.head, base: c.head }
    return c.result.base !== null && c.baseBranch === this.target.baseBranch && c.baseCommit === this.target.baseCommit ? { head: c.head, base: c.result.base } : null
  }

  /** Letters and counts of tracked changes against `base`. `stop()` ends it early (its result is then not used). */
  private diffAgainst(base: string, signal: AbortSignal): { done: Promise<{ diff: DiffParser; run: ProcessResult; overlong: boolean }>; stop(): void } {
    const diff = new DiffParser()
    const ds = this.stoppable(signal)
    const recs = new ZRecords((rec) => diff.record(rec))
    this.counters.diff++
    const done = this.run(['diff', '--raw', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--no-color', '-M', ...(this.prefix ? ['--relative'] : []), base, '--'], {
      signal: ds.signal,
      maxBytes: L.gitDiffCapBytes,
      onStdout: (chunk) => {
        if (!recs.push(chunk)) ds.stop()
      },
    })
      .finally(() => ds.dispose())
      .then((run) => {
        recs.end()
        return { diff, run, overlong: recs.overlong }
      })
    return { done, stop: () => ds.stop() }
  }

  /** `HEAD`'s commit, asked of git (for a caller with no status at hand). */
  async headOid(): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { signal: new AbortController().signal, maxBytes: 4096 })
    const s = (r.stdout ?? Buffer.alloc(0)).toString('utf8').trim()
    return r.code === 0 && s ? s : null
  }

  private async untrackedLines(rel: string, budget: { left: number }): Promise<number | null> {
    const abs = path.join(this.target.root, rel)
    let st: fs.Stats
    try {
      st = await fs.promises.lstat(abs)
    } catch {
      return null
    }
    if (!st.isFile() || st.size > L.untrackedCountMaxBytes) return null
    const hit = this.lines.get(rel)
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.lines
    if (st.size > budget.left) return null
    budget.left -= st.size
    let lines: number | null
    try {
      lines = countLines(await fs.promises.readFile(abs))
    } catch {
      return null
    }
    this.counters.counted++
    this.lines.set(rel, { size: st.size, mtimeMs: st.mtimeMs, lines })
    return lines
  }

  /** One pipeline for `scope`. */
  async snapshot(scope: DiffScope, signal: AbortSignal): Promise<StatusOutcome> {
    const t0 = performance.now()
    const t = this.target
    const prefix = this.prefix
    const inDir = (p: string): string | null => (prefix === '' ? p : p.startsWith(prefix) ? p.slice(prefix.length) : null)
    const head = (state: GitState, h: StatusHeader | null, more: Partial<GitHead> = {}): GitHead => ({
      scope,
      base: null,
      state,
      branch: h?.branch ?? null,
      detached: h?.detached && h.oid ? h.oid.slice(0, 7) : null,
      baseBranch: t.baseBranch,
      ahead: null,
      behind: null,
      upstream: h?.upstream ?? null,
      operation: null,
      totals: { files: 0, added: 0, removed: 0 },
      truncated: false,
      ...more,
    })
    const failed = (state: GitState, h: StatusHeader | null = null): StatusOutcome => ({ kind: 'done', snapshot: { head: head(state, h), entries: new Map(), oid: h?.oid ?? null }, ms: performance.now() - t0 })

    // The diff against the base that stands unless `HEAD` or a ref moved since the last status starts beside the
    // status, so a save costs one git run's time, not two in a row (P-GS-1). It is used only if the status then
    // reports the `HEAD` it was guessed for.
    const guess = this.standing(scope)
    let early = guess ? this.diffAgainst(guess.base, signal) : null
    try {
      return await this.pipeline(scope, signal, t0, head, failed, inDir, guess, () => {
        const e = early
        early = null
        return e
      })
    } catch (e) {
      // git could not be run at all — no process was started (too many waiting for the pool, a working directory
      // that is gone, no binary). That is "git did not answer" like a timeout: never a rejection, which would leave
      // the caller's last rows on screen as if they were this status's
      if (signal.aborted) return { kind: 'cancelled' }
      const out = failed('unavailable')
      return out.kind === 'done' ? { ...out, error: String(e) } : out
    } finally {
      // not used (the status failed, was cancelled, or found another `HEAD`): ended, and its exit awaited by nobody
      if (early) {
        early.stop()
        void early.done.catch(() => undefined)
      }
    }
  }

  private async pipeline(
    scope: DiffScope,
    signal: AbortSignal,
    t0: number,
    head: (state: GitState, h: StatusHeader | null, more?: Partial<GitHead>) => GitHead,
    failed: (state: GitState, h?: StatusHeader | null) => StatusOutcome,
    inDir: (p: string) => string | null,
    guess: { head: string; base: string } | null,
    takeEarly: () => ReturnType<GitStatus['diffAgainst']> | null,
  ): Promise<StatusOutcome> {
    const t = this.target
    const prefix = this.prefix

    // 1. status
    const tracked: StatusEntry[] = []
    const untracked: string[] = []
    const parser = new StatusParser((e) => {
      const p = inDir(e.path)
      if (p === null || p === '') return
      if (e.kind === '?') untracked.push(p)
      else tracked.push({ ...e, path: p, origPath: e.origPath === null ? null : inDir(e.origPath) })
    })
    const st = this.stoppable(signal)
    const records = new ZRecords((rec) => parser.record(rec))
    let statusRun: ProcessResult
    try {
      this.counters.status++
      statusRun = await this.run(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--no-renames', ...(prefix ? ['--', '.'] : [])], {
        signal: st.signal,
        maxBytes: L.gitStatusCapBytes,
        onStdout: (chunk) => {
          if (!records.push(chunk)) st.stop() // killed early
        },
      })
    } finally {
      st.dispose()
    }
    records.end()
    if (signal.aborted) return { kind: 'cancelled' }
    if (parser.tooMany) return failed('tooMany', parser.header)
    if (statusRun.timedOut) return failed('unavailable', parser.header)
    if (!records.stopped && !records.overlong && statusRun.code !== 0 && !statusRun.truncated) return failed(/not a git repository/i.test(statusRun.stderr) ? 'notGit' : 'unavailable', parser.header)
    let truncated = statusRun.truncated || records.overlong
    const h = parser.header

    // 2. the branch point (the header's branch line in either scope) and the base of the active scope
    const branch = await this.baseOf('branch', h.oid)
    const b = scope === 'branch' ? branch : { base: h.oid, branch: null }
    if (signal.aborted) return { kind: 'cancelled' }

    // 3. letters and counts of tracked changes against it
    this.lastHead = h.oid
    const entries = new Map<string, GitEntry>()
    let diffed = false
    if (b.base !== null) {
      const running = guess && guess.head === h.oid && guess.base === b.base ? takeEarly() : null
      const d = await (running ?? this.diffAgainst(b.base, signal)).done
      if (signal.aborted) return { kind: 'cancelled' }
      if (d.diff.tooMany) return failed('tooMany', h)
      if (d.run.timedOut) return failed('unavailable', h)
      truncated ||= d.run.truncated || d.overlong
      diffed = d.run.code === 0 || d.run.truncated
      // git did not answer: the status's own rows are not the list (in Branch they would leave out everything
      // committed), so the caller keeps the last one that worked. A diff Kea itself cut short (one record over
      // L.gitRecordMaxBytes) is not that: it is an incomplete list, said so by `truncated`.
      if (!diffed && !d.overlong) return failed('unavailable', h)
      if (diffed) for (const e of d.diff.entries.values()) entries.set(e.path, entry(e))
    }

    // 4. what only the status knows: conflicts, submodules, and every tracked change when there was no diff (no commit
    // to compare with yet, or a diff cut short at the record cap, L.gitRecordMaxBytes). The status runs without rename
    // detection, so a rename's old path is a deletion to it: the diff has that path as the new one's origin, and it is
    // not listed a second time.
    // A path the status calls deleted from the working tree and the diff does not list is not in the base either (the
    // diff compares the two): the file was added to git and then deleted from disk, and only the index has it
    // (`indexOnly`: Discard restores it from there, discard.ts). Not said of a diff cut short, which may have left it out.
    const baseLacksUnlisted = (diffed && !truncated) || b.base === null
    const renamedFrom = new Set<string>()
    for (const e of entries.values()) if (e.origPath !== null) renamedFrom.add(e.origPath)
    for (const e of tracked) {
      const have = entries.get(e.path)
      if (e.kind === 'u') entries.set(e.path, { path: e.path, code: '!', added: have?.added ?? null, removed: have?.removed ?? null, origPath: null })
      else if (!have && e.code === 'D' && renamedFrom.has(e.path)) continue
      else if (!have && (!diffed || scope === 'uncommitted'))
        entries.set(e.path, { path: e.path, code: e.code, added: null, removed: null, origPath: e.origPath, ...(e.submodule ? { submodule: true } : {}), ...(e.y === 'D' && baseLacksUnlisted ? { indexOnly: true } : {}) })
      else if (have && e.submodule && !have.submodule) entries.set(e.path, { ...have, submodule: true })
    }

    // 5. untracked files, with their line counts
    if (entries.size + untracked.length > L.gitStatusEntriesMax) return failed('tooMany', h)
    const budget = { left: L.untrackedCountBudgetBytes }
    for (const p of untracked) {
      if (signal.aborted) return { kind: 'cancelled' }
      entries.set(p, { path: p, code: 'U', added: await this.untrackedLines(p, budget), removed: null, origPath: null })
    }
    // counts kept only for files that are still untracked
    if (this.lines.size > untracked.length) {
      const now = new Set(untracked)
      for (const [k] of this.lines.entries()) if (!now.has(k)) this.lines.delete(k)
    }

    let added = 0
    let removed = 0
    for (const e of entries.values()) {
      added += e.added ?? 0
      removed += e.removed ?? 0
    }
    return {
      kind: 'done',
      ms: performance.now() - t0,
      snapshot: {
        entries,
        oid: h.oid,
        head: head('ok', h, { base: b.base, baseBranch: branch.branch, ahead: this.aheadBehind.ahead, behind: this.aheadBehind.behind, operation: operationIn(t.gitDir), totals: { files: entries.size, added, removed }, truncated }),
      },
    }
  }
}

function entry(e: DiffEntry): GitEntry {
  return { path: e.path, code: e.code, added: e.added, removed: e.removed, origPath: e.origPath, ...(e.submodule ? { submodule: true } : {}) }
}
