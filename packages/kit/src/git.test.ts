import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { L } from '@kea/protocol/limits'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GitCommandError, git, gitBinary, gitText, setGitBinary } from './git.ts'

let tmp: string
let repo: string
/** Hermetic git: no user or system config. */
const env = { PATH: process.env.PATH, HOME: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

beforeAll(async () => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'kea-kit-git-'))
  repo = join(tmp, 'repo')
  fs.mkdirSync(repo)
  expect((await git(['init', '-q', '-b', 'main'], { cwd: repo, env })).code).toBe(0)
  fs.writeFileSync(join(repo, 'a.txt'), 'hello\n')
  await gitText(['add', 'a.txt'], { cwd: repo, env })
  await gitText(['-c', 'user.name=Kea Test', '-c', 'user.email=test@kea.invalid', 'commit', '-q', '-m', 'init'], { cwd: repo, env })
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

afterEach(() => {
  setGitBinary('git')
  vi.useRealTimers()
})

function fakeGit(body: string): string {
  const path = join(tmp, `fake-git-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return path
}

describe('git()', () => {
  it('U-WT-9 · runs real git in a repo and returns its output; non-zero exits resolve', async () => {
    const head = await gitText(['rev-parse', 'HEAD'], { cwd: repo, env, readOnly: true })
    expect(head.trim()).toMatch(/^[0-9a-f]{40}$/)
    fs.writeFileSync(join(repo, 'b.txt'), 'new\n')
    const status = await git(['status', '--porcelain=v1', '-z'], { cwd: repo, env, readOnly: true })
    expect(status.code).toBe(0)
    expect(status.stdout?.toString()).toBe('?? b.txt\0')
    const bad = await git(['rev-parse', 'no-such-ref'], { cwd: repo, env })
    expect(bad.code).not.toBe(0)
    expect(bad.stderr).toContain('no-such-ref')
    await expect(gitText(['rev-parse', 'no-such-ref'], { cwd: repo, env })).rejects.toBeInstanceOf(GitCommandError)
  })

  it('U-WT-9 · always sets GIT_TERMINAL_PROMPT=0, and GIT_OPTIONAL_LOCKS=0 only for read-only commands', async () => {
    setGitBinary(fakeGit('echo "prompt=$GIT_TERMINAL_PROMPT locks=${GIT_OPTIONAL_LOCKS-unset} args=$*"'))
    const ro = await gitText(['status', '--short'], { cwd: repo, env, readOnly: true })
    expect(ro.trim()).toBe('prompt=0 locks=0 args=status --short')
    const rw = await gitText(['commit', '-m', 'x y'], { cwd: repo, env })
    expect(rw.trim()).toBe('prompt=0 locks=unset args=commit -m x y')
    expect(gitBinary()).not.toBe('git')
  })

  it('U-WT-9 · times out after L.gitDefaultTimeoutMs by default (or the given timeout) and kills git', async () => {
    setGitBinary(fakeGit('echo started; exec sleep 30'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let started!: () => void
    const isStarted = new Promise<void>((r) => (started = r))
    const run = git(['fetch'], { cwd: repo, env, onStdout: () => started() })
    await isStarted
    vi.advanceTimersByTime(L.gitDefaultTimeoutMs - 1)
    await Promise.resolve()
    vi.advanceTimersByTime(1)
    const res = await run
    expect(res.timedOut).toBe(true)
    expect(res.signal).toBe('SIGTERM')
    vi.useRealTimers()

    const quick = await git(['fetch'], { cwd: repo, env, timeoutMs: 50 })
    expect(quick.timedOut).toBe(true)
  })
})
