import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_FILES_TO_COPY } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { copyEntries, selectCopies } from './copy.ts'
import { compileRules, matches } from './ignore.ts'

const rel = (xs: { rel: string; dir: boolean }[]) => xs.map((x) => (x.dir ? `${x.rel}/` : x.rel))

describe('files to copy', () => {
  it('U-WT-7 · the matcher follows gitignore semantics: negation, anchoring, directory-only, `*`, `?`, classes and `**`', () => {
    const m = (patterns: string[], p: string, dir = false) => matches(compileRules(patterns), p, dir)
    // unanchored: any depth; anchored: from the root
    expect(m(['.env'], '.env')).toBe(true)
    expect(m(['.env'], 'apps/web/.env')).toBe(true)
    expect(m(['/.env'], 'apps/web/.env')).toBe(false)
    expect(m(['config/local.json'], 'config/local.json')).toBe(true)
    expect(m(['config/local.json'], 'x/config/local.json')).toBe(false)
    // `*` and `?` never cross a slash
    expect(m(['.env.*'], 'a/.env.local')).toBe(true)
    expect(m(['*.pem'], 'certs/dev.pem')).toBe(true)
    expect(m(['certs/*.pem'], 'certs/sub/dev.pem')).toBe(false)
    expect(m(['?.txt'], 'a.txt')).toBe(true)
    expect(m(['?.txt'], 'ab.txt')).toBe(false)
    expect(m(['file[0-9].txt'], 'file7.txt')).toBe(true)
    expect(m(['file[!0-9].txt'], 'file7.txt')).toBe(false)
    // `**`
    expect(m(['**/secrets.json'], 'a/b/secrets.json')).toBe(true)
    expect(m(['**/secrets.json'], 'secrets.json')).toBe(true)
    expect(m(['keys/**'], 'keys/a/b.key')).toBe(true)
    expect(m(['keys/**'], 'keys', true)).toBe(false)
    expect(m(['a/**/z'], 'a/z')).toBe(true)
    expect(m(['a/**/z'], 'a/b/c/z')).toBe(true)
    // directory-only patterns, and what is inside a matched directory
    expect(m(['certs/'], 'certs', true)).toBe(true)
    expect(m(['certs/'], 'certs', false)).toBe(false)
    expect(m(['certs/'], 'certs/dev.pem')).toBe(true)
    // negation: the last match wins; nothing inside a matched directory comes back
    expect(m(['.env*', '!.env.example'], '.env.example')).toBe(false)
    expect(m(['.env*', '!.env.example'], '.env.local')).toBe(true)
    expect(m(['certs/', '!certs/keep.pem'], 'certs/keep.pem')).toBe(true)
    // comments, blanks, escapes
    expect(compileRules(['# a comment', '', '   ', '\\#hash', '\\!bang'])).toHaveLength(2)
    expect(m(['\\#hash'], '#hash')).toBe(true)
    expect(m(['\\!bang'], '!bang')).toBe(true)
  })

  it('U-WT-7 · selection: `.worktreeinclude` takes ignored files only; the defaults take untracked ones; never .git, never node_modules unless named; a copied directory carries its contents', () => {
    const ignored = ['.env', '.env.local', 'apps/web/.env.production', 'node_modules/', 'certs/', 'dist/', 'CLAUDE.local.md', 'sub/.env', '.git/x']
    const untracked = ['notes.md', '.env.untracked-not-ignored', 'docs/CLAUDE.local.md', '.commandcode/settings.local.json']
    // the defaults: .env and .env.* at any depth, two root files; anything ignored or untracked, never tracked (git lists neither)
    expect(rel(selectCopies({ ignored, untracked, patterns: DEFAULT_FILES_TO_COPY, ignoredOnly: false }))).toEqual([
      '.commandcode/settings.local.json',
      '.env',
      '.env.local',
      '.env.untracked-not-ignored',
      'apps/web/.env.production',
      'CLAUDE.local.md',
      'sub/.env',
    ])
    // .worktreeinclude: only what is ignored
    expect(rel(selectCopies({ ignored, untracked, patterns: ['.env*', 'certs/', 'notes.md'], ignoredOnly: true }))).toEqual(['.env', '.env.local', 'apps/web/.env.production', 'certs/', 'sub/.env'])
    // never .git, not even when a pattern names it or matches everything
    for (const patterns of [['**'], ['.git', '.git/'], ['.git/x', '.git/y'], ['**/z']]) {
      const picked = rel(selectCopies({ ignored, untracked: ['.git/y', 'sub/.git/z'], patterns, ignoredOnly: false }))
      expect(picked.filter((x) => /(^|\/)\.git(\/|$)/.test(x)), `patterns ${patterns.join(' ')}`).toEqual([])
    }
    // node_modules only when a pattern names it; `**` alone does not bring it
    expect(rel(selectCopies({ ignored, untracked: [], patterns: ['**'], ignoredOnly: true }))).not.toContain('node_modules/')
    expect(rel(selectCopies({ ignored, untracked: [], patterns: ['node_modules'], ignoredOnly: true }))).toEqual(['node_modules/'])
    // a directory copied whole carries what is inside it once
    expect(rel(selectCopies({ ignored: ['certs/', 'certs/a.pem'], untracked: [], patterns: ['certs/', '*.pem'], ignoredOnly: true }))).toEqual(['certs/'])
  })

  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const tmp = (prefix: string) => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
    dirs.push(d)
    return d
  }
  const write = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }

  it('U-WT-12 · the copy never writes through a symlink in the new worktree: a symlinked parent at any depth, or a destination that is a symlink, is refused and named; everything outside stays as it was', async () => {
    const main = tmp('kea-copy-main-')
    const wt = tmp('kea-copy-wt-')
    const outside = tmp('kea-copy-outside-')
    for (const rel of ['.commandcode/settings.local.json', 'deep/a/b/.env', 'CLAUDE.local.md', '.env', 'certs/dev.pem']) write(path.join(main, rel), `from main: ${rel}\n`)
    write(path.join(outside, 'CLAUDE.local.md'), 'outside\n')
    // what a checked-out base can hold: tracked symlinks out of the worktree
    fs.symlinkSync(outside, path.join(wt, '.commandcode'))
    fs.mkdirSync(path.join(wt, 'deep'))
    fs.symlinkSync(outside, path.join(wt, 'deep', 'a'))
    fs.symlinkSync(path.join(outside, 'CLAUDE.local.md'), path.join(wt, 'CLAUDE.local.md'))
    fs.symlinkSync(outside, path.join(wt, 'certs'))
    const before = fs.readdirSync(outside).sort()
    const r = await copyEntries(main, wt, [
      { rel: '.commandcode/settings.local.json', dir: false },
      { rel: 'deep/a/b/.env', dir: false },
      { rel: 'CLAUDE.local.md', dir: false },
      { rel: 'certs', dir: true },
      { rel: '.env', dir: false },
    ])
    expect(r.copied).toEqual(['.env'])
    expect(r.refused.map((x) => x.rel)).toEqual(['.commandcode/settings.local.json', 'deep/a/b/.env', 'CLAUDE.local.md', 'certs/'])
    expect(fs.readdirSync(outside).sort(), 'nothing written outside the worktree').toEqual(before)
    expect(fs.readFileSync(path.join(outside, 'CLAUDE.local.md'), 'utf8')).toBe('outside\n')
    expect(fs.readFileSync(path.join(wt, '.env'), 'utf8')).toBe('from main: .env\n')
  })
})
