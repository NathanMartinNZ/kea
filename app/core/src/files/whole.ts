// Which directories of a work tree git ignores whole: ignored by its rules, with nothing tracked inside, so that no
// status can ever report from below them. Only those may be left out of the worktree's watch stream in the kernel
// (platform/watch/exclusions.ts): a tracked `build/` or `dist/` must be heard.
//
// One `git check-ignore`, read-only, on the git pool. Asked with a trailing slash, a name is answered as a directory
// whether or not it exists yet (a rule like `node_modules/` matches before `pnpm install` makes the folder); and a
// directory with a tracked file below it is not answered at all, whatever the rules say (git checks the path against
// the index first), which is exactly the question.

import { git } from '@kea/kit'
import { L } from '@kea/protocol'
import type { Env } from './status.ts'

/**
 * Those of `names` (directories directly inside `root`) that git ignores whole. Null: git did not say (it failed, was
 * cut short or timed out), and nothing may be assumed. Never rejects.
 */
export async function ignoredWhole(root: string, names: readonly string[], env: () => Promise<Env>, timeoutMs: number = L.gitStatusTimeoutMs): Promise<string[] | null> {
  if (names.length === 0) return []
  try {
    const r = await git(['check-ignore', '-z', '--stdin'], { cwd: root, env: await env(), readOnly: true, stdin: names.map((n) => `${n}/\0`).join(''), timeoutMs, collect: true })
    // 0: some are ignored; 1: none is; anything else (128: not a repository, a damaged one) is no answer
    if (r.timedOut || r.truncated || r.cancelled || (r.code !== 0 && r.code !== 1)) return null
    const said = new Set((r.stdout ?? Buffer.alloc(0)).toString('utf8').split('\0'))
    return names.filter((n) => said.has(`${n}/`))
  } catch {
    return null
  }
}
