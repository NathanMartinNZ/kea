import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isMainThread } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { isAvailable } from '../../../packages/protocol/src/platform.ts'
import { parseOptions } from './options.ts'
import { packOs } from './os/index.ts'
import { discardStage, execQuiet, finish, holdSignals, leftovers, recover, sides, stage, stageDeps, stageFailure, swap, swapFailure, type Exec, type StageDeps } from './replace.ts'
import { installedApp, resolveTarget, testTargetProblem } from './target.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function temp(): string {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-pack-test-')))
  dirs.push(tmp)
  return tmp
}

/** A stand-in bundle: a folder with a marker saying which build it is. */
function bundle(dir: string, build: string): string {
  fs.mkdirSync(path.join(dir, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Contents', 'build'), build)
  fs.writeFileSync(path.join(dir, 'Contents', 'MacOS', 'Kea'), `executable of ${build}`)
  return dir
}
/** Which build is at `dir`: its marker, 'none' when there is nothing, 'partial' when it is not a whole bundle. */
function buildAt(dir: string): string {
  if (!fs.existsSync(dir)) return 'none'
  const whole = fs.existsSync(path.join(dir, 'Contents', 'build')) && fs.existsSync(path.join(dir, 'Contents', 'MacOS', 'Kea'))
  return whole ? fs.readFileSync(path.join(dir, 'Contents', 'build'), 'utf8') : 'partial'
}
const copies: StageDeps = { copy: (from, to) => fs.cpSync(from, to, { recursive: true }), verify: () => null }
class Killed extends Error {}

function world(): { target: string; built: string; state: () => Record<'target' | 'installing' | 'previous', string> } {
  const tmp = temp()
  fs.mkdirSync(path.join(tmp, 'apps'))
  const target = bundle(path.join(tmp, 'apps', 'Kea.app'), 'old')
  const built = bundle(path.join(tmp, 'out', 'Kea.app'), 'new')
  const s = sides(target)
  return { target, built, state: () => ({ target: buildAt(target), installing: buildAt(s.installing), previous: buildAt(s.previous) }) }
}

describe('replacing the app in place (tools/pack/src/replace.ts)', () => {
  it('U-PACK-7 · stage, swap, finish: the new build ends at the same path, the old one is gone, and until the swap the app is the old one', () => {
    const w = world()
    stage(w.built, w.target, copies)
    expect(w.state()).toEqual({ target: 'old', installing: 'new', previous: 'none' })
    swap(w.target)
    expect(w.state()).toEqual({ target: 'new', installing: 'none', previous: 'old' })
    expect(finish(w.target)).toEqual({ removed: true, error: null })
    expect(w.state()).toEqual({ target: 'new', installing: 'none', previous: 'none' })
    expect(recover(w.target), 'a finished install leaves nothing to put right').toEqual([])
    // a first install: nothing was there
    fs.rmSync(w.target, { recursive: true })
    stage(w.built, w.target, copies)
    swap(w.target)
    expect(finish(w.target)).toEqual({ removed: false, error: null })
    expect(w.state()).toEqual({ target: 'new', installing: 'none', previous: 'none' })
    // the built app is only ever read
    expect(buildAt(w.built)).toBe('new')
  })

  it('U-PACK-8 · a run killed at any point leaves a whole app or the old one a rename away, and the next run puts it right', () => {
    // during the copy: a partial copy beside the untouched app
    let w = world()
    expect(() => stage(w.built, w.target, { copy: (from, to) => (fs.cpSync(path.join(from, 'Contents', 'MacOS'), path.join(to, 'Contents', 'MacOS'), { recursive: true }), undefined), verify: () => { throw new Killed() } })).toThrow(Killed) // prettier-ignore
    fs.mkdirSync(path.join(sides(w.target).installing, 'Contents'), { recursive: true }) // what a kill mid-copy leaves (stage itself cleans up when it can)
    expect(w.state()).toEqual({ target: 'old', installing: 'partial', previous: 'none' })
    // said first, in words, without doing it (the plan is printed before anything changes)
    expect(leftovers(w.target)).toEqual([`${sides(w.target).installing}, the copy an earlier install had not finished, is removed first.`])
    expect(w.state()).toEqual({ target: 'old', installing: 'partial', previous: 'none' })
    expect(recover(w.target)).toHaveLength(1)
    expect(leftovers(w.target), 'nothing left to say').toEqual([])
    expect(w.state()).toEqual({ target: 'old', installing: 'none', previous: 'none' })

    // after the copy, before the swap (say, while Kea was quitting): the staged copy goes
    w = world()
    stage(w.built, w.target, copies)
    expect(recover(w.target)).toHaveLength(1)
    expect(w.state()).toEqual({ target: 'old', installing: 'none', previous: 'none' })

    // between the two renames: no app at the path, both whole beside it; the old one is put back
    w = world()
    stage(w.built, w.target, copies)
    expect(() => swap(w.target, { between: () => { throw new Killed() } })).toThrow(Killed) // prettier-ignore
    expect(w.state()).toEqual({ target: 'none', installing: 'new', previous: 'old' })
    expect(leftovers(w.target)).toHaveLength(2)
    expect(leftovers(w.target)[0]).toMatch(/the old app, now at .*Kea\.app\.previous, is put back at .*Kea\.app first\./)
    expect(w.state(), 'looking changed nothing').toEqual({ target: 'none', installing: 'new', previous: 'old' })
    const did = recover(w.target)
    expect(did[0]).toMatch(/the old app is back/)
    expect(w.state()).toEqual({ target: 'old', installing: 'none', previous: 'none' })

    // after the swap, while the old app was being deleted: the new one stays, the rest goes
    w = world()
    stage(w.built, w.target, copies)
    swap(w.target)
    fs.rmSync(path.join(sides(w.target).previous, 'Contents', 'MacOS'), { recursive: true })
    expect(w.state()).toEqual({ target: 'new', installing: 'none', previous: 'partial' })
    expect(leftovers(w.target)).toEqual([`${sides(w.target).previous}, the old app an earlier install had not finished deleting, is removed first.`])
    expect(recover(w.target)).toHaveLength(1)
    expect(w.state()).toEqual({ target: 'new', installing: 'none', previous: 'none' })
  })

  it('U-PACK-9 · a failure that is not a kill never costs the app: a copy that does not verify is dropped, a failed swap puts the old app back', () => {
    const w = world()
    expect(() => stage(w.built, w.target, { ...copies, verify: () => 'invalid signature' })).toThrow(/does not verify, so nothing was replaced: invalid signature/)
    expect(w.state()).toEqual({ target: 'old', installing: 'none', previous: 'none' })
    expect(() => stage(w.built, w.target, { ...copies, copy: () => { throw new Error('ditto: no space left') } })).toThrow(/no space left/) // prettier-ignore
    expect(w.state()).toEqual({ target: 'old', installing: 'none', previous: 'none' })
    // the staged copy vanishes before the second rename: the old app is renamed back
    stage(w.built, w.target, copies)
    expect(() => swap(w.target, { between: () => fs.rmSync(sides(w.target).installing, { recursive: true }) })).toThrow(/ENOENT/)
    expect(w.state()).toEqual({ target: 'old', installing: 'none', previous: 'none' })
    // nothing staged, or a leftover in the way: refused before anything moves
    expect(() => swap(w.target)).toThrow(/nothing is staged/)
    stage(w.built, w.target, copies)
    bundle(sides(w.target).previous, 'older')
    expect(() => swap(w.target)).toThrow(/in the way/)
    expect(w.state().target).toBe('old')
    discardStage(w.target)
    expect(w.state().installing).toBe('none')
  })

  // The copy and the check throw when they fail instead of ending the run, so a `ditto` that fails (a full disk) leaves
  // no partial `<target>.installing` behind, and the failure says the app is as it was. ditto and codesign are macOS's
  // (`pnpm kea:install`; Linux installs from packages): a named skip on Linux. Gated on the install place, not on
  // `packOs.tools`, which Linux has too (its packaging tools).
  it.runIf(isAvailable(packOs.installPlace))('U-PACK-23 · the tool’s own copy and check (`ditto`, `codesign --verify`) fail by throwing, never by ending the run: a copy that fails half way is removed, the app is untouched, and the failure says why and that the app is as it was', () => {
    const w = world()
    const { installing } = sides(w.target)
    // `ditto` fails after writing part of the bundle (the disk is full)
    const ran: string[][] = []
    const full: Exec = (file, args) => {
      ran.push([file, ...args])
      fs.mkdirSync(path.join(args[1]!, 'Contents'), { recursive: true })
      fs.writeFileSync(path.join(args[1]!, 'Contents', 'build'), 'half of new')
      return { status: 1, out: 'ditto: /x/Kea.app.installing/Contents/Frameworks: No space left on device\n' }
    }
    let said = ''
    try {
      stage(w.built, w.target, stageDeps(full))
    } catch (e) {
      said = stageFailure(e, w.target)
    }
    expect(ran).toEqual([['/usr/bin/ditto', w.built, installing]]) // os-ok: macOS's answer from the OS layer (os/darwin.ts)
    expect(said).toBe(`the build could not be copied to ${installing}, so nothing was replaced: ditto: /x/Kea.app.installing/Contents/Frameworks: No space left on device\n${w.target} is as it was.`)
    expect(w.state(), 'the partial copy is gone').toEqual({ target: 'old', installing: 'none', previous: 'none' })
    // a command that could not be started at all (no exit status, no output)
    expect(() => stage(w.built, w.target, stageDeps(() => ({ status: null, out: '' })))).toThrow(/could not be copied .* nothing was replaced: ditto did not run/)
    // the copy is whole but does not verify: the same end
    const unsigned: Exec = (file, args) => {
      if (file === '/usr/bin/ditto') fs.cpSync(args[0]!, args[1]!, { recursive: true }) // os-ok: macOS's answer from the OS layer (os/darwin.ts)
      return file === '/usr/bin/ditto' ? { status: 0, out: '' } : { status: 3, out: `${args.at(-1)}: code object is not signed at all\n` } // os-ok: macOS's answer from the OS layer (os/darwin.ts)
    }
    expect(() => stage(w.built, w.target, stageDeps(unsigned))).toThrow(/does not verify, so nothing was replaced: .*not signed at all/)
    expect(w.state()).toEqual({ target: 'old', installing: 'none', previous: 'none' })
    // the real `ditto`, as the tool runs it, with nothing to copy: it throws here too (this process goes on), and leaves nothing
    expect(() => stage(path.join(path.dirname(w.built), 'Missing.app'), w.target, stageDeps(execQuiet))).toThrow(/could not be copied .* nothing was replaced: /)
    expect(w.state()).toEqual({ target: 'old', installing: 'none', previous: 'none' })
    // and a copy that works is staged as before
    stage(w.built, w.target, stageDeps((file, args) => (file === '/usr/bin/ditto' ? execQuiet(file, args) : { status: 0, out: '' }))) // os-ok: macOS's answer from the OS layer (os/darwin.ts)
    expect(w.state()).toEqual({ target: 'old', installing: 'new', previous: 'none' })
  })

  // A real signal, not `process.emit`: emit calls the listener at once, while a real signal's listener runs on the next
  // event-loop turn. The hold must still catch it then and raise it again.
  it('U-PACK-10 · SIGINT, SIGTERM and SIGHUP are held back for the two renames and raised again afterwards: a real signal sent while they run does not end the run then, and is sent again once the event loop has turned', async () => {
    const HELD = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
    const listeners = () => HELD.map((s) => process.listenerCount(s))
    // the swaps of the rows before this one let go once the loop has turned (a hold outlives its `fn` by one turn)
    for (let turns = 0; turns < 3; turns++) await new Promise((r) => setImmediate(r))
    const before = listeners()
    // a real signal to this very process: only in a process of the test's own (a forked worker), and one of the three
    // that nothing else here listens for, so that only the hold can hear it
    expect(isMainThread, 'the unit tests run in forked workers').toBe(true)
    const sig = HELD.find((s) => process.listenerCount(s) === 0)
    expect(sig, 'one of the three has no listener in the test process').toBeDefined()
    const raised: string[] = []
    const kill = process.kill
    process.kill = ((pid: number, s?: string | number) => (pid === process.pid && s !== 0 ? (raised.push(String(s)), true) : kill.call(process, pid, s))) as typeof process.kill
    /** The event loop turns until the hold has let go (its listeners are gone), a few times at most. */
    const released = async (): Promise<void> => {
      for (let turns = 0; turns < 20 && listeners().some((n, i) => n !== before[i]); turns++) await new Promise((r) => setImmediate(r))
    }
    try {
      const during = holdSignals(() => {
        const counts = listeners()
        kill.call(process, process.pid, sig as NodeJS.Signals) // while the renames run: caught, so the run goes on
        return counts
      })
      expect(during).toEqual(before.map((n) => n + 1))
      expect(raised, 'not while the renames run, nor before the signal has been heard').toEqual([])
      await released()
      expect(listeners(), 'the hold has let go').toEqual(before)
      expect(raised, 'heard, and sent again now that it may end the run').toEqual([sig])
      // nothing arrived: nothing is raised
      holdSignals(() => undefined)
      await released()
      expect(listeners()).toEqual(before)
      expect(raised).toEqual([sig])
    } finally {
      process.kill = kill
    }
  })

  it('U-PACK-24 · a swap that fails says the app is as it was, and, when Kea was quit for it, that Kea has quit, that its sessions run on, and that it is not opened again', () => {
    const e = new Error('EPERM: operation not permitted, rename')
    expect(swapFailure('/x/Kea.app', e, { quit: false })).toBe('/x/Kea.app could not be replaced (EPERM: operation not permitted, rename). It is as it was.')
    expect(swapFailure('/x/Kea.app', e, { quit: true })).toBe(
      '/x/Kea.app could not be replaced (EPERM: operation not permitted, rename). It is as it was.\nKea has quit for this install and is not opened again: open it yourself. Its sessions kept running, and it reattaches every one.',
    )
  })
})

// `pnpm kea:install` is macOS's (Linux installs from packages): a named skip on Linux
describe.runIf(isAvailable(packOs.installPlace))('where a build may be installed (tools/pack/src/target.ts, options.ts)', () => {
  // os-ok: test data
  it('U-PACK-11 · the default target is /Applications/Kea.app; --install-to takes an existing folder outside every Applications folder, by any spelling', () => {
    const tmp = temp()
    const home = path.join(tmp, 'user')
    fs.mkdirSync(path.join(home, 'Applications'), { recursive: true })
    const target = path.join(tmp, 'target')
    fs.mkdirSync(target)
    expect(resolveTarget(null, home)).toEqual({ app: installedApp(), test: false })
    expect(resolveTarget(target, home)).toEqual({ app: path.join(target, 'Kea.app'), test: true })
    // os-ok: test data
    for (const refused of ['/Applications', '/Applications/', '/Applications/Utilities', '/Applications/Kea.app', path.join(home, 'Applications'), path.join(home, 'Applications', 'sub')]) {
      expect(testTargetProblem(refused, home), refused).toMatch(/only the default install/)
      expect(() => resolveTarget(refused, home)).toThrow(/--install-to/)
    }
    // a symlink into an Applications folder is that folder
    fs.symlinkSync(path.join(home, 'Applications'), path.join(tmp, 'looks-harmless'))
    expect(testTargetProblem(path.join(tmp, 'looks-harmless'), home)).toMatch(/only the default install/)
    expect(testTargetProblem(path.join(tmp, 'looks-harmless', 'deeper'), home)).toMatch(/only the default install/)
    expect(testTargetProblem('relative/dir', home)).toMatch(/absolute/)
    expect(testTargetProblem(path.join(tmp, 'missing'), home)).toMatch(/does not exist/)
    fs.writeFileSync(path.join(tmp, 'file'), '')
    expect(testTargetProblem(path.join(tmp, 'file'), home)).toMatch(/not a folder/)
    fs.mkdirSync(path.join(tmp, 'Some.app', 'Contents'), { recursive: true })
    expect(testTargetProblem(path.join(tmp, 'Some.app', 'Contents'), home)).toMatch(/inside an app bundle/)
  })

  // os-ok: test data
  it('U-PACK-12 · only the plain command installs for use: ad-hoc and perf-probe builds never reach /Applications, and a perf-probe build installs only into a test target', () => {
    const tmp = temp()
    const home = path.join(tmp, 'user')
    const target = path.join(tmp, 'target')
    fs.mkdirSync(target)
    const parse = (...argv: string[]) => parseOptions(argv, { root: '/repo', homedir: home })
    expect(parse()).toMatchObject({ target: { app: installedApp(), test: false }, noRelaunch: false, adhoc: false, perfProbes: false, out: '/repo/dist/pack', versionSuffix: '' })
    expect(parse('--no-relaunch').noRelaunch).toBe(true)
    expect(parse('--no-install').target).toBeNull()
    expect(parse('--adhoc').target).toBeNull()
    expect(parse('--perf-probes').target).toBeNull()
    expect(parse('--perf-probes', '--version-suffix', 'n1', '--out', path.join(tmp, 'out'))).toMatchObject({ target: null, versionSuffix: 'n1', out: path.join(tmp, 'out') })
    // a build with another version (a test's build N+1) is no build for use either
    expect(parse('--version-suffix', 'n1')).toMatchObject({ target: null, versionSuffix: 'n1' })
    expect(parse('--version-suffix', 'n1', '--no-relaunch').target).toBeNull()
    expect(parse('--version-suffix', 'n1', '--install-to', target).target).toEqual({ app: path.join(target, 'Kea.app'), test: true })
    expect(parse('--perf-probes', '--install-to', target).target).toEqual({ app: path.join(target, 'Kea.app'), test: true })
    expect(parse('--install-to', target).target?.test).toBe(true)
    expect(() => parse('--adhoc', '--install-to', target)).toThrow(/never installed/)
    expect(() => parse('--no-install', '--install-to', target)).toThrow(/contradict/)
    expect(() => parse('--install-to', '/Applications')).toThrow(/only the default install/) // os-ok: test data
    expect(() => parse('--install-to')).toThrow(/needs a value/)
    expect(() => parse('--install-to', '--adhoc')).toThrow(/needs a value/)
    expect(() => parse('--out', '/Applications')).toThrow(/Applications folder/) // os-ok: test data
    expect(() => parse('--out', '/Applications/sub')).toThrow(/Applications folder/) // os-ok: test data
    expect(() => parse('--version-suffix', 'a b')).toThrow(/semver/)
    expect(() => parse('--install')).toThrow(/unknown option/)
  })

  // `/applications` and `/System/Volumes/Data/Applications` are /Applications itself (same device and inode, no
  // symlink), so a check that compares names lets them through, and `--out` there would let the build step delete
  // `<out>/Kea.app`. The check compares what a folder is, not its name. The test only stats the real folders.
  it('U-PACK-22 · an Applications folder is refused by what it is, not by how it is spelled: another case, the data volume’s path, a symlink to either, and anything below them, for --install-to and for --out, with --perf-probes and --adhoc too', () => {
    const tmp = temp()
    const home = path.join(tmp, 'user')
    fs.mkdirSync(path.join(home, 'Applications', 'sub'), { recursive: true })
    const parse = (...argv: string[]) => parseOptions(argv, { root: '/repo', homedir: home })
    // the same folders through the data volume (a firmlink: `realpath` keeps the spelling, the inode is the same)
    const data = (p: string) => path.join('/System/Volumes/Data', p) // os-ok: test data
    expect(fs.statSync(data(home), { bigint: true }).ino, 'this Mac has the data volume’s path').toBe(fs.statSync(home, { bigint: true }).ino)
    const spellings = [data('/Applications'), data(path.join(home, 'Applications'))] // os-ok: test data
    // another case names the same folder on a case-insensitive volume (the default); on a case-sensitive one it names nothing
    for (const other of ['/applications', '/APPLICATIONS', path.join(home, 'applications')]) if (fs.existsSync(other)) spellings.push(other)
    expect(spellings.length, 'the startup volume is case-insensitive here, so the other case is tested too').toBeGreaterThan(2)
    for (const [i, apps] of [...spellings].entries()) {
      fs.symlinkSync(apps, path.join(tmp, `link-${i}`))
      spellings.push(path.join(tmp, `link-${i}`))
    }
    for (const apps of spellings) {
      for (const dir of [apps, `${apps}/`, path.join(apps, 'sub'), path.join(apps, 'Kea.app'), path.join(apps, 'not', 'there')]) {
        expect(testTargetProblem(dir, home), dir).toMatch(/only the default install/)
        expect(() => resolveTarget(dir, home), dir).toThrow(/only the default install/)
        expect(() => parse('--install-to', dir), dir).toThrow(/only the default install/)
        expect(() => parse('--perf-probes', '--install-to', dir), dir).toThrow(/only the default install/)
        expect(() => parse('--adhoc', '--install-to', dir), dir).toThrow(/never installed|only the default install/)
        for (const more of [[], ['--no-install'], ['--perf-probes'], ['--adhoc'], ['--install-to', path.join(tmp, 'link-0')]]) {
          expect(() => parse('--out', dir, ...more), `--out ${dir} ${more.join(' ')}`).toThrow(/--out must not be in an Applications folder/)
        }
      }
    }
    // a folder that only looks like one is a folder like any other
    fs.mkdirSync(path.join(tmp, 'Applications'))
    fs.mkdirSync(path.join(tmp, 'target'))
    expect(testTargetProblem(path.join(tmp, 'Applications'), home)).toBeNull()
    // (the system volume's inodes are past 2^53: read as doubles, the inodes of /System/Volumes/Data and
    // /System/Applications compare equal)
    expect(testTargetProblem(data(path.join(tmp, 'target')), home)).toBeNull()
    expect(parse('--perf-probes', '--install-to', path.join(tmp, 'target'), '--out', path.join(tmp, 'out', 'deeper')).target).toEqual({ app: path.join(tmp, 'target', 'Kea.app'), test: true })
  })
})
