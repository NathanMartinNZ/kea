// The `tiny` demo repo: ten small files with a fixed author and date, marked as a repo-factory repo so recorders may
// run in it (tools/scrubber/src/guard.ts). The files are what tools/recorder/demo-prompts.json talks about
// (`src/math.js`, the greeting typo in `src/hello.js`, `x` in `src/counter.js`, the tests).
//
// git runs with no global or system config, so the user's identity, hooks, signing and templates never reach it.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FIXTURE_REPO_MARKER } from '../../scrubber/src/guard.ts'

export const FIXTURE_AUTHOR = { name: 'Kea Fixture', email: 'fixture@example.invalid' }
const FIXED_DATE = '2026-01-01T12:00:00Z'

export const TINY_FILES: Record<string, string> = {
  [FIXTURE_REPO_MARKER]: '',
  'README.md': '# demo\n\nA tiny project used for Kea recordings.\n',
  'package.json': `${JSON.stringify({ name: 'demo', version: '1.0.0', private: true, type: 'module', scripts: { test: 'node --test test/' } }, null, 2)}\n`,
  '.gitignore': 'node_modules/\n',
  'src/math.js': 'export function add(a, b) {\n  return a + b\n}\n\nexport function sub(a, b) {\n  return a - b\n}\n',
  'src/hello.js': "export function greet(name) {\n  return `Helo, ${name}!`\n}\n",
  'src/counter.js': 'let x = 0\n\nexport function next() {\n  x += 1\n  return x\n}\n',
  'src/index.js': "import { add } from './math.js'\nimport { greet } from './hello.js'\n\nconsole.log(greet('world'), add(2, 3))\n",
  'test/math.test.js': "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { add, sub } from '../src/math.js'\n\ntest('add', () => assert.equal(add(2, 3), 5))\ntest('sub', () => assert.equal(sub(5, 3), 2))\n",
  'test/counter.test.js': "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { next } from '../src/counter.js'\n\ntest('counts up', () => {\n  assert.equal(next(), 1)\n  assert.equal(next(), 2)\n})\n",
}

/** The environment every repo-factory git command runs with. */
export function fixtureGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: base.PATH ?? '/usr/bin:/bin',
    HOME: tmpdir(),
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: FIXTURE_AUTHOR.name,
    GIT_AUTHOR_EMAIL: FIXTURE_AUTHOR.email,
    GIT_COMMITTER_NAME: FIXTURE_AUTHOR.name,
    GIT_COMMITTER_EMAIL: FIXTURE_AUTHOR.email,
    GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_DATE: FIXED_DATE,
  }
}

export interface FixtureRepo {
  /** The work tree (symlinks resolved, so it matches what a child sees as its cwd). */
  root: string
  dispose(): void
}

/** Create the tiny repo in a new directory under `parent` (default: the OS temp dir). */
export function tinyRepo(opts: { parent?: string; name?: string } = {}): FixtureRepo {
  const parent = opts.parent ?? tmpdir()
  const holder = realpathSync(mkdtempSync(join(parent, 'kea-fixture-')))
  const root = join(holder, opts.name ?? 'demo')
  mkdirSync(root)
  for (const [rel, content] of Object.entries(TINY_FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  const env = fixtureGitEnv()
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'Initial commit')
  return { root, dispose: () => rmSync(holder, { recursive: true, force: true }) }
}
