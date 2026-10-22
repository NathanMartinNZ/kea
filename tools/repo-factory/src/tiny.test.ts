import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertRecordable, demoPrompts } from '../../scrubber/src/guard.ts'
import { fixtureGitEnv, type FixtureRepo, TINY_FILES, tinyRepo } from './tiny.ts'

let repo: FixtureRepo | null = null
afterEach(() => {
  repo?.dispose()
  repo = null
})

describe('repo factory: tiny', () => {
  it('U-REPO-1 · ten committed files, a fixed identity, and the recorder guard accepts it', () => {
    repo = tinyRepo()
    expect(Object.keys(TINY_FILES)).toHaveLength(10)
    for (const rel of Object.keys(TINY_FILES)) expect(readFileSync(join(repo.root, rel), 'utf8')).toBe(TINY_FILES[rel])
    const git = (...a: string[]) => execFileSync('git', ['-C', repo!.root, ...a], { env: fixtureGitEnv(), encoding: 'utf8' }).trim()
    expect(git('status', '--porcelain')).toBe('')
    expect(git('log', '--format=%an <%ae> %ai')).toBe('Kea Fixture <fixture@example.invalid> 2026-01-01 12:00:00 +0000') // %ai: git's strict ISO form (%aI) writes UTC as Z in newer gits, +00:00 in older ones
    expect(git('ls-files').split('\n')).toHaveLength(10)
    // every demo prompt is recordable here, and nothing else is
    for (const p of demoPrompts()) expect(assertRecordable({ cwd: join(repo.root, 'src'), prompt: p }).root).toBe(repo.root)
    expect(() => assertRecordable({ cwd: repo!.root, prompt: 'summarise ~/secrets' })).toThrow(/not in/)
    repo.dispose()
    expect(existsSync(repo.root)).toBe(false)
    repo = null
  })

  it('U-REPO-2 · the demo files do what the demo prompts assume (tests pass, the typo exists)', () => {
    repo = tinyRepo()
    const out = execFileSync(process.execPath, ['--test', 'test/'], { cwd: repo.root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })
    expect(out).toMatch(/pass 3\n/)
    expect(readFileSync(join(repo.root, 'src/hello.js'), 'utf8')).toContain('Helo,')
  })
})
