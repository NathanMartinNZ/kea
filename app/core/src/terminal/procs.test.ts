import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HELPER_EXECUTABLE, holderAlive, isHolderProcess, probeable, procsProbe } from './procs.ts'
import { parseHolderJson } from './holders.ts'

const US = 1_000_000

describe('holder liveness (pid reuse)', () => {
  it('U-PTY-42 · a state file names its holder only while pid, start second and executable all match (a reused pid does not)', () => {
    const info = { pid: 412, startSec: 1_791_379_080, startTicks: null, command: `/x/${HELPER_EXECUTABLE}` }
    const state = { pid: 412, pidStartTime: info.startSec * US + 123_456 }
    expect(isHolderProcess(state, info)).toBe(true)
    expect(isHolderProcess(state, undefined), 'no such process').toBe(false)
    expect(isHolderProcess({ ...state, pidStartTime: state.pidStartTime - US }, info), 'pid reused: another start time').toBe(false)
    expect(isHolderProcess(state, { ...info, command: '/usr/bin/sleep' }), 'pid reused by another program').toBe(false) // os-ok: test data
    expect(isHolderProcess(state, { ...info, command: '/x/kea-helper-old' })).toBe(false)
    expect(isHolderProcess({ ...state, pid: 413 }, info)).toBe(false)
    expect([0, 1, -5, 1.5, Number.NaN, '7', null].map(probeable)).toEqual([false, false, false, false, false, false, false])
    expect(probeable(2)).toBe(true)
  })

  // The probe's run and reading, from a stand-in helper that prints what the real one prints (the real one's lines are
  // checked against `ps` in U-PLT-3; the integration suites run it on live holders).
  it('U-PTY-42 · the probe: one `kea-helper procs <pid…>` run, read with the one parser (argv[0] is the command, a start time to the second); a pid it does not list is not alive; without a helper only an empty question has an answer', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-u-pty-42-')))
    try {
      const helper = path.join(dir, 'kea-helper')
      fs.writeFileSync(`${helper}.out`, '412\t1\t1791379080999999\t/x/kea-helper.real\t/y/kea-helper\n9\t1\t5\t-\n')
      fs.writeFileSync(helper, `#!/bin/sh\necho "$*" > '${helper}.args'\nexec /bin/cat '${helper}.out'\n`, { mode: 0o755 })
      const m = await procsProbe(helper, () => null)([412, 413, 412, 0, 1, 1.5])
      expect(fs.readFileSync(`${helper}.args`, 'utf8'), 'each probeable pid once; never 0 or init').toBe('procs 412 413\n')
      expect(m.get(412)).toEqual({ pid: 412, startSec: 1_791_379_080, startTicks: null, command: '/y/kea-helper' })
      expect(isHolderProcess({ pid: 412, pidStartTime: 1_791_379_080_000_001 }, m.get(412))).toBe(true)
      expect(m.has(413), 'not listed: not alive').toBe(false)
      expect(m.get(9)?.command, 'a zombie: no command').toBe('')
      fs.writeFileSync(helper, '#!/bin/sh\necho "kea-helper procs: Permission denied" >&2\nexit 1\n')
      await expect(procsProbe(helper, () => null)([412]), 'cannot tell').rejects.toThrow(/Permission denied/)
      expect(await procsProbe(helper, () => null)([0, 1])).toEqual(new Map())
      await expect(procsProbe(null)([412])).rejects.toThrow(/no kea-helper/)
      expect(await procsProbe(null)([])).toEqual(new Map())
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // Linux's state file records the raw start in clock ticks and `procs` prints it: when both sides have it,
  // it decides exactly, so a wall clock stepped since the holder started (the derived seconds moved) still matches and
  // a pid reused within the same second does not; a state file without it (an older holder, macOS) or a `procs` line
  // without it falls back to the second. The state file's `pidStartTicks` is read where it is a whole number.
  it('U-PLT-13 · the raw start ticks decide when both the state file and procs have them; otherwise the start second; parseHolderJson reads them', () => {
    const exe = `/x/${HELPER_EXECUTABLE}`
    const state = { pid: 412, pidStartTime: 1_791_379_080 * US + 5, pidStartTicks: 35_543 }
    const info = { pid: 412, startSec: 1_791_379_080, startTicks: 35_543, command: exe }
    expect(isHolderProcess(state, info)).toBe(true)
    expect(isHolderProcess(state, { ...info, startSec: info.startSec + 2 }), 'the wall clock was stepped: the ticks still match').toBe(true)
    expect(isHolderProcess(state, { ...info, startTicks: 35_544 }), 'pid reused in the same second').toBe(false)
    expect(isHolderProcess({ ...state, pidStartTicks: null }, { ...info, startTicks: 1 }), 'an older state file: the second').toBe(true)
    expect(isHolderProcess({ pid: 412, pidStartTime: state.pidStartTime }, { ...info, startTicks: 1 }), 'no ticks field at all').toBe(true)
    expect(isHolderProcess(state, { ...info, startTicks: null }), 'procs without ticks: the second').toBe(true)
    expect(isHolderProcess(state, { ...info, startTicks: null, startSec: info.startSec + 2 })).toBe(false)
    const file = (extra: string) => `{"ptyId":"p","sessionId":"s","kind":"shell","cwd":"/","argv":["sh"],"pid":412,"pidStartTime":${state.pidStartTime}${extra},"socket":"/r/p.sock"}`
    expect(parseHolderJson(file(',"pidStartTicks":35543'))?.pidStartTicks).toBe(35_543)
    for (const bad of ['', ',"pidStartTicks":-1', ',"pidStartTicks":"35543"', ',"pidStartTicks":1.5']) expect(parseHolderJson(file(bad))?.pidStartTicks, bad).toBeNull()
  })

  // With `/proc` mounted `hidepid` a non-dumpable holder is missing from `procs`: a missing pid that still
  // exists cannot be told (alive null, never gone), one that does not exist is gone; on a stock `/proc` missing is gone.
  it('U-PLT-13 · where /proc hides holders, a pid procs does not list but kill(pid, 0) finds is unknown, not gone', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-u-plt-13-')))
    try {
      const helper = path.join(dir, 'kea-helper')
      fs.writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o755 }) // lists nothing
      const exists = (pid: number) => pid === 412
      const state = { pid: 412, pidStartTime: 1_791_379_080 * US, pidStartTicks: 35_543 }
      const hidden = await procsProbe(helper, () => 'invisible', exists)([412, 413])
      expect(hidden.get(412)?.hidden).toBe(true)
      expect(holderAlive(state, hidden.get(412)), 'hidden: cannot tell').toBeNull()
      expect(isHolderProcess(state, hidden.get(412)), 'never taken for the holder either').toBe(false)
      expect(holderAlive({ ...state, pid: 413 }, hidden.get(413)), 'no such pid: gone').toBe(false)
      const stock = await procsProbe(helper, () => null, exists)([412])
      expect(holderAlive(state, stock.get(412)), 'a stock /proc: missing is gone').toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

