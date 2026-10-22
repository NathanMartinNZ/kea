import { describe, expect, it } from 'vitest'
import { L, type GitCode } from '@kea/protocol'
import { BaseCache, type BaseInputs } from './base.ts'
import { StatusParser, statusCode, type StatusEntry } from './porcelain.ts'
import { DiffParser } from './rawdiff.ts'
import { ZRecords } from './records.ts'
import { countLines } from './status.ts'

const Z = '\0'
const O = '1234567890abcdef1234567890abcdef12345678'

/** Parse `bytes` as status output, fed in chunks of `step` bytes (every boundary a real stream could have). */
function status(bytes: Buffer, step = bytes.length, max?: number): { p: StatusParser; entries: StatusEntry[]; z: ZRecords } {
  const entries: StatusEntry[] = []
  const p = new StatusParser((e) => void entries.push(e), max)
  const z = new ZRecords((r) => p.record(r))
  for (let i = 0; i < bytes.length && z.push(bytes.subarray(i, i + Math.max(1, step))); i += Math.max(1, step));
  z.end()
  return { p, entries, z }
}

function diff(bytes: Buffer, step = bytes.length, max?: number): DiffParser {
  const d = new DiffParser(max)
  const z = new ZRecords((r) => d.record(r))
  for (let i = 0; i < bytes.length && z.push(bytes.subarray(i, i + Math.max(1, step))); i += Math.max(1, step));
  z.end()
  return d
}

