// The aliases a file's imports may use, read from the nearest tsconfig or jsconfig in temp worktrees: paths and baseUrl,
// extends chains and a solution file's references, the caps, broken and missing configs, the cache and the $lib fallback.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { noopLogger, type Clock } from '@kea/kit'
import { L, type CallContext } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { PathChecks } from '../editor/paths.ts'
import { StubGitFacts } from '../files/facts.ts'
import { VisibleSet } from '../platform/visible.ts'
import { StubWatchService } from '../platform/watch/stub.ts'
import { aliasesFor, ConfigReader, findProject, type Aliases } from './aliases.ts'
import { ViewerService } from './service.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** A worktree holding `files` (a value that is an object is written as JSON): its real path. */
function tree(files: Record<string, string | object>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-aliases-')))
  dirs.push(root)
  write(root, files)
  return root
}

function write(root: string, files: Record<string, string | object>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body))
  }
}

/** The aliases for the file `from` in `root`, read as `viewer.resolveRefs` reads them. */
async function aliasesOf(root: string, from: string, configs = new ConfigReader(), session = 'S'): Promise<{ a: Aliases; match: (spec: string) => string[] }> {
  const checks = new PathChecks()
  const req = checks.begin('viewer')
  try {
    const project = await findProject(path.join(root, from), root, req)
    if (typeof project === 'symbol') throw new Error('not checked')
    const a = await aliasesFor(project, configs, { req, root, session }, root)
    if (typeof a === 'symbol') throw new Error('not checked')
    return { a, match: (spec) => a.match(spec).map((p) => path.relative(root, p)) }
  } finally {
    req.end()
    checks.dispose()
  }
}

const config = (compilerOptions: object, more: object = {}) => ({ compilerOptions, ...more })

