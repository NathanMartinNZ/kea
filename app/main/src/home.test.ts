import { describe, expect, it } from 'vitest'
import { keaHome } from './home.ts'

// a made-up home directory: keaHome only joins paths, it never touches the disk
const HOMEDIR = '/Users/someone'
const EXE = '/Applications/Kea.app/Contents/MacOS/Kea' // os-ok: test data

describe('keaHome', () => {
  it('U-FAIL-7 · the installed app uses ~/.kea and a dev build ~/.kea-dev, so a dev build started inside a Kea session never shares the installed app’s holders', () => {
    expect(keaHome({ packaged: true, argv: [EXE], homedir: HOMEDIR })).toBe('/Users/someone/.kea')
    expect(keaHome({ packaged: false, argv: ['/electron', 'dist/app'], homedir: HOMEDIR })).toBe('/Users/someone/.kea-dev')
    // a session's variables do not reach it: the home comes from the build and the command line only
    expect(keaHome({ packaged: false, argv: ['/electron', 'dist/app', '--kea-perf'], homedir: HOMEDIR })).not.toBe(keaHome({ packaged: true, argv: [EXE], homedir: HOMEDIR }))
  })

  it('U-FAIL-7 · --kea-home=<absolute path> wins over both defaults, normalised; a relative or empty path is refused', () => {
    for (const packaged of [true, false]) {
      expect(keaHome({ packaged, argv: [EXE, '--kea-home=/tmp/kea-test-x'], homedir: HOMEDIR })).toBe('/tmp/kea-test-x')
      expect(keaHome({ packaged, argv: [EXE, '--kea-perf', '--kea-home=/tmp/a/../kea-test-y//'], homedir: HOMEDIR })).toBe('/tmp/kea-test-y')
    }
    for (const bad of ['kea-home', './x', '../x', '~/x', ''])
      expect(() => keaHome({ packaged: false, argv: [EXE, `--kea-home=${bad}`], homedir: HOMEDIR }), JSON.stringify(bad)).toThrow(/absolute path/)
  })

  it('U-FAIL-7 · a --kea-home that is not used is refused, never ignored: the path given after a space, a bare flag, the root directory', () => {
    // ignored, the first two would run a dev build on ~/.kea-dev; the root would make a home of "/"
    expect(() => keaHome({ packaged: false, argv: [EXE, '--kea-home', '/tmp/kea-test-x'], homedir: HOMEDIR })).toThrow(/--kea-home=/)
    expect(() => keaHome({ packaged: false, argv: [EXE, '--kea-home'], homedir: HOMEDIR })).toThrow(/--kea-home=/)
    for (const root of ['/', '//', '/tmp/..'])
      expect(() => keaHome({ packaged: false, argv: [EXE, `--kea-home=${root}`], homedir: HOMEDIR }), root).toThrow(/root/)
  })
})
