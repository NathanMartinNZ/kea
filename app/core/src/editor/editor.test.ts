import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { noopLogger } from '@kea/kit'
import { L, need, SETTINGS, TERMINAL_APPS, type TerminalAppChoice } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { editorUrl, launchPlan, positionSafe, terminalAppArgv, type LaunchTarget } from './argv.ts'
import { defaultEditor, EDITOR_DEFS, editorDef, LINUX_TERMINAL_APP_DEFS, TERMINAL_APP_DEFS, terminalAppFor, type EditorDef } from './catalog.ts'
import { Editors, mdfindArgs, parseMdfind } from './editors.ts'
import { PathChecks, type PathFs } from './paths.ts'
import { coreOs } from '../os/index.ts'

const OPEN = '/usr/bin/open' // os-ok: test data
const def = (id: string): EditorDef => editorDef(id) as EditorDef
const at = (file: string | null, line: number | null = null, col: number | null = null): LaunchTarget => ({ dir: '/w/tree', file, line, col })

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('open in editor: argv', () => {
  it('U-ED-1 · the argv per editor and strategy: a folder, a file, a file at a position; every path is one argument; odd names (spaces, unicode, a:1)', () => {
    // the VS Code family: the bundled CLI with the worktree first (the file opens in that window), then `open -a` with
    // the bundle and the path, then the same with the URL
    for (const id of ['vscode', 'vscode-insiders', 'cursor', 'windsurf']) {
      const d = def(id)
      const bundle = `/Applications/${d.appName}` // os-ok: test data
      const cli = `${bundle}/${d.cli}`
      expect(launchPlan(d, { bundle, cli, open: OPEN }, at(null)), id).toEqual([
        { strategy: 'cli', file: cli, args: ['/w/tree'] },
        { strategy: 'bundle', file: OPEN, args: ['-a', bundle, '/w/tree'] },
        { strategy: 'url', file: OPEN, args: ['-a', bundle, `${d.scheme}://file/w/tree`] },
      ])
      expect(launchPlan(d, { bundle, cli, open: OPEN }, at('/w/tree/src/auth/login.ts', 42, 7)), id).toEqual([
        { strategy: 'cli', file: cli, args: ['/w/tree', '--goto', '/w/tree/src/auth/login.ts:42:7'] },
        { strategy: 'bundle', file: OPEN, args: ['-a', bundle, '/w/tree/src/auth/login.ts'] },
        { strategy: 'url', file: OPEN, args: ['-a', bundle, `${d.scheme}://file/w/tree/src/auth/login.ts:42:7`] },
      ])
    }
    const code = def('vscode')
    const bundle = '/Applications/Visual Studio Code.app' // os-ok: test data
    const cli = `${bundle}/Contents/Resources/app/bin/code`
    expect(code.cli).toBe('Contents/Resources/app/bin/code')
    // a file with no position is not parsed for one; a line with no column lands on column 1
    expect(launchPlan(code, { bundle, cli, open: OPEN }, at('/w/tree/a.ts'))[0]).toEqual({ strategy: 'cli', file: cli, args: ['/w/tree', '/w/tree/a.ts'] })
    expect(launchPlan(code, { bundle, cli, open: OPEN }, at('/w/tree/a.ts', 9))[0]?.args).toEqual(['/w/tree', '--goto', '/w/tree/a.ts:9:1'])
    expect(launchPlan(code, { bundle, cli, open: OPEN }, at('/w/tree/a.ts', 9)).at(-1)?.args).toEqual(['-a', bundle, 'vscode://file/w/tree/a.ts:9'])
    // no CLI in the bundle: strategy 1 is skipped
    expect(launchPlan(code, { bundle, cli: null, open: OPEN }, at(null)).map((a) => a.strategy)).toEqual(['bundle', 'url'])

    // Zed: its own CLI, the position as the file argument's suffix
    const zed = def('zed')
    const zbundle = '/Applications/Zed.app' // os-ok: test data
    const zcli = `${zbundle}/Contents/MacOS/cli`
    expect(launchPlan(zed, { bundle: zbundle, cli: zcli, open: OPEN }, at('/w/tree/src/a.rs', 3, 2))).toEqual([
      { strategy: 'cli', file: zcli, args: ['/w/tree', '/w/tree/src/a.rs:3:2'] },
      { strategy: 'bundle', file: OPEN, args: ['-a', zbundle, '/w/tree/src/a.rs'] },
      { strategy: 'url', file: OPEN, args: ['-a', zbundle, 'zed://file/w/tree/src/a.rs:3:2'] },
    ])
    expect(launchPlan(zed, { bundle: zbundle, cli: zcli, open: OPEN }, at(null))[0]?.args).toEqual(['/w/tree'])

    // spaces and unicode stay inside one argument; the URL encodes them
    const odd = '/w/tree/my notes/naïve café — 日本.md'
    const plan = launchPlan(code, { bundle, cli, open: OPEN }, { dir: '/w/my tree', file: odd, line: 1, col: 1 })
    expect(plan[0]?.args).toEqual(['/w/my tree', '--goto', `${odd}:1:1`])
    expect(plan[1]?.args).toEqual(['-a', bundle, odd])
    expect(plan[2]?.args).toEqual(['-a', bundle, `vscode://file/w/tree/my%20notes/na%C3%AFve%20caf%C3%A9%20%E2%80%94%20%E6%97%A5%E6%9C%AC.md:1:1`])
    expect(editorUrl('vscode', '/a/b#c?d.ts', null, null)).toBe('vscode://file/a/b%23c%3Fd.ts')

    // A name a position parser would misread goes through `open -a <bundle>` alone, with or without a position
    for (const name of ['a:1', 'a:1:2', 'x:12.ts:3', 'log::x', '2024:10:11.txt']) {
      expect(positionSafe(`/w/tree/${name}`), name).toBe(false)
      for (const d of EDITOR_DEFS) {
        expect(launchPlan(d, { bundle: '/x', cli: '/x/cli', open: OPEN }, at(`/w/tree/${name}`, 5, 1)), `${d.id} ${name}`).toEqual([{ strategy: 'bundle', file: OPEN, args: ['-a', '/x', `/w/tree/${name}`] }])
        expect(launchPlan(d, { bundle: '/x', cli: '/x/cli', open: OPEN }, at(`/w/tree/${name}`)), `${d.id} ${name}`).toEqual([{ strategy: 'bundle', file: OPEN, args: ['-a', '/x', `/w/tree/${name}`] }])
      }
    }
    // a colon that no parser reads as a number is an ordinary character
    for (const name of ['a:b.ts', 'C:x', 'time:now.md']) expect(positionSafe(`/w/tree/${name}`), name).toBe(true)
    expect(launchPlan(code, { bundle, cli, open: OPEN }, at('/w/tree/a:b.ts', 2, 3))[0]?.args).toEqual(['/w/tree', '--goto', '/w/tree/a:b.ts:2:3'])
    // a folder whose own name reads as a position: the CLI takes it as it is (no --goto), and no URL is tried
    expect(launchPlan(code, { bundle, cli, open: OPEN }, { dir: '/w/v:2', file: null, line: null, col: null })).toEqual([
      { strategy: 'cli', file: cli, args: ['/w/v:2'] },
      { strategy: 'bundle', file: OPEN, args: ['-a', bundle, '/w/v:2'] },
    ])

    // The terminal app, by its bundle
    // os-ok: test data
    expect(terminalAppArgv(OPEN, '/Applications/Ghostty.app', '/w/my tree')).toEqual({ file: OPEN, args: ['-a', '/Applications/Ghostty.app', '/w/my tree'] })
  })

  it('U-ED-6 · every launch names the app by the path of the bundle detection accepted: its bundled CLI, or `open -a <that bundle>` for a path and for the editor’s URL; nothing is launched by bundle id or left to the handler of a URL scheme, which the system may answer with another bundle of the same id (one inside a repository)', () => {
    const targets: LaunchTarget[] = [
      at(null),
      at('/w/tree/src/a.ts'),
      at('/w/tree/src/a.ts', 42, 7),
      at('/w/tree/a:1'), // `open` alone
      at('/w/tree/a:1', 3, 1),
      { dir: '/w/v:2', file: null, line: null, col: null },
    ]
    for (const d of EDITOR_DEFS) {
      const bundle = `/Applications/Tools/${d.appName}` // os-ok: test data
      const cli = `${bundle}/${d.cli}`
      for (const withCli of [true, false]) {
        for (const t of targets) {
          const plan = launchPlan(d, { bundle, cli: withCli ? cli : null, open: OPEN }, t)
          const label = `${d.id} ${JSON.stringify(t)} cli=${withCli}`
          expect(plan.length, label).toBeGreaterThan(0)
          for (const a of plan) {
            if (a.strategy === 'cli') expect(a.file, label).toBe(cli)
            else {
              expect(a.file, label).toBe(OPEN)
              // `open -a <bundle> <one path or URL>`: the app is the bundle at that path, whatever else has its id or scheme
              expect(a.args.slice(0, 2), label).toEqual(['-a', bundle])
              expect(a.args, label).toHaveLength(3)
            }
            expect(a.args, label).not.toContain('-b')
            expect(a.args, label).not.toContain(d.bundleId)
          }
          // a name a position parser would misread is still opened as a path alone
          if (t.file?.endsWith('a:1')) expect(plan, label).toEqual([{ strategy: 'bundle', file: OPEN, args: ['-a', bundle, t.file] }])
        }
      }
      // the URL goes to that bundle too, with its position
      expect(launchPlan(d, { bundle, cli: null, open: OPEN }, at('/w/tree/src/a.ts', 42, 7)).at(-1), d.id).toEqual({ strategy: 'url', file: OPEN, args: ['-a', bundle, `${d.scheme}://file/w/tree/src/a.ts:42:7`] })
    }
  })

  it('U-ED-3 · the default editor is the setting when installed; with the setting untouched and VS Code absent, the first one found; a chosen editor that is absent is none. Spotlight’s answer is read per bundle id', () => {
    expect(defaultEditor('vscode', ['vscode', 'cursor'], 'vscode')).toBe('vscode')
    expect(defaultEditor('cursor', ['vscode', 'cursor'], 'vscode')).toBe('cursor')
    // Only Cursor installed
    expect(defaultEditor('vscode', ['cursor'], 'vscode')).toBe('cursor')
    expect(defaultEditor('vscode', ['windsurf', 'zed'], 'vscode')).toBe('windsurf')
    // The person chose Zed, and Zed is not here
    expect(defaultEditor('zed', ['vscode', 'cursor'], 'vscode')).toBeNull()
    expect(defaultEditor('vscode', [], 'vscode')).toBeNull()

    const args = mdfindArgs([def('vscode'), def('zed')])
    expect(args).toEqual(['-attr', 'kMDItemCFBundleIdentifier', "kMDItemCFBundleIdentifier == 'com.microsoft.VSCode' || kMDItemCFBundleIdentifier == 'dev.zed.Zed'"])
    const out = [
      '/Applications/Visual Studio Code.app   kMDItemCFBundleIdentifier = com.microsoft.VSCode', // os-ok: test data
      '/Volumes/Backup/Visual Studio Code.app   kMDItemCFBundleIdentifier = com.microsoft.VSCode',
      '/Users/someone/Apps/My   kMDItemCFBundleIdentifier = odd.app   kMDItemCFBundleIdentifier = dev.zed.Zed',
      'relative/Thing.app   kMDItemCFBundleIdentifier = x.y',
      '/Applications/NotAnApp   kMDItemCFBundleIdentifier = x.z', // os-ok: test data
      'garbage',
      '',
    ].join('\n')
    expect([...parseMdfind(out)]).toEqual([
      ['com.microsoft.VSCode', ['/Applications/Visual Studio Code.app', '/Volumes/Backup/Visual Studio Code.app']], // os-ok: test data
      ['dev.zed.Zed', ['/Users/someone/Apps/My   kMDItemCFBundleIdentifier = odd.app']],
    ])
  })
})

