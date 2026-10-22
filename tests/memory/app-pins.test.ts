// The terminal stack's version pins and the upstream patch set, a static check: nothing is launched. Every `@xterm/*`
// package the renderer, ptyhost and packages/terminal use is installed once, at its pinned version, built from the one
// pinned upstream commit (each package numbers its betas apart, so the `commit` field of its package.json is the real
// pin). Every open upstream bug whose workaround is a patch has its file in patches/, registered and applied, and no
// other patch is there. The pins and the upstream register come from the private specification (`.plan/`): without it
// the test skips, and KEA_REQUIRE_PLAN=1 makes that a failure.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../../tools/perf/src/launch.ts'
import { NO_PLAN, skipsWithoutPlan } from '../../tools/trace/src/presence.ts'

// the pins and the upstream register are read from the specification, which a public clone does not have
const noPlan = skipsWithoutPlan(repoRoot)
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')
const cells = (line: string) => line.split('|').slice(1, -1).map((c) => c.trim())

/** `@xterm/*` name → version, from the specification's stack table. */
function pins(): Map<string, string> {
  const rows = read('.plan/plan/03-architecture.md').split('\n').filter((l) => l.startsWith('| Terminal renderer') || l.startsWith('| Terminal mirror'))
  const out = new Map<string, string>()
  for (const row of rows) {
    const [, choice, pin] = cells(row) as [string, string, string]
    // "`@xterm/xterm` 6.1.0-beta.304, `@xterm/addon-webgl` 0.20.0-beta.300, `-fit` 0.12.0-beta.301, …"
    for (const m of pin.matchAll(/`(@xterm\/[\w-]+|-[\w-]+)` (\d+\.\d+\.\d+-beta\.\d+)/g)) out.set((m[1] as string).startsWith('-') ? `@xterm/addon${m[1]}` : (m[1] as string), m[2] as string)
    // "`@xterm/headless` + `@xterm/addon-serialize` …" with "6.1.0-beta.303 / 0.15.0-beta.301"
    const names = [...choice.matchAll(/`(@xterm\/[\w-]+)`/g)].map((m) => m[1] as string)
    const versions = pin.split(' / ').map((v) => v.trim())
    if (names.length && names.length === versions.length && versions.every((v) => /^\d+\.\d+\.\d+-beta\.\d+$/.test(v))) names.forEach((n, i) => out.set(n, versions[i] as string))
  }
  return out
}

/** The upstream commit the terminal stack is built from, the full hash (from the specification's version-pin row). */
function pinnedCommit(): string {
  const row = read('.plan/specs/13-resources.md')
    .split('\n')
    .find((l) => l.startsWith('| MEM-16 |'))
  const m = row ? /`([0-9a-f]{40})`/.exec(row) : null
  if (!m) throw new Error('the private specification\'s version-pin row names no 40-character upstream commit')
  return m[1] as string
}

/** The packages that use the terminal stack. */
const USERS = ['app/renderer', 'app/ptyhost', 'packages/terminal']

/** `name@version` → patch file, from pnpm-workspace.yaml's `patchedDependencies` (pnpm 11) or package.json's `pnpm`. */
function patchedDependencies(): Map<string, string> {
  const out = new Map<string, string>()
  const pkg = JSON.parse(read('package.json')) as { pnpm?: { patchedDependencies?: Record<string, string> } }
  for (const [k, v] of Object.entries(pkg.pnpm?.patchedDependencies ?? {})) out.set(k, v)
  let inBlock = false
  for (const line of read('pnpm-workspace.yaml').split('\n')) {
    if (/^patchedDependencies:\s*$/.test(line)) inBlock = true
    else if (inBlock && /^\S/.test(line)) inBlock = false
    else if (inBlock) {
      const m = /^\s+['"]?([^'"]+?)['"]?\s*:\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line)
      if (m) out.set(m[1] as string, m[2] as string)
    }
  }
  return out
}

