import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { kitOs } from '../../../packages/kit/src/os/index.ts'
import { need } from '../../../packages/protocol/src/platform.ts'
import { userDataDirIfKnown } from './holders.ts'
import { appEnv, isZygote, launchEnv, processInfo, processTable, programName, QUIET_AGENT_ENV, runAppProcesses, type ProcInfo } from './launch.ts'

describe('process rows (launch.ts)', () => {
  it('U-PERF-4 · a process row carries the whole executable path and command line, longer than ps’s 16-character comm column', () => {
    // macOS's ps cuts `comm` to 16 characters when another column follows it, so a table read from it would never
    // recognise a run's Electron processes and holders by their executable (runAppProcesses would find none)
    const me = processInfo(process.pid)
    expect(me).not.toBeNull()
    expect(me!.comm.length).toBeGreaterThan(16)
    expect(path.basename(me!.comm)).toBe(path.basename(process.execPath))
    expect(me!.args).toContain(process.argv[1] ? path.basename(process.argv[1]) : 'node')
    expect(processTable().find((p) => p.pid === process.pid)).toEqual(me)
    expect(processInfo(2 ** 22 + 7)).toBeNull() // no such pid
  })
})

describe('a run’s processes on Linux (launch.ts)', () => {
  // The tree a dev build has in an Ubuntu 24.04 VM under the set-uid sandbox. Chromium rewrites every process's command
  // line into one title, so `procs` gives the whole title as argv[0]; the set-uid helper's and the sandboxed zygote's
  // executables cannot be read. The zygotes carry neither the run's home nor its userData.
  const E = '/x/node_modules/electron/dist/electron'
  const home = path.join(os.tmpdir(), 'kea-test-u-perf-10')
  const ud = userDataDirIfKnown(home, false) ?? path.join(os.tmpdir(), 'kea-test-u-perf-10-user-data')
  const other = path.join(os.tmpdir(), 'kea-test-u-perf-10-other')
  const row = (pid: number, ppid: number, title: string, exe: string | null = E, args = title): ProcInfo => ({ pid, ppid, start: 1, comm: title, args, exe })
  const table: ProcInfo[] = [
    row(100, 50, `${E} --inspect=0 --kea-home=${home} --kea-perf --ozone-platform=x11`),
    row(101, 100, `${E} --type=zygote --no-zygote-sandbox`),
    row(102, 100, '/x/node_modules/electron/dist/chrome-sandbox', null, `/x/node_modules/electron/dist/chrome-sandbox ${E} --type=zygote`),
    row(103, 102, `${E} --type=zygote`, null),
    row(104, 103, `${E} --type=zygote`, null),
    row(105, 101, `${E} --type=gpu-process --user-data-dir=${ud} --ozone-platform=x11`),
    row(106, 104, `${E} --type=renderer --user-data-dir=${ud}`, null),
    row(107, 100, `${E} --type=utility --utility-sub-type=node.mojom.NodeService --user-data-dir=${ud}`),
    row(108, 107, '/usr/bin/git status', '/usr/bin/git'), // os-ok: test data
    row(200, 50, `${E} --kea-home=${other} --kea-perf`),
    row(201, 200, `${E} --type=zygote --no-zygote-sandbox`),
    row(202, 201, `${E} --type=gpu-process --user-data-dir=${other}-ud`),
  ]

  it('U-PERF-10 · Linux’s rewritten titles: the run’s main and every Electron process below it, the zygotes and the sandbox’s helper among them (role zygote), and nothing of another run or what Kea’s processes start', () => {
    expect(programName(table[0]!)).toBe('electron')
    expect(programName(table[2]!), 'the helper by its title').toBe('chrome-sandbox')
    expect(programName(table[3]!), 'an unreadable executable').toBe('electron')
    expect(runAppProcesses(home, { table }).map((p) => p.pid).sort()).toEqual([100, 101, 102, 103, 104, 105, 106, 107])
    expect(table.filter(isZygote).map((p) => p.pid)).toEqual([101, 102, 103, 104, 201])
    // a macOS row: the executable names the program, the title is argv as it was
    expect(programName({ comm: '/A/Electron.app/Contents/MacOS/Electron', exe: '/A/Electron.app/Contents/MacOS/Electron' })).toBe('Electron')
  })
})

describe('the environment a harness starts Kea with (launch.ts)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('U-PERF-7 · a harness run never puts a real agent CLI on Kea’s PATH unless the caller sets PATH itself', () => {
    // with the inherited PATH, Kea's agent detection could run the user's real `claude --version` /
    // `auth status` outside the recorder's sandbox
    const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-perf-bin-')))
    try {
      fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`)
      expect(appEnv().PATH!.split(':')).not.toContain(bin)
      expect(appEnv().PATH!.split(':')).toEqual(expect.arrayContaining(['/usr/bin', '/bin']))
      expect(appEnv({ PATH: `${bin}:/bin` }).PATH).toBe(`${bin}:/bin`) // KeaRun's fake-agent shim directory comes first on purpose
    } finally {
      fs.rmSync(bin, { recursive: true, force: true })
    }
  })

  it('U-PERF-8 · a harness run tells any agent CLI it starts to send no telemetry and check for no update', () => {
    // a Kea typed into another run's shell can find a real `cmd` first, and its detection would run it unsandboxed,
    // with telemetry on: the PATH guard is the first line, this environment the second
    const env = appEnv()
    expect(env).toMatchObject(QUIET_AGENT_ENV)
    expect(QUIET_AGENT_ENV).toMatchObject({ DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1' })
    expect(appEnv({ DO_NOT_TRACK: '0' }).DO_NOT_TRACK).toBe('0') // a caller's own value wins
  })

  it('U-PERF-12 · a harness run keeps the folders Kea and what it starts make per user in the run’s own HOME: a person’s XDG base folders are left out, and the userData the harness cleans up is the one Kea makes', () => {
    // on Linux Electron's userData is `$XDG_CONFIG_HOME/<name>` when that is set and a discarded file goes to
    // `$XDG_DATA_HOME`'s Trash; git reads `$XDG_CONFIG_HOME/git/config` on either system. Inherited, they would send a
    // run into the person's own folders.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-test-u-perf-12-'))
    const person = path.join(os.tmpdir(), 'kea-test-u-perf-12-person')
    try {
      for (const k of XDG_BASE) vi.stubEnv(k, path.join(person, k))
      const env = launchEnv({ home })
      for (const k of XDG_BASE) expect(env[k], k).toBeUndefined()
      expect(Object.values(env).filter((v) => v.includes(person))).toEqual([])
      expect(launchEnv({ home, env: { XDG_DATA_HOME: path.join(home, 'data') } }).XDG_DATA_HOME).toBe(path.join(home, 'data')) // a caller's own value wins
      const ud = userDataDirIfKnown(home, false)
      if (ud === null) return
      expect(ud.startsWith(person)).toBe(false)
      expect(need(kitOs.paths).appData({ accountHome: os.userInfo().homedir, env }, path.basename(ud))).toBe(ud)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

/** The XDG base-directory variables (the freedesktop.org spec). */
const XDG_BASE = ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']
