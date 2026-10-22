import { afterAll, describe, expect, it } from 'vitest'
import { UsageError } from './cli.ts'
import { counterLine, counterText, parseCounterArgs, verifyCounter } from './counter.ts'
import { killAll, zoo } from './test-support.ts'

afterAll(killAll)

describe('process zoo: counter', () => {
  it('U-ZOO-1 · lines follow the format, the expected text is rebuilt byte for byte, and verifyCounter finds loss, duplication and reordering', () => {
    expect(counterLine(7, { format: '{n}\n', width: 0 })).toBe('7\n')
    expect(counterLine(7, { format: 'seq {n} [{n}]\r\n', width: 4 })).toBe('seq 0007 [0007]\r\n')
    expect(counterText({ count: 3, start: 9, width: 2 })).toBe('09\n10\n11\n')
    expect(counterText({ count: 2 }, true)).toBe('1\r\n2\r\n') // as read from a PTY master (ONLCR)
    expect(parseCounterArgs(['--count', '5', '--format', 'n={n}\\n', '--width', '3', '--rate', '2.5'])).toEqual({ start: 1, count: 5, rate: 2.5, format: 'n={n}\n', width: 3 })
    expect(parseCounterArgs(['--forever']).count).toBeNull()
    expect(() => parseCounterArgs(['--format', 'x'])).toThrow(UsageError)
    expect(() => parseCounterArgs(['--count', '-1'])).toThrow(/--count must be an integer 0…/)
    expect(() => parseCounterArgs(['--count', '1', '--forever'])).toThrow(/exclusive/)

    const good = verifyCounter(counterText({ count: 1000 }, true), { start: 1, count: 1000 })
    expect(good).toMatchObject({ ok: true, lines: 1000, first: 1, last: 1000, missing: [], duplicates: [], outOfOrder: 0, badLines: [] })
    // a partial last line is not counted until the stream is final
    expect(verifyCounter('1\n2\n3\n4').lines).toBe(3)
    expect(verifyCounter('1\n2\n3\n4', { final: true }).lines).toBe(4)
    const lost = verifyCounter('1\n2\n5\n6\n')
    expect(lost).toMatchObject({ ok: false, missing: [3, 4] })
    const dup = verifyCounter('1\n2\n2\n3\n')
    expect(dup).toMatchObject({ ok: false, duplicates: [2], outOfOrder: 1 })
    expect(verifyCounter('1\n3\n2\n')).toMatchObject({ ok: false, outOfOrder: 1, missing: [] })
    expect(verifyCounter('1\n2x\n3\n')).toMatchObject({ ok: false, badLines: ['2x'], missing: [2] })
    expect(verifyCounter('2\n3\n', { start: 1 })).toMatchObject({ ok: false, missing: [1] })
    expect(verifyCounter('1\n2\n', { count: 3 }).ok).toBe(false)
    expect(verifyCounter(counterText({ count: 12, width: 3, format: 'n={n};\n' }), { width: 3, format: 'n={n};\n', count: 12 }).ok).toBe(true)
    expect(verifyCounter('n=1;\n', { width: 3, format: 'n={n};\n' }).badLines).toEqual(['n=1;'])
  })

  it('U-ZOO-2 · counter on a pipe: unpaced and paced output is exactly the expected text; --forever counts until killed', async () => {
    const fast = zoo('counter', ['--count', '50000', '--width', '6'])
    const paced = zoo('counter', ['--count', '20', '--start', '100', '--rate', '5000', '--format', 'L{n}\\n'])
    const forever = zoo('counter', ['--forever'])
    expect(await fast.exited).toEqual({ code: 0, signal: null })
    expect(fast.out()).toBe(counterText({ count: 50000, width: 6 }))
    expect(await paced.exited).toEqual({ code: 0, signal: null })
    expect(paced.out()).toBe(counterText({ count: 20, start: 100, format: 'L{n}\n' }))
    await forever.until((s) => s.split('\n').length > 5000, '5000 lines')
    forever.child.kill('SIGTERM')
    expect((await forever.exited).signal).toBe('SIGTERM')
    const check = verifyCounter(forever.out(), { start: 1 })
    expect(check.ok).toBe(true)
    expect(check.lines).toBeGreaterThanOrEqual(5000)
  })
})

