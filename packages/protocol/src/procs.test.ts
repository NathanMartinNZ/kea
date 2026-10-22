import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseProcs } from './procs.ts'

describe('kea-helper procs', () => {
  it('U-PLT-3 · the one parser reads the lines of the recorded /proc tree, the raw start ticks Linux adds, and every escape the helper writes', () => {
    // what `kea-helper procs --args` printed for fixtures/os/linux/proc (the test's Rust half checks that, U-PLT-3)
    const recorded = readFileSync(join(import.meta.dirname, '../../../fixtures/os/linux/procs.txt'), 'utf8')
    expect(parseProcs(recorded)).toEqual([
      { pid: 2472, ppid: 2468, startUs: 1_792_438_829_430_000, startTicks: 35_543, exe: '/usr/bin/python3.12', argv: ['python3', '/tmp/listen.py'] }, // os-ok: test data
      { pid: 2507, ppid: 2468, startUs: 1_792_438_829_450_000, startTicks: 35_545, exe: '/usr/bin/sleep', argv: ['sleep', '300'] }, // os-ok: test data
      { pid: 2516, ppid: 2514, startUs: 1_792_438_829_460_000, startTicks: 35_546, exe: null, argv: [] },
    ])
    // the cases of procs.rs's own test, line for line
    const lines = [
      '7\t1\t1792438474355430\t/Applications/My App.app/Contents/MacOS/kea-helper\t/x/kea-helper\tpty-daemon\t--id\ta b', // os-ok: test data
      '7\t1\t1792438474355430\t\\x2d\t-',
      '7\t1\t1792438474355430\t/h/é\\\\x\\ty\\nz\\x01\\x7f\t\\xff\\xfeok',
      '7\t1\t1792438474355430/35543\t/usr/bin/sleep\tsleep\t300', // os-ok: test data (Linux adds the raw ticks)
    ]
    expect(parseProcs(lines.join('\n') + '\n')).toEqual([
      { pid: 7, ppid: 1, startUs: 1_792_438_474_355_430, startTicks: null, exe: '/Applications/My App.app/Contents/MacOS/kea-helper', argv: ['/x/kea-helper', 'pty-daemon', '--id', 'a b'] }, // os-ok: test data
      { pid: 7, ppid: 1, startUs: 1_792_438_474_355_430, startTicks: null, exe: '-', argv: ['-'] },
      { pid: 7, ppid: 1, startUs: 1_792_438_474_355_430, startTicks: null, exe: '/h/é\\x\ty\nz\x01\x7f', argv: ['\ufffd\ufffdok'] },
      { pid: 7, ppid: 1, startUs: 1_792_438_474_355_430, startTicks: 35_543, exe: '/usr/bin/sleep', argv: ['sleep', '300'] }, // os-ok: test data
    ])
    expect(parseProcs('\nkea-helper procs: Permission denied\n7\t1\n0\t1\t5\t-\nx\t1\t5\t-\n1\t1\t99999999999999999999\t-\n'), 'not lines of procs').toEqual([])
    expect(parseProcs('1\t1\t5/\t-\n1\t1\t/5\t-\n1\t1\t5/6/7\t-\n1\t1\t5/99999999999999999999\t-\n'), 'a start field that is not µs[/ticks]').toEqual([])
    expect(parseProcs('5\t1\t9\t/a\\qb\\x4\t'), 'a backslash that is no escape stays').toEqual([{ pid: 5, ppid: 1, startUs: 9, startTicks: null, exe: '/a\\qb\\x4', argv: [''] }])
  })
})
