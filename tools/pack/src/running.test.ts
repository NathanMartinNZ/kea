import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseProcs } from '../../../packages/protocol/src/procs.ts'
import { descendantsOf, sameProcess, tableOf, type Proc } from './processes.ts'
import { bundleOf, bundleProcesses, holdersByBuild, homeSwitch, quitKeas, runningKeas, type QuitDeps } from './running.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** A temp folder holding `<name>/Kea.app` with the app's executable in it (an empty file: nothing here is ever run). */
function fakeBundle(name = 'apps'): { tmp: string; app: string } {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-pack-test-')))
  dirs.push(tmp)
  const app = path.join(tmp, name, 'Kea.app')
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Kea'), '')
  return { tmp, app }
}

let nextPid = 4000
const proc = (comm: string, o: Partial<Proc> = {}): Proc => ({ pid: nextPid++, ppid: 1, start: 1_790_000_000, comm, args: comm, exe: comm, ...o })
const mainOf = (app: string) => path.join(app, 'Contents', 'MacOS', 'Kea')
const rendererOf = (app: string) => path.join(app, 'Contents', 'Frameworks', 'Kea Helper (Renderer).app', 'Contents', 'MacOS', 'Kea Helper (Renderer)')
const utilityOf = (app: string) => path.join(app, 'Contents', 'Frameworks', 'Kea Helper.app', 'Contents', 'MacOS', 'Kea Helper')

/** The installed app and its holders, as they look in a process table. The tests below must never match any of them. */
const OWNERS = [
  proc('/Applications/Kea.app/Contents/MacOS/Kea'), // os-ok: test data
  // os-ok: test data
  proc('/Applications/Kea.app/Contents/Frameworks/Kea Helper (Renderer).app/Contents/MacOS/Kea Helper (Renderer)', { args: 'Kea Helper (Renderer) --type=renderer' }),
  proc('/Users/someone/.kea/bin/0.1.0-f1b33f039614/kea-helper', { args: '/Users/someone/.kea/bin/0.1.0-f1b33f039614/kea-helper pty-daemon --id t43 --session shells' }),
]

describe('the process table (tools/pack/src/processes.ts)', () => {
  it('U-PACK-2 · `kea-helper procs --args` rows: the start to the second, argv[0] as the executable, the words joined as `ps args` printed them; a zombie with neither is left out', () => {
    const start = Date.UTC(2026, 9, 7, 13, 18, 0) * 1000 + 999_999
    const lines = [
      `123\t1\t${start}\t/Apps/Kea.app/Contents/MacOS/Kea\t/Apps/Kea.app/Contents/MacOS/Kea\t--kea-home=/tmp/h h\t--kea-perf`,
      `124\t123\t${start}\t/Apps/Kea.app/Contents/Frameworks/Kea Helper.app/Contents/MacOS/Kea Helper\t/Apps/Kea.app/Contents/Frameworks/Kea Helper.app/Contents/MacOS/Kea Helper\t--type=utility`,
      `125\t123\t${start}\t-`,
      `126\t1\t${start}\t/usr/libexec/bare`, // os-ok: test data
      'garbage',
    ]
    const t = tableOf(parseProcs(lines.join('\n')))
    expect(t.map((p) => p.pid)).toEqual([123, 124, 126])
    expect(t[0]).toEqual({ pid: 123, ppid: 1, start: Date.UTC(2026, 9, 7, 13, 18, 0) / 1000, comm: '/Apps/Kea.app/Contents/MacOS/Kea', args: '/Apps/Kea.app/Contents/MacOS/Kea --kea-home=/tmp/h h --kea-perf', exe: '/Apps/Kea.app/Contents/MacOS/Kea' })
    expect(t[2], 'no arguments: the executable, no command line').toMatchObject({ comm: '/usr/libexec/bare', args: '' }) // os-ok: test data
    expect(t[1]!.comm.endsWith('Kea Helper')).toBe(true)
    expect(descendantsOf(123, t).map((p) => p.pid)).toEqual([124])
    // identity is pid + start + executable: a reused pid is another process
    expect(sameProcess(t[0]!, t[0])).toBe(true)
    expect(sameProcess(t[0]!, { ...t[0]!, start: t[0]!.start + 1 })).toBe(false)
    expect(sameProcess(t[0]!, { ...t[0]!, comm: '/bin/zsh' })).toBe(false)
    expect(sameProcess(t[0]!, undefined)).toBe(false)
  })
})

