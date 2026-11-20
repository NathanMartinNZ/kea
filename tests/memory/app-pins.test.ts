// The terminal stack's version pins and the upstream patch set, a static check: nothing is launched. Every `@xterm/*`
// package the renderer, ptyhost and packages/terminal use is installed once, at its pinned version, built from the one
// pinned upstream commit (each package numbers its betas apart, so the `commit` field of its package.json is the real
// pin). Every patch declared in patches/manifest.json exists in patches/, is registered and applied, and no undeclared
// patch is present.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../../tools/perf/src/launch.ts'

const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')

interface PatchManifest {
  terminalStack: {
    commit: string
    packages: Record<string, string>
  }
  patches: {
    package: string
    version: string
    file: string
    issues?: string[]
    reason: string
    dropWhen: string
  }[]
}

function readManifest(): PatchManifest {
  return JSON.parse(read('patches/manifest.json')) as PatchManifest
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
  it('L-MEM-14 · every @xterm package resolves to the pinned build and commit in patches/manifest.json; every declared patch is in patches/, registered and applied, and no other', () => {
    const manifest = readManifest()
    const pinned = new Map(Object.entries(manifest.terminalStack.packages))
    const pinnedCommit = manifest.terminalStack.commit
    expect(pinnedCommit, 'patches/manifest.json terminalStack.commit is a 40-character commit hash').toMatch(/^[0-9a-f]{40}$/)
    expect([...pinned.keys()].sort(), 'patches/manifest.json names the terminal stack').toEqual(
      expect.arrayContaining(['@xterm/xterm', '@xterm/headless', '@xterm/addon-webgl', '@xterm/addon-serialize']),
    )
    const installed = new Map<string, { version: string; dir: string }>()
    for (const user of USERS) {
      const pkg = JSON.parse(read(`${user}/package.json`)) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      const req = createRequire(path.join(repoRoot, user, 'package.json'))
      for (const [name, range] of [...Object.entries(pkg.dependencies ?? {}), ...Object.entries(pkg.devDependencies ?? {})]) {
        if (!name.startsWith('@xterm/')) continue
        expect(range, `${user}: ${name} pinned as patches/manifest.json says`).toBe(pinned.get(name))
        const manifestPath = req.resolve(`${name}/package.json`)
        const { version, commit } = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version: string; commit?: string }
        expect(version, `${user}: ${name} as installed`).toBe(pinned.get(name))
        expect(commit, `${user}: ${name} built from the pinned upstream commit`).toBe(pinnedCommit)
        const seen = installed.get(name)
        if (seen) expect(path.dirname(manifestPath), `${name}: one copy for every user`).toBe(seen.dir)
        installed.set(name, { version, dir: path.dirname(manifestPath) })
      }
    }
    // one installed version of each package in the whole store (no second copy pulled in by something else)
    const store = fs.readdirSync(path.join(repoRoot, 'node_modules', '.pnpm')).filter((d) => d.startsWith('@xterm+'))
    for (const name of installed.keys()) {
      const versions = new Set(store.filter((d) => d.startsWith(`${name.replace('/', '+')}@`)).map((d) => d.slice(name.length + 1).split(/[_(]/)[0]))
      expect([...versions], `${name}: versions in node_modules/.pnpm`).toEqual([installed.get(name)?.version])
    }

    const registered = patchedDependencies()
    // a patched package outside the terminal stack: the copy the process that uses it runs (`svelte`: the renderer's;
    // `@parcel/watcher`: core's; `electron-updater`: main's)
    const users = ['app/renderer', 'app/core', 'app/main'].map((u) => createRequire(path.join(repoRoot, u, 'package.json')))
    for (const r of manifest.patches) {
      if (installed.has(r.package)) continue
      for (const req of users) {
        try {
          const manifestPath = req.resolve(`${r.package}/package.json`)
          installed.set(r.package, { version: (JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version: string }).version, dir: path.dirname(manifestPath) })
          break
        } catch {
          // not this process's: the next, else reported below
        }
      }
    }

    const files = fs.existsSync(path.join(repoRoot, 'patches')) ? fs.readdirSync(path.join(repoRoot, 'patches')).filter((f) => f.endsWith('.patch')) : []
    const problems: string[] = []
    const declaredKeys = new Set<string>()
    for (const r of manifest.patches) {
      if (!r.reason.trim()) problems.push(`${r.package}: missing reason in patches/manifest.json`)
      if (!r.dropWhen.trim()) problems.push(`${r.package}: missing dropWhen in patches/manifest.json`)
      const v = installed.get(r.package)?.version
      if (!v) {
        problems.push(`${r.package}: not installed`)
        continue
      }
      if (v !== r.version) problems.push(`${r.package}: installed version is ${v}, patches/manifest.json says ${r.version}`)
      const expectedFile = `patches/${r.package.replace('/', '__')}@${v}.patch`
      if (r.file !== expectedFile) problems.push(`${r.package}: patches/manifest.json file is ${r.file}, expected ${expectedFile}`)
      if (!files.includes(path.basename(expectedFile))) problems.push(`${r.package}: missing ${expectedFile}`)
      const key = `${r.package}@${v}`
      declaredKeys.add(key)
      if (registered.get(key) !== expectedFile) problems.push(`${key}: not in patchedDependencies as ${expectedFile}`)
      // pnpm installs a patched package under a store directory carrying the patch hash
      else if (!installed.get(r.package)?.dir.includes('patch_hash=')) problems.push(`${r.package}: installed package is not the patched build`)
    }
    for (const f of files) {
      if (!manifest.patches.some((r) => path.basename(r.file) === f)) problems.push(`patches/${f}: not listed in patches/manifest.json`)
    }
    for (const key of registered.keys()) {
      if (!declaredKeys.has(key)) problems.push(`patchedDependencies[${key}]: not listed in patches/manifest.json`)
    }
    expect(problems, 'the upstream patch set in patches/manifest.json and pnpm-workspace.yaml').toEqual([])
  })
})