describe('git status --porcelain=v2 -z', () => {
  const sample = Buffer.from(
    [
      `# branch.oid ${O}`,
      '# branch.head kea/fix-auth',
      '# branch.upstream origin/kea/fix-auth',
      '# branch.ab +3 -12',
      `1 .M N... 100644 100644 100644 ${O} ${O} src/auth/login.ts`,
      `1 A. N... 000000 100644 100644 ${'0'.repeat(40)} ${O} src/new file.ts`,
      `2 R. N... 100644 100644 100644 ${O} ${O} R100 src/renamed.ts${Z}src/old name.ts`,
      `u UU N... 100644 100644 100644 100644 ${O} ${O} ${O} src/conflict.ts`,
      `1 .M S.M. 160000 160000 160000 ${O} ${O} vendor/lib`,
      '? notes.txt',
      '? nested-repo/',
      '! node_modules/',
      '',
    ].join(Z),
  )

  it('U-GS-1 · ordinary, renamed (its second NUL-separated path), unmerged and untracked entries and the branch headers, whatever the chunk boundaries', () => {
    for (const step of [sample.length, 1, 7, 64]) {
      const { p, entries } = status(sample, step)
      expect(p.header, `step ${step}`).toEqual({ oid: O, branch: 'kea/fix-auth', detached: false, upstream: 'origin/kea/fix-auth', ahead: 3, behind: 12 })
      expect(entries.map((e) => [e.kind, e.x + e.y, e.code, e.path, e.origPath, e.submodule]), `step ${step}`).toEqual([
        ['1', '.M', 'M', 'src/auth/login.ts', null, false],
        ['1', 'A.', 'A', 'src/new file.ts', null, false],
        ['2', 'R.', 'R', 'src/renamed.ts', 'src/old name.ts', false],
        ['u', 'UU', '!', 'src/conflict.ts', null, false],
        ['1', '.M', 'M', 'vendor/lib', null, true], // a submodule: one entry
        ['?', '??', 'U', 'notes.txt', null, false],
        ['?', '??', 'U', 'nested-repo', null, false], // a nested repository is listed as `dir/`
      ])
      expect(p.count).toBe(7) // the ignored record is not an entry
    }
    // before the first commit, and on a detached HEAD
    const fresh = status(Buffer.from(`# branch.oid (initial)${Z}# branch.head main${Z}`))
    expect(fresh.p.header).toMatchObject({ oid: null, branch: 'main', detached: false, upstream: null, ahead: null })
    const detached = status(Buffer.from(`# branch.oid ${O}${Z}# branch.head (detached)${Z}`))
    expect(detached.p.header).toMatchObject({ oid: O, branch: null, detached: true })
  })


  it('U-GS-12 · a path loses every trailing slash (a nested repository’s `dir/`, and `dir//`, which git never prints); one that is only slashes is no entry', () => {
    const recs = ['? nested/', '? twice//', `1 .M N... 100644 100644 100644 ${O} ${O} sub///`, '? /', '? //']
    const { entries } = status(Buffer.from(recs.map((r) => `${r}${Z}`).join('')))
    expect(entries.map((e) => e.path)).toEqual(['nested', 'twice', 'sub'])
  })
  it('U-GS-2 · paths with spaces, tabs, newlines, leading dashes and bytes that are not UTF-8 come through whole (replacement characters for the bytes)', () => {
    const paths = ['a b/c d.txt', 'tab\there.txt', 'line\nbreak.txt', '-rf', '--help.md', ' lead and trail ', 'ünï/çødé.txt', '1 .M looks like a record']
    const recs: Buffer[] = paths.map((p) => Buffer.from(`1 .M N... 100644 100644 100644 ${O} ${O} ${p}${Z}`))
    recs.push(Buffer.concat([Buffer.from(`1 .M N... 100644 100644 100644 ${O} ${O} bad-`), Buffer.from([0xff, 0xfe]), Buffer.from(`.bin${Z}`)]))
    recs.push(Buffer.concat([Buffer.from('? latin-'), Buffer.from([0xe9]), Buffer.from(Z)]))
    const all = Buffer.concat(recs)
    for (const step of [all.length, 1, 13]) {
      const { entries } = status(all, step)
      expect(entries.map((e) => e.path), `step ${step}`).toEqual([...paths, 'bad-��.bin', 'latin-�'])
    }
    // the same names in a diff's raw and numstat records
    const d = diff(Buffer.from(paths.map((p) => `:100644 100644 ${O} ${O} M${Z}${p}${Z}`).join('') + paths.map((p, i) => `${i}\t${i + 1}\t${p}${Z}`).join('')), 5)
    expect([...d.entries.values()].map((e) => [e.path, e.added, e.removed])).toEqual(paths.map((p, i) => [p, i, i + 1]))
  })

  it('U-GS-3 · every staged / unstaged letter pair maps to one of Kea’s letters: conflicts whatever the pair, deleted on either side, renamed, new to the index, else modified', () => {
    const table: Record<string, GitCode> = {
      // unstaged only
      '.M': 'M', '.T': 'M', '.D': 'D', '.A': 'A',
      // staged only
      'M.': 'M', 'T.': 'M', 'A.': 'A', 'D.': 'D', 'C.': 'A',
      // both
      MM: 'M', MT: 'M', MD: 'D', TM: 'M', TD: 'D', AM: 'A', AT: 'A', AD: 'D', CM: 'A', CD: 'D',
    }
    for (const [xy, code] of Object.entries(table)) expect(statusCode('1', xy[0] as string, xy[1] as string), xy).toBe(code)
    for (const xy of ['R.', 'RM', 'RT']) expect(statusCode('2', xy[0] as string, xy[1] as string), xy).toBe('R')
    expect(statusCode('2', 'R', 'D')).toBe('D')
    expect(statusCode('2', 'C', '.')).toBe('A')
    for (const xy of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) expect(statusCode('u', xy[0] as string, xy[1] as string), xy).toBe('!')
    expect(statusCode('?', '?', '?')).toBe('U')
  })

  it('U-GS-4 · `git diff --raw --numstat -z`: raw records (letters, rename and copy scores) then numstat records (counts, binary `-`, the rename triple), paired by path', () => {
    const out = Buffer.from(
      [
        `:100644 100644 ${O} ${O} M${Z}src/a.ts${Z}`,
        `:000000 100644 ${O} ${O} A${Z}src/new.ts${Z}`,
        `:100644 000000 ${O} ${O} D${Z}src/gone.ts${Z}`,
        `:100644 100644 ${O} ${O} R087${Z}src/old.ts${Z}src/moved.ts${Z}`,
        `:100644 100644 ${O} ${O} C100${Z}src/a.ts${Z}src/copy.ts${Z}`,
        `:100644 100755 ${O} ${O} T${Z}bin/tool${Z}`,
        `:100644 100644 ${O} ${O} M${Z}img/logo.png${Z}`,
        `:160000 160000 ${O} ${O} M${Z}vendor/lib${Z}`,
        `:100644 100644 ${O} ${O} U${Z}src/conflict.ts${Z}`,
        `12\t3\tsrc/a.ts${Z}`,
        `40\t0\tsrc/new.ts${Z}`,
        `0\t25\tsrc/gone.ts${Z}`,
        `2\t1\t${Z}src/old.ts${Z}src/moved.ts${Z}`,
        `0\t0\t${Z}src/a.ts${Z}src/copy.ts${Z}`,
        `0\t0\tbin/tool${Z}`,
        `-\t-\timg/logo.png${Z}`,
        `1\t1\tvendor/lib${Z}`,
        `3\t3\tsrc/conflict.ts${Z}`,
      ].join(''),
    )
    for (const step of [out.length, 1, 9]) {
      const d = diff(out, step)
      expect([...d.entries.values()].map((e) => [e.path, e.code, e.added, e.removed, e.origPath, e.submodule]), `step ${step}`).toEqual([
        ['src/a.ts', 'M', 12, 3, null, false],
        ['src/new.ts', 'A', 40, 0, null, false],
        ['src/gone.ts', 'D', 0, 25, null, false],
        ['src/moved.ts', 'R', 2, 1, 'src/old.ts', false],
        ['src/copy.ts', 'A', 0, 0, null, false], // a copy is a new file
        ['bin/tool', 'M', 0, 0, null, false],
        ['img/logo.png', 'M', null, null, null, false], // binary: no counts
        ['vendor/lib', 'M', 1, 1, null, true],
        ['src/conflict.ts', '!', 3, 3, null, false],
      ])
    }
    // the output cut after the raw records: every letter, no counts
    const cut = diff(out.subarray(0, out.indexOf(`12\t3`)))
    expect([...cut.entries.values()].every((e) => e.added === null && e.removed === null)).toBe(true)
    expect(cut.entries.size).toBe(9)
  })

  it('U-GS-5 · the merge base is computed once and reused until `HEAD` or a ref moves; a move during the computation is not lost', async () => {
    const seen: BaseInputs[] = []
    const gate: { release: (() => void) | null } = { release: null }
    let hold = false
    const cache = new BaseCache(async (inputs) => {
      seen.push(inputs)
      if (hold) await new Promise<void>((r) => (gate.release = r))
      return { base: `base-of-${inputs.head}-${seen.length}`, branch: inputs.baseBranch }
    })
    const at = (head: string): BaseInputs => ({ head, baseBranch: 'main', baseCommit: O })
    expect((await cache.get(at('h1'))).base).toBe('base-of-h1-1')
    for (let i = 0; i < 5; i++) expect((await cache.get(at('h1'))).base).toBe('base-of-h1-1') // five refreshes: no git
    expect(cache.computed).toBe(1)
    cache.moved() // a ref event (the base branch moved, a fetch): the same HEAD, a new answer
    expect(cache.peek(at('h1'))).toBeNull()
    expect((await cache.get(at('h1'))).base).toBe('base-of-h1-2')
    expect((await cache.get(at('h2'))).base).toBe('base-of-h2-3') // HEAD moved (a commit): seen in the status itself
    expect((await cache.get(at('h2'))).base).toBe('base-of-h2-3')
    expect((await cache.get({ ...at('h2'), baseBranch: 'develop' })).base).toBe('base-of-h2-4') // the session's base changed
    expect(cache.computed).toBe(4)
    // a move that arrives while the base is being computed: that answer is given, but not kept
    hold = true
    const running = cache.get(at('h3'))
    await Promise.resolve()
    cache.moved()
    gate.release?.()
    expect((await running).base).toBe('base-of-h3-5')
    hold = false
    expect((await cache.get(at('h3'))).base).toBe('base-of-h3-6')
    expect((await cache.get(at('h3'))).base).toBe('base-of-h3-6')
  })

  it('U-GS-6 · the parsers stop at L.gitStatusEntriesMax and say `tooMany`; at the cap exactly they do not', () => {
    const many = (n: number): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => `? f${i}${Z}`).join(''))
    const at = status(many(L.gitStatusEntriesMax))
    expect([at.p.tooMany, at.entries.length, at.z.stopped]).toEqual([false, L.gitStatusEntriesMax, false])
    const over = status(many(L.gitStatusEntriesMax + 500))
    expect([over.p.tooMany, over.entries.length, over.z.stopped]).toEqual([true, L.gitStatusEntriesMax, true]) // nothing past the cap was read
    expect(over.z.records).toBe(L.gitStatusEntriesMax + 1)
    const d = diff(Buffer.from(Array.from({ length: 12 }, (_, i) => `:100644 100644 ${O} ${O} M${Z}f${i}${Z}`).join('')), 1 << 20, 10)
    expect([d.tooMany, d.entries.size]).toEqual([true, 10])
  })
})