describe('terminal stack pins (static)', () => {
  it('L-MEM-14 · every @xterm package resolves to the pinned build, built from the upstream commit the private specification pins; every patch its upstream register lists is in patches/, registered and applied, and no other', ({ skip }) => {
    skip(noPlan, NO_PLAN)
    const pinned = pins()
    expect([...pinned.keys()].sort(), 'the private specification\'s stack table names the terminal stack').toEqual(
      expect.arrayContaining(['@xterm/xterm', '@xterm/headless', '@xterm/addon-webgl', '@xterm/addon-serialize']),
    )
    const installed = new Map<string, { version: string; dir: string }>()
    for (const user of USERS) {
      const pkg = JSON.parse(read(`${user}/package.json`)) as { dependencies?: Record<string, string> }
      const req = createRequire(path.join(repoRoot, user, 'package.json'))
      for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
        if (!name.startsWith('@xterm/')) continue
        expect(range, `${user}: ${name} pinned exactly as the specification's stack table says`).toBe(pinned.get(name))
        const manifest = req.resolve(`${name}/package.json`)
        const { version, commit } = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version: string; commit?: string }
        expect(version, `${user}: ${name} as installed`).toBe(pinned.get(name))
        expect(commit, `${user}: ${name} built from the specification's pinned upstream commit`).toBe(pinnedCommit())
        const seen = installed.get(name)
        if (seen) expect(path.dirname(manifest), `${name}: one copy for every user`).toBe(seen.dir)
        installed.set(name, { version, dir: path.dirname(manifest) })
      }
    }
    // one installed version of each package in the whole store (no second copy pulled in by something else)
    const store = fs.readdirSync(path.join(repoRoot, 'node_modules', '.pnpm')).filter((d) => d.startsWith('@xterm+'))
    for (const name of installed.keys()) {
      const versions = new Set(store.filter((d) => d.startsWith(`${name.replace('/', '+')}@`)).map((d) => d.slice(name.length + 1).split(/[_(]/)[0]))
      expect([...versions], `${name}: versions in node_modules/.pnpm`).toEqual([installed.get(name)?.version])
    }

    // the upstream register (.plan/plan/09-upstream.md): open rows whose patch column names `patches/`
    const register = read('.plan/plan/09-upstream.md')
      .split('\n')
      .filter((l) => /^\| UP-\d+ \|/.test(l))
      .map(cells)
      .map(([id, component, , , , status, patch]) => ({ id: id as string, component: /`([^`]+)`/.exec(component as string)?.[1] ?? (component as string), status: status as string, patch: patch as string }))
    const wanted = register.filter((r) => r.patch.includes('`patches/`') && !/^fixed/i.test(r.status))
    const registered = patchedDependencies()
    // a patched package outside the terminal stack: the copy the process that uses it runs (`svelte`: the renderer's;
    // `@parcel/watcher`: core's)
    const users = ['app/renderer', 'app/core'].map((u) => createRequire(path.join(repoRoot, u, 'package.json')))
    for (const r of wanted) {
      if (installed.has(r.component)) continue
      for (const req of users) {
        try {
          const manifest = req.resolve(`${r.component}/package.json`)
          installed.set(r.component, { version: (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version: string }).version, dir: path.dirname(manifest) })
          break
        } catch {
          // not this process's: the next, else reported below
        }
      }
    }
    const files = fs.existsSync(path.join(repoRoot, 'patches')) ? fs.readdirSync(path.join(repoRoot, 'patches')).filter((f) => f.endsWith('.patch')) : []
    const problems: string[] = []
    for (const r of wanted) {
      const v = installed.get(r.component)?.version
      if (!v) {
        problems.push(`${r.id}: ${r.component} is not installed`)
        continue
      }
      const file = `patches/${r.component.replace('/', '__')}@${v}.patch`
      if (!files.includes(path.basename(file))) problems.push(`${r.id}: no ${file}`)
      if (registered.get(`${r.component}@${v}`) !== file) problems.push(`${r.id}: ${r.component}@${v} is not in patchedDependencies as ${file}`)
      // pnpm installs a patched package under a store directory carrying the patch hash
      else if (!installed.get(r.component)?.dir.includes('patch_hash=')) problems.push(`${r.id}: the installed ${r.component} is not the patched build`)
    }
    // no patch without an open row: a fixed row's patch must go
    for (const f of files) if (!wanted.some((r) => f.startsWith(`${r.component.replace('/', '__')}@`))) problems.push(`patches/${f}: no open row of the private specification's upstream register asks for it`)
    expect(problems, 'the upstream patch set (the private specification\'s upstream register and the "Upstream patches" row of its stack table)').toEqual([])
  })
})