describe('the Kea running from the bundle being replaced (tools/pack/src/running.ts)', () => {
  it('U-PACK-3 · only processes whose executable lies in that very bundle count: not the installed app, not another Kea.app, not a holder, not a command that names it', () => {
    const { tmp, app } = fakeBundle()
    const other = path.join(tmp, 'elsewhere', 'Kea.app')
    fs.mkdirSync(path.join(other, 'Contents', 'MacOS'), { recursive: true })
    fs.symlinkSync(path.join(tmp, 'apps'), path.join(tmp, 'link'))
    const main = proc(mainOf(app))
    const renderer = proc(rendererOf(app), { ppid: main.pid })
    const viaLink = proc(mainOf(path.join(tmp, 'link', 'Kea.app')))
    const table = [
      ...OWNERS,
      main,
      renderer,
      viaLink,
      proc(mainOf(other)),
      proc(path.join(tmp, 'home', 'bin', '0.1.0-aaaaaaaaaaaa', 'kea-helper'), { args: `kea-helper pty-daemon --dir ${tmp}/home/sessions/s` }),
      proc('/usr/bin/codesign', { args: `/usr/bin/codesign --verify ${app}` }), // os-ok: test data
      proc(`${app}.installing/Contents/MacOS/Kea`),
    ]
    expect(bundleProcesses(table, app).map((p) => p.pid)).toEqual([main.pid, renderer.pid, viaLink.pid])
    expect(runningKeas(table, app).map((k) => k.main.pid)).toEqual([main.pid, viaLink.pid])
    expect(bundleOf(viaLink.comm, app)).toBe(path.join(tmp, 'link', 'Kea.app'))
    // the installed app is found only when it is the target itself
    expect(runningKeas(table, '/Applications/Kea.app').map((k) => k.main.pid)).toEqual([OWNERS[0]!.pid]) // os-ok: test data
    expect(bundleProcesses(table, other).map((p) => p.comm)).toEqual([mainOf(other)])
    // a bundle that is gone still owns the processes started from its path
    fs.rmSync(app, { recursive: true })
    expect(bundleProcesses(table, app).map((p) => p.pid)).toEqual([main.pid, renderer.pid])
  })

  it('U-PACK-4 · each Kea is described: its home switch, whether a window is open (a renderer below it), and holders that are not detached', () => {
    const { tmp, app } = fakeBundle()
    const home = path.join(tmp, 'a home')
    const windowed = proc(mainOf(app), { args: `${mainOf(app)} --kea-home=${home} --kea-perf` })
    const menuBar = proc(mainOf(app), { args: mainOf(app) })
    const ptyhost = proc(utilityOf(app), { ppid: menuBar.pid, args: 'Kea Helper --type=utility' })
    const held = proc(path.join(home, 'bin', '0.1.0-aaaaaaaaaaaa', 'kea-helper'), { ppid: ptyhost.pid, args: `${home}/bin/0.1.0-aaaaaaaaaaaa/kea-helper pty --id p1 --session s1 --no-detach -- /bin/zsh -l` })
    const table = [
      windowed,
      proc(utilityOf(app), { ppid: windowed.pid }),
      proc(rendererOf(app), { ppid: windowed.pid, args: 'Kea Helper (Renderer) --type=renderer' }),
      menuBar,
      ptyhost,
      held,
      // a detached holder is launchd's child and nobody's `held`; a short-lived helper run is not a holder
      proc(path.join(home, 'bin', '0.1.0-aaaaaaaaaaaa', 'kea-helper'), { args: `${home}/bin/0.1.0-aaaaaaaaaaaa/kea-helper pty-daemon --id p2 --session s1` }),
      proc(path.join(app, 'Contents', 'Resources', 'kea-helper'), { ppid: menuBar.pid, args: 'kea-helper footprint 1 2 3' }),
    ]
    const [a, b] = runningKeas(table, app)
    expect(a).toMatchObject({ main: windowed, home, window: true, held: [] })
    expect(b).toMatchObject({ main: menuBar, home: null, window: false, held: [held] })
    expect(homeSwitch('/x/Kea --kea-home=/tmp/with space/h --kea-perf')).toBe('/tmp/with space/h')
    expect(homeSwitch('/x/Kea')).toBeNull()
    // alive holders by the build whose copy they run from, read from the table alone
    expect(holdersByBuild([...table, ...OWNERS], home)).toEqual([{ build: '0.1.0-aaaaaaaaaaaa', count: 2 }])
    // holders start from bin/current: grouped by the version each was started with
    const current = path.join(home, 'bin', 'current', 'kea-helper')
    const since = [
      proc(current, { args: `${current} pty-daemon --id p3 --session s1 --kea-version 0.2.0 --ready-fd 3 -- /bin/zsh -l` }),
      proc(current, { args: `${current} pty-daemon --id p4 --session s2 --kea-version 0.2.1 --ready-fd 3 -- /bin/zsh -l` }),
      proc(current, { args: `${current} pty-daemon --id p5 --session s2 --kea-version 0.2.1 --ready-fd 3 -- /bin/zsh -l` }),
      proc(current, { args: `${current} pty-daemon --id p6 --session s3 -- /bin/zsh -l` }),
      proc(current, { args: `${current} hook claude --session s2` }), // not a holder
    ]
    expect(holdersByBuild([...table, ...since], home)).toEqual([
      { build: '0.1.0-aaaaaaaaaaaa', count: 2 },
      { build: '0.2.0 (bin/current)', count: 1 },
      { build: '0.2.1 (bin/current)', count: 2 },
      { build: 'bin/current', count: 1 },
    ])
    expect(holdersByBuild([...table, ...OWNERS], '/Users/someone/.kea')).toEqual([{ build: '0.1.0-f1b33f039614', count: 1 }])
    expect(holdersByBuild(table, path.join(tmp, 'no such home'))).toEqual([])
  })

  /** A scripted world: `tables` are returned one per look (the last one for ever), and every sleep moves the clock. */
  function world(tables: Proc[][]): QuitDeps & { terminated: number[]; looks: number } {
    let t = 0
    const w = {
      terminated: [] as number[],
      looks: 0,
      table: () => tables[Math.min(w.looks++, tables.length - 1)]!,
      terminate: (pid: number) => void w.terminated.push(pid),
      sleep: async (ms: number) => void (t += ms),
      now: () => t,
    }
    return w
  }

  it('U-PACK-5 · quitting signals only a main process that is still the one found, then waits until nothing runs from the bundle', async () => {
    const { app } = fakeBundle()
    const main = proc(mainOf(app))
    const helper = proc(utilityOf(app), { ppid: main.pid })
    const [kea] = runningKeas([main, helper], app)
    // it leaves after two looks
    const w = world([[main, helper, ...OWNERS], [main, helper, ...OWNERS], [helper, ...OWNERS], [...OWNERS]])
    const q = await quitKeas(app, [kea!], w, { timeoutMs: 5000, pollMs: 100 })
    expect(q).toMatchObject({ empty: true, asked: [main.pid], skipped: [], left: [] })
    expect(w.terminated, 'one signal, to the main process, and never to the installed app').toEqual([main.pid])

    // the pid now belongs to another process (later start), or to another executable: never signalled
    for (const impostor of [{ ...main, start: main.start + 60 }, { ...main, comm: '/bin/zsh' }, { ...main, comm: utilityOf(app) }]) {
      const w2 = world([[impostor], []])
      const q2 = await quitKeas(app, [kea!], w2, { timeoutMs: 5000, pollMs: 100 })
      expect(w2.terminated).toEqual([])
      expect(q2.skipped.map((s) => s.pid)).toEqual([main.pid])
    }
    // already gone: nothing to ask, nothing left
    const w3 = world([[]])
    expect(await quitKeas(app, [kea!], w3, { timeoutMs: 5000, pollMs: 100 })).toMatchObject({ empty: true, asked: [], skipped: [] })
    expect(w3.terminated).toEqual([])
  })

  it('U-PACK-6 · a Kea that does not quit in time is reported, with what still runs from the bundle; it is asked once and nothing else is signalled', async () => {
    const { app } = fakeBundle()
    const main = proc(mainOf(app))
    const gpu = proc(path.join(app, 'Contents', 'Frameworks', 'Kea Helper (GPU).app', 'Contents', 'MacOS', 'Kea Helper (GPU)'), { ppid: main.pid })
    const [kea] = runningKeas([main, gpu], app)
    const w = world([[main, gpu]])
    const q = await quitKeas(app, [kea!], w, { timeoutMs: 1000, pollMs: 250 })
    expect(q.empty).toBe(false)
    expect(q.left.map((p) => p.pid)).toEqual([main.pid, gpu.pid])
    expect(w.terminated).toEqual([main.pid])
    expect(w.now(), 'it waited the whole time, no longer').toBe(1000)
    // a signal the system refuses is a skip, not a crash; a pid that vanished at that moment is no skip
    const refuse = (code: string): QuitDeps => ({ ...world([[main], []]), terminate: () => { throw Object.assign(new Error(code), { code }) } }) // prettier-ignore
    expect((await quitKeas(app, [kea!], refuse('EPERM'), { timeoutMs: 100, pollMs: 50 })).skipped).toHaveLength(1)
    expect((await quitKeas(app, [kea!], refuse('ESRCH'), { timeoutMs: 100, pollMs: 50 })).skipped).toHaveLength(0)
  })
})
