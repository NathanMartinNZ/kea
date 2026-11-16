// A workspace's packages for an import by name: pnpm-workspace.yaml's packages and package.json's workspaces, the
// globs expanded inside the worktree (literal, *, **, ! excludes, never node_modules or a hidden folder), a package
// matched by its name with the folder named as its last segment read first, and each cap answering not checked.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { noopLogger } from '@kea/kit'
import { L, type FileRef } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { NOT_CHECKED, PathChecks } from '../editor/paths.ts'
import { ConfigReader } from './aliases.ts'
import { resolveRefs } from './fileRefs.ts'
import { openForRead } from './read.ts'
import { findWorkspace, globPattern, packageNamed, packageOf, packageWorkspaces, parseWorkspaceYaml, type Workspace } from './workspace.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-ws-')))
  dirs.push(root)
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
  }
  return root
}

/** The workspace found, or a failure when there is none or it was not checked. */
function known(ws: Workspace | null | symbol): Workspace {
  if (ws === null || typeof ws === 'symbol') throw new Error(`no workspace: ${String(ws)}`)
  return ws
}
const pkg = (name: string, more: Record<string, unknown> = {}): string => JSON.stringify({ name, ...more })
const YAML = ['packages:', '  - app/*', "  - 'packages/*'   # quoted", '  - "tools/cli"', '  - apps/**', "  - '!**/fixtures/**'", '', 'allowBuilds:', '  esbuild: true', ''].join('\n')

/** The workspace of `from` in `root`, as worktree paths, with a reader that records each package.json it opens. */
async function workspaceOf(root: string, from: string) {
  const opened: string[] = []
  const configs = new ConfigReader(async (real) => {
    if (real.endsWith('package.json')) opened.push(path.relative(root, path.dirname(real)))
    return openForRead(real)
  })
  const checks = new PathChecks()
  const req = checks.begin('viewer')
  const reader = { req, root, session: 'S' }
  const ws = await findWorkspace(path.join(root, from), root, req, configs, reader)
  return { ws, opened, configs, reader, end: () => (req.end(), checks.dispose()) }
}

