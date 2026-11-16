// Where a file reference leads: core's candidates per family in order, the caps, what is never tried, and the
// reference's checks on a temp worktree and on a stand-in file system (a folder or a link out moves on, refusals and
// the list's budget answer `unknown`, the real file's name for a case-only difference).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { noopLogger } from '@kea/kit'
import { L, type FileRef, type RefAnswer } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PathChecks, type PathFs } from '../editor/paths.ts'
import { Aliases, ConfigReader } from './aliases.ts'
import { keepStep, manifestSteps, packageSteps, probeImport, resolveRefs, stepsFor, subpathTargets, type RefContext, type Step } from './fileRefs.ts'

const W = '/w'
const ctx = (o: Partial<RefContext> = {}): RefContext => ({ root: W, from: `${W}/src/app.ts`, home: '/home/u', project: null, aliases: null, ...o })
/** A step as a worktree path (a package.json read as `dir/`, a workspace's package as `workspace:name/sub`). */
const shown = (s: Step, root = W): string => (s.kind === 'file' ? path.relative(root, s.abs) : s.kind === 'workspace' ? `workspace:${s.name}${s.sub}` : `${path.relative(root, s.dir)}/`)
/** The steps of a reference, kept and in order. */
const steps = (ref: Pick<FileRef, 'family' | 'spec'>, c: RefContext = ctx()): string[] =>
  stepsFor(ref, c)
    .filter((s) => keepStep(s, ref, c.root))
    .map((s) => shown(s, c.root))

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-refs-')))
  dirs.push(root)
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
  }
  return root
}

/** `viewer.resolveRefs` on `cwd` for the file `from`, over `checks`. */
function resolve(checks: PathChecks, cwd: string, from: string, refs: FileRef[]): Promise<RefAnswer[]> {
  return resolveRefs({ cwd, from, refs, req: checks.begin('viewer'), configs: new ConfigReader(), session: 'S', home: os.homedir(), log: noopLogger })
}

