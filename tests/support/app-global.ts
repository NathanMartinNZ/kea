// Global setup and teardown of the app-level suites (chaos, memory and e2e). Setup builds the app they launch into
// dist/test-app-<tag> (app.ts `testAppDist`): its own directory per Vitest invocation, so a `pnpm dev` or `pnpm perf`
// rebuilding dist/app, or another invocation, never pulls files from under a running test; the leak suite's, whose
// project `env` asks for Svelte without its dev mode, goes into dist/test-app-<tag>-svelte. It also builds the release
// kea-helper the app runs (cargo does nothing when it is current; an older one would lack what core now asks of it,
// such as `procs`). Teardown fails if anything an app-level run started is still alive or still on disk. Strays
// are removed even then, so one bad test cannot leak into the next run; processes of other runs (the installed app,
// other suites) are never touched.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { processTable, repoRoot } from '../../tools/perf/src/launch.ts'
import { cleanupHome, homePrefix, RUN_TAG_ENV, svelteProduction, testAppDist } from './app.ts'

const HELPER = path.join(repoRoot, 'native/kea-helper/target/release/kea-helper')

function homesOf(args: string, prefix: string): string[] {
  const out: string[] = []
  const re = new RegExp(`(/[^ ]*?/${prefix}[^/ ]+)`, 'g')
  for (const m of args.matchAll(re)) out.push(m[1] as string)
  return out
}

/** `project`: Vitest's (its `env` is the project's); Playwright passes its config, which has none. */
export default function setup(project?: { config?: { env?: Record<string, string | undefined> } }): () => void {
  const env = project?.config?.env ?? {}
  // this invocation's tag: its homes are kea-test-app-<tag>-*, and only those are this teardown's business
  process.env[RUN_TAG_ENV] = Math.random().toString(36).slice(2, 8)
  const prefix = homePrefix()
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'tools/cargo.ts'), 'build', '--release', '--manifest-path', path.join(repoRoot, 'native/kea-helper/Cargo.toml')], { stdio: 'inherit' })
  if (r.status !== 0 || !fs.existsSync(HELPER)) throw new Error('kea-helper release build failed (pnpm helper:build)')
  const dist = testAppDist(env)
  // a dev build: development main, core and ptyhost, and the renderer in Vite's development mode, whose Svelte follows
  // NODE_ENV (its dev mode under Vitest, whose NODE_ENV is `test`), except the leak suite's (`--svelte-production`:
  // Svelte without its dev mode whatever NODE_ENV is)
  const built = spawnSync(process.execPath, [path.join(repoRoot, 'tools/build.ts'), '--out', path.relative(repoRoot, dist), ...(svelteProduction(env) ? ['--svelte-production'] : [])], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  if (built.status !== 0) throw new Error(`building ${dist} failed:\n${built.stdout}\n${built.stderr}`)
  const tmp = fs.realpathSync(os.tmpdir())

  return function teardown() {
    const strays = processTable().filter((p) => p.args.includes(`/${prefix}`))
    const homes = new Set(strays.flatMap((p) => homesOf(p.args, prefix)))
    const dirs = fs.readdirSync(tmp).filter((d) => d.startsWith(prefix))
    for (const d of dirs) homes.add(path.join(tmp, d))
    for (const h of homes) cleanupHome(h)
    fs.rmSync(dist, { recursive: true, force: true })
    const problems = [...strays.map((p) => `process ${p.pid} ${p.args.slice(0, 160)}`), ...dirs.map((d) => `directory ${path.join(tmp, d)}`)]
    if (problems.length) throw new Error(`app-level runs left these behind (now removed):\n  ${problems.join('\n  ')}`)
  }
}