describe('a workspace’s packages', () => {
  it('U-FV-40 · pnpm-workspace.yaml’s packages as a block or a flow list, quoted or not, comments and other keys left out; package.json’s workspaces as a list or { packages }; a bare import’s package name and subpath; a glob’s pattern', () => {
    expect(parseWorkspaceYaml(YAML)).toEqual({ packages: ['app/*', 'packages/*', 'tools/cli', 'apps/**', '!**/fixtures/**'] })
    expect(parseWorkspaceYaml("packages: ['a/*', \"b\", c] # flow\n")).toEqual({ packages: ['a/*', 'b', 'c'] })
    expect(parseWorkspaceYaml("packages:\n- 'it''s/*'\n- x\nother: 1\n- y\n")).toEqual({ packages: ["it's/*", 'x'] })
    expect(parseWorkspaceYaml('catalog:\n  react: ^19\n')).toBeNull()
    expect(packageWorkspaces({ workspaces: ['a/*', 3] })).toEqual(['a/*'])
    expect(packageWorkspaces({ workspaces: { packages: ['b/*'], nohoist: ['x'] } })).toEqual(['b/*'])
    expect(packageWorkspaces({ name: 'x' })).toBeNull()
    expect(packageOf('@kea/kit')).toEqual({ name: '@kea/kit', sub: '' })
    expect(packageOf('@kea/kit/fsm')).toEqual({ name: '@kea/kit', sub: '/fsm' })
    expect(packageOf('react-dom/client')).toEqual({ name: 'react-dom', sub: '/client' })
    for (const none of ['$lib/x', '~/x', 'node:fs', 'virtual:x', '@scope', '.hidden']) expect(packageOf(none), none).toBeNull()
    const exclude = globPattern('**/fixtures/**')
    expect(['fixtures', 'packages/a/fixtures', 'packages/a/fixtures/pkg'].every((p) => exclude.test(p))).toBe(true)
    expect(exclude.test('packages/fixtures-kit')).toBe(false)
    expect(globPattern('pkg-*').test('pkg-a')).toBe(true)
    expect(globPattern('pkg-*').test('pkg-a/b')).toBe(false)
  })

  it('U-FV-40 · the globs on a worktree: literal, * and ** folders in order, a ! glob, node_modules and hidden folders left out; the nearest workspace from a nested file; package.json’s workspaces without a yaml; none outside one', async () => {
    const root = tree({
      'pnpm-workspace.yaml': YAML,
      'app/core/package.json': pkg('@kea/core'),
      'app/core/src/a.ts': 'x',
      'app/main/package.json': pkg('@kea/main'),
      'packages/kit/package.json': pkg('@kea/kit'),
      'tools/cli/package.json': pkg('kea-cli'),
      'apps/web/site/package.json': pkg('@acme/site'),
      'apps/web/fixtures/pkg/package.json': pkg('fixture'),
      'node_modules/dep/package.json': pkg('dep'),
      'app/.cache/package.json': pkg('hidden'),
    })
    const w = await workspaceOf(root, 'app/core/src/a.ts')
    const ws = known(w.ws)
    expect(path.relative(root, ws.root)).toBe('')
    expect(ws.dirs.map((d) => path.relative(root, d))).toEqual(['app/core', 'app/main', 'packages/kit', 'tools/cli', 'apps', 'apps/web', 'apps/web/site'])
    expect(ws.cut).toBe(false)
    w.end()
    const npm = tree({ 'package.json': pkg('root', { workspaces: { packages: ['libs/*'] } }), 'libs/a/package.json': pkg('a'), 'libs/a/x.ts': 'x' })
    const n = await workspaceOf(npm, 'libs/a/x.ts')
    expect(known(n.ws).dirs.map((d) => path.relative(npm, d))).toEqual(['libs/a'])
    n.end()
    const lone = tree({ 'package.json': pkg('solo'), 'src/x.ts': 'x' })
    const l = await workspaceOf(lone, 'src/x.ts')
    expect(l.ws).toBeNull()
    l.end()
  })

  it('U-FV-40 · a package by its name: the folder named as the last segment read first, another folder’s name found by reading on; none answers no package; past the package cap or the listing cap, not checked', async () => {
    const root = tree({
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n  - deep/**\n',
      'packages/a/package.json': pkg('@acme/a'),
      'packages/b/package.json': pkg('@acme/b'),
      'packages/site/package.json': pkg('@acme/web'),
      'packages/a/x.ts': 'x',
    })
    const w = await workspaceOf(root, 'packages/a/x.ts')
    const ws = known(w.ws)
    w.opened.length = 0
    expect(await packageNamed(ws, '@acme/b', w.configs, w.reader)).toMatchObject({ dir: path.join(root, 'packages/b') })
    expect(w.opened, 'the folder named b, alone').toEqual(['packages/b'])
    expect(await packageNamed(ws, '@acme/web', w.configs, w.reader)).toMatchObject({ dir: path.join(root, 'packages/site') })
    expect(await packageNamed(ws, '@acme/none', w.configs, w.reader)).toBeNull()
    w.end()
    const many: Record<string, string> = { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n', 'x.ts': 'x' }
    for (let i = 0; i <= L.viewerWorkspacePackagesMax; i++) many[`packages/p${String(i).padStart(4, '0')}/package.json`] = pkg(`p${i}`)
    const big = await workspaceOf(tree(many), 'x.ts')
    const bigWs = known(big.ws)
    expect([bigWs.dirs.length, bigWs.cut]).toEqual([L.viewerWorkspacePackagesMax, true])
    expect(await packageNamed(bigWs, '@acme/none', big.configs, big.reader), 'cut: not "no package"').toBe(NOT_CHECKED)
    big.end()
    const deep: Record<string, string> = { 'pnpm-workspace.yaml': 'packages:\n  - deep/**\n', 'x.ts': 'x' }
    for (let i = 0; i <= L.viewerWorkspaceListingsMax; i++) deep[`deep/d${i}/.keep`] = ''
    const d = await workspaceOf(tree(deep), 'x.ts')
    expect(known(d.ws).cut).toBe(true)
    d.end()
  })

  it('U-FV-40 · a workspace’s package on a worktree: @kea/kit and its ./fsm subpath by exports from a file of another package, a package with only main, an unexported subpath, a package of no workspace and a cut workspace answer as they should', async () => {
    const files: Record<string, string> = {
      'pnpm-workspace.yaml': YAML,
      'packages/kit/package.json': pkg('@kea/kit', { exports: { '.': './src/index.ts', './fsm': './src/fsm.ts' } }),
      'packages/kit/src/index.ts': 'x',
      'packages/kit/src/fsm.ts': 'x',
      'packages/legacy/package.json': pkg('legacy', { main: './lib/index.js' }),
      'packages/legacy/lib/index.ts': 'x',
      'app/core/package.json': pkg('@kea/core'),
      'app/core/src/a.ts': 'x',
    }
    const root = tree(files)
    const checks = new PathChecks()
    const refs: FileRef[] = ['@kea/kit', '@kea/kit/fsm', 'legacy', '@kea/kit/internal', 'react'].map((spec) => ({ family: 'import', spec }))
    const answers = await resolveRefs({ cwd: root, from: 'app/core/src/a.ts', refs, req: checks.begin('viewer'), configs: new ConfigReader(), session: 'S', home: os.homedir(), log: noopLogger })
    expect(answers).toEqual([{ path: 'packages/kit/src/index.ts' }, { path: 'packages/kit/src/fsm.ts' }, { path: 'packages/legacy/lib/index.ts' }, null, null])
    expect(checks.counts).toEqual({ inFlight: 0, waiting: 0, hung: 0 })
    checks.dispose()
  })
})
