// Loading the inputs of the trace report from the repository: the plan, test sources and constants/.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SourceFile } from './plan.ts'

/** The kea repository root: the nearest ancestor holding pnpm-workspace.yaml. */
export function repoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const up = dirname(dir)
    if (up === dir) throw new Error('kea repo root not found')
    dir = up
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'target', 'coverage', '.plan', '.vite', 'test-results', 'playwright-report'])

export function walk(dir: string, accept: (path: string) => boolean, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, accept, out)
    } else if (e.isFile() && accept(p)) out.push(p)
  }
  return out
}

export function planFiles(root: string): SourceFile[] {
  const out: SourceFile[] = []
  for (const sub of ['specs', 'plan', 'tests']) {
    const dir = join(root, '.plan', sub)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.md')) out.push({ path: `.plan/${sub}/${f}`, text: readFileSync(join(dir, f), 'utf8') })
    }
  }
  return out
}

const TS_TEST = /\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/

/** Test sources: `*.test.ts(x)` / `*.spec.ts(x)` under app, packages, tools and tests; Rust files under native. */
export function testFiles(root: string): SourceFile[] {
  const paths: string[] = []
  for (const top of ['app', 'packages', 'tools', 'tests']) walk(join(root, top), (p) => TS_TEST.test(p), paths)
  walk(join(root, 'native'), (p) => p.endsWith('.rs'), paths)
  return paths.sort().map((p) => ({ path: relative(root, p), text: readFileSync(p, 'utf8') }))
}

export function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/** One of the plan's private tables (`coverage.tsv`, `constants-owners.tsv`; coverage.ts), when it exists. */
export function planTable(root: string, name: string): SourceFile | undefined {
  const text = readIfExists(join(root, '.plan', name))
  return text === undefined ? undefined : { path: `.plan/${name}`, text }
}
