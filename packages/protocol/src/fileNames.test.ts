import { describe, expect, it } from 'vitest'
import { checkName, hasGitSegment, isGitSegment, sizeText } from './fileNames.ts'
import { zDroppedPaths } from './files.ts'
import { L } from './generated/limits.ts'

const reason = (name: string, o: { nested: boolean; dir?: string }): string | null => {
  const r = checkName(name, o)
  return r.ok ? null : r.reason
}

describe('the names the file tree gives', () => {
  it('U-FT-24 · a name is refused with its reason: empty, a control character, `/` in a rename, an empty segment, `.` and `..`, a space at either end, git’s folder, too long', () => {
    const one = { nested: false }
    const nested = { nested: true }
    expect(checkName('a.ts', one)).toEqual({ ok: true, segments: ['a.ts'] })
    expect(checkName('Ünïcødé name.md', one).ok).toBe(true)
    expect(reason('', one)).toBe('Type a name')
    expect(reason('a\tb', one)).toMatch(/control character/)
    expect(reason('a\u007fb', nested)).toMatch(/control character/)
    expect(reason('a/b', one)).toMatch(/“\/”/)
    for (const bad of ['/a', 'a/', 'a//b']) expect(reason(bad, nested), bad).toMatch(/begin or end with “\/”/)
    for (const bad of ['.', '..', 'a/./b', 'a/..']) expect(reason(bad, nested), bad).toMatch(/are not names/)
    for (const bad of [' a', 'a ', 'a/ b']) expect(reason(bad, nested), bad).toMatch(/space/)
    expect(checkName('a b', one).ok).toBe(true)
    // one segment at most the file systems' length in UTF-8 bytes (é is two)
    expect(checkName('x'.repeat(L.fileNameMaxBytes), one).ok).toBe(true)
    expect(reason('x'.repeat(L.fileNameMaxBytes + 1), one)).toMatch(/at most/)
    expect(reason('é'.repeat(L.fileNameMaxBytes / 2 + 1), one)).toMatch(/at most/)
  })

  it('U-FT-24 · a new entry’s name makes the folders on the way; its whole path, with the folder it goes in, has a length too', () => {
    expect(checkName('src/lib/a.ts', { nested: true })).toEqual({ ok: true, segments: ['src', 'lib', 'a.ts'] })
    // a nested name of `n` bytes, in segments of 99
    const nested = (n: number): string => `${'x'.repeat(99)}/`.repeat(Math.floor(n / 100)) + 'x'.repeat(n % 100)
    expect(nested(L.filePathMaxBytes)).toHaveLength(L.filePathMaxBytes)
    expect(checkName(nested(L.filePathMaxBytes), { nested: true }).ok).toBe(true)
    expect(reason(nested(L.filePathMaxBytes + 1), { nested: true })).toMatch(/A path is at most/)
    // the folder it goes in counts: `d/` plus the name
    expect(checkName(nested(L.filePathMaxBytes - 2), { nested: true, dir: 'd' }).ok).toBe(true)
    expect(reason(nested(L.filePathMaxBytes - 1), { nested: true, dir: 'd' })).toMatch(/A path is at most/)
  })

  it('U-FT-24 · git’s own folder in any spelling git treats as it: any case, and with the code points the Mac volume ignores', () => {
    for (const s of ['.git', '.GIT', '.Git', '.g‌it', '‍.git', '.gi﻿t', '.‪git']) {
      expect(isGitSegment(s), JSON.stringify(s)).toBe(true)
      expect(reason(s, { nested: false }), JSON.stringify(s)).toMatch(/git’s own folder/)
      expect(reason(`a/${s}/b`, { nested: true }), JSON.stringify(s)).toMatch(/git’s own folder/)
    }
    for (const s of ['.gitignore', 'git', '.git2', '..git', '.github']) {
      expect(isGitSegment(s), s).toBe(false)
      expect(checkName(s, { nested: false }).ok, s).toBe(true)
    }
    expect(hasGitSegment('a/.GIT/config')).toBe(true)
    expect(hasGitSegment('a/.gitignore')).toBe(false)
  })

  it('U-FT-24 · dropped paths: absolute, no NUL, not too long, not repeated, and not too many', () => {
    expect(zDroppedPaths.safeParse(['/Users/someone/a.txt', '/tmp/b']).success).toBe(true)
    for (const bad of [[], ['a.txt'], ['/'], ['/a\0b'], [`/${'x'.repeat(L.fileDropPathMaxBytes)}`], ['/a', '/a']]) expect(zDroppedPaths.safeParse(bad).success, JSON.stringify(bad).slice(0, 40)).toBe(false)
    expect(zDroppedPaths.safeParse(Array.from({ length: L.fileDropMax }, (_, i) => `/f${i}`)).success).toBe(true)
    expect(zDroppedPaths.safeParse(Array.from({ length: L.fileDropMax + 1 }, (_, i) => `/f${i}`)).success).toBe(false)
  })

  it('U-FT-24 · sizes in the copy sheet read as Finder writes them, in decimal units', () => {
    expect(sizeText(0)).toBe('0 bytes')
    expect(sizeText(1)).toBe('1 byte')
    expect(sizeText(999)).toBe('999 bytes')
    expect(sizeText(1000)).toBe('1 KB')
    expect(sizeText(1500)).toBe('1.5 KB')
    expect(sizeText(12_400_000)).toBe('12 MB')
    expect(sizeText(1_500_000_000)).toBe('1.5 GB')
  })
})
