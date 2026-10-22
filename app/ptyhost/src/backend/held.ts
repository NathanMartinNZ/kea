// A non-detached holder, the fallback when holders cannot detach: the same `kea-helper pty` argv plus
// `--no-detach`, run as ptyhost's own child with its stdin pipe held open (`kit/runHeld`). The process itself is the
// holder: it prints the same result line once it listens, speaks the same protocol, and takes EOF on its stdin (this
// pipe closing, because ptyhost released it or exited) as "ptyhost is gone": it terminates the child's tree (SIGTERM,
// then SIGKILL after L.holderParentGoneGraceMs) and exits, so nothing outlives Kea unowned.

import { runHeld, type ProcessResult } from '@kea/kit'
import { L } from '@kea/protocol'
import { helperSpawnError, HolderLaunchError, launchArgs, noResultError, parseLaunchOutput, prepareLaunch, type LaunchRequest } from '../holder/launch.ts'

export interface HeldHolder {
  readonly pid: number
  readonly childPid: number
  /** Close the stdin pipe: the holder ends its child's tree and exits. Idempotent. */
  release(): void
  /** Settles once the holder process has exited and been reaped. */
  readonly exited: Promise<ProcessResult>
}

/** Start a non-detached holder; resolves once it listens (its result line), like the detached launcher. */
export function launchHeld(r: LaunchRequest): Promise<HeldHolder> {
  prepareLaunch(r)
  return new Promise<HeldHolder>((resolve, reject) => {
    const abort = new AbortController()
    let closeStdin: (() => void) | null = null
    let line = ''
    let settled = false
    const timer = setTimeout(() => abort.abort(), L.holderLaunchTimeoutMs)
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    let result: { pid: number; childPid: number } | null = null
    const exited = runHeld(r.helper, launchArgs({ ...r, noDetach: true }), {
      env: r.spec.env, // the helper's environment is the child's
      maxBytes: L.holderLaunchOutputMaxBytes,
      collect: false,
      signal: abort.signal,
      onSpawn: (c) => {
        closeStdin = c.closeStdin
      },
      onStdout: (chunk) => {
        if (result) return
        line += chunk.toString('utf8')
        if (!line.includes('\n')) return
        try {
          result = parseLaunchOutput(line)
        } catch (e) {
          // a refusal comes before any PTY child exists: the holder exits by itself (exit 1); make sure of it
          settle(() => reject(e))
          abort.abort()
          return
        }
        const ok = result
        let released = false
        const release = () => {
          if (released) return
          released = true
          closeStdin?.()
        }
        settle(() => resolve({ pid: ok.pid, childPid: ok.childPid, release, exited }))
      },
    })
    exited.then(
      (res) => {
        // exited before its result line: report why (a broken helper, the timeout, a refusal without a line)
        settle(() => reject(result ? new HolderLaunchError('kea-helper exited') : noResultError(res, new Error(line ? `printed ${JSON.stringify(line.slice(0, 200))}` : 'printed nothing'))))
      },
      (e: unknown) => settle(() => reject(helperSpawnError(r.helper, e))), // a missing helper, or a resource limit
    )
  })
}
