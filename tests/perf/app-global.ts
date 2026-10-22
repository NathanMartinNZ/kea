// Global setup of the perf project. Like the chaos and memory suites' (tests/support/app-global.ts), it tags this
// Vitest invocation, so its app runs use their own `kea-test-app-<tag>-*` homes and `dist/test-app-<tag>`, and makes
// sure the release kea-helper exists. Unlike them, the app is built on first use, as a release bundle
// (tests/perf/app-harness.ts `ensureBuild`: budgets are measured on the production bundle, with no development-only
// checks), so a run of only the in-process benchmarks builds nothing. Teardown removes the build and fails if anything
// an app-level run started is still alive or on disk; strays are removed even then. Processes of other runs (the
// installed app, other suites, other invocations) are never touched.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { processTable, repoRoot } from '../../tools/perf/src/launch.ts'
import { cleanupHome, homePrefix, RUN_TAG_ENV, testAppDist } from '../support/app.ts'

const HELPER = path.join(repoRoot, 'native/kea-helper/target/release/kea-helper')

function homesOf(args: string, prefix: string): string[] {
  const out: string[] = []
  for (const m of args.matchAll(new RegExp(`(/[^ ]*?/${prefix}[^/ ]+)`, 'g'))) out.push(m[1] as string)
  return out
}

export default function setup(): () => void {
  process.env[RUN_TAG_ENV] = `perf${Math.random().toString(36).slice(2, 8)}`
  const prefix = homePrefix()
  if (!fs.existsSync(HELPER)) {
    const r = spawnSync(process.execPath, [path.join(repoRoot, 'tools/cargo.ts'), 'build', '--release', '--manifest-path', path.join(repoRoot, 'native/kea-helper/Cargo.toml')], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('kea-helper release build failed (pnpm helper:build)')
  }
  const dist = testAppDist()
  const tmp = fs.realpathSync(os.tmpdir())

  return function teardown() {
    const strays = processTable().filter((p) => p.args.includes(`/${prefix}`))
    const homes = new Set(strays.flatMap((p) => homesOf(p.args, prefix)))
    const dirs = fs.readdirSync(tmp).filter((d) => d.startsWith(prefix))
    for (const d of dirs) homes.add(path.join(tmp, d))
    for (const h of homes) cleanupHome(h)
    fs.rmSync(dist, { recursive: true, force: true })
    const problems = [...strays.map((p) => `process ${p.pid} ${p.args.slice(0, 160)}`), ...dirs.map((d) => `directory ${path.join(tmp, d)}`)]
    if (problems.length) throw new Error(`app-level perf runs left these behind (now removed):\n  ${problems.join('\n  ')}`)
  }
}