/** An app bundle folder with an executable at `cli` inside. */
function bundleAt(dir: string, cli: string | null): string {
  fs.mkdirSync(dir, { recursive: true })
  if (cli !== null) {
    fs.mkdirSync(path.dirname(path.join(dir, cli)), { recursive: true })
    fs.writeFileSync(path.join(dir, cli), '#!/bin/sh\n', { mode: 0o755 })
  }
  return dir
}

/** Editors over stand-ins: `spotlight` is what the lookup tool answers (bundle → id); every launch is recorded, none is run. */
function editorsWith(o: { appDirs: string[]; spotlight: [string, string][]; cwd: string; projects: string[]; sessions: string[]; terminalApp?: () => TerminalAppChoice; lookups?: { n: number } }) {
  const ran: { file: string; args: string[] }[] = []
  const done = { code: 0, signal: null, stderr: '', timedOut: false, truncated: false, cancelled: false, stdoutBytes: 0 }
  const run = (async (file: string, args: string[]) => {
    if (file === '/fake/mdfind' && o.lookups) o.lookups.n++
    if (file === '/fake/mdfind') return { ...done, stdout: Buffer.from(o.spotlight.map(([p, id]) => `${p}   kMDItemCFBundleIdentifier = ${id}\n`).join('')) }
    ran.push({ file, args })
    return { ...done, stdout: Buffer.alloc(0) }
  }) as never
  const ed = new Editors({ log: noopLogger, host: { kind: 'bundles', appDirs: o.appDirs, mdfind: '/fake/mdfind', open: '/fake/open', gh: () => null }, env: async () => ({}), run })
  const sessions = [o.cwd, ...o.sessions].map((cwd, i) => ({ id: `s${i}`, cwd }))
  ed.bind({
    sessions: { store: { get: (id: string) => sessions.find((x) => x.id === id), values: () => sessions.values() } } as never,
    projects: { get: () => undefined, list: () => o.projects.map((rootPath) => ({ rootPath })) } as never,
    configured: () => 'vscode',
    ...(o.terminalApp ? { terminalApp: o.terminalApp } : {}),
  })
  return { ed, ran }
}

