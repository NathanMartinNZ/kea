// Core microbenchmarks: git work on a repository of repo-factory's `medium` shape, in-process, through the same
// functions core runs. Run them on the reference machine with nothing else heavy running: each is timed 5× after one
// warm-up and the median is compared with its budget. Each result is recorded in tools/perf/last.json like the
// app-level ones.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RepoMutex } from '@kea/core/src/worktrees/mutex.ts'
import { writeSnapshot, type Repo } from '@kea/core/src/worktrees/ops.ts'
import { fixtureGitEnv, MEDIUM_FILES, mediumRepo, mediumSourceFile, type FixtureRepo } from '@kea-tools/repo-factory/src/index.ts'
import { BUDGETS } from '../../tools/perf/src/generated/budgets.ts'
import { check, perfEnv, recordResult, type PerfResult } from '../../tools/perf/src/record.ts'

const RUNS = 5
/** The dirty worktree's modified and untracked files: this many of each. */
const MODIFIED = 200
const UNTRACKED = 200

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

function record(r: PerfResult): boolean {
  return recordResult(r, { env: perfEnv(`in-process microbenchmark: Vitest on Node ${process.version}`) }).pass
}

const repos: FixtureRepo[] = []
afterAll(() => {
  for (const r of repos.splice(0)) r.dispose()
})

describe('core microbenchmarks', () => {
  it('P-WT-1 · the delete snapshot of a dirty worktree of the medium repo (modified and untracked files) is written within budget', async () => {
    const repo = mediumRepo()
    repos.push(repo)
    const env = fixtureGitEnv() as Record<string, string | undefined>
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString()
    expect(Number(git(repo.root, 'ls-files').split('\n').filter(Boolean).length), 'the medium shape').toBe(MEDIUM_FILES)
    // a session's worktree, as core makes it, then dirtied
    const wt = path.join(path.dirname(repo.root), 'worktrees', 'snapshot-me')
    git(repo.root, 'worktree', 'add', '-q', '-b', 'kea/snapshot-me', wt, 'main')
    const modified = Array.from({ length: MODIFIED }, (_, i) => path.join(wt, mediumSourceFile(i * 7, i)))
    const originals = modified.map((f) => fs.readFileSync(f, 'utf8'))
    fs.mkdirSync(path.join(wt, 'scratch'), { recursive: true })
    /**
     * Dirty the worktree with content of its own for each run: a snapshot writes a blob for every changed file, and one
     * the object database already holds (an earlier run's) costs nothing, so every run must bring new ones, as a real
     * delete does.
     */
    const dirty = (run: number) => {
      modified.forEach((f, i) => fs.writeFileSync(f, `${originals[i]}// edited ${i} in run ${run}\n`))
      for (let i = 0; i < UNTRACKED; i++) fs.writeFileSync(path.join(wt, 'scratch', `new-${i}.ts`), `export const n${i} = ${i} // run ${run}\n`)
    }
    dirty(0)
    const status = git(wt, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    expect(status.length, 'the dirty worktree').toBe(MODIFIED + UNTRACKED)

    const r: Repo = { root: repo.root, commonDir: path.join(repo.root, '.git'), env, mutex: new RepoMutex() }
    const tmpDir = path.join(path.dirname(repo.root), 'snapshot-tmp')
    const times: number[] = []
    let files = 0
    for (let i = 0; i <= RUNS; i++) {
      if (i > 0) dirty(i) // new content, so new objects to write (outside the timing)
      const t0 = performance.now()
      const s = await writeSnapshot(r, { wt, sessionId: `perf${i}`, slug: 'snapshot-me', tmpDir })
      const ms = performance.now() - t0
      if (i > 0) times.push(ms) // the first is the warm-up
      files = git(repo.root, 'diff', '--name-only', `${s.ref}^`, s.ref).split('\n').filter(Boolean).length
    }
    expect(files, 'the snapshot holds every modified and untracked file').toBe(MODIFIED + UNTRACKED)
    const b = BUDGETS['P-WT-1']
    const ms = median(times)
    console.log(`P-WT-1 delete snapshot: median ${ms.toFixed(0)} ms (${times.map((t) => t.toFixed(0)).join(', ')})`)
    const pass = record({
      id: 'P-WT-1',
      metric: b.metric,
      method: `repo-factory medium (${MEDIUM_FILES} files), a linked worktree with ${MODIFIED} modified and ${UNTRACKED} untracked files, rewritten with new content before each run (so each writes its own objects); core's writeSnapshot (temporary index, add, write-tree, commit-tree, update-ref) timed ${RUNS}× after one warm-up, median`,
      values: { medianMs: ms, maxMs: Math.max(...times) },
      checks: [check('medianMs', ms, b.max, 'max', b.unit)],
    })
    expect(ms).toBeLessThanOrEqual(b.max)
    expect(pass).toBe(true)
  }, 120_000)
})
