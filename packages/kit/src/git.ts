// Every git invocation by Kea goes through `git()`: the `git` pool, GIT_TERMINAL_PROMPT=0 always (Kea never blocks on a
// credential prompt), GIT_OPTIONAL_LOCKS=0 for read-only commands (so a background `status` never takes index.lock from
// under the user), and a timeout (default L.gitDefaultTimeoutMs). Children have no controlling terminal (own session)
// and stdin is /dev/null unless given, so nothing can prompt.

import { L } from '@kea/protocol/limits'
import { runProcess } from './runProcess.ts'
import type { ProcessResult, RunProcessOptions } from './runProcess.ts'

export interface GitOptions extends Omit<RunProcessOptions, 'pool' | 'cwd'> {
  /** Working directory (the repo or worktree). */
  cwd: string
  /** A command that only reads: adds GIT_OPTIONAL_LOCKS=0. */
  readOnly?: boolean
}

let binary = 'git'

/** Use a specific git executable (resolved at startup, e.g. from the login-shell PATH). */
export function setGitBinary(path: string): void {
  if (path.length === 0) throw new TypeError('setGitBinary: empty path')
  binary = path
}

export function gitBinary(): string {
  return binary
}

/** The environment `git()` gives its child for `opts`. */
export function gitEnv(opts: Pick<GitOptions, 'env' | 'readOnly'>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...(opts.env ?? process.env), GIT_TERMINAL_PROMPT: '0' }
  if (opts.readOnly) env.GIT_OPTIONAL_LOCKS = '0'
  return env
}

/** Run git with `args` on the `git` pool. Resolves for any exit status; see `runProcess`. */
export function git(args: readonly string[], opts: GitOptions): Promise<ProcessResult> {
  const { readOnly: _readOnly, ...rest } = opts
  return runProcess(binary, args, {
    ...rest,
    pool: 'git',
    env: gitEnv(opts),
    timeoutMs: opts.timeoutMs ?? L.gitDefaultTimeoutMs,
  })
}

/** A git command that did not exit 0 (or was killed). */
export class GitCommandError extends Error {
  readonly args: readonly string[]
  readonly result: ProcessResult
  constructor(args: readonly string[], result: ProcessResult) {
    const why = result.timedOut
      ? 'timed out'
      : result.cancelled
        ? 'cancelled'
        : result.truncated
          ? 'output over its byte cap'
          : result.signal
            ? `killed by ${result.signal}`
            : `exit ${result.code}`
    const detail = result.stderr.trim().split('\n').slice(-3).join(' | ')
    super(`git ${args.join(' ')}: ${why}${detail ? ` — ${detail}` : ''}`)
    this.name = 'GitCommandError'
    this.args = args
    this.result = result
  }
}

/** Run git and return its stdout as UTF-8; throws GitCommandError unless it exited 0 untruncated. */
export async function gitText(args: readonly string[], opts: GitOptions): Promise<string> {
  const res = await git(args, { ...opts, collect: true })
  if (res.code !== 0 || res.truncated || res.timedOut || res.cancelled) throw new GitCommandError(args, res)
  return (res.stdout ?? Buffer.alloc(0)).toString('utf8')
}
