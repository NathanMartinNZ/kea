import { describe, expect, it } from 'vitest'
import { HunkParser, parseHunkHeader } from './hunks.ts'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -0,0 +1,2 @@',
  '+first',
  '+second',
  '@@ -4 +6 @@ function context() {',
  '-old',
  '+new',
  '@@ -9,3 +10,0 @@',
  '-gone 1',
  '-@@ -1,1 +1,1 @@ a removed line that looks like a header',
  '-gone 3',
  '@@ -20,2 +18,5 @@',
  '-a',
  '-b',
  '+1',
  '+2',
  '+@@ not a header either',
  '+4',
  '+5',
  '\\ No newline at end of file',
  '',
].join('\n')

const WANT = [
  { kind: 'added', from: 1, to: 2 },
  { kind: 'modified', from: 6, to: 6 },
  { kind: 'deleted', from: 10, to: 10 },
  { kind: 'modified', from: 18, to: 22 },
]

describe('git diff -U0 hunk headers', () => {
  it('U-FV-4 · hunk headers become added, modified and deleted line ranges of the new side, however the output is cut into chunks', () => {
    expect(parseHunkHeader('@@ -0,0 +1,3 @@')).toEqual({ kind: 'added', from: 1, to: 3 })
    expect(parseHunkHeader('@@ -5 +5 @@')).toEqual({ kind: 'modified', from: 5, to: 5 })
    expect(parseHunkHeader('@@ -5,2 +5,7 @@ fn()')).toEqual({ kind: 'modified', from: 5, to: 11 })
    // removed after line 7; removed before the first line
    expect(parseHunkHeader('@@ -8,2 +7,0 @@')).toEqual({ kind: 'deleted', from: 7, to: 7 })
    expect(parseHunkHeader('@@ -1,4 +0,0 @@')).toEqual({ kind: 'deleted', from: 0, to: 0 })
    for (const bad of ['@@ -a +b @@', '@@@ -1 -1 +1 @@@', '+@@ -1 +1 @@', '@@ -1 +1', 'diff --git a/x b/x', '']) expect(parseHunkHeader(bad), bad).toBeNull()

    const whole = new HunkParser(100)
    whole.push(Buffer.from(DIFF))
    whole.end()
    expect(whole.changes).toEqual(WANT)
    expect(whole.overflow).toBe(false)

    // every way of cutting the stream in two, and byte by byte, gives the same ranges
    const bytes = Buffer.from(DIFF)
    for (let cut = 0; cut <= bytes.length; cut++) {
      const p = new HunkParser(100)
      p.push(bytes.subarray(0, cut))
      p.push(bytes.subarray(cut))
      p.end()
      expect(p.changes, `cut at ${cut}`).toEqual(WANT)
    }
    const single = new HunkParser(100)
    for (const b of bytes) single.push(Uint8Array.of(b))
    single.end()
    expect(single.changes).toEqual(WANT)

    // a header as the stream's last line, with no newline after it
    const tail = new HunkParser(100)
    tail.push(Buffer.from('+++ b/x\n@@ -1 +1,2 @@'))
    tail.end()
    expect(tail.changes).toEqual([{ kind: 'modified', from: 1, to: 2 }])

    // a very long content line costs nothing and hides nothing after it
    const long = new HunkParser(100)
    long.push(Buffer.from(`@@ -1 +1 @@\n-${'x'.repeat(100_000)}\n+${'@'.repeat(100_000)}\n@@ -3,0 +4 @@\n+y\n`))
    long.end()
    expect(long.changes).toEqual([
      { kind: 'modified', from: 1, to: 1 },
      { kind: 'added', from: 4, to: 4 },
    ])

    // over the cap: the ranges stop growing and the overflow is said
    const capped = new HunkParser(2)
    capped.push(Buffer.from(DIFF))
    capped.end()
    expect(capped.changes).toHaveLength(2)
    expect(capped.overflow).toBe(true)
  })
})