describe('file references in core', () => {
  it('U-FV-40 · imports in TypeScript’s order: .js → .ts, .tsx, .d.ts, .js; .mjs → .mts; an unknown extension; extensionless with its package.json and index; nothing in node_modules or out of the worktree; a bare package other than the workspace’s, or a #import with no package, gives none', () => {
    expect(steps({ family: 'import', spec: './util.js' })).toEqual(['src/util.ts', 'src/util.tsx', 'src/util.d.ts', 'src/util.js'])
    expect(steps({ family: 'import', spec: '../lib/m.mjs' })).toEqual(['lib/m.mts', 'lib/m.d.mts', 'lib/m.mjs'])
    expect(steps({ family: 'import', spec: './C.jsx' })).toEqual(['src/C.tsx', 'src/C.jsx'])
    expect(steps({ family: 'import', spec: './state.svelte' }).slice(0, 3)).toEqual(['src/state.svelte', 'src/state.svelte.ts', 'src/state.svelte.tsx'])
    const ext = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json']
    // the worst ordinary list for one target: the file, each extension, the folder's package.json, its index with each
    const util = steps({ family: 'import', spec: './util' })
    expect(util).toEqual(['src/util', ...ext.map((e) => `src/util${e}`), 'src/util/', ...ext.map((e) => `src/util/index${e}`)])
    expect(2 * util.length, 'two targets of an alias fit the cap').toBeLessThanOrEqual(L.viewerLinkCandidatesMax)
    expect(steps({ family: 'import', spec: './data.json' })[0]).toBe('src/data.json')
    // never out of the worktree, never in node_modules (an alias such as "*" included), never a package; a #import
    // needs the file's package
    expect(steps({ family: 'import', spec: '../../../etc/x' })).toEqual([])
    expect(steps({ family: 'import', spec: './node_modules/x/y' })).toEqual([])
    expect(steps({ family: 'import', spec: 'react' }), 'a bare package: its workspace’s package alone').toEqual(['workspace:react'])
    expect(steps({ family: 'import', spec: '$lib/x' })).toEqual([])
    expect(steps({ family: 'import', spec: '#internal/x' })).toEqual([])
    expect(steps({ family: 'import', spec: '~/lib/x' }), 'not the home folder').toEqual([])
    // a folder's manifest gives its types, typings and main, each tried as a file is
    expect(probeImport(`${W}/pkg`).filter((s) => s.kind === 'manifest')).toEqual([{ kind: 'manifest', dir: `${W}/pkg`, field: 'module' }])
  })

  it('U-FV-40 · stylesheets with Sass’s partials, markup and root paths from a nested package then its public/ and static/ then the worktree, Markdown, JSON, extends, references and paths', () => {
    const css = ctx({ from: `${W}/src/app.scss` })
    expect(steps({ family: 'style', spec: 'tokens' }, css)).toEqual(['src/tokens', 'src/_tokens.scss', 'src/tokens.scss', 'src/_tokens.sass', 'src/tokens.sass', 'src/tokens.css', 'src/tokens/_index.scss', 'src/tokens/index.scss'])
    expect(steps({ family: 'style', spec: '../base.css' }, css)).toEqual(['base.css', '_base.css'])
    expect(steps({ family: 'style', spec: '~bootstrap/x' }, css)).toEqual([])
    const nested = ctx({ from: `${W}/apps/web/src/index.html`, project: { config: null, packageDir: `${W}/apps/web`, svelteKit: false } })
    expect(steps({ family: 'markup', spec: '/logo.png' }, nested)).toEqual(['apps/web/logo.png', 'apps/web/public/logo.png', 'apps/web/static/logo.png', 'logo.png'])
    expect(steps({ family: 'markup', spec: './a.css?v=2' }, nested)).toEqual(['apps/web/src/a.css'])
    expect(steps({ family: 'markup', spec: '/logo.png' })).toEqual(['logo.png'])
    expect(steps({ family: 'import', spec: '/src/main.ts' }, nested).slice(0, 2)).toEqual(['apps/web/src/main.ts', 'apps/web/src/main.ts.ts'])
    expect(steps({ family: 'markdown', spec: 'docs/a.md' })).toEqual(['docs/a.md'])
    expect(steps({ family: 'json', spec: './dist/index.js' })).toEqual(['src/dist/index.js'])
    expect(steps({ family: 'json', spec: 'src/x' })).toEqual([])
    const cfg = ctx({ from: `${W}/apps/web/tsconfig.json` })
    expect(steps({ family: 'extends', spec: './base' }, cfg)).toEqual(['apps/web/base', 'apps/web/base.json'])
    expect(steps({ family: 'extends', spec: '@tsconfig/node20' }, cfg)).toEqual([
      'apps/web/node_modules/@tsconfig/node20/',
      'apps/web/node_modules/@tsconfig/node20/tsconfig.json',
      'apps/node_modules/@tsconfig/node20/',
      'apps/node_modules/@tsconfig/node20/tsconfig.json',
      'node_modules/@tsconfig/node20/',
      'node_modules/@tsconfig/node20/tsconfig.json',
    ])
    expect(steps({ family: 'reference', spec: './packages/a' }, cfg)).toEqual(['apps/web/packages/a', 'apps/web/packages/a/tsconfig.json'])
    expect(steps({ family: 'reference', spec: './tsconfig.node.json' }, cfg)).toEqual(['apps/web/tsconfig.node.json'])
    expect(steps({ family: 'path', spec: 'README.md' })).toEqual(['src/README.md', 'README.md'])
    expect(steps({ family: 'path', spec: `file://${W}/a.ts` })).toEqual(['a.ts'])
    expect(steps({ family: 'path', spec: '~/notes.md' }), 'the home folder is outside the worktree').toEqual([])
    expect(steps({ family: 'path', spec: '/etc/hosts' })).toEqual([]) // os-ok: test data
  })

  it('U-FV-40 · the reference’s checks on a worktree: a folder or a link out moves on, the first regular file inside wins; a folder’s package.json names its entry, and one too large, missing or broken is skipped for its index; two targets of an alias reach index.ts; a list cut by the cap answers unknown', async () => {
    const root = tree({
      'src/app.ts': 'x',
      'src/thing/index.ts': 'x',
      'src/out.tsx': 'x',
      'src/typed/package.json': JSON.stringify({ types: './lib/main.d.ts' }),
      'src/typed/lib/main.d.ts': 'x',
      'src/typed/index.ts': 'x',
      'src/big/package.json': `{"main":"./x.ts","pad":"${'x'.repeat(L.viewerAliasFileMaxBytes)}"}`,
      'src/big/x.ts': 'x',
      'src/big/index.ts': 'x',
      'src/broken/package.json': '{ "main": ',
      'src/broken/index.js': 'x',
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./a/*', './b/*'], '@many/*': ['./m1/*', './m2/*', './m3/*'] } } }),
      'b/x/index.ts': 'x',
    })
    const outside = tree({ 'secret.ts': 'x' })
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'src/out.ts'))
    const checks = new PathChecks()
    const ask = async (spec: string, family: FileRef['family'] = 'import') => (await resolve(checks, root, 'src/app.ts', [{ family, spec }]))[0]
    expect(await ask('./thing')).toEqual({ path: 'src/thing/index.ts' })
    expect(await ask('./out'), 'the link out is passed over').toEqual({ path: 'src/out.tsx' })
    expect(await ask('./typed')).toEqual({ path: 'src/typed/lib/main.d.ts' })
    expect(await ask('./big')).toEqual({ path: 'src/big/index.ts' })
    expect(await ask('./broken')).toEqual({ path: 'src/broken/index.js' })
    expect(await ask('./gone')).toBeNull()
    expect(await ask('@/x'), 'index.ts behind the second target').toEqual({ path: 'b/x/index.ts' })
    expect(await ask('@many/nothing'), 'more candidates than the cap: not "no file"').toBe('unknown')
    expect(await ask('react')).toBeNull()
    // the position comes back with the file; answers are in order
    expect(await resolve(checks, root, 'src/app.ts', [{ family: 'path', spec: 'thing/index.ts', line: 3, col: 2 }, { family: 'path', spec: 'nope.ts' }])).toEqual([{ path: 'src/thing/index.ts', line: 3, col: 2 }, null])
    expect(checks.counts).toEqual({ inFlight: 0, waiting: 0, hung: 0 })
    checks.dispose()
  })

  it('U-FV-40 · a #import after the config’s paths: the nearest package.json’s imports, the exact key else the pattern with the longest part before its *, each target in the order written and tried as an import; a package name, a target not starting ./, a .. or node_modules segment, or a key with two * gives none', () => {
    const pkg = { config: null, packageDir: W, svelteKit: false }
    const page = ctx({ from: `${W}/src/routes/+page.svelte`, project: pkg })
    // the worktree's own package.json is read
    expect(stepsFor({ family: 'import', spec: '#lib/x' }, page)).toEqual([{ kind: 'manifest', dir: W, field: 'imports', spec: '#lib/x' }])
    expect(steps({ family: 'import', spec: '#lib/x' }, page)).toEqual(['/'])
    // a config's paths first, as TypeScript tries them, then the package's imports
    const aliased = ctx({ project: pkg, aliases: new Aliases([{ pattern: '#a/*', targets: ['./alt/*'], base: W }], null) })
    const viaPaths = steps({ family: 'import', spec: '#a/x' }, aliased)
    expect([viaPaths[0], viaPaths.at(-1)]).toEqual(['alt/x', '/'])
    const imports = {
      '#lib/*': './src/lib/*',
      '#lib/special/*': './special/*',
      '#lib/special/*.js': './special-js/*.js',
      '#exact': './src/exact.ts',
      '#cond': { types: './types/c.d.ts', node: { import: './node/c.mjs' }, browser: null, default: './src/c.ts' },
      '#list': ['./a.ts', 'some-package', './b.ts'],
      '#dep': 'some-package',
      '#up/*': '../outside/*',
      '#nm/*': './node_modules/*',
      '#two/*/*': './x/*/*',
      '#star/*': './s/*/*.ts',
    }
    const t = (spec: string): string[] => subpathTargets(W, imports, spec).map((a) => path.relative(W, a))
    expect(t('#lib/components/Seo.svelte')).toEqual(['src/lib/components/Seo.svelte'])
    expect(t('#lib/special/a'), 'the longest part before *').toEqual(['special/a'])
    expect(t('#lib/special/a.js'), 'of two with that part, the longer key').toEqual(['special-js/a.js'])
    expect(t('#lib/'), 'a * stands for one character at least').toEqual([])
    expect(t('#exact')).toEqual(['src/exact.ts'])
    expect(t('#cond'), 'every condition in the order written; null is none').toEqual(['types/c.d.ts', 'node/c.mjs', 'src/c.ts'])
    expect(t('#list')).toEqual(['a.ts', 'b.ts'])
    expect(t('#dep'), 'a package name').toEqual([])
    expect(t('#up/x'), 'a target not starting ./').toEqual([])
    expect(t('#lib/../x'), 'a .. in the matched part').toEqual([])
    expect(t('#nm/x'), 'a node_modules segment').toEqual([])
    expect(t('#two/a/b')).toEqual([])
    expect(t('#star/q'), 'every * of the target').toEqual(['s/q/q.ts'])
    expect(t('#none')).toEqual([])
    expect(subpathTargets(W, ['./x'], '#x')).toEqual([])
    expect(subpathTargets(W, undefined, '#x')).toEqual([])
    // each target is tried as an import is: TypeScript's sources for a .js
    const util = manifestSteps({ kind: 'manifest', dir: W, field: 'imports', spec: '#lib/util.js' }, { imports })
    expect(util.map((s) => shown(s))).toEqual(['src/lib/util.ts', 'src/lib/util.tsx', 'src/lib/util.d.ts', 'src/lib/util.js'])
  })

  it('U-FV-40 · Python by its dots or from the top package’s parent, the worktree and src/; Rust beside a crate root or in the declaring file’s folder; C includes from the file’s folder, the worktree, include/ and src/; Ruby with .rb added', () => {
    const py = ctx({ from: `${W}/app/api/views.py` })
    expect(steps({ family: 'python', spec: '.models' }, py)).toEqual(['app/api/models.py', 'app/api/models/__init__.py'])
    expect(steps({ family: 'python', spec: '..core.db' }, py)).toEqual(['app/core/db.py', 'app/core/db/__init__.py'])
    expect(steps({ family: 'python', spec: '.' }, py)).toEqual(['app/api/__init__.py'])
    expect(steps({ family: 'python', spec: '..' }, py)).toEqual(['app/__init__.py'])
    const base = ctx({ from: `${W}/app/api/views.py`, pythonBase: W })
    expect(steps({ family: 'python', spec: 'app.models' }, base)).toEqual(['app/models.py', 'app/models/__init__.py', 'src/app/models.py', 'src/app/models/__init__.py'])
    const nested = ctx({ from: `${W}/svc/pkg/x.py`, pythonBase: `${W}/svc` })
    expect(steps({ family: 'python', spec: 'pkg.util' }, nested)).toEqual(['svc/pkg/util.py', 'svc/pkg/util/__init__.py', 'pkg/util.py', 'pkg/util/__init__.py', 'src/pkg/util.py', 'src/pkg/util/__init__.py'])
    expect(steps({ family: 'python', spec: '.....x' }, py), 'dots past the worktree').toEqual([])
    const rs = (from: string, name = 'parser') => steps({ family: 'rust', spec: name }, ctx({ from: `${W}/${from}` }))
    expect(rs('src/lib.rs')).toEqual(['src/parser.rs', 'src/parser/mod.rs'])
    expect(rs('src/net/mod.rs')).toEqual(['src/net/parser.rs', 'src/net/parser/mod.rs'])
    expect(rs('src/net.rs')).toEqual(['src/net/parser.rs', 'src/net/parser/mod.rs'])
    expect(rs('src/bin/tool.rs')).toEqual(['src/bin/parser.rs', 'src/bin/parser/mod.rs', 'src/bin/tool/parser.rs', 'src/bin/tool/parser/mod.rs'])
    expect(rs('src/lib.rs', '../x')).toEqual([])
    const c = ctx({ from: `${W}/src/net/socket.c` })
    expect(steps({ family: 'include', spec: 'socket.h' }, c)).toEqual(['src/net/socket.h', 'socket.h', 'include/socket.h', 'src/socket.h'])
    // from the worktree's root it climbs out and is dropped; include/ and src/ both give util/str.h
    expect(steps({ family: 'include', spec: '../util/str.h' }, c)).toEqual(['src/util/str.h', 'util/str.h', 'util/str.h'])
    const rb = ctx({ from: `${W}/lib/app.rb` })
    expect(steps({ family: 'ruby', spec: '../config/boot' }, rb)).toEqual(['config/boot.rb', 'config/boot'])
    expect(steps({ family: 'ruby', spec: 'helpers.rb' }, rb)).toEqual(['lib/helpers.rb'])
  })

  it('U-FV-40 · a workspace package’s files: its exports by the subpath (a string, a list or conditions alone are its .), each tried as an import; without exports its types, typings, main and index, or the subpath in its folder', () => {
    const P = `${W}/packages/ui`
    const rel = (s: Step[]) => s.map((x) => shown(x))
    const exports = { '.': './src/index.ts', './button': { types: './dist/button.d.ts', default: './src/button.ts' }, './icons/*': './src/icons/*.svelte' }
    expect(rel(packageSteps(P, { exports }, ''))[0]).toBe('packages/ui/src/index.ts')
    // each condition's target in turn, each probed as an import (the exact file first)
    const button = rel(packageSteps(P, { exports }, '/button'))
    expect(button[0]).toBe('packages/ui/dist/button.d.ts')
    expect(button.indexOf('packages/ui/src/button.ts')).toBeGreaterThan(0)
    expect(rel(packageSteps(P, { exports }, '/icons/close'))[0]).toBe('packages/ui/src/icons/close.svelte')
    expect(rel(packageSteps(P, { exports: './src/main.js' }, ''))).toEqual(['packages/ui/src/main.ts', 'packages/ui/src/main.tsx', 'packages/ui/src/main.d.ts', 'packages/ui/src/main.js'])
    expect(rel(packageSteps(P, { exports: { import: './esm.js', require: './cjs.cjs' } }, ''))).toEqual([
      'packages/ui/esm.ts',
      'packages/ui/esm.tsx',
      'packages/ui/esm.d.ts',
      'packages/ui/esm.js',
      'packages/ui/cjs.cts',
      'packages/ui/cjs.d.cts',
      'packages/ui/cjs.cjs',
    ])
    expect(rel(packageSteps(P, { exports: { '.': './src/index.ts' } }, '/internal')), 'not exported').toEqual([])
    const plain = rel(packageSteps(P, { main: './lib/main.js' }, ''))
    expect(plain.slice(0, 4)).toEqual(['packages/ui/lib/main.ts', 'packages/ui/lib/main.tsx', 'packages/ui/lib/main.d.ts', 'packages/ui/lib/main.js'])
    expect(plain.at(-1)).toBe('packages/ui/index.json')
    expect(rel(packageSteps(P, {}, '/src/util')).slice(0, 2)).toEqual(['packages/ui/src/util', 'packages/ui/src/util.ts'])
  })

  it('U-FV-40 · Python, Rust, C and Ruby on a worktree: absolute modules from above the top package found by its __init__.py chain, relative ones by their dots; mod, #include and require_relative reach their files', async () => {
    const root = tree({
      'svc/app/__init__.py': '',
      'svc/app/api/__init__.py': '',
      'svc/app/api/views.py': 'x',
      'svc/app/models.py': 'x',
      'svc/app/core/__init__.py': '',
      'svc/script.py': 'x',
      'svc/helpers.py': 'x',
      'src/lib.rs': 'x',
      'src/net.rs': 'x',
      'src/net/socket/mod.rs': 'x',
      'src/parser.rs': 'x',
      'include/kea.h': 'x',
      'native/main.c': 'x',
      'lib/app.rb': 'x',
      'config/boot.rb': 'x',
    })
    const checks = new PathChecks()
    const ask = async (from: string, family: FileRef['family'], spec: string) => (await resolve(checks, root, from, [{ family, spec }]))[0]
    expect(await ask('svc/app/api/views.py', 'python', 'app.models'), 'from svc/, above the top package').toEqual({ path: 'svc/app/models.py' })
    expect(await ask('svc/app/api/views.py', 'python', '..models')).toEqual({ path: 'svc/app/models.py' })
    expect(await ask('svc/app/api/views.py', 'python', '..core')).toEqual({ path: 'svc/app/core/__init__.py' })
    expect(await ask('svc/script.py', 'python', 'helpers'), 'outside a package: the file’s own folder').toEqual({ path: 'svc/helpers.py' })
    expect(await ask('svc/app/api/views.py', 'python', 'requests')).toBeNull()
    expect(await ask('src/lib.rs', 'rust', 'parser')).toEqual({ path: 'src/parser.rs' })
    expect(await ask('src/net.rs', 'rust', 'socket')).toEqual({ path: 'src/net/socket/mod.rs' })
    expect(await ask('native/main.c', 'include', 'kea.h')).toEqual({ path: 'include/kea.h' })
    expect(await ask('lib/app.rb', 'ruby', '../config/boot')).toEqual({ path: 'config/boot.rb' })
    expect(checks.counts).toEqual({ inFlight: 0, waiting: 0, hung: 0 })
    checks.dispose()
  })

  it('U-FV-40 · a #import on a worktree: the package.json at its root maps #lib/* to a Svelte component and an extensionless module; one that matches no file, an unknown key and a file whose nearest package.json has no imports answer no file', async () => {
    const root = tree({
      'package.json': JSON.stringify({ imports: { '#lib/*': './src/lib/*' } }),
      'src/routes/+page.svelte': 'x',
      'src/lib/components/Seo.svelte': 'x',
      'src/lib/util.ts': 'x',
      'nested/package.json': JSON.stringify({ name: 'nested' }),
      'nested/a.ts': 'x',
    })
    const checks = new PathChecks()
    const refs: FileRef[] = ['#lib/components/Seo.svelte', '#lib/util', '#lib/nothing', '#nope/x'].map((spec) => ({ family: 'import', spec }))
    expect(await resolve(checks, root, 'src/routes/+page.svelte', refs)).toEqual([{ path: 'src/lib/components/Seo.svelte' }, { path: 'src/lib/util.ts' }, null, null])
    expect(await resolve(checks, root, 'nested/a.ts', [{ family: 'import', spec: '#lib/util' }])).toEqual([null])
    expect(checks.counts).toEqual({ inFlight: 0, waiting: 0, hung: 0 })
    checks.dispose()
  })

  it('U-FV-40 · a candidate spelt in another case answers the real file’s name; one reached through a link inside the worktree keeps its own spelling', async () => {
    // a volume that ignores case: `Button.ts` is found, and its real path is `button.ts`
    const files = new Map([
      [`${W}/src/button.ts`, `${W}/src/button.ts`],
      [`${W}/src/Button.ts`, `${W}/src/button.ts`],
      [`${W}/src/alias.ts`, `${W}/src/real.ts`],
      [`${W}/src/real.ts`, `${W}/src/real.ts`],
    ])
    const disk: PathFs = {
      realpath: async (p) => {
        if (p === W) return W
        const r = files.get(p)
        if (!r) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return r
      },
      stat: async (p) => {
        if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return { isFile: () => true }
      },
    }
    const checks = new PathChecks({ fs: disk })
    expect(await resolve(checks, W, 'src/app.ts', [{ family: 'import', spec: './Button' }, { family: 'import', spec: './alias' }])).toEqual([{ path: 'src/button.ts' }, { path: 'src/alias.ts' }])
    checks.dispose()
  })

  it('U-FV-40 · not checked is not "no file": a place left alone, every place in flight stuck, dispose before and during, and a check given up while waiting each answer unknown; the list’s budget answers unknown and gives up no check', async () => {
    vi.useFakeTimers()
    const held: { p: string; answer: () => void }[] = []
    let slowMs = 0
    const hang = new Set<string>()
    const ok = new Set([`${W}/src/a.ts`, `${W}/lib/c.ts`])
    const disk: PathFs = {
      realpath: (p) => call(p, () => p),
      stat: (p) => call(p, () => ({ isFile: () => ok.has(p) })),
    }
    function call<T>(p: string, value: () => T): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const answer = (): void => {
          if (p === W || ok.has(p) || p.endsWith('/lib')) resolve(value())
          else reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        }
        if ([...hang].some((d) => p.startsWith(`${d}/`))) held.push({ p, answer })
        else if (slowMs > 0 && p.startsWith(`${W}/slow/`)) setTimeout(answer, slowMs)
        else void Promise.resolve().then(answer)
      })
    }
    const checks = new PathChecks({ fs: disk })
    const one = async (spec: string) => {
      const p = resolve(checks, W, 'src/app.ts', [{ family: 'path', spec }])
      await vi.advanceTimersByTimeAsync(0)
      return p
    }

    // a terminal check on a mount that does not answer: given up at its deadline, its place is left alone
    hang.add(`${W}/m1`)
    const t1 = checks.resolveLinks(W, ['m1/x.ts'], '/home/u')
    await vi.advanceTimersByTimeAsync(L.terminalLinkCheckDeadlineMs)
    expect(await t1).toEqual([null])
    expect(await (await one('m1/y.ts'))[0], 'a place left alone').toBe('unknown')
    // a second hung place: every place in flight is stuck, nothing is checked
    hang.add(`${W}/m2`)
    const t2 = checks.resolveLinks(W, ['m2/x.ts'], '/home/u')
    await vi.advanceTimersByTimeAsync(L.terminalLinkCheckDeadlineMs)
    expect(await t2).toEqual([null])
    expect(checks.counts.hung).toBe(2)
    expect(await (await one('src/a.ts'))[0], 'every place in flight stuck').toBe('unknown')
    for (const h of held.splice(0)) h.answer()
    hang.clear()
    await vi.advanceTimersByTimeAsync(L.terminalLinkHungAfterMs + L.terminalLinkHungPlaceMs)
    expect(await (await one('src/a.ts'))[0]).toEqual({ path: 'src/a.ts' })

    // given up while waiting: a viewer check waits behind another viewer check that hangs; at the hang's deadline both
    // are answered, unknown
    hang.add(`${W}/m3`)
    const two = resolve(checks, W, 'src/app.ts', [
      { family: 'path', spec: 'm3/a.ts' },
      { family: 'path', spec: 'm3/b.ts' },
    ])
    await vi.advanceTimersByTimeAsync(L.terminalLinkCheckDeadlineMs)
    expect(await two).toEqual(['unknown', 'unknown'])
    for (const h of held.splice(0)) h.answer()
    hang.clear()
    await vi.advanceTimersByTimeAsync(L.terminalLinkHungAfterMs + L.terminalLinkHungPlaceMs)

    // the list's budget: a slow (not hung) folder, each call just under the hang deadline; the list stops at the budget
    // with unknown, and no check is given up for it
    slowMs = L.terminalLinkCheckDeadlineMs - 100
    const slow = resolve(checks, W, 'src/app.ts', [{ family: 'import', spec: '../slow/x' }])
    await vi.advanceTimersByTimeAsync(L.viewerLinkListBudgetMs)
    expect(await slow).toEqual(['unknown'])
    await vi.advanceTimersByTimeAsync(slowMs)
    expect(checks.counts).toEqual({ inFlight: 0, waiting: 0, hung: 0 })
    expect(vi.getTimerCount()).toBe(0)
    slowMs = 0

    // dispose during a list, and before one
    hang.add(`${W}/m4`)
    const during = resolve(checks, W, 'src/app.ts', [{ family: 'path', spec: 'm4/a.ts' }])
    await vi.advanceTimersByTimeAsync(0)
    checks.dispose()
    expect(await during).toEqual(['unknown'])
    expect(await resolve(checks, W, 'src/app.ts', [{ family: 'path', spec: 'src/a.ts' }])).toEqual(['unknown'])
    for (const h of held.splice(0)) h.answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
