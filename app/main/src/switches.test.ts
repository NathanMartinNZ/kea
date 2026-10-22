import { describe, expect, it } from 'vitest'
import { refusedSwitches } from './switches.ts'

const EXE = '/Applications/Kea.app/Contents/MacOS/Kea' // os-ok: test data
const packaged = { packaged: true, perfProbes: false }
const probes = { packaged: true, perfProbes: true }
const dev = { packaged: false, perfProbes: false }

const DEBUGGERS = ['--remote-debugging-port=9222', '--remote-debugging-pipe', '-remote-debugging-port=0', '--remote-debugging-address=0.0.0.0', '--inspect', '--inspect=127.0.0.1:9229', '--inspect-brk', '--inspect-port=0', '-inspect', '--Remote-Debugging-Port=1']
const PERF = ['--kea-perf', '--kea-perf-busy=30:100', '-kea-perf']

describe('refusedSwitches', () => {
  it('U-SEC-1 · a packaged build refuses debugger switches in every spelling and the perf probes; a dev build refuses nothing', () => {
    for (const s of [...DEBUGGERS, ...PERF]) {
      expect(refusedSwitches([EXE, '--kea-home=/tmp/k', s], packaged)).toEqual([s])
      expect(refusedSwitches([EXE, s], dev)).toEqual([])
    }
    expect(refusedSwitches([EXE, '--', '--inspect'], packaged)).toEqual(['--inspect'])
  })

  it('U-SEC-1 · a perf-probe build accepts only --kea-perf*: debugger switches are still refused', () => {
    for (const s of PERF) expect(refusedSwitches([EXE, s], probes)).toEqual([])
    for (const s of DEBUGGERS) expect(refusedSwitches([EXE, '--kea-perf', s], probes)).toEqual([s])
  })

  it('U-SEC-1 · ordinary arguments, values and the executable itself are never refused', () => {
    const argv = [`${EXE}--inspect`, '--kea-home=/tmp/--inspect', '-psn_0_12345', '--', '---inspect', '--=kea-perf', 'inspect', '/tmp/--remote-debugging-port']
    expect(refusedSwitches(argv, packaged)).toEqual([])
    expect(refusedSwitches([], packaged)).toEqual([])
  })
})
