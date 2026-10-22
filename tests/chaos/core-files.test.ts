// Files and git in core against hostile inputs: the status and diff parsers on random and mutated git output (never a
// throw, never more entries than L.gitStatusEntriesMax, time linear in the input), and a git that hangs forever (every
// call ends at its timeout, the tree stays usable meanwhile, the pool never holds more children than its limit and
// none is left behind). Core in-process (tests/integration/core-files-support.ts); the parsers are fed directly.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { activeCount, POOL_LIMITS, queuedCount, setGitBinary } from '@kea/kit'
import { isWorktreePath, L } from '@kea/protocol'
import { StatusParser } from '@kea/core/src/files/porcelain.ts'
import { DiffParser } from '@kea/core/src/files/rawdiff.ts'
import { ZRecords } from '@kea/core/src/files/records.ts'
import { IgnoreIndex } from '@kea/core/src/files/ignore.ts'
import { until } from '../support/holders.ts'
import { cleanup, linkedWorktree, repo, startFiles, tempDir, write, type FilesUnderTest } from '../integration/core-files-support.ts'

let t: FilesUnderTest | null = null
afterEach(async () => {
  await t?.dispose()
  t = null
  cleanup()
})

/**
 * The whole process table as `ps` prints it: over Node's default 1 MiB for a child's output on a busy machine
 * (ENOBUFS), as core-git.test.ts allows it.
 */
const PS_MAX_BYTES = 64 * 2 ** 20

const O = '1234567890abcdef1234567890abcdef12345678'
const Z = '\0'
const VALID_STATUS = [
  `# branch.oid ${O}`,
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +1 -2',
  `1 .M N... 100644 100644 100644 ${O} ${O} src/a file.ts`,
  `1 A. N... 000000 100644 100644 ${O} ${O} new.ts`,
  `2 R. N... 100644 100644 100644 ${O} ${O} R100 to.ts${Z}from.ts`,
  `u UU N... 100644 100644 100644 100644 ${O} ${O} ${O} conflict.ts`,
  `1 .M S.M. 160000 160000 160000 ${O} ${O} vendor/lib`,
  '? untracked.txt',
  '? nested/',
  '! ignored/',
]
const VALID_DIFF = [
  `:100644 100644 ${O} ${O} M${Z}src/a.ts`,
  `:000000 100644 ${O} ${O} A${Z}new.ts`,
  `:100644 100644 ${O} ${O} R087${Z}old.ts${Z}moved.ts`,
  `:160000 160000 ${O} ${O} M${Z}vendor/lib`,
  '12\t3\tsrc/a.ts',
  '40\t0\tnew.ts',
  `2\t1\t${Z}old.ts${Z}moved.ts`,
  '-\t-\tlogo.png',
]

/** Parse `bytes` in chunks of `sizes` (cycled); everything the parsers emit must be well-formed. */
function parse(bytes: Buffer, sizes: number[]): { status: number; diff: number } {
  let entries = 0
  const sp = new StatusParser((e) => {
    entries++
    if (typeof e.path !== 'string' || e.path === '' || e.path.endsWith('/')) throw new Error(`bad status path ${JSON.stringify(e.path)}`)
    if (!['M', 'A', 'U', 'D', 'R', '!'].includes(e.code)) throw new Error(`bad code ${e.code}`)
    if (e.origPath !== null && typeof e.origPath !== 'string') throw new Error('bad origPath')
  })
  const dp = new DiffParser()
  for (const p of [new ZRecords((r) => sp.record(r)), new ZRecords((r) => dp.record(r))]) {
    let at = 0
    for (let i = 0; at < bytes.length; i++) {
      const n = Math.max(1, sizes[i % sizes.length] ?? 1)
      if (!p.push(bytes.subarray(at, at + n))) break
      at += n
      if (p.held > L.gitRecordMaxBytes) throw new Error(`holding ${p.held} bytes of one record`)
    }
    p.end()
  }
  if (entries > L.gitStatusEntriesMax || dp.entries.size > L.gitStatusEntriesMax) throw new Error('more entries than the cap')
  for (const e of dp.entries.values()) {
    if (e.path === '' || (e.added !== null && !(Number.isInteger(e.added) && e.added >= 0)) || (e.removed !== null && !(Number.isInteger(e.removed) && e.removed >= 0))) throw new Error(`bad diff entry ${JSON.stringify(e)}`)
  }
  // a header parsed from garbage is still a header: numbers or null, never NaN
  const h = sp.header
  for (const n of [h.ahead, h.behind]) if (n !== null && !Number.isInteger(n)) throw new Error('bad ahead/behind')
  return { status: entries, diff: dp.entries.size }
}