describe('open in editor: where an editor may be found', () => {
  it('U-ED-5 · an editor or terminal app is used only from an application folder: a bundle Spotlight lists inside a cloned repository, a worktree or anywhere else is not listed, never the default and never run; inside an application folder a bundle within a project’s root, or a link there that leads into one, is refused too; a link there to a bundle elsewhere, and a bundle in a subfolder, are used', async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-editors-where-')))
    dirs.push(tmp)
    const CLI = 'Contents/Resources/app/bin'
    const id = (e: string) => def(e).bundleId
    const apps = path.join(tmp, 'Applications')
    const repo = path.join(tmp, 'Developer', 'cloned-repo')
    const worktree = path.join(tmp, 'worktrees', 'demo', 's1')
    // only Cursor is installed; the repository carries "VS Code" and a terminal app
    const cursor = bundleAt(path.join(apps, 'Cursor.app'), `${CLI}/cursor`)
    const repoCode = bundleAt(path.join(repo, 'tools', 'Visual Studio Code.app'), `${CLI}/code`)
    const repoGhostty = bundleAt(path.join(repo, 'tools', 'Ghostty.app'), null)
    const worktreeZed = bundleAt(path.join(worktree, 'Zed.app'), 'Contents/MacOS/cli')
    const downloads = bundleAt(path.join(tmp, 'Downloads', 'Windsurf.app'), `${CLI}/windsurf`)
    {
      const { ed, ran } = editorsWith({
        appDirs: [apps],
        spotlight: [[repoCode, id('vscode')], [cursor, id('cursor')], [repoGhostty, 'com.mitchellh.ghostty'], [worktreeZed, id('zed')], [downloads, id('windsurf')]],
        cwd: repo,
        projects: [repo],
        sessions: [worktree],
      })
      expect(await ed.list(true)).toMatchObject({ editors: [{ id: 'cursor', name: 'Cursor' }], default: 'cursor', terminalApp: null })
      // the default is Cursor, from the applications folder
      expect(await ed.open({ target: 'session', id: 's0' })).toEqual({ ok: true, editor: 'cursor', reason: null, message: null })
      expect(ran).toEqual([{ file: path.join(cursor, `${CLI}/cursor`), args: [repo] }])
      // asked for by name, the repository's "VS Code" is not installed; nor is its terminal app
      for (const editor of ['vscode', 'zed', 'windsurf'] as const) expect(await ed.open({ target: 'session', id: 's0', editor })).toEqual({ ok: false, editor, reason: 'unavailable', message: null })
      expect(await ed.openTerminalApp('session', 's0')).toEqual({ ok: false, reason: 'unavailable', message: null })
      expect(ran, 'nothing of the repository, the worktree or the downloads was run').toHaveLength(1)
      ed.dispose()
    }

    // inside an application folder, but inside a project too (a project kept under it; a link that leads into one)
    const site = path.join(apps, 'MAMP', 'htdocs', 'site')
    const siteInsiders = bundleAt(path.join(site, 'tools', 'Visual Studio Code - Insiders.app'), `${CLI}/code`)
    const repoWindsurf = bundleAt(path.join(repo, 'tools', 'Windsurf.app'), `${CLI}/windsurf`)
    fs.symlinkSync(repoWindsurf, path.join(apps, 'Windsurf.app'))
    fs.symlinkSync(repoCode, path.join(apps, 'Visual Studio Code.app'))
    // a link in the application folder to a bundle kept elsewhere (a package manager's store), and a bundle in a subfolder
    const stored = bundleAt(path.join(tmp, 'store', 'abc-zed', 'Zed.app'), 'Contents/MacOS/cli')
    fs.symlinkSync(stored, path.join(apps, 'Zed.app'))
    const iterm = bundleAt(path.join(apps, 'Tools', 'iTerm.app'), null)
    // and a link elsewhere that leads to the application folder's own bundle (Homebrew's Caskroom keeps one)
    fs.mkdirSync(path.join(tmp, 'Caskroom', 'cursor', '1.0'), { recursive: true })
    const caskLink = path.join(tmp, 'Caskroom', 'cursor', '1.0', 'Cursor.app')
    fs.symlinkSync(cursor, caskLink)
    {
      const { ed, ran } = editorsWith({
        appDirs: [apps],
        spotlight: [[siteInsiders, id('vscode-insiders')], [path.join(apps, 'Windsurf.app'), id('windsurf')], [repoWindsurf, id('windsurf')], [stored, id('zed')], [caskLink, id('cursor')], [iterm, 'com.googlecode.iterm2'], [repoGhostty, 'com.mitchellh.ghostty']],
        cwd: repo,
        projects: [repo, site],
        sessions: [],
      })
      const list = await ed.list(true)
      expect(list.editors.map((e) => e.id)).toEqual(['cursor', 'zed'])
      expect(list.terminalApp).toEqual({ name: 'iTerm' })
      for (const editor of ['vscode', 'vscode-insiders', 'windsurf'] as const) expect(await ed.open({ target: 'session', id: 's0', editor })).toEqual({ ok: false, editor, reason: 'unavailable', message: null })
      expect((await ed.open({ target: 'session', id: 's0', editor: 'zed' })).ok).toBe(true)
      expect((await ed.open({ target: 'session', id: 's0', editor: 'cursor' })).ok).toBe(true)
      expect((await ed.openTerminalApp('session', 's0')).ok).toBe(true)
      expect(ran).toEqual([
        { file: path.join(apps, 'Zed.app', 'Contents/MacOS/cli'), args: [repo] },
        { file: path.join(cursor, `${CLI}/cursor`), args: [repo] },
        { file: '/fake/open', args: ['-a', iterm, repo] },
      ])
      ed.dispose()
    }
  })
})

