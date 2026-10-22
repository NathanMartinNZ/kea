import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundleLines, installBundle, installTool, parseFakeArgs, readCalls, writeBundles } from './index.ts'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('fake-editor', () => {
  it('U-ED-2 · an installed stand-in records its argv untouched (spaces, quotes, unicode, colons), its cwd and its environment, exits as told, and opens nothing; a stand-in mdfind answers for the bundles it was given', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kea-fake editor's-")))
    dirs.push(root)
    const log = path.join(root, 'calls.ndjson')
    expect(readCalls(log)).toEqual([])

    // a bundle with its CLI, as detection and strategy 1 expect them
    const bundle = installBundle(path.join(root, 'Applications'), { appName: 'Visual Studio Code.app', bundleId: 'com.microsoft.VSCode', cli: 'Contents/Resources/app/bin/code' }, { log })
    const cli = path.join(bundle, 'Contents/Resources/app/bin/code')
    expect(fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8')).toContain('<string>com.microsoft.VSCode</string>')
    fs.accessSync(cli, fs.constants.X_OK)
    const argv = ['/w/my tree', '--goto', "/w/my tree/it's a “naïve” file — 日本.ts:42:7", '', '--help', '$HOME `id` \\ "q"', 'a:1']
    const r = spawnSync(cli, argv, { cwd: root, env: { PATH: '/nowhere', KEA_MARK: 'x y' }, encoding: 'utf8' })
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(readCalls(log)).toEqual([{ tool: 'code', argv, cwd: root, env: expect.objectContaining({ PATH: '/nowhere', KEA_MARK: 'x y' }) }])

    // a bundle found by its id alone has no CLI
    const bare = installBundle(path.join(root, 'Applications'), { appName: 'Zed.app', bundleId: 'dev.zed.Zed' }, { log })
    expect(fs.existsSync(path.join(bare, 'Contents', 'MacOS'))).toBe(false)

    // a tool that fails, with its last words
    const open = installTool(path.join(root, 'bin', 'open'), { as: 'open', log, exit: 3, stderr: "The application can't be opened. -10661" })
    const failed = spawnSync(open, ['-a', bundle, '/w/my tree'], { encoding: 'utf8' })
    expect({ status: failed.status, stderr: failed.stderr }).toEqual({ status: 3, stderr: "The application can't be opened. -10661\n" })
    expect(readCalls(log).at(-1)).toMatchObject({ tool: 'open', argv: ['-a', bundle, '/w/my tree'] })

    // mdfind: one line per bundle id of the query that it knows, in the real tool's form
    const bundles = writeBundles(path.join(root, 'bundles.json'), { 'com.microsoft.VSCode': bundle, 'dev.zed.Zed': bare })
    const mdfind = installTool(path.join(root, 'bin', 'mdfind'), { as: 'mdfind', log, bundles })
    const query = "kMDItemCFBundleIdentifier == 'com.microsoft.VSCode' || kMDItemCFBundleIdentifier == 'com.example.absent' || kMDItemCFBundleIdentifier == 'dev.zed.Zed'"
    const found = spawnSync(mdfind, ['-attr', 'kMDItemCFBundleIdentifier', query], { encoding: 'utf8' })
    expect(found.stdout).toBe(`${bundle}   kMDItemCFBundleIdentifier = com.microsoft.VSCode\n${bare}   kMDItemCFBundleIdentifier = dev.zed.Zed\n`)
    expect(bundleLines(['nothing quoted'], { a: '/x' })).toBe('')
    expect(readCalls(log)).toHaveLength(3)

    expect(parseFakeArgs(['--as', 'gh', '--log', '/l', '--exit', '7', '--', 'pr', 'create', '--web'])).toEqual({ as: 'gh', log: '/l', exit: 7, stderr: null, bundles: null, argv: ['pr', 'create', '--web'] })
    expect(() => parseFakeArgs(['--log', '/l'])).toThrow(/--as/)
    expect(() => parseFakeArgs(['--as', 'x', '--log', '/l', '--exit', '256'])).toThrow(/--exit/)
    expect(() => parseFakeArgs(['--as', 'x', '--loud', '1'])).toThrow(/unknown option/)
  })
})
