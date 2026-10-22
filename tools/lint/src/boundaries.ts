// U-LINT-1 · package boundaries: imports follow the package graph.
//
// For every source file in app/*/src and packages/*/src (.svelte components: their <script> blocks), every import
// specifier must resolve to
//   - the package's own files (a relative import may not leave the package directory), or
//   - a package listed in its package.json dependencies (dev / peer / optional included; test files may also use
//     the root package.json's devDependencies, e.g. vitest), or
//   - a Node builtin — except in app/renderer, packages/ui and packages/terminal (renderer-side code: no Node,
//     no electron), test files excepted.
// Also: packages/* never import an app package (@kea/main|core|ptyhost|renderer|preload); one process never imports
// another process's package; `@kea/x/sub` deep imports must be listed in x's package.json "exports".
import { builtinModules } from 'node:module'
import { lexJs, lexSvelte } from './lexer.ts'
import type { Violation } from './types.ts'

export type PackageInfo = {
  /** repo-relative directory, e.g. `app/renderer`, `packages/ui` */
  dir: string
  name: string
  deps: Set<string>
  /** `exports` keys (`.`, `./holder`, `./generated/*`) */
  exports: string[]
  /** `imports` keys (`#internal`) */
  imports: string[]
}

export type BoundaryContext = {
  packages: PackageInfo[]
  /** root package.json devDependencies — allowed in test files */
  rootDevDeps: Set<string>
}

const APP_PACKAGES = new Set(['@kea/main', '@kea/core', '@kea/ptyhost', '@kea/renderer', '@kea/preload'])
const NO_NODE = new Set(['app/renderer', 'packages/ui', 'packages/terminal'])
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))

export function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)__tests__\//.test(path)
}

export function packageInfo(dir: string, pkgJson: Record<string, unknown>): PackageInfo {
  const deps = new Set<string>()
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const v = pkgJson[k]
    if (v && typeof v === 'object') for (const name of Object.keys(v)) deps.add(name)
  }
  const exp = pkgJson.exports
  const exports = typeof exp === 'string' ? ['.'] : exp && typeof exp === 'object' ? Object.keys(exp).filter((k) => k.startsWith('.')) : ['.']
  const imp = pkgJson.imports
  const imports = imp && typeof imp === 'object' ? Object.keys(imp) : []
  return { dir, name: String(pkgJson.name ?? dir), deps, exports, imports }
}

export type ImportRef = { specifier: string; offset: number }

/** Every static, dynamic and require import specifier in a JS/TS source (comments ignored). */
export function importSpecifiers(src: string): ImportRef[] {
  const { code, strings } = lexJs(src)
  const out: ImportRef[] = []
  const notInString = (offset: number) => !strings.some((s) => offset >= s.start && offset < s.end)
  const push = (m: RegExpMatchArray, groupOffset: number) => {
    if (!notInString(m.index!)) return
    out.push({ specifier: m[2]!, offset: m.index! + groupOffset })
  }
  for (const m of code.matchAll(/\bfrom\s*(['"])([^'"\n]+)\1/g)) push(m, m[0].indexOf(m[1]!) + 1)
  for (const m of code.matchAll(/(?<![\w$.])import\s*(['"])([^'"\n]+)\1/g)) push(m, m[0].indexOf(m[1]!) + 1)
  for (const m of code.matchAll(/(?<![\w$.])(?:import|require)\s*\(\s*(['"`])([^'"`\n]+)\1\s*[,)]/g)) push(m, m[0].indexOf(m[1]!) + 1)
  return out.sort((a, b) => a.offset - b.offset)
}

export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

function normalise(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function exportAllowed(target: PackageInfo, subpath: string): boolean {
  const key = `./${subpath}`
  return target.exports.some((e) => {
    if (e === key) return true
    const star = e.indexOf('*')
    if (star < 0) return false
    return key.startsWith(e.slice(0, star)) && key.endsWith(e.slice(star + 1))
  })
}

/** Check one file. `path` is repo-relative (`app/renderer/src/x.ts`); `pkg` is the package that contains it. */
export function checkImports(path: string, src: string, pkg: PackageInfo, ctx: BoundaryContext): Violation[] {
  const out: Violation[] = []
  const test = isTestFile(path)
  const line = (offset: number) => src.slice(0, offset).split('\n').length
  const v = (offset: number, message: string) => out.push({ file: path, line: line(offset), rule: 'boundaries', message })
  const byName = new Map(ctx.packages.map((p) => [p.name, p]))

  for (const { specifier: raw, offset } of importSpecifiers(path.endsWith('.svelte') ? lexSvelte(src).scripts : src)) {
    const spec = raw.replace(/\?.*$/, '')
    if (spec.startsWith('.')) {
      const fromDir = path.slice(0, path.lastIndexOf('/'))
      const target = normalise(`${fromDir}/${spec}`)
      if (!(target === pkg.dir || target.startsWith(`${pkg.dir}/`))) {
        const owner = ctx.packages.find((p) => target === p.dir || target.startsWith(`${p.dir}/`))
        v(offset, owner ? `relative import of another package's internals (${raw} → ${owner.name}); import "${owner.name}" by name` : `relative import leaves the package (${raw} → ${target})`)
      }
      continue
    }
    if (spec.startsWith('/')) {
      v(offset, `absolute import path "${raw}"`)
      continue
    }
    if (spec.startsWith('#')) {
      if (!pkg.imports.some((k) => k === spec || (k.endsWith('*') && spec.startsWith(k.slice(0, -1))))) v(offset, `"${raw}" is not in ${pkg.name}'s package.json "imports"`)
      continue
    }
    if (spec.startsWith('virtual:')) continue
    if (BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0]!) || spec.startsWith('node:')) {
      if (NO_NODE.has(pkg.dir) && !test) v(offset, `Node builtin "${raw}" in ${pkg.dir} (renderer-side code has no Node)`)
      continue
    }
    const name = packageNameOf(spec)
    if (name === 'electron' && NO_NODE.has(pkg.dir) && !test) {
      v(offset, `"electron" imported in ${pkg.dir} (renderer-side code never imports electron)`)
      continue
    }
    if (APP_PACKAGES.has(name) && name !== pkg.name) {
      if (pkg.dir.startsWith('packages/')) v(offset, `shared package imports the app package ${name} (packages/* never import app/*)`)
      else v(offset, `one process imports another process's package (${name})`)
      continue
    }
    if (name === pkg.name) continue
    if (!pkg.deps.has(name) && !(test && ctx.rootDevDeps.has(name))) {
      v(offset, `"${name}" is not in ${pkg.dir}/package.json dependencies`)
      continue
    }
    const target = byName.get(name)
    if (target && spec !== name && !exportAllowed(target, spec.slice(name.length + 1))) {
      v(offset, `deep import "${raw}" reaches into ${name}'s internals (not in its package.json "exports")`)
    }
  }
  return out
}