describe('paths printed in a terminal', () => {
  it('U-TERM-25 · a printed path or file: URL is a link only when it is a file inside the session’s worktree: traversal, an absolute path elsewhere, another host’s URL and a symlink that leads out are refused', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-links-')))
    dirs.push(base)
    const wt = path.join(base, 'wt')
    const home = path.join(base, 'home')
    fs.mkdirSync(path.join(wt, 'src', 'my dir'), { recursive: true })
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'a')
    fs.writeFileSync(path.join(wt, 'src', 'my dir', 'b c.ts'), 'b')
    fs.writeFileSync(path.join(wt, 'a:1'), 'odd')
    fs.writeFileSync(path.join(base, 'secret.txt'), 'outside')
    fs.writeFileSync(path.join(home, 'notes.md'), 'home')
    fs.symlinkSync(path.join(wt, 'src', 'a.ts'), path.join(wt, 'inside-link.ts'))
    fs.symlinkSync(path.join(base, 'secret.txt'), path.join(wt, 'escape.txt'))
    fs.symlinkSync(base, path.join(wt, 'up'))
    // the worktree named through a link, as `/tmp` names `/private/tmp`
    fs.symlinkSync(wt, path.join(base, 'alias'))

    const url = (p: string) => `file://${p.split('/').map(encodeURIComponent).join('/')}`
    const checks = new PathChecks()
    const resolveLinks = (cwd: string, candidates: string[], h: string) => checks.resolveLinks(cwd, candidates, h)
    const ask = async (c: string, cwd = wt) => (await resolveLinks(cwd, [c], home))[0]

    // inside: relative, absolute, a file: URL (this machine's, with or without `localhost`), a link that stays inside
    expect(await ask('src/a.ts')).toBe('src/a.ts')
    expect(await ask('./src/a.ts')).toBe('src/a.ts')
    expect(await ask('src/../src/a.ts')).toBe('src/a.ts')
    expect(await ask(path.join(wt, 'src', 'a.ts'))).toBe('src/a.ts')
    expect(await ask(url(path.join(wt, 'src', 'a.ts')))).toBe('src/a.ts')
    expect(await ask(url(path.join(wt, 'src', 'my dir', 'b c.ts')))).toBe('src/my dir/b c.ts')
    expect(await ask(`file://localhost${path.join(wt, 'a:1')}`)).toBe('a:1')
    expect(await ask('inside-link.ts')).toBe('inside-link.ts')
    // the same file whichever name the worktree goes by
    expect(await ask(path.join(base, 'alias', 'src', 'a.ts'))).toBe('src/a.ts')
    expect(await ask('src/a.ts', path.join(base, 'alias'))).toBe('src/a.ts')

    // not a file of the worktree: nothing there, a folder, the worktree itself
    expect(await ask('src/missing.ts')).toBeNull()
    expect(await ask('src')).toBeNull()
    expect(await ask('.')).toBeNull()
    // traversal, by path and by URL
    expect(await ask('../secret.txt')).toBeNull()
    expect(await ask('src/../../secret.txt')).toBeNull()
    expect(await ask(path.join(base, 'secret.txt'))).toBeNull()
    expect(await ask(url(path.join(base, 'secret.txt')))).toBeNull()
    expect(await ask(`file://${wt}/../secret.txt`)).toBeNull()
    expect(await ask('file:///etc/hosts')).toBeNull() // os-ok: test data
    expect(await ask('/etc/hosts')).toBeNull() // os-ok: test data
    // a symlink that leads out, as a file and as a folder on the way
    expect(await ask('escape.txt')).toBeNull()
    expect(await ask('up/secret.txt')).toBeNull()
    expect(await ask(url(path.join(wt, 'escape.txt')))).toBeNull()
    // the home folder is outside too
    expect(await ask('~/notes.md')).toBeNull()
    // another host's file, something that is no path, a NUL
    expect(await ask(`file://elsewhere.example${path.join(wt, 'src', 'a.ts')}`)).toBeNull()
    expect(await ask('file:')).toBeNull()
    expect(await ask('src/a.ts\0.png')).toBeNull()

    // one answer per candidate, in order; a worktree that is gone answers none
    expect(await resolveLinks(wt, ['src/a.ts', '../secret.txt', 'a:1'], home)).toEqual(['src/a.ts', null, 'a:1'])
    expect(await resolveLinks(path.join(base, 'gone'), ['src/a.ts'], home)).toEqual([null])
  })

  it('U-TERM-53 · a printed path on a volume that no longer answers never ties up core’s file calls: at most L.terminalLinkChecksInFlightMax checks are on disk at once, one per place, and at most L.terminalLinkChecksWaitingMax wait; every candidate is answered by L.terminalLinkCheckDeadlineMs; the place whose check hung is not checked again while the system has not answered, nor for L.terminalLinkHungPlaceMs after it failed (L.terminalLinkHungPlacesMax places remembered); a check answered within L.terminalLinkHungAfterMs of its deadline was only slow, and its place is checked again at once; paths elsewhere still resolve, and no timer is left', async () => {
    vi.useFakeTimers()
    try {
      const wt = '/w/tree'
      const home = '/w/home'
      const names = Array.from({ length: L.terminalLinkCandidatesMax }, (_, i) => `src/f${i}.ts`)
      const folders = new Set([wt])
      const files = new Set([...names.map((n) => `${wt}/${n}`), `${wt}/lib/c.ts`])
      // a file call that is asked takes one of libuv's threads until it is answered: `out` counts them
      let out = 0
      let most = 0
      const asked: string[] = []
      const held: { p: string; answer: (ok: boolean) => void }[] = []
      // a volume, a place of its own (this system's volumes: `/Volumes` on macOS, `/media/<user>` on Linux)
      const VOL = need(coreOs.mounts).volumeRoots()[0] as string
      const silent = new Set([`${VOL}/dead`, '/w/mnt']) // what lies under these is not answered until the test says so
      const call = <T>(p: string, value: () => T): Promise<T> => {
        asked.push(p)
        out++
        most = Math.max(most, out)
        return new Promise<T>((resolve, reject) => {
          const answer = (ok: boolean): void => {
            out--
            try {
              if (!ok) throw Object.assign(new Error(`ETIMEDOUT: ${p}`), { code: 'ETIMEDOUT' })
              resolve(value())
            } catch (e) {
              reject(e as Error)
            }
          }
          if ([...silent].some((d) => p === d || p.startsWith(`${d}/`))) held.push({ p, answer })
          else void Promise.resolve().then(() => answer(true))
        })
      }
      const disk: PathFs = {
        realpath: (p) =>
          call(p, () => {
            if (!files.has(p) && !folders.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
            return p
          }),
        stat: (p) => call(p, () => ({ isFile: () => files.has(p) })),
      }
      const checks = new PathChecks({ fs: disk })
      const ask = (candidates: string[]) => checks.resolveLinks(wt, candidates, home)
      const deadline = () => vi.advanceTimersByTimeAsync(L.terminalLinkCheckDeadlineMs)
      const idle = { inFlight: 0, waiting: 0, hung: 0 }

      // 1. a line full of references that are files: all answered, never more file calls at once than the cap
      expect(await ask(names)).toEqual(names)
      expect(most).toBeLessThanOrEqual(L.terminalLinkChecksInFlightMax)
      expect(checks.counts).toEqual(idle)
      expect(vi.getTimerCount()).toBe(0)

      // 2. two references on a volume that does not answer, one in the worktree: answered at the deadline, the file
      // found; one call went to the volume, the second reference waited behind it and was never asked of the disk
      asked.length = 0
      const first = ask([`${VOL}/dead/proj/a.ts`, `${VOL}/dead/proj/src/b.ts`, 'lib/c.ts'])
      await deadline()
      expect(await first).toEqual([null, null, 'lib/c.ts'])
      expect(held.map((h) => h.p)).toEqual([`${VOL}/dead/proj/a.ts`])
      expect(checks.counts).toEqual({ inFlight: 1, waiting: 0, hung: 1 })
      expect(vi.getTimerCount()).toBe(0)
      // while the system has not answered, nothing on that volume is asked again: answered at once, with no wait
      asked.length = 0
      expect(await ask([`${VOL}/dead/other/c.ts`, `${VOL}/dead`, `file://${VOL}/dead/proj/a.ts`, 'src/f0.ts'])).toEqual([null, null, null, 'src/f0.ts'])
      expect(asked.filter((p) => p.startsWith(`${VOL}/`))).toEqual([])
      expect(vi.getTimerCount()).toBe(0)

      // 3. a second place that does not answer takes the other place in flight: now nothing is checked at all (core's
      // other file calls keep libuv's other threads), and every reference is "not a file" at once
      const second = ask(['/w/mnt/share/x.ts'])
      await deadline()
      expect(await second).toEqual([null])
      expect(held.map((h) => h.p)).toEqual([`${VOL}/dead/proj/a.ts`, '/w/mnt/share/x.ts'])
      asked.length = 0
      expect(await ask(['src/f0.ts', '/w/mnt/share/y.ts'])).toEqual([null, null])
      expect(asked).toEqual([])
      expect(most).toBe(L.terminalLinkChecksInFlightMax)
      expect(checks.counts).toEqual({ inFlight: 2, waiting: 0, hung: 2 })

      // 4. the system answers the second at last (an error), L.terminalLinkHungAfterMs after it was given up on: its
      // place in flight is free, files resolve again, and that folder is left alone for L.terminalLinkHungPlaceMs more
      await vi.advanceTimersByTimeAsync(L.terminalLinkHungAfterMs)
      held[1]!.answer(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(checks.counts).toEqual({ inFlight: 1, waiting: 0, hung: 2 })
      asked.length = 0
      expect(await ask(['src/f0.ts', '/w/mnt/share/y.ts', '/w/mnt/share/deeper/z.ts'])).toEqual(['src/f0.ts', null, null])
      expect(asked.filter((p) => p.startsWith('/w/mnt/'))).toEqual([])
      silent.delete('/w/mnt')
      files.add('/w/mnt/share/y.ts') // outside the worktree: never a link, but asked of the disk again once the time is up
      await vi.advanceTimersByTimeAsync(L.terminalLinkHungPlaceMs)
      expect(await ask(['/w/mnt/share/y.ts'])).toEqual([null])
      expect(asked.filter((p) => p.startsWith('/w/mnt/'))).toEqual(['/w/mnt/share/y.ts'])
      // the first volume answers at last (whatever it says; it was given up on far longer ago): its place in flight
      // is free too, and the volume is left alone as long again, then asked of the disk like any other
      silent.delete(`${VOL}/dead`)
      held[0]!.answer(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(checks.counts).toEqual({ inFlight: 0, waiting: 0, hung: 1 })
      asked.length = 0
      expect(await ask([`${VOL}/dead/proj/a.ts`])).toEqual([null])
      expect(asked.filter((p) => p.startsWith(`${VOL}/`))).toEqual([])
      await vi.advanceTimersByTimeAsync(L.terminalLinkHungPlaceMs)
      expect(await ask([`${VOL}/dead/proj/a.ts`])).toEqual([null])
      expect(asked.filter((p) => p.startsWith(`${VOL}/`))).toEqual([`${VOL}/dead/proj/a.ts`])
      expect(checks.counts).toEqual(idle)

      // 4b. slow is not hung: a check answered just after the deadline does not turn its place off for
      // L.terminalLinkHungPlaceMs (the place of the working directory's own check is the whole worktree). The worktree
      // answers late once, a busy disk: that request has no links, and while the call is out nothing more is asked
      // there; answered within L.terminalLinkHungAfterMs, the worktree is checked again by the very next request
      silent.add(wt)
      const slow = ask(['lib/c.ts'])
      await deadline()
      expect(await slow).toEqual([null])
      expect(held.at(-1)!.p).toBe(wt)
      expect(checks.counts).toEqual({ inFlight: 1, waiting: 0, hung: 1 })
      asked.length = 0
      expect(await ask(['lib/c.ts']), 'not asked again while the call is out').toEqual([null])
      expect(asked).toEqual([])
      silent.delete(wt)
      await vi.advanceTimersByTimeAsync(L.terminalLinkHungAfterMs - 1)
      held.at(-1)!.answer(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(checks.counts, 'answered in time: nothing is remembered').toEqual(idle)
      expect(await ask(['lib/c.ts', 'src/f0.ts'])).toEqual(['lib/c.ts', 'src/f0.ts'])
      expect(asked[0]).toBe(wt)
      expect(vi.getTimerCount()).toBe(0)

      // 5. the remembered places are capped: more than the cap, each hung and then failed, forgets the oldest. As
      // many hang at once as may be on disk, so that more than the cap have hung before the first is forgotten by age
      silent.add('/w/mnt')
      held.length = 0
      let places = 0
      while (places <= L.terminalLinkHungPlacesMax) {
        const round = Array.from({ length: L.terminalLinkChecksInFlightMax }, () => ask([`/w/mnt/d${places++}/x.ts`]))
        await deadline()
        expect((await Promise.all(round)).flat()).toEqual(round.map(() => null))
        await vi.advanceTimersByTimeAsync(L.terminalLinkHungAfterMs)
        for (const h of held.splice(0)) h.answer(false)
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(checks.counts).toEqual({ inFlight: 0, waiting: 0, hung: L.terminalLinkHungPlacesMax })
      silent.delete('/w/mnt')
      asked.length = 0
      await ask(['/w/mnt/d0/x.ts', `/w/mnt/d${places - 1}/x.ts`])
      expect(asked.filter((p) => p.startsWith('/w/mnt/'))).toEqual(['/w/mnt/d0/x.ts'])
      await vi.advanceTimersByTimeAsync(L.terminalLinkHungPlaceMs)
      await ask(['src/f0.ts'])
      expect(checks.counts, 'forgotten when their time is up').toEqual(idle)

      // 6. the checks waiting are capped: five lines' worth for one folder that answers slowly: one is on disk, the
      // cap's worth wait, the rest are "not a file" at once; at the deadline every one of them is answered
      silent.add(`${wt}/slow`)
      held.length = 0
      const lines = Array.from({ length: 5 }, (_, l) => ask(names.map((n, i) => `slow/l${l}-${i}.ts`)))
      await vi.advanceTimersByTimeAsync(0)
      expect(checks.counts).toEqual({ inFlight: 1, waiting: L.terminalLinkChecksWaitingMax, hung: 0 })
      expect(held).toHaveLength(1)
      await deadline()
      expect((await Promise.all(lines)).flat()).toEqual(Array.from({ length: 5 * names.length }, () => null))
      expect(checks.counts).toEqual({ inFlight: 1, waiting: 0, hung: 1 })
      expect(vi.getTimerCount()).toBe(0)
      // and going away answers what is still out and leaves nothing behind
      const last = ask(['lib/c.ts'])
      checks.dispose()
      expect(await last).toEqual([null])
      held[0]!.answer(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(checks.counts).toEqual(idle)
      expect(vi.getTimerCount()).toBe(0)
      expect(most).toBeLessThanOrEqual(L.terminalLinkChecksInFlightMax)
    } finally {
      vi.useRealTimers()
    }
  })

  it('U-ED-7 · the terminal app is the one the setting names when it is installed, and the first one found while the setting is Automatic; a named app that is not installed is none, and no other is opened in its place; a change of the setting needs no new lookup', async () => {
    // the setting's values are the catalog's apps, in its order, after Automatic, then the ones only Linux has;
    // each is offered by the catalog's name
    const linuxOnly = LINUX_TERMINAL_APP_DEFS.filter((d) => !TERMINAL_APP_DEFS.some((m) => m.id === d.id))
    expect(TERMINAL_APPS).toEqual(['auto', ...TERMINAL_APP_DEFS.map((d) => d.id), ...linuxOnly.map((d) => d.id)])
    const options = SETTINGS.find((d) => d.key === 'general.terminalApp')!.options!
    expect(options.slice(1).map((o) => o.label)).toEqual([...TERMINAL_APP_DEFS.map((d) => d.name), ...linuxOnly.map((d) => d.name)])
    for (const d of LINUX_TERMINAL_APP_DEFS) expect(options.find((o) => o.value === d.id)?.label, d.id).toBe(d.name)
    // os-ok: test data
    const found = (...ids: string[]) => TERMINAL_APP_DEFS.filter((d) => ids.includes(d.id)).map((d) => ({ def: d, app: `/Applications/${d.appName}` }))
    expect(terminalAppFor('auto', found('terminal', 'kitty'))?.def.id, 'Automatic: the first found, in the catalog’s order').toBe('kitty')
    expect(terminalAppFor('terminal', found('terminal', 'kitty'))?.def.id).toBe('terminal')
    expect(terminalAppFor('warp', found('terminal', 'kitty')), 'the person chose Warp, and Warp is not here').toBeNull()
    expect(terminalAppFor('auto', [])).toBeNull()

    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-editors-terminal-')))
    dirs.push(tmp)
    const apps = path.join(tmp, 'Applications')
    const repo = path.join(tmp, 'Developer', 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const ghostty = bundleAt(path.join(apps, 'Ghostty.app'), null)
    const terminal = bundleAt(path.join(apps, 'Utilities', 'Terminal.app'), null)
    let choice: TerminalAppChoice = 'auto'
    const lookups = { n: 0 }
    const { ed, ran } = editorsWith({ appDirs: [apps], spotlight: [[terminal, 'com.apple.Terminal'], [ghostty, 'com.mitchellh.ghostty']], cwd: repo, projects: [repo], sessions: [], terminalApp: () => choice, lookups })
    expect((await ed.list(true)).terminalApp).toEqual({ name: 'Ghostty' })
    expect((await ed.openTerminalApp('session', 's0')).ok).toBe(true)
    // the setting changes (Settings › General): what the window lists and what opens follow it at once
    choice = 'terminal'
    expect((await ed.list(false)).terminalApp).toEqual({ name: 'Terminal' })
    expect((await ed.openTerminalApp('session', 's0')).ok).toBe(true)
    // an app that is not installed: none, and neither of the installed ones is opened in its place
    choice = 'iterm'
    expect((await ed.list(false)).terminalApp).toBeNull()
    expect(await ed.openTerminalApp('session', 's0')).toEqual({ ok: false, reason: 'unavailable', message: null })
    choice = 'ghostty'
    expect((await ed.list(false)).terminalApp).toEqual({ name: 'Ghostty' })
    expect((await ed.openTerminalApp('session', 's0')).ok).toBe(true)
    expect(ran).toEqual([
      { file: '/fake/open', args: ['-a', ghostty, repo] },
      { file: '/fake/open', args: ['-a', terminal, repo] },
      { file: '/fake/open', args: ['-a', ghostty, repo] },
    ])
    expect(lookups.n, 'one lookup served every choice (the detection’s cache holds every app found)').toBe(1)
    ed.dispose()
  })
})