describe('aliases of a file’s config', () => {
  it('U-FV-41 · paths with and without baseUrl, the longest prefix, an exact pattern, fallback lists, a catch-all *, baseUrl for bare specifiers', async () => {
    const root = tree({
      'tsconfig.json': config({ paths: { '@/*': ['./src/*', './generated/*'], '@/components/*': ['ui/*'], config: ['./config/index.ts'], '*': ['./types/*', './node_modules/*'] } }),
      'src/a/b.ts': 'x',
      'web/tsconfig.json': config({ baseUrl: './src', paths: { '~/*': ['./*'] } }),
      'web/src/c.ts': 'x',
    })
    const { match } = await aliasesOf(root, 'src/a/b.ts')
    expect(match('@/lib/x')).toEqual(['src/lib/x', 'generated/lib/x'])
    expect(match('@/components/Button')).toEqual(['ui/Button'])
    expect(match('config')).toEqual(['config/index.ts'])
    // a catch-all matches every bare specifier; its `node_modules` target is dropped before it is checked (fileRefs.ts)
    expect(match('react')).toEqual(['types/react', 'node_modules/react'])
    // with baseUrl the targets resolve from it, and a bare specifier is tried from it too
    const web = await aliasesOf(root, 'web/src/c.ts')
    expect(web.match('~/lib/x')).toEqual(['web/src/lib/x'])
    expect(web.a.baseUrl).toBe(path.join(root, 'web/src'))
    // `~/` is an alias only where paths has it, never the home folder
    expect(match('~/lib/x')).toEqual(['types/~/lib/x', 'node_modules/~/lib/x'])
  })

  it('U-FV-41 · extends: paths from an extended config resolve from that config; a list (the later wins), into node_modules and a bare package; ${configDir}; a missing link keeps the rest; a loop ends', async () => {
    const root = tree({
      'configs/base.json': config({ paths: { '@app/*': ['../app/*'] } }),
      'one/tsconfig.json': { extends: './../configs/base' },
      'one/a.ts': 'x',
      'two/a.json': config({ paths: { '@a/*': ['a/*'] } }),
      'two/b.json': config({ paths: { '@b/*': ['b/*'] } }),
      'two/tsconfig.json': { extends: ['./a.json', './b.json'] },
      'two/a.ts': 'x',
      'node_modules/@tsconfig/x/tsconfig.json': config({ paths: { '@nm/*': ['./nm/*'] } }),
      'three/tsconfig.json': { extends: '@tsconfig/x/tsconfig.json' },
      'three/a.ts': 'x',
      'node_modules/@kea/cfg/package.json': { name: '@kea/cfg', tsconfig: './strict.json' },
      'node_modules/@kea/cfg/strict.json': config({ paths: { '@pkg/*': ['${configDir}/src/*'] } }),
      'four/tsconfig.json': { extends: '@kea/cfg' },
      'four/a.ts': 'x',
      'five/tsconfig.json': { extends: './.svelte-kit/tsconfig.json', ...config({ paths: { '@own/*': ['own/*'] } }) },
      'five/a.ts': 'x',
      'six/a.json': { extends: './b.json', ...config({ paths: { '@loop/*': ['loop/*'] } }) },
      'six/b.json': { extends: './a.json' },
      'six/tsconfig.json': { extends: './b.json' },
      'six/a.ts': 'x',
    })
    expect((await aliasesOf(root, 'one/a.ts')).match('@app/x')).toEqual(['app/x'])
    const two = await aliasesOf(root, 'two/a.ts')
    expect(two.match('@b/x')).toEqual(['two/b/x'])
    expect(two.match('@a/x'), 'the later entry of the list overrides the earlier one').toEqual([])
    expect((await aliasesOf(root, 'three/a.ts')).match('@nm/x')).toEqual(['node_modules/@tsconfig/x/nm/x'])
    // a bare package's config is the one its package.json names; ${configDir} is the extending config's folder
    expect((await aliasesOf(root, 'four/a.ts')).match('@pkg/x')).toEqual(['four/src/x'])
    // `.svelte-kit/tsconfig.json` before setup: only that link goes
    expect((await aliasesOf(root, 'five/a.ts')).match('@own/x')).toEqual(['five/own/x'])
    expect((await aliasesOf(root, 'six/a.ts')).match('@loop/x')).toEqual(['six/loop/x'])
  })

  it('U-FV-41 · a solution file’s references are read and their paths merged in order; JSONC comments and trailing commas parse', async () => {
    const root = tree({
      'tsconfig.json': '// Vite\n{\n  "files": [],\n  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" },],\n}\n',
      'tsconfig.app.json': '{\n  /* the app */\n  "compilerOptions": { "paths": { "@/*": ["./src/*"], }, },\n}',
      'tsconfig.node.json': config({ paths: { '@scripts/*': ['./scripts/*'], '@/*': ['./other/*'] } }),
      'src/main.ts': 'x',
    })
    const { match } = await aliasesOf(root, 'src/main.ts')
    expect(match('@/x')).toEqual(['src/x'])
    expect(match('@scripts/build')).toEqual(['scripts/build'])
  })

  it('U-FV-41 · a config too large, broken, not a regular file or out of the worktree gives no aliases, and that is no error; at most L.viewerAliasExtendsMax configs are read', async () => {
    const root = tree({
      'big/tsconfig.json': `{"compilerOptions":{"paths":{"@/*":["src/*"]}},"pad":"${'x'.repeat(L.viewerAliasFileMaxBytes)}"}`,
      'big/a.ts': 'x',
      'broken/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["src/*"] ',
      'broken/a.ts': 'x',
      'dir/a.ts': 'x',
      'long/a.ts': 'x',
    })
    fs.mkdirSync(path.join(root, 'dir/tsconfig.json'))
    expect((await aliasesOf(root, 'big/a.ts')).match('@/x')).toEqual([])
    expect((await aliasesOf(root, 'broken/a.ts')).match('@/x')).toEqual([])
    expect((await aliasesOf(root, 'dir/a.ts')).a.entries).toEqual([])
    // a link out of the worktree is never read
    const outside = tree({ 'tsconfig.json': config({ paths: { '@/*': ['src/*'] } }) })
    fs.mkdirSync(path.join(root, 'out'))
    fs.symlinkSync(path.join(outside, 'tsconfig.json'), path.join(root, 'out/tsconfig.json'))
    write(root, { 'out/a.ts': 'x' })
    expect((await aliasesOf(root, 'out/a.ts')).match('@/x')).toEqual([])
    // a chain longer than the cap: the configs past it are not read
    const n = L.viewerAliasExtendsMax + 2
    const chain: Record<string, object> = { 'long/tsconfig.json': { extends: './c1.json' } }
    for (let i = 1; i < n; i++) chain[`long/c${i}.json`] = { extends: `./c${i + 1}.json` }
    chain[`long/c${n}.json`] = config({ paths: { '@deep/*': ['deep/*'] } })
    chain[`long/c${L.viewerAliasExtendsMax - 1}.json`] = { extends: `./c${L.viewerAliasExtendsMax}.json`, ...config({ paths: { '@near/*': ['near/*'] } }) }
    write(root, chain)
    const long = await aliasesOf(root, 'long/a.ts')
    expect(long.match('@deep/x')).toEqual([])
    expect(long.match('@near/x')).toEqual(['long/near/x'])
  })

  it('U-FV-41 · parsed configs are kept by real path, modification time and size: a changed config is read again; a session’s go when no window shows it', async () => {
    const root = tree({ 'tsconfig.json': config({ paths: { '@/*': ['src/*'] } }), 'src/a.ts': 'x' })
    const configs = new ConfigReader()
    expect((await aliasesOf(root, 'src/a.ts', configs)).match('@/x')).toEqual(['src/x'])
    expect(configs.size).toBe(1)
    write(root, { 'tsconfig.json': config({ paths: { '@/*': ['lib/*'] } }) })
    fs.utimesSync(path.join(root, 'tsconfig.json'), new Date(), new Date(Date.now() + 5000))
    expect((await aliasesOf(root, 'src/a.ts', configs)).match('@/x')).toEqual(['lib/x'])
    expect(configs.size).toBe(1)
    expect((await aliasesOf(root, 'src/a.ts', configs, 'T')).match('@/x')).toEqual(['lib/x'])
    expect(configs.size).toBe(2)
    configs.forget('S')
    expect(configs.size).toBe(1)

    // through the viewer service: a session no window shows keeps none
    const visible = new VisibleSet()
    const clock: Clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined }
    const service = new ViewerService({ log: noopLogger, cwd: () => root, visible, watch: new StubWatchService(), git: new StubGitFacts(), gitEnv: async () => ({}), openTool: null, clock })
    const win = {}
    const ctx = { peer: win, signal: new AbortController().signal } as unknown as CallContext
    visible.set(win, 'S')
    const r = await service.handlers()['viewer.resolveRefs']!({ sessionId: 'S', from: 'src/a.ts', refs: [{ family: 'import', spec: '@/a' }] }, ctx)
    expect(r).toEqual({ refs: [null] })
    expect(service.resourceCounts.aliases).toBe(1)
    visible.set(win, 'other')
    expect(service.resourceCounts.aliases).toBe(0)
    service.dispose()
  })

  it('U-FV-41 · a SvelteKit project whose configs name no $lib has $lib as src/lib beside the nearest package.json; one that names it keeps its own', async () => {
    const root = tree({ 'apps/kit/package.json': { name: 'kit' }, 'apps/kit/svelte.config.js': 'export default {}', 'apps/kit/src/routes/+page.svelte': 'x', 'package.json': { name: 'root' } })
    const fresh = await aliasesOf(root, 'apps/kit/src/routes/+page.svelte')
    expect(fresh.match('$lib/user')).toEqual(['apps/kit/src/lib/user'])
    expect(fresh.match('$lib')).toEqual(['apps/kit/src/lib'])
    write(root, { 'apps/kit/tsconfig.json': { extends: './.svelte-kit/tsconfig.json' }, 'apps/kit/.svelte-kit/tsconfig.json': config({ paths: { $lib: ['../src/lib'], '$lib/*': ['../src/lib/*'], '$app/*': ['../node_modules/@sveltejs/kit/src/runtime/app/*'] } }) })
    const set = await aliasesOf(root, 'apps/kit/src/routes/+page.svelte')
    expect(set.match('$lib/user')).toEqual(['apps/kit/src/lib/user'])
    expect(set.a.entries.filter((e) => e.pattern === '$lib/*')).toHaveLength(1)
    // without svelte.config.* it is no SvelteKit project
    const plain = tree({ 'package.json': { name: 'p' }, 'src/a.ts': 'x' })
    expect((await aliasesOf(plain, 'src/a.ts')).match('$lib/user')).toEqual([])
  })
})