describe('files and git against hostile inputs', () => {
  it('C-FUZZ-4 · the status and diff parsers take random bytes and mutated git output without throwing, never pass L.gitStatusEntriesMax or hold more than one record, and take time linear in the input', () => {
    const bytes = fc.uint8Array({ minLength: 0, maxLength: 4096 }).map((a) => Buffer.from(a))
    const sizes = fc.array(fc.integer({ min: 1, max: 97 }), { minLength: 1, maxLength: 8 })
    // 1. anything at all
    fc.assert(fc.property(bytes, sizes, (b, s) => void parse(b, s)), { numRuns: 1500 })
    // 2. real records, shuffled, cut, repeated, with bytes flipped and separators moved
    const record = fc.oneof(fc.constantFrom(...VALID_STATUS, ...VALID_DIFF), fc.string({ maxLength: 40 }), fc.constantFrom('', ' ', '1 ', '2 R. ', 'u ', '# ', '# branch.ab +x -y', ':', ':100644', '\t\t', '9999999999999999999999\t1\tbig', '-1\t-1\tneg'))
    const mutated = fc.tuple(fc.array(record, { maxLength: 60 }), fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 12 }), fc.constantFrom(Z, Z, Z, '\n', `${Z}${Z}`, '')).map(([recs, flips, sep]) => {
      const b = Buffer.from(recs.join(sep) + sep)
      for (const [at, v] of flips) if (b.length) b[at % b.length] = v
      return b
    })
    fc.assert(fc.property(mutated, sizes, (b, s) => void parse(b, s)), { numRuns: 3000 })
    // 3. valid output parses the same whatever the chunking
    const valid = Buffer.from(`${VALID_STATUS.join(Z)}${Z}`)
    const whole = parse(valid, [valid.length])
    expect(whole.status).toBe(7)
    fc.assert(
      fc.property(sizes, (s) => {
        expect(parse(valid, s)).toEqual(whole)
      }),
      { numRuns: 300 },
    )
    expect(parse(Buffer.from(`${VALID_DIFF.join(Z)}${Z}`), [7]).diff).toBe(4)

    // 4. bounded time: twice the input, about twice the time (never quadratic), and a flood ends at the cap
    const big = (n: number): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => `1 .M N... 100644 100644 100644 ${O} ${O} dir-${i % 50}/file-${i}.ts${Z}`).join(''))
    const time = (b: Buffer): number => {
      const t0 = performance.now()
      for (let i = 0; i < 5; i++) parse(b, [65536])
      return (performance.now() - t0) / 5
    }
    const half = big(5_000)
    const full = big(10_000)
    time(full) // warm
    const [a, b] = [time(half), time(full)]
    expect(b, `${half.length} bytes in ${a.toFixed(1)} ms, ${full.length} in ${b.toFixed(1)} ms`).toBeLessThan(Math.max(a * 4, 50))
    const flood = big(L.gitStatusEntriesMax * 3)
    const t0 = performance.now()
    expect(parse(flood, [65536]).status).toBe(L.gitStatusEntriesMax) // stopped at the cap: the rest was never read
    expect(performance.now() - t0).toBeLessThan(2000)
    // one endless record (no separator at all): given up on at the record cap, memory bounded
    const endless = Buffer.alloc(4 * 1024 * 1024, 0x61)
    expect(parse(endless, [65536])).toEqual({ status: 0, diff: 0 })

    // the ignore index takes any listing too, and every path the parsers emit for a store row is a worktree path or is dropped there
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 30 }), { maxLength: 50 }), fc.string({ maxLength: 30 }), (listed, q) => {
        const ix = new IgnoreIndex(40)
        for (const l of listed) ix.addListed(l)
        ix.loaded = true
        expect(['ignored', 'not', 'unknown']).toContain(ix.query(q))
        expect(ix.size).toBeLessThanOrEqual(40)
      }),
      { numRuns: 500 },
    )
    expect(isWorktreePath('src/a file.ts')).toBe(true)
  })

  it('C-RES-9 · a git that hangs forever: every call ends at its timeout, the tree is listed and follows changes meanwhile, the pool never holds more than its limit, and no child is left behind', async () => {
    const r = repo()
    const dir = tempDir()
    const started = path.join(dir, 'started')
    // every git Kea runs writes its pid and sleeps
    const stub = path.join(dir, 'git')
    fs.writeFileSync(stub, `#!/bin/sh\necho $$ >> '${started}'\nexec /bin/sleep 3600\n`, { mode: 0o755 })
    // as many sessions on screen as worktrees are followed: each has its stream
    const roots = [r.root, ...Array.from({ length: L.watchWorktreesLru - 1 }, (_, i) => linkedWorktree(r.root, `wt-${i}`))]
    setGitBinary(stub)
    const TIMEOUT = 300
    t = await startFiles({ files: { statusTimeoutMs: TIMEOUT } })
    const ids = roots.map((root, i) => {
      t!.session(`s${i}`, root)
      return `s${i}`
    })
    let peak = 0
    const sample = (): void => void (peak = Math.max(peak, activeCount('git')))
    const t0 = performance.now()
    ids.forEach((id, i) => t!.show(id, i)) // a window each, all asking a git that never answers
    // the tree does not wait for git: every root is listed while the first calls are still hanging
    await until('every root to be listed', () => (sample(), ids.every((id) => t!.tree(id).get('/') !== undefined)))
    expect(performance.now() - t0).toBeLessThan(TIMEOUT * 5) // long before five timeouts in a row could have passed
    expect(activeCount('git')).toBeGreaterThan(0)
    expect(t.names('s0')).toContain('src')
    // …and it can be used: expand, and see a change arrive
    expect(await t.call('files.expand', { sessionId: 's0', path: 'src' })).toEqual({ ok: true })
    // every session ends up "unavailable" (whether it is a repository could not even be asked), none stuck on "loading"
    await until('every status to give up', () => (sample(), ids.every((id) => t!.head(id)?.state === 'unavailable' && t!.s(id).scheduler.idle)), 60_000)
    expect(ids.map((id) => t!.treeHead(id))).toEqual(ids.map(() => ({ git: false, live: true, missing: false })))
    await until('the stream', () => t?.watcher?.followed().find((f) => f.root === fs.realpathSync(r.root))?.mode === 'live')
    write(r.root, 'src/while-git-hangs.js')
    await until('the new file in the tree', () => (sample(), t!.names('s0', 'src').includes('while-git-hangs.js')))

    // more triggers: each tries again, each times out; the pool is never over its limit and its queue stays short
    for (let round = 0; round < 3; round++) {
      t.files.focus()
      expect(queuedCount('git')).toBeLessThanOrEqual(ids.length * 4)
      await until(`round ${round} to time out`, () => (sample(), ids.every((id) => t!.s(id).scheduler.idle) && activeCount('git') === 0), 60_000)
    }
    expect(peak).toBeLessThanOrEqual(POOL_LIMITS.git)
    expect(peak).toBe(POOL_LIMITS.git)
    // no pile-up: every git that was started is gone (killed with its group), none is a zombie
    const pids = fs.readFileSync(started, 'utf8').trim().split('\n').map(Number)
    expect(pids.length).toBeGreaterThanOrEqual(ids.length * 4)
    await until('every hung git to be gone', () => pids.every((pid) => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }))
    const mine = execFileSync('/bin/ps', ['-axo', 'ppid=,stat=,command='], { maxBuffer: PS_MAX_BYTES }).toString().split('\n').filter((l) => l.trim().startsWith(`${process.pid} `) && !l.includes('/bin/ps'))
    expect(mine).toEqual([])
    expect(t.files.counts).toMatchObject({ statusRunning: 0, statusPending: 0 })

    // git answers again: the next trigger finds the repository and the status
    setGitBinary('git')
    t.files.focus()
    await until('the status to be back', () => ids.every((id) => t!.head(id)?.state === 'ok'), 60_000)
    expect(t.treeHead('s0')).toEqual({ git: true, live: true, missing: false })
    expect(t.codes('s0')).toEqual({ 'src/while-git-hangs.js': 'U' })
  })
})