describe('stream parsing under a cap', () => {
  it('U-FT-7 · records are cut from the stream as it arrives and nothing is held but an unfinished record; output cut at a byte cap loses its unfinished last record, and an overlong record ends the parse', () => {
    const got: string[] = []
    const z = new ZRecords((r) => void got.push(r.toString()))
    const whole = Buffer.from(`one${Z}two${Z}thr`)
    expect(z.push(whole.subarray(0, 2))).toBe(true)
    expect(z.held).toBe(2)
    expect(z.push(whole.subarray(2, 5))).toBe(true)
    expect([got, z.held]).toEqual([['one'], 1])
    expect(z.push(whole.subarray(5))).toBe(true)
    expect([got, z.held]).toEqual([['one', 'two'], 3])
    z.end() // the child was killed at its byte cap: `thr` is half a path, not a path
    expect([got, z.held, z.records]).toEqual([['one', 'two'], 0, 2])

    // a status cut in the middle of an entry: the entries before it, and no broken one
    const full = Buffer.from(Array.from({ length: 50 }, (_, i) => `1 .M N... 100644 100644 100644 ${O} ${O} src/file-${i}.ts${Z}`).join(''))
    const cutAt = full.length - 20
    const { entries } = status(full.subarray(0, cutAt), 100)
    expect(entries).toHaveLength(49)
    expect(entries.every((e) => /^src\/file-\d+\.ts$/.test(e.path))).toBe(true)
    // the same for a diff and for a plain list of paths (`ls-files -z`)
    const d = diff(Buffer.from(`:100644 100644 ${O} ${O} M${Z}a${Z}:100644 100644 ${O} ${O} M${Z}b`), 3)
    expect([...d.entries.keys()]).toEqual(['a'])
    const names: string[] = []
    const ls = new ZRecords((r) => void names.push(r.toString()))
    ls.push(Buffer.from(`a${Z}b/c${Z}d/e/`))
    ls.end()
    expect(names).toEqual(['a', 'b/c'])

    // a record longer than any path: the parse is over, with what it had; memory stays bounded while it arrives
    const big = new ZRecords((r) => void names.push(r.toString()))
    let fed = 0
    const chunk = Buffer.alloc(16 * 1024, 0x61)
    while (big.push(chunk)) {
      fed += chunk.length
      expect(big.held).toBeLessThanOrEqual(L.gitRecordMaxBytes)
    }
    expect(big.overlong).toBe(true)
    expect(fed).toBeLessThanOrEqual(L.gitRecordMaxBytes)
    expect(big.push(Buffer.from(`x${Z}`))).toBe(false)
    // a consumer that has enough stops the stream (the caller kills the child)
    let n = 0
    const stop = new ZRecords(() => ++n < 3)
    expect(stop.push(Buffer.from(`a${Z}b${Z}c${Z}d${Z}e${Z}`))).toBe(false)
    expect([n, stop.stopped]).toEqual([3, true])
  })

  it('U-GS-8 · an untracked file’s line count is what numstat would say: newlines, one more for a last line without one, none for a binary file', () => {
    expect(countLines(Buffer.from(''))).toBe(0)
    expect(countLines(Buffer.from('a\nb\n'))).toBe(2)
    expect(countLines(Buffer.from('a\nb'))).toBe(2)
    expect(countLines(Buffer.from('\n\n\n'))).toBe(3)
    expect(countLines(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 10]))).toBeNull()
    expect(countLines(Buffer.concat([Buffer.alloc(L.binarySniffBytes, 0x61), Buffer.from([0, 10])]))).toBe(1) // only the first bytes are sniffed
  })
})
