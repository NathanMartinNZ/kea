// The per-build kea-helper copies under `<KEA_HOME>/bin`: how one is named and installed, and when an earlier build's
// copy goes. Everything here is a temp home and a made-up process list; the process list is read through
// `procsExecutables` in one test only, from a stand-in helper (U-HLD-14: how a path comes through is the point there;
// C-UPD-1 and C-UPD-5 run the real helper, U-PLT-3 checks its lines against `ps`).

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultRegistry } from '@kea/adapters'
import { createMemoryLogger } from '@kea/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HelperCopies, helperCopyName, installHookHelper, procsExecutables, pruneHelperCopies, type PruneOptions } from './helper.ts'

const cleanups: (() => unknown)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function tempHome(): string {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-helper-copies-')))
  cleanups.push(() => fs.rmSync(h, { recursive: true, force: true }))
  return h
}

/** A stand-in for the helper Kea ships (never run here). */
function source(dir: string, content = 'helper of this build'): string {
  const f = path.join(dir, 'shipped-kea-helper')
  fs.writeFileSync(f, content, { mode: 0o755 })
  return f
}

/** An earlier build's copy: `<home>/bin/<name>/kea-helper`. Returns the executable. */
function copy(home: string, name: string): string {
  const dir = path.join(home, 'bin', name)
  fs.mkdirSync(dir, { recursive: true })
  const exe = path.join(dir, 'kea-helper')
  fs.writeFileSync(exe, `helper ${name}`, { mode: 0o755 })
  return exe
}

const bin = (home: string): string[] => fs.readdirSync(path.join(home, 'bin')).sort()
const N1 = '0.1.0-aaaaaaaaaaaa'
const N2 = '0.1.0-bbbbbbbbbbbb'
const NOW = '0.2.0-cccccccccccc'

function options(home: string, o: Partial<PruneOptions> = {}): PruneOptions {
  return { home, current: NOW, executables: async () => [], argvs: () => [], log: createMemoryLogger(), ...o }
}

