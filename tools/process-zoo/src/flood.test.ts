import { afterAll, describe, expect, it } from 'vitest'
import { UsageError } from './cli.ts'
import { floodBuffer, floodExpected, floodPeriod, parseFloodArgs, parseSize } from './flood.ts'
import { killAll, zoo } from './test-support.ts'

afterAll(killAll)

describe('process zoo: flood', () => {
  it('U-ZOO-3 · sizes parse with binary and decimal suffixes; the stream is periodic printable ASCII any slice of which can be rebuilt', () => {
    expect(parseSize('100M')).toBe(100 * 1024 * 1024)
    expect(parseSize('64k')).toBe(65536)
    expect(parseSize('1GB')).toBe(1e9)
    expect(parseSize('2KB')).toBe(2000)
    expect(parseSize('512')).toBe(512)
    for (const bad of ['', '1.5M', '-1', '10X', 'M']) expect(() => parseSize(bad)).toThrow(UsageError)
    expect(() => parseFloodArgs([])).toThrow(/--bytes is required/)
    expect(() => parseFloodArgs(['--bytes', '1', '--eol', 'cr'])).toThrow(/lf, crlf or none/)
    expect(parseFloodArgs(['--bytes', '1M', '--report'])).toEqual({ bytes: 1048576, lineLength: 80, eol: 'lf', chunk: 65536, report: true })

    const lf = floodPeriod({ lineLength: 80, eol: 'lf' })
    expect(lf.length).toBe(94 * 80)
    const lines = lf.split('\n')
    expect(lines[0]).toBe('!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmno')
    expect(lines[1]?.startsWith('"#$')).toBe(true) // each line starts one character later
    expect(/^[\x21-\x7e\n]*$/.test(lf)).toBe(true)
    expect(floodPeriod({ lineLength: 4, eol: 'crlf' }).slice(0, 8)).toBe('!"\r\n"#\r\n')
    expect(floodPeriod({ lineLength: 1, eol: 'none' })).toHaveLength(94)
    expect(floodExpected(0, 3)).toBe('!"#')
    expect(floodExpected(lf.length - 2, 4)).toBe(lf.slice(-2) + lf.slice(0, 2)) // wraps around the period
    expect(floodExpected(5 * lf.length + 80, 3)).toBe('"#$') // line 1 of a later period
    const buf = floodBuffer({ lineLength: 80, eol: 'lf', chunk: 65536 })
    expect(buf.length % lf.length).toBe(0) // writes start at period offset 0
  })

  it('U-ZOO-4 · flood on a pipe writes exactly N bytes of the expected stream and exits 0; --report times it', async () => {
    const mb = zoo('flood', ['--bytes', '1M', '--report'], { encoding: 'latin1' })
    const odd = zoo('flood', ['--bytes', '12345', '--line-length', '7', '--eol', 'crlf', '--chunk', '100'], { encoding: 'latin1' })
    const usage = zoo('flood', ['--line-length', '3'])
    expect(await mb.exited).toEqual({ code: 0, signal: null })
    expect(mb.out().length).toBe(1048576)
    expect(mb.out() === floodExpected(0, 1048576)).toBe(true)
    expect(JSON.parse(mb.err())).toMatchObject({ bytes: 1048576, ms: expect.any(Number), mbPerSec: expect.any(Number) })
    expect(await odd.exited).toEqual({ code: 0, signal: null })
    expect(odd.out()).toBe(floodExpected(0, 12345, { lineLength: 7, eol: 'crlf' }))
    expect((await usage.exited).code).toBe(2)
    expect(usage.err()).toMatch(/--bytes is required/)
  })
})
