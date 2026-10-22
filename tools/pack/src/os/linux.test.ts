// tools/pack's Linux side: the dev build's desktop file, the dev sandbox check and a build's native files (the bundled
// builds on Linux, Kea's patched watcher first).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseExec } from '../../../../app/core/src/editor/desktop.ts'
import { DESKTOP_IDS } from '../../../../packages/protocol/src/platform.ts'
import { appPackageJson } from '../appPackage.ts'
import { darwin } from './darwin.ts'
import { packOs } from './index.ts'
import { devDesktopFile, devSandboxProblem, execArg, linux } from './linux.ts'

const root = path.resolve(import.meta.dirname, '..', '..', '..', '..')

describe("pnpm dev's desktop file and sandbox check", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-desk-'))
    dirs.push(d)
    return d
  }

  // The file goes to the user's applications folder under the dev build's id, never the packaged one; it starts this
  // checkout's dev build, hidden from the app grid. `pnpm dev --remove-desktop-file` removes it and runs nothing; only
  // tools/dev.ts writes it (a test or harness run never does). The dev build's `desktopName` is that id.
  it('U-PLT-19 · the dev desktop file: its place and text under the dev id; --remove-desktop-file deletes it; no test writes it; the dev desktopName', () => {
    const home = '/home/kea'
    const electron = '/src/kea $1/node_modules/electron/dist/electron'
    const f = devDesktopFile({ home, env: {}, root: '/src/kea $1', electron })
    expect(f.path).toBe('/home/kea/.local/share/applications/dev.kea.app.dev.desktop')
    expect(devDesktopFile({ home, env: { XDG_DATA_HOME: '/data' }, root: '/r', electron }).path).toBe('/data/applications/dev.kea.app.dev.desktop')
    expect(devDesktopFile({ home, env: { XDG_DATA_HOME: 'relative' }, root: '/r', electron }).path, 'a relative XDG_DATA_HOME is ignored').toBe('/home/kea/.local/share/applications/dev.kea.app.dev.desktop')
    expect(f.path).not.toContain(`${DESKTOP_IDS.packaged}.desktop`)
    const lines = f.text.split('\n')
    expect(lines[0]).toBe('[Desktop Entry]')
    expect(lines).toContain('Type=Application')
    expect(lines).toContain('NoDisplay=true')
    expect(lines).toContain('StartupWMClass=dev.kea.app.dev')
    expect(lines).toContain('Exec="/src/kea \\\\$1/node_modules/electron/dist/electron" "/src/kea \\\\$1/dist/app"') // both escape steps (U-PLT-57)
    expect(execArg('50%')).toBe('"50%%"')
    // the dev build's app id, window class and desktop file name
    expect(appPackageJson('0.1.0')).toMatchObject({ desktopName: 'dev.kea.app.dev.desktop', productName: 'Kea' })
    expect(DESKTOP_IDS).toEqual({ packaged: 'dev.kea.app', dev: 'dev.kea.app.dev' })
    // macOS needs none
    expect(darwin.devDesktop.file({ home, env: {}, root: '/r', electron })).toBeNull()
    // only `pnpm dev` writes it: no test, harness or other tool asks for the file
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.ts$/.test(e.name) && p !== import.meta.filename && /devDesktop\.file\(|devDesktopFile\(/.test(fs.readFileSync(p, 'utf8'))) callers.push(path.relative(root, p))
      }
    }
    for (const top of ['app', 'packages', 'tools', 'tests']) walk(path.join(root, top))
    expect(callers.sort()).toEqual(['tools/dev.ts', 'tools/pack/src/os/linux.ts'])
    // --remove-desktop-file: removes this system's file (none on macOS) and builds nothing
    const data = tmp()
    const desk = packOs.devDesktop.file({ home: os.homedir(), env: { XDG_DATA_HOME: data }, root, electron: '/e' })
    if (desk) {
      fs.mkdirSync(path.dirname(desk.path), { recursive: true })
      fs.writeFileSync(desk.path, 'old')
    }
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'dev.ts'), '--remove-desktop-file'], { cwd: root, env: { ...process.env, XDG_DATA_HOME: data }, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(desk ? /^removed / : /needs no desktop file/)
    if (desk) expect(fs.existsSync(desk.path)).toBe(false)
    expect(r.stdout, 'nothing was built').not.toMatch(/^built /m)
  })

  // The Desktop Entry spec reads `Exec` in two steps: the string type's escapes first (`\s`, `\n`, `\t`, `\r`, `\\`;
  // GLib refuses any other and drops the value), then Exec's quoting. So a `$`, `"`, `` ` `` or `\` in a path takes
  // both: `\\$`, `\\"`, `` \\` `` and four backslashes. A file with Exec's quoting alone passes a lenient reader,
  // such as core's, but not GNOME's.
  it('U-PLT-57 · the dev desktop file’s Exec reads back as the two paths through both escape steps, for a checkout whose path holds $, ", `, \\, % and a space', () => {
    /** The string type as GLib reads it: an escape it does not know is an error. */
    const strictString = (v: string) =>
      v.replace(/\\(.)/g, (_m, c: string) => {
        const out = { s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' }[c]
        if (out === undefined) throw new Error(`invalid escape \\${c} in ${v}`)
        return out
      })
    for (const root of ['/a/$b', '/src/kea "x"', '/w/`q`', '/back\\slash', '/50% off', '/plain']) {
      const electron = `${root}/node_modules/electron/dist/electron`
      const exec = devDesktopFile({ home: '/home/kea', env: {}, root, electron }).text.split('\n').find((l) => l.startsWith('Exec='))!.slice('Exec='.length)
      expect(parseExec(strictString(exec)), root).toEqual([electron, path.join(root, 'dist', 'app')])
    }
    expect(execArg('/a/$b')).toBe('"/a/\\\\$b"')
    expect(execArg('a"b`c\\d')).toBe('"a\\\\"b\\\\`c\\\\\\\\d"')
  })

  // The sandbox check for a dev build: user namespaces Electron may make, or npm's chrome-sandbox set-uid root; else
  // the fix.
  it('U-PLT-36 · the dev sandbox check: user namespaces, or chrome-sandbox root-owned 4755; else the chown and chmod to run', () => {
    const electron = '/n/electron/dist/electron'
    const read = (restricted: number | null, clone: number | null) => (f: string) => (f.endsWith('apparmor_restrict_unprivileged_userns') ? restricted : clone)
    const stat = (uid: number, mode: number) => () => ({ uid, mode }) as fs.Stats
    expect(devSandboxProblem(electron, read(0, null), () => null)).toBeNull()
    expect(devSandboxProblem(electron, read(null, 1), () => null)).toBeNull()
    expect(devSandboxProblem(electron, read(1, null), stat(0, 0o104755))).toBeNull()
    const fix = devSandboxProblem(electron, read(1, null), stat(501, 0o100755))
    expect(fix).toContain('sudo chown root:root /n/electron/dist/chrome-sandbox')
    expect(fix).toContain('sudo chmod 4755 /n/electron/dist/chrome-sandbox')
    expect(fix).toContain('never runs with --no-sandbox')
    expect(devSandboxProblem(electron, read(null, 0), stat(0, 0o100755)), "Debian's switch off and no set-uid helper").not.toBeNull()
    expect(darwin.devDesktop.sandboxProblem(electron)).toBeNull()
    // the launcher of the packages does the same before Chromium starts: it never passes --no-sandbox
    const launcher = fs.readFileSync(path.join(import.meta.dirname, 'kea-app.sh'), 'utf8')
    expect(launcher).toContain('unshare --user true')
    expect(launcher).toContain("stat -c '%u %a'")
    expect(launcher.split('\n').filter((l) => !l.trimStart().startsWith('#') && l.includes('--no-sandbox') && !l.includes('never runs with'))).toEqual([])
    // a build's native files on Linux: the glibc prebuilds, and Kea's patched watcher where pnpm built it
    const addons = linux.nativeAddons as Exclude<typeof linux.nativeAddons, { available: false }>
    expect([addons.sqlitePrebuild('arm64'), addons.watcherPackage('x64'), addons.watcherPatchedBuild]).toEqual(['prebuilds/linux-arm64.node', '@parcel/watcher-linux-x64-glibc', path.join('build', 'Release', 'watcher.node')])
  })
})
