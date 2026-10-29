import { describe, expect, it } from 'vitest'
import { copyNames } from './ops.ts'

const first = (name: string, dir: boolean, keep: boolean, n: number): string[] => {
  const out: string[] = []
  for (const s of copyNames(name, dir, keep)) {
    out.push(s)
    if (out.length === n) break
  }
  return out
}

describe('the names of a copy', () => {
  it('U-FT-27 · a copy keeps its name in another folder, then is named as Finder names one: before the extension, counting on from a copy of a copy', () => {
    expect(first('a.txt', false, true, 3)).toEqual(['a.txt', 'a copy.txt', 'a copy 2.txt'])
    expect(first('a.txt', false, false, 3)).toEqual(['a copy.txt', 'a copy 2.txt', 'a copy 3.txt'])
    expect(first('a copy.txt', false, false, 2)).toEqual(['a copy.txt', 'a copy 2.txt'])
    expect(first('a copy 7.txt', false, false, 2)).toEqual(['a copy.txt', 'a copy 2.txt'])
    expect(first('archive.tar.gz', false, false, 1)).toEqual(['archive.tar copy.gz'])
    // a dotfile has no extension; a folder's name never has one
    expect(first('.env', false, false, 2)).toEqual(['.env copy', '.env copy 2'])
    expect(first('v1.2', true, false, 2)).toEqual(['v1.2 copy', 'v1.2 copy 2'])
    expect(first('Makefile', false, false, 1)).toEqual(['Makefile copy'])
  })
})
