// The `large` repo: 300 000 committed files in one commit, with the fixed author and date of `tiny` and its
// repo-factory marker. Two shapes side by side, as a big repository has: wide generated folders (`data/dNNN/`, 100
// folders of 2 000 records each: exactly one first page of a big directory, L.dirFirstPage) and a source tree
// (`src/mNNN/`, 1 000 modules of 100 files).
// The budgets that name it measure git on a work tree of this size (P-GS-2) and a tree view with as many rows loaded
// as a session's directory cache holds (P-FT-3).
//
// Generated once and cached: the commit is written straight into a bare repository with `git fast-import` (no file
// touches the disk; a few seconds) and kept under `node_modules/.cache/kea-repo-factory/` (`KEA_FIXTURE_CACHE` names
// another folder). Each `largeRepo()` is a clone of its own from that template: its objects are hard links (or copies,
// across volumes), its work tree is checked out in full (300 000 files: the slow part, tens of seconds), and it has no
// remote, like the other shapes. Nothing a test does to its clone reaches the template.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURE_REPO_MARKER } from '../../scrubber/src/guard.ts'
import { FIXTURE_AUTHOR, fixtureGitEnv, type FixtureRepo } from './tiny.ts'

/** How many files the commit holds. */
export const LARGE_FILES = 300_000
/** `data/dNNN/`: folders of generated records, each exactly one first page of a big directory. */
export const LARGE_DATA_DIRS = 100
export const LARGE_DATA_PER_DIR = 2000
/** `src/mNNN/`: source modules of `LARGE_FILES_PER_MODULE` files (the last one is short by the top-level files). */
export const LARGE_MODULES = 1000
export const LARGE_FILES_PER_MODULE = 100
/** The template's name: changed whenever the shape or the content below changes. */
const TEMPLATE = 'large-v2.git'
/** 2026-01-01T12:00:00Z, `tiny`'s fixed date, as fast-import wants it. */
const FIXED_EPOCH = 1_767_268_800

const TOP_LEVEL: Record<string, string> = {
  [FIXTURE_REPO_MARKER]: '',
  'README.md': '# large\n\nA large project used for Kea measurements.\n',
  'package.json': `${JSON.stringify({ name: 'large', version: '1.0.0', private: true, type: 'module' }, null, 2)}\n`,
  '.gitignore': 'node_modules/\ndist/\n',
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0')

/** The path of record `i` of data folder `dir` (both wrap). */
export function largeDataFile(dir: number, i: number): string {
  return `data/d${pad(dir % LARGE_DATA_DIRS, 3)}/r${pad(i % LARGE_DATA_PER_DIR, 4)}.json`
}

/** The path of source file `i` of `module` (both wrap; the last module's last files do not exist: see `largeFiles`). */
export function largeSourceFile(module: number, i: number): string {
  return `src/m${pad(module % LARGE_MODULES, 3)}/f${pad(i % LARGE_FILES_PER_MODULE, 3)}.ts`
}

/** Every committed file with its content, in a fixed order: exactly `LARGE_FILES` of them. */
export function* largeFiles(): Generator<[string, string]> {
  let n = 0
  for (const e of Object.entries(TOP_LEVEL)) {
    n++
    yield e
  }
  for (let d = 0; d < LARGE_DATA_DIRS; d++) {
    for (let i = 0; i < LARGE_DATA_PER_DIR; i++, n++) yield [largeDataFile(d, i), `{ "dir": ${d}, "record": ${i}, "label": "d${d}-r${i}" }\n`]
  }
  for (let m = 0; m < LARGE_MODULES && n < LARGE_FILES; m++) {
    for (let i = 0; i < LARGE_FILES_PER_MODULE && n < LARGE_FILES; i++, n++) yield [largeSourceFile(m, i), `// m${m}/f${i}\nexport function f${i}(x: number): number {\n  return x * ${i + 1} + ${m}\n}\n`]
  }
}

/** Where the template is kept: `KEA_FIXTURE_CACHE`, else this checkout's `node_modules/.cache/kea-repo-factory`. */
export function fixtureCacheDir(): string {
  return process.env.KEA_FIXTURE_CACHE || join(import.meta.dirname, '../../..', 'node_modules', '.cache', 'kea-repo-factory')
}

/** The whole commit as a `git fast-import` stream. */
function importStream(): Buffer {
  const who = `${FIXTURE_AUTHOR.name} <${FIXTURE_AUTHOR.email}> ${FIXED_EPOCH} +0000`
  const message = 'Initial commit'
  const parts: string[] = [`commit refs/heads/main\nauthor ${who}\ncommitter ${who}\ndata ${Buffer.byteLength(message)}\n${message}\n`]
  for (const [rel, content] of largeFiles()) parts.push(`M 100644 inline ${rel}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
  parts.push('\ndone\n')
  return Buffer.from(parts.join(''))
}

/**
 * The cached template (a bare repository holding the one commit), built on first use. Built aside and renamed into
 * place, so a build that was interrupted, or two at once, never leave a half-written template behind.
 */
export function largeTemplate(cache = fixtureCacheDir()): string {
  const template = join(cache, TEMPLATE)
  if (existsSync(join(template, 'HEAD'))) return template
  mkdirSync(cache, { recursive: true })
  const aside = mkdtempSync(join(cache, `${TEMPLATE}.tmp-`))
  const env = fixtureGitEnv()
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', aside], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['-C', aside, 'fast-import', '--quiet', '--done'], { env, input: importStream(), stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    const files = execFileSync('git', ['-C', aside, 'ls-tree', '-r', '--name-only', 'main'], { env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    const count = files.toString('utf8').split('\n').filter(Boolean).length
    if (count !== LARGE_FILES) throw new Error(`the large template has ${count} files, not ${LARGE_FILES}`)
    try {
      renameSync(aside, template)
    } catch (e) {
      // another builder got there first: its template is the same commit
      if (!existsSync(join(template, 'HEAD'))) throw e
    }
  } finally {
    rmSync(aside, { recursive: true, force: true })
  }
  return template
}

/**
 * Create a large repo in a new directory under `parent` (default: the OS temp dir): a clone of the cached template
 * with its 300 000 files checked out and no remote.
 */
export function largeRepo(opts: { parent?: string; name?: string; cache?: string } = {}): FixtureRepo {
  const template = largeTemplate(opts.cache)
  const parent = opts.parent ?? tmpdir()
  const holder = realpathSync(mkdtempSync(join(parent, 'kea-fixture-')))
  const root = join(holder, opts.name ?? 'large')
  const env = fixtureGitEnv()
  try {
    // the checkout is 300 000 small files: git's parallel checkout, one worker per core
    execFileSync('git', ['-c', 'checkout.workers=0', 'clone', '-q', '--local', '--branch', 'main', template, root], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['-C', root, 'remote', 'remove', 'origin'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    // the index as git itself would refresh it on first use, so the first status of a test is not the one that pays for it
    execFileSync('git', ['-C', root, 'update-index', '-q', '--refresh'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    rmSync(holder, { recursive: true, force: true })
    throw e
  }
  return { root, dispose: () => rmSync(holder, { recursive: true, force: true }) }
}
