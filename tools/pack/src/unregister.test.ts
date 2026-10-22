import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isAvailable } from '../../../packages/protocol/src/platform.ts'
import { packOs } from './os/index.ts'
import { lsregister, registeredApps, runFolderOf, unregisterGiven, unregisterOwnApp, unregisterProblem, type OwnPlaces } from './unregister.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
function temp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-unregister-')))
  dirs.push(d)
  return d
}

// LaunchServices and `pnpm kea:install` are macOS's (Linux installs from packages): a named skip on Linux
describe.runIf(isAvailable(packOs.installPlace))('unregistering a test build from LaunchServices (tools/pack/src/unregister.ts)', () => {
  // os-ok: test data
  it('U-PACK-25 · a harness may unregister only an app inside a folder its run made, under a temp folder or dist/test-app-*: never /Applications/Kea.app under any spelling, never dist/pack/Kea.app, never an app of another run, never through a symlink or `..` that leads out; a path that is gone is judged the same', () => {
    const tmp = fs.realpathSync(os.tmpdir())
    const repo = '/x/kea'
    const places: OwnPlaces = { tmp: [tmp, '/private/tmp'], repoRoot: repo, homedir: '/x/home' }
    const ok = (app: string, made: string) => expect(unregisterProblem(app, made, places), `${app} of ${made}`).toBeNull()
    const no = (app: string, made: string, why: RegExp) => expect(unregisterProblem(app, made, places), `${app} of ${made}`).toMatch(why)

    // ── a run's own: a folder it made in a temp folder (there or gone), or the suites' build folder
    const made = temp()
    fs.mkdirSync(path.join(made, 'target', 'Kea.app'), { recursive: true })
    ok(path.join(made, 'target', 'Kea.app'), made)
    ok(path.join(made, 'build-n', 'Kea.app'), made) // not there (yet, or any more)
    const gone = path.join(tmp, 'kea-test-app-abc123-upd-work-Zz9Zz9')
    ok(path.join(gone, 'target', 'Kea.app'), gone)
    ok('/private/tmp/kea-run-1/pack/Kea.app', '/private/tmp/kea-run-1')
    ok('/tmp/kea-run-1/pack/Kea.app', '/tmp/kea-run-1') // /tmp is /private/tmp
    ok(`${repo}/dist/test-app-abc123/Kea.app`, `${repo}/dist/test-app-abc123`)
    ok(`${repo}/dist/test-app-abc123-n1/out/Kea.app`, `${repo}/dist/test-app-abc123-n1`)

    // ── the installed app and the repo's own build, whatever the run says it made
    // os-ok: test data
    for (const app of ['/Applications/Kea.app', '/applications/Kea.app', '/System/Volumes/Data/Applications/Kea.app', '/Applications/Utilities/Kea.app', '/x/home/Applications/Kea.app']) {
      for (const m of ['/Applications', '/', tmp, path.dirname(app), made]) no(app, m, /./) // os-ok: test data
    }
    no('/Applications/Kea.app', '/Applications', /Applications/) // os-ok: test data
    for (const m of [`${repo}/dist/pack`, `${repo}/dist`, repo, made]) no(`${repo}/dist/pack/Kea.app`, m, /./)
    no(`${repo}/dist/pack/Kea.app`, `${repo}/dist/pack`, /not a folder a test run makes/)
    no(`${repo}/dist/s7/n/Kea.app`, `${repo}/dist/s7`, /not a folder a test run makes/)
    no(`${repo}/dist/test-app-/Kea.app`, `${repo}/dist/test-app-`, /not a folder a test run makes/)
    no(`${repo}/dist/test-app-abc/../pack/Kea.app`, `${repo}/dist/test-app-abc`, /written out in full/)
    no('/y/other/dist/test-app-abc/Kea.app', '/y/other/dist/test-app-abc', /not a folder a test run makes/)

    // ── the folder must be the run's own, and the app inside it
    no(path.join(tmp, 'Kea.app'), tmp, /not a folder a test run makes/) // the temp folder itself is nobody's
    no('/private/tmp/Kea.app', '/private/tmp', /not a folder a test run makes/)
    no(path.join(made, 'target', 'Kea.app'), '/', /not a folder a test run makes/)
    const other = temp()
    no(path.join(other, 'target', 'Kea.app'), made, /not inside/)
    no(path.join(made, '..', path.basename(other), 'target', 'Kea.app'), made, /not inside/)
    no(path.join(made, 'target', 'Kea.app'), path.join(made, 'target', 'Kea.app'), /not inside/) // the folder made is not the app
    no(path.join(made, 'target', 'Kea'), made, /not an app bundle/)
    no('target/Kea.app', made, /absolute/)
    no(path.join(made, 'target', 'Kea.app'), 'relative', /absolute/)

    // ── a symlink that leads out of the run's folder: judged by where it leads
    fs.symlinkSync('/Applications', path.join(made, 'apps')) // os-ok: test data
    no(path.join(made, 'apps', 'Kea.app'), made, /./)
    fs.symlinkSync(other, path.join(made, 'elsewhere'))
    no(path.join(made, 'elsewhere', 'Kea.app'), made, /not inside/)
    const link = path.join(temp(), 'link')
    fs.symlinkSync('/Applications', link) // os-ok: test data
    no(path.join(link, 'Kea.app'), link, /./)

    // ── `..` after a link: the OS reads it from where the link leads (here the other run's folder), whatever the
    // text says. What is judged is what is handed on, so a path is taken only written out in full
    fs.mkdirSync(path.join(other, 'deep'))
    fs.symlinkSync(path.join(other, 'deep'), path.join(made, 'into'))
    expect(fs.realpathSync.native(`${made}/into/..`)).toBe(other) // the OS's reading; Node's own realpath takes `..` out first
    no(`${made}/into/../Kea.app`, made, /written out in full/)
    no(`${made}/target/./Kea.app`, made, /written out in full/)
    no(`${made}/target/Kea.app/`, made, /written out in full/)
    no(path.join(made, 'target', 'Kea.app'), `${made}/into/..`, /written out in full/)
    const calls: string[][] = []
    expect(unregisterOwnApp(`${made}/into/../Kea.app`, made, { exec: (_f, args) => (calls.push(args), ''), places })).toMatchObject({ done: false })
    expect(calls).toEqual([])

    // ── the repo's own builds stay the person's even when the whole repo lies in a temp folder
    const inTemp: OwnPlaces = { tmp: [tmp], repoRoot: path.join(made, 'kea'), homedir: '/x/home' }
    expect(unregisterProblem(path.join(made, 'kea', 'dist', 'pack', 'Kea.app'), made, inTemp)).toMatch(/the repository’s own build/)
    expect(unregisterProblem(path.join(made, 'kea', 'dist', 's7', 'n', 'Kea.app'), made, inTemp)).toMatch(/the repository’s own build/)
    expect(unregisterProblem(path.join(made, 'kea', 'dist', 'test-app-abc', 'Kea.app'), path.join(made, 'kea', 'dist', 'test-app-abc'), inTemp)).toBeNull()

    // ── an app a harness was handed (the survival check's `--app`): the run folder it lies in, when it lies in one
    const folder = (app: string) => runFolderOf(app, places)
    expect(folder(path.join(made, 'target', 'Kea.app'))).toBe(made)
    expect(folder(path.join(gone, 'a', 'b', 'Kea.app'))).toBe(gone)
    expect(folder('/tmp/kea-run-1/pack/Kea.app')).toBe('/private/tmp/kea-run-1')
    expect(folder(`${repo}/dist/test-app-abc123/out/Kea.app`)).toBe(`${repo}/dist/test-app-abc123`)
    // os-ok: test data
    for (const app of [path.join(tmp, 'Kea.app'), `${repo}/dist/s7/n/Kea.app`, `${repo}/dist/pack/Kea.app`, '/Applications/Kea.app', '/x/home/Applications/Kea.app', path.join(made, 'apps', 'Kea.app'), path.join(link, 'Kea.app'), 'target/Kea.app', path.join(made, 'target', 'Kea')]) {
      expect(folder(app), app).toBeNull()
    }
    // and what it names always passes the rule
    for (const app of [path.join(made, 'target', 'Kea.app'), path.join(gone, 'a', 'b', 'Kea.app'), `${repo}/dist/test-app-abc123/out/Kea.app`]) ok(app, folder(app) as string)
  })

  it('U-PACK-26 · unregistering runs `lsregister -u <path>` and nothing else, only for a path the rule allows; a refused path runs nothing and says why; a failed run is told, not thrown; the registered paths of a bundle id are read from a dump, with the ones that are gone marked', () => {
    const made = temp()
    const app = path.join(made, 'target', 'Kea.app')
    const calls: [string, string[]][] = []
    const exec = (file: string, args: string[]): string => {
      calls.push([file, args])
      return ''
    }
    expect(unregisterOwnApp(app, made, { exec })).toEqual({ done: true, app })
    expect(calls).toEqual([[lsregister(), ['-u', app]]])
    expect(lsregister()).toBe('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister') // os-ok: macOS's answer from the OS layer (os/darwin.ts)

    calls.length = 0
    // os-ok: test data
    for (const [a, m] of [['/Applications/Kea.app', '/Applications'], [path.join(path.dirname(made), 'Kea.app'), path.dirname(made)], [app, path.join(made, 'target', 'Kea.app')]] as const) {
      const r = unregisterOwnApp(a, m, { exec })
      expect(r.done, a).toBe(false)
      expect(r.done === false && r.why).toMatch(/\S/)
    }
    expect(calls, 'nothing ran for a refused path').toEqual([])

    const failing = (): string => {
      throw new Error('lsregister: exit 1')
    }
    expect(unregisterOwnApp(app, made, { exec: failing })).toEqual({ done: false, app, why: 'lsregister: exit 1' })

    // a harness handed its builds (the survival check): one in a run folder is unregistered, any other is left with the
    // line that says how
    calls.length = 0
    const places: OwnPlaces = { tmp: [fs.realpathSync(os.tmpdir())], repoRoot: '/x/kea', homedir: '/x/home' }
    expect(unregisterGiven([app, null, '/x/kea/dist/s7/n/Kea.app', '/Applications/Kea.app'], { exec, places })).toEqual([ // os-ok: test data
      `LaunchServices: ${app} unregistered (a test build is not left known to macOS as Kea)`,
      `LaunchServices: /x/kea/dist/s7/n/Kea.app stays registered with macOS as Kea. Once you have deleted it: ${lsregister()} -u /x/kea/dist/s7/n/Kea.app`,
    ]) // and no line for the installed app: it is meant to be registered
    expect(calls).toEqual([[lsregister(), ['-u', app]]])

    // what `lsregister -dump` prints, cut to the lines read (made-up paths)
    const dump = [
      'Checking data integrity......done.',
      'Status: Database is seeded.',
      '-'.repeat(80),
      'bundle id:                  Kea (0x1b90)',
      'Bundle node not found on disk: Error Domain=NSOSStatusErrorDomain Code=-43 "fnfErr: File not found"',
      'path:                       /private/tmp/run 1/target/Kea.app (0x34b0)',
      'name:                       Kea',
      'identifier:                 dev.kea.app',
      'reg date:                   2026-10-13 18:26 (POSIX 1791933968)',
      '-'.repeat(80),
      'bundle id:                  Kea (0x1c00)',
      'path:                       /Applications/Kea.app (0x40)', // os-ok: test data
      'identifier:                 dev.kea.app',
      '-'.repeat(80),
      'bundle id:                  Other (0x1c04)',
      'path:                       /Applications/Other.app (0x44)', // os-ok: test data
      'identifier:                 dev.kea.application',
      '-'.repeat(80),
      'claim id:                   Kea file (0x99)',
      'bindings:                   dev.kea.app',
      'identifier:                 dev.kea.app',
      '-'.repeat(80),
      'bundle id:                  Kea Helper (0x1c08)',
      'path:                       /Applications/Kea.app/Contents/Frameworks/Kea Helper.app (0x48)', // os-ok: test data
      'identifier:                 dev.kea.app.helper',
      '',
    ].join('\n')
    expect(registeredApps(dump, 'dev.kea.app')).toEqual([
      { path: '/private/tmp/run 1/target/Kea.app', missing: true },
      { path: '/Applications/Kea.app', missing: false }, // os-ok: test data
    ])
    expect(registeredApps(dump, 'dev.kea.none')).toEqual([])
    expect(registeredApps('', 'dev.kea.app')).toEqual([])
  })
})
