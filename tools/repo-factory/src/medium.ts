// The `medium` repo: 20 000 committed files — a mid-sized TypeScript project's shape, modules of source files with
// their tests, docs and config — with the fixed author and date of `tiny` and its repo-factory marker. Generated on
// demand in a few seconds (`large` is the one generated once and cached). The perf budgets that name it (P-WT-1,
// P-UI-5) measure git work on a repository of this size.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURE_REPO_MARKER } from '../../scrubber/src/guard.ts'
import { fixtureGitEnv, type FixtureRepo } from './tiny.ts'

/** How many files the commit holds. */
export const MEDIUM_FILES = 20_000
/** Source modules, each a directory of `FILES_PER_MODULE` files (and a test for every fourth). */
const MODULES = 156
const FILES_PER_MODULE = 100
const TESTS_PER_MODULE = FILES_PER_MODULE / 4
/** The rest: docs and fixtures, to reach MEDIUM_FILES with the marker and the top-level files. */
const TOP_LEVEL: Record<string, string> = {
  [FIXTURE_REPO_MARKER]: '',
  'README.md': '# medium\n\nA medium-sized project used for Kea measurements.\n',
  'package.json': `${JSON.stringify({ name: 'medium', version: '1.0.0', private: true, type: 'module' }, null, 2)}\n`,
  '.gitignore': 'node_modules/\ndist/\n',
}

/** The relative path and content of file `i` of `module` (deterministic, a few hundred bytes each). */
function sourceFile(module: number, i: number): [string, string] {
  const name = `m${String(module).padStart(3, '0')}`
  return [`src/${name}/f${String(i).padStart(3, '0')}.ts`, `// ${name}/f${i}\nexport function f${i}(x: number): number {\n  return x * ${i + 1} + ${module}\n}\n\nexport const label${i} = '${name}-${i}'\n`]
}

/** Create the medium repo in a new directory under `parent` (default: the OS temp dir). */
export function mediumRepo(opts: { parent?: string; name?: string } = {}): FixtureRepo {
  const parent = opts.parent ?? tmpdir()
  const holder = realpathSync(mkdtempSync(join(parent, 'kea-fixture-')))
  const root = join(holder, opts.name ?? 'medium')
  mkdirSync(root)
  let files = 0
  const write = (rel: string, content: string) => {
    writeFileSync(join(root, rel), content)
    files++
  }
  for (const [rel, content] of Object.entries(TOP_LEVEL)) write(rel, content)
  for (let m = 0; m < MODULES; m++) {
    const name = `m${String(m).padStart(3, '0')}`
    mkdirSync(join(root, 'src', name), { recursive: true })
    mkdirSync(join(root, 'test', name), { recursive: true })
    for (let i = 0; i < FILES_PER_MODULE; i++) write(...sourceFile(m, i))
    for (let i = 0; i < TESTS_PER_MODULE; i++) write(`test/${name}/f${String(i).padStart(3, '0')}.test.ts`, `import { f${i} } from '../../src/${name}/f${String(i).padStart(3, '0')}.ts'\n\nif (f${i}(1) !== ${i + 1 + m}) throw new Error('f${i}')\n`)
  }
  mkdirSync(join(root, 'docs'), { recursive: true })
  for (let d = 0; files < MEDIUM_FILES; d++) write(`docs/page-${String(d).padStart(4, '0')}.md`, `# Page ${d}\n\nSome documentation.\n`)
  const env = fixtureGitEnv()
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'Initial commit')
  return { root, dispose: () => rmSync(holder, { recursive: true, force: true }) }
}

/** The path of a committed source file of the medium repo (for tests that modify some). */
export function mediumSourceFile(module: number, i: number): string {
  return sourceFile(module % MODULES, i % FILES_PER_MODULE)[0]
}