describe('the per-build kea-helper copy', () => {
  it('U-HLD-8 · the copy is named by Kea’s version and a hash of the binary, installed once under <home>/bin and never written again; a rebuilt helper gets a folder of its own', () => {
    const home = tempHome()
    const src = source(home)
    const name = helperCopyName(src, '0.2.0')
    expect(name).toBe(`0.2.0-${createHash('sha256').update('helper of this build').digest('hex').slice(0, 12)}`)
    const dest = installHookHelper(src, home, '0.2.0')
    expect(dest).toBe(path.join(home, 'bin', name, 'kea-helper'))
    expect(fs.readFileSync(dest, 'utf8')).toBe('helper of this build')
    expect(fs.statSync(dest).mode & 0o777).toBe(0o755)
    expect(fs.readdirSync(path.dirname(dest)), 'no temp file left').toEqual(['kea-helper'])
    // a second launch of the same build: the same file, untouched (a running hook's executable is never replaced)
    const ino = fs.statSync(dest).ino
    expect(installHookHelper(src, home, '0.2.0')).toBe(dest)
    expect(fs.statSync(dest).ino).toBe(ino)
    // the same version rebuilt: another folder, the first one as it was
    const rebuilt = installHookHelper(source(home, 'helper, rebuilt'), home, '0.2.0')
    expect(path.dirname(rebuilt)).not.toBe(path.dirname(dest))
    expect(fs.readFileSync(dest, 'utf8')).toBe('helper of this build')
    expect(bin(home)).toHaveLength(2)
  })

  it('U-HLD-9 · an earlier build’s copy goes only when no process runs from it and no running terminal’s command names it; this build’s copy, the agents’ files and anything else in bin/ stay', async () => {
    const home = tempHome()
    copy(home, NOW)
    const held = copy(home, N1) // a holder of build N1 still runs
    const hooked = copy(home, N2) // an agent started by build N2 calls its hooks through this path
    copy(home, '0.1.0-dddddddddddd') // nothing uses it
    copy(home, '0.0.9-eeeeeeeeeeee') // nothing uses it
    fs.mkdirSync(path.join(home, 'bin', 'agents', 'cmd-0123456789ab'), { recursive: true }) // an agent's launch files: not a helper copy
    fs.mkdirSync(path.join(home, 'bin', 'notes'))
    fs.writeFileSync(path.join(home, 'bin', '0.1.0-ffffffffffff'), 'a file, not a copy')
    fs.symlinkSync(path.join(home, 'bin', N1), path.join(home, 'bin', '0.1.0-999999999999')) // a link: never followed, never removed
    const elsewhere = copy(tempHome(), N1) // a kea-helper of another home (a dev build, a test's): a file, and none of these copies
    const log = createMemoryLogger()
    const r = await pruneHelperCopies(
      options(home, {
        log,
        executables: async () => ['/sbin/launchd', held, elsewhere, '/Applications/Other.app/Contents/MacOS/Other'], // os-ok: test data
        argvs: () => [['/bin/zsh', '-l'], ['claude', '--settings', JSON.stringify({ hooks: { Stop: [{ command: hooked }] } })]],
      }),
    )
    expect(r).toEqual({ removed: ['0.0.9-eeeeeeeeeeee', '0.1.0-dddddddddddd'], kept: [{ name: N1, why: 'process' }, { name: N2, why: 'argv' }] })
    expect(bin(home)).toEqual(['0.1.0-999999999999', N1, N2, '0.1.0-ffffffffffff', NOW, 'agents', 'notes'].sort())
    expect(fs.existsSync(path.join(home, 'bin', 'agents', 'cmd-0123456789ab'))).toBe(true)
    expect(log.entries.map((e) => e.msg)).toEqual(['helper copies of earlier builds'])

    // the holder has ended and the agent too: both go at the next look, this build's copy never
    const after = await pruneHelperCopies(options(home))
    expect(after.removed).toEqual([N1, N2])
    expect(bin(home)).toEqual(['0.1.0-999999999999', '0.1.0-ffffffffffff', NOW, 'agents', 'notes'].sort())

    // an agent whose command names its helper inside an encoded option (Command Code's), and one whose home has
    // characters its option escapes (a quote in Claude's inline settings): no argument holds the copy's path as plain
    // text. Which helper a command names is what its adapter says (`helperPaths`).
    const registry = defaultRegistry()
    const odd = path.join(tempHome(), 'a "quoted" home')
    fs.mkdirSync(odd)
    for (const [id, h] of [['commandcode', home], ['claude', odd], ['commandcode', odd]] as const) {
      const helper = copy(h, N1)
      copy(h, N2)
      copy(h, NOW)
      const spec = registry.get(id)!.buildLaunch({ prompt: 'go on' }, { keaSessionId: '01JXKEASESSION0000000000AA', agentSessionId: '6f1c2b8e-1d2a-4c55-9a7e-0b3c4d5e6f70', cwd: h, ownWorktree: true, helperPath: helper, keaHome: h, portBase: null, binary: null, version: null, env: {}, settings: { extraArgs: [], env: {}, allowDangerousModes: false }, filesDir: path.join(h, 'bin', 'agents', `${id}-0123456789ab`) })
      // as the terminal's record holds it, started through the login shell
      const argv = ['/bin/zsh', '-l', '-i', '-c', 'exec "$@"', 'kea', spec.file, ...spec.args]
      expect(argv.some((a) => a.includes(path.dirname(helper) + path.sep)), `${id}: the path is not in the command as plain text`).toBe(false)
      const r = await pruneHelperCopies(options(h, { argvs: () => [argv], helperPaths: (v) => registry.helperPaths(v) }))
      expect(r, `${id} in ${h}`).toEqual({ removed: [N2], kept: [{ name: N1, why: 'argv' }] })
      expect((await pruneHelperCopies(options(h, { helperPaths: (v) => registry.helperPaths(v) }))).removed, `${id}: the agent has ended`).toEqual([N1])
    }
  })

  it('U-HLD-18 · bin/current, where holders start from, is never removed; holders running it (one started before the next build renamed its own over it among them) keep no build’s copy, and do not stop the prune', async () => {
    const home = tempHome()
    copy(home, NOW)
    copy(home, N1) // hooks of an agent that has ended: nothing names it now
    const current = copy(home, 'current')
    const r = await pruneHelperCopies(options(home, { executables: async () => [current, current, path.join(home, 'elsewhere', 'agent')] }))
    expect(r).toEqual({ removed: [N1], kept: [] })
    expect(bin(home)).toEqual(['current', NOW].sort())
    expect(fs.readFileSync(current, 'utf8')).toBe('helper current')
  })

  it('U-HLD-10 · a process is matched as the file it runs, so a home reached by another path keeps its copy; a name that merely starts like a copy’s folder keeps nothing', async () => {
    const home = tempHome()
    const real = copy(home, N1)
    copy(home, N2)
    const link = path.join(tempHome(), 'home-by-another-name')
    fs.symlinkSync(home, link)
    const r = await pruneHelperCopies(options(home, { executables: async () => [path.join(link, 'bin', N1, 'kea-helper')], argvs: () => [[`${path.join(home, 'bin', N2)}-not-it/kea-helper`]] }))
    expect(r).toEqual({ removed: [N2], kept: [{ name: N1, why: 'process' }] })
    expect(fs.existsSync(real)).toBe(true)
    // a holder whose copy's file was replaced under it still shows the path it was started with: kept by that
    fs.rmSync(real)
    fs.writeFileSync(real, 'another file at the same path')
    expect((await pruneHelperCopies(options(home, { executables: async () => [real] }))).kept).toEqual([{ name: N1, why: 'process' }])
  })

  it('U-HLD-11 · when the running processes cannot be listed nothing is removed; with no earlier build’s copy they are not listed at all', async () => {
    const home = tempHome()
    expect(await pruneHelperCopies(options(home, { executables: () => Promise.reject(new Error('never asked')) })), 'no bin/ yet').toEqual({ removed: [], kept: [] })
    copy(home, NOW)
    const asked = vi.fn(async () => [])
    expect(await pruneHelperCopies(options(home, { executables: asked }))).toEqual({ removed: [], kept: [] })
    expect(asked, 'only this build’s copy: nothing to ask').not.toHaveBeenCalled()

    copy(home, N1)
    const log = createMemoryLogger()
    expect(await pruneHelperCopies(options(home, { log, executables: () => Promise.reject(new Error('ps did not answer')) }))).toEqual({ removed: [], kept: [] })
    expect(bin(home)).toEqual([N1, NOW])
    expect(log.entries.map((e) => [e.level, e.msg])).toEqual([['warn', 'helper copies not pruned: the running processes could not be listed']])
  })

  it('U-HLD-12 · core’s prune runs one at a time and once more when asked meanwhile; without the shipped helper this build’s copy has no name, so nothing is ever removed', async () => {
    const home = tempHome()
    const src = source(home)
    const mine = path.dirname(installHookHelper(src, home, '0.2.0'))
    copy(home, N1)
    copy(home, N2)

    // no shipped helper (a core without `--helper`): never a look, never a removal
    const blind = new HelperCopies({ home, version: '0.2.0', source: null, executables: () => Promise.reject(new Error('never asked')), argvs: () => [], log: createMemoryLogger() })
    expect(await blind.prune()).toBeNull()
    expect(bin(home)).toHaveLength(3)

    let release!: (exes: string[]) => void
    const lists: Promise<string[]>[] = []
    const executables = vi.fn(() => {
      const p = new Promise<string[]>((r) => (release = r))
      lists.push(p)
      return p
    })
    const copies = new HelperCopies({ home, version: '0.2.0', source: src, executables, argvs: () => [], log: createMemoryLogger() })
    const first = copies.prune()
    // asked twice more while the first list is being read (two terminals ended): one more run, not two
    expect(copies.prune()).toBe(first)
    expect(copies.prune()).toBe(first)
    await vi.waitFor(() => expect(executables).toHaveBeenCalledTimes(1))
    release([path.join(home, 'bin', N1, 'kea-helper'), path.join(home, 'bin', N2, 'kea-helper')])
    expect(await first).toEqual({ removed: [], kept: [{ name: N1, why: 'process' }, { name: N2, why: 'process' }] })
    await vi.waitFor(() => expect(executables).toHaveBeenCalledTimes(2))
    release([path.join(home, 'bin', N2, 'kea-helper')])
    await vi.waitFor(() => expect(bin(home)).toEqual([N2, path.basename(mine)].sort()))
    await lists[1]
    expect(executables, 'no third run').toHaveBeenCalledTimes(2)
    expect(fs.existsSync(path.join(mine, 'kea-helper')), 'this build’s copy').toBe(true)

    // disposed with core: asked again, nothing runs
    copies.dispose()
    expect(await copies.prune()).toBeNull()
    expect(executables).toHaveBeenCalledTimes(2)
    expect(bin(home)).toEqual([N2, path.basename(mine)].sort())
  })

  // Keeping only this build's copy, named at the first look, is not enough: a helper rebuilt under a running dev core
  // makes the copy the next agent's hooks are handed another build's (its hash is the rebuilt binary's), so the next
  // look would remove it before anything ran from it or named it; and a first look made after a rebuild names the
  // rebuilt helper's copy, so the copy the hooks were handed before it would go.
  it('U-HLD-16 · the copy the agents’ hooks were last handed is never pruned, whichever build’s it is: also after the helper was rebuilt under a running core, and while the launch it went to has no terminal yet; once another copy is handed out it goes like any other', async () => {
    const home = tempHome()
    const src = source(home)
    // as core wires it: the prune keeps what the agent service last handed out (`AgentService.hookHelperPath`)
    let handed: string | null = null
    const copies = new HelperCopies({ home, version: '0.2.0', source: src, executables: async () => [], argvs: () => [], handedOut: () => handed, log: createMemoryLogger() })
    // core's first look, after its launch reconciliation: this build's copy is named from the helper as it is now
    expect(await copies.prune()).toEqual({ removed: [], kept: [] })
    const first = path.join(home, 'bin', helperCopyName(src, '0.2.0'), 'kea-helper')

    // the helper is rebuilt; the next agent's launch installs the rebuilt one's copy and hands it to its hooks, and a
    // terminal ends before the agent's terminal is recorded (nothing runs from the copy, no command names it yet)
    fs.writeFileSync(src, 'helper, rebuilt', { mode: 0o755 })
    handed = installHookHelper(src, home, '0.2.0')
    expect(path.dirname(handed)).not.toBe(path.dirname(first))
    expect(await copies.prune(), 'the copy just handed out').toEqual({ removed: [], kept: [] })
    expect(fs.existsSync(handed)).toBe(true)

    // a core whose first look came after the rebuild, while the hooks were still handed the copy made before it
    const other = tempHome()
    const src2 = source(other)
    const before = installHookHelper(src2, other, '0.2.0')
    let handed2: string | null = before
    fs.writeFileSync(src2, 'helper, rebuilt', { mode: 0o755 })
    const late = new HelperCopies({ home: other, version: '0.2.0', source: src2, executables: async () => [], argvs: () => [], handedOut: () => handed2, log: createMemoryLogger() })
    expect(await late.prune(), 'the copy the hooks are handed').toEqual({ removed: [], kept: [] })
    expect(fs.existsSync(before)).toBe(true)

    // what is handed out is read when the copies are judged, not when the look began: the hooks were handed another
    // copy while the processes were being listed
    let listed!: (exes: string[]) => void
    const slow = new HelperCopies({ home: other, version: '0.2.0', source: src2, executables: () => new Promise<string[]>((r) => (listed = r)), argvs: () => [], handedOut: () => handed2, log: createMemoryLogger() })
    const now = installHookHelper(src2, other, '0.2.0')
    copy(other, N1) // an earlier build's copy: something to judge
    handed2 = null
    const judged = slow.prune()
    await vi.waitFor(() => expect(listed).toBeTypeOf('function'))
    handed2 = before
    listed([])
    expect(await judged).toEqual({ removed: [N1], kept: [] })
    expect(fs.existsSync(before)).toBe(true)

    // once the hooks are handed another copy, the earlier one goes like any copy nothing uses
    handed2 = now
    expect((await late.prune())?.removed).toEqual([path.basename(path.dirname(before))])
    expect(fs.existsSync(now)).toBe(true)
  })

  // `ps` under `LC_ALL=C` prints every byte past ASCII in its own notation (`é` as `M-CM-)`), so the path of a live
  // holder in such a home would name no file, and the holder's copy would be matched by nothing and removed.
  // `kea-helper procs` prints UTF-8 as it is and escapes only what is not. This is the one test here that reads the
  // list through `procsExecutables`, from a stand-in helper printing what the real one prints.
  it('U-HLD-14 · a home with a letter past ASCII and a space in its name keeps the copy a process runs from (`kea-helper procs` prints the path as it is); and while any running kea-helper names no file that is there, nothing is removed at all', async () => {
    const home = path.join(tempHome(), 'hé x')
    fs.mkdirSync(home)
    const exe = copy(home, N1)
    copy(home, N2)
    copy(home, NOW)

    // a kea-helper whose path is no file (printed in another notation, relative, or gone): it may run from any copy
    for (const unmatched of [exe.replace('é', 'M-CM-)'), './kea-helper', 'kea-helper', path.join(home, 'bin', 'gone-000000000000', 'kea-helper')]) {
      const log = createMemoryLogger()
      // os-ok: test data
      expect(await pruneHelperCopies(options(home, { log, executables: async () => ['/sbin/launchd', unmatched] })), unmatched).toEqual({ removed: [], kept: [] })
      expect(bin(home), unmatched).toEqual([N1, N2, NOW])
      expect(log.entries.map((e) => [e.level, e.msg])).toEqual([['warn', 'helper copies not pruned: a running kea-helper names no file that is there']])
    }

    // a holder runs from the N1 copy: `kea-helper procs` names it by the path it was started with, the letter and the
    // space as they are; a zombie (no executable, no arguments) and a process with only its executable come through too
    const helper = path.join(tempHome(), 'kea-helper')
    const lines = [`412\t1\t1791379080123456\t${exe}\t${exe}\tpty-daemon`, '413\t1\t1791379080123456\t-', '414\t1\t1791379080123456\t/bin/cat'] // os-ok: test data
    fs.writeFileSync(`${helper}.out`, lines.join('\n') + '\n')
    fs.writeFileSync(helper, `#!/bin/sh\n[ "$*" = procs ] || exit 2\nexec /bin/cat '${helper}.out'\n`, { mode: 0o755 })
    const listed = await procsExecutables(helper)()
    expect(listed).toEqual([exe, '/bin/cat']) // os-ok: test data
    expect(await pruneHelperCopies(options(home, { executables: async () => listed }))).toEqual({ removed: [N2], kept: [{ name: N1, why: 'process' }] })
    expect(bin(home)).toEqual([N1, NOW])
    fs.writeFileSync(helper, '#!/bin/sh\necho "kea-helper procs: Permission denied" >&2\nexit 1\n')
    await expect(procsExecutables(helper)(), 'a helper that cannot list them: no list').rejects.toThrow(/Permission denied/)
  })
})
