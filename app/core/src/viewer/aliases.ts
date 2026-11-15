// The aliases a file's imports may use, read from its tsconfig or jsconfig: the nearest one walking up from the file
// inside the worktree, its `extends` chain (a string or an array; relative, or a package's config under the worktree's
// `node_modules`), and for a solution file (`"files": []` with `references`) the referenced configs, whose `paths` are
// merged in their order. `paths` resolve from the config that declares them, or from `baseUrl` when one is set;
// `${configDir}` is the folder of the config the chain starts from. A SvelteKit project (a `svelte.config.*` beside
// the nearest package.json) whose configs name no `$lib` has `$lib` as `src/lib`, so a worktree whose setup has not run
// yet resolves it too.
//
// Nothing outside the worktree is read and nothing is run. Each config is opened through the viewer's safe open
// (read.ts: no link followed at the last step, no waiting on a FIFO), must be a regular file of at most
// L.viewerAliasFileMaxBytes whose real path lies inside the worktree, and is parsed as JSONC; one that is missing, too
// large or broken gives no aliases. Each read is one of the rationed checks (editor/paths.ts). At most
// L.viewerAliasExtendsMax configs are read for one file, so a loop of `extends` ends. Parsed files are kept by real
// path, modification time and size (`ConfigReader`).

import path from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import { L } from '@kea/protocol'
import { NOT_CHECKED, within, type NotChecked, type PathRequest } from '../editor/paths.ts'
import { openForRead, readUpTo, type Opened } from './read.ts'

/** Where a reference's file lives: its nearest config and package, inside the worktree. */
export interface Project {
  /** The nearest tsconfig.json or jsconfig.json walking up from the file (absolute), or null. */
  config: string | null
  /** The nearest folder holding a package.json (absolute), or null. */
  packageDir: string | null
  /** A `svelte.config.*` is beside that package.json. */
  svelteKit: boolean
}

const SVELTE_CONFIGS = ['svelte.config.js', 'svelte.config.ts', 'svelte.config.mjs', 'svelte.config.cjs'] as const
const CONFIG_DIR = '${configDir}'
const PACKAGE_NAME = /^(?:@[^/@\s]+\/)?[^/@.\s][^/\s]*$/

/**
 * The nearest config and package for the file `fromAbs`, walking up from its folder to the worktree `base` (both as
 * the session names them): one check per folder. `NOT_CHECKED` when a folder could not be checked.
 */
export async function findProject(fromAbs: string, base: string, req: PathRequest): Promise<Project | NotChecked> {
  let config: string | null = null
  let packageDir: string | null = null
  let svelteKit = false
  for (let dir = path.dirname(fromAbs); within(base, dir); dir = path.dirname(dir)) {
    const lookConfig = config === null
    const lookPackage = packageDir === null
    const here = await req.check(
      dir,
      async () => {
        const has = (name: string): Promise<boolean> => req.fs.stat(path.join(dir, name)).then((s) => s.isFile(), () => false)
        const ts = lookConfig ? ((await has('tsconfig.json')) ? 'tsconfig.json' : (await has('jsconfig.json')) ? 'jsconfig.json' : null) : null
        const pkg = lookPackage && (await has('package.json'))
        let svelte = false
        if (pkg) for (const n of SVELTE_CONFIGS) if ((svelte = await has(n))) break
        return { ts, pkg, svelte }
      },
      true,
    )
    if (here === NOT_CHECKED) return NOT_CHECKED
    if (here?.ts) config = path.join(dir, here.ts)
    if (here?.pkg) {
      packageDir = dir
      svelteKit = here.svelte
    }
    if ((config !== null && packageDir !== null) || dir === base) break
  }
  return { config, packageDir, svelteKit }
}

/** What a config read is made with: the request its checks are part of, the worktree's real path, the session. */
export interface ReaderContext {
  req: PathRequest
  root: string
  session: string
}

interface Parsed {
  session: string
  mtimeMs: number
  size: number
  json: unknown
}

/**
 * Reads a config or a package.json for the file references, through the safe open, and keeps what it parsed by real
 * path, modification time and size. A session's files go when no window shows it (`forget`).
 */
export class ConfigReader {
  // bounded: L.viewerAliasCacheMax parsed files, least recently used out; a session's go when no window shows it
  private readonly parsed = new Map<string, Parsed>()
  private readonly open: (real: string) => Promise<Opened | null>

  constructor(open: (real: string) => Promise<Opened | null> = openForRead) {
    this.open = open
  }

  get size(): number {
    return this.parsed.size
  }

  /** No window shows the session any more. */
  forget(sessionId: string): void {
    for (const [key, p] of this.parsed) if (p.session === sessionId) this.parsed.delete(key)
  }

  clear(): void {
    this.parsed.clear()
  }

  /** The JSON at `abs` (in `{ json }`), or null when it is missing, outside the worktree, not a regular file, too large or broken. */
  read(r: ReaderContext, abs: string): Promise<{ json: unknown } | null | NotChecked> {
    return r.req.check(abs, async () => {
      const real = await r.req.fs.realpath(abs)
      if (!within(r.root, real) || real === r.root) return null
      const opened = await this.open(real)
      if (!opened) return null
      const { fh, stat } = opened
      try {
        if (!stat.isFile() || stat.size > L.viewerAliasFileMaxBytes) return null
        const key = `${r.session}\0${real}`
        const hit = this.parsed.get(key)
        if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
          // most recently used last
          this.parsed.delete(key)
          this.parsed.set(key, hit)
          return { json: hit.json }
        }
        const json = parseConfig(new TextDecoder().decode(await readUpTo(fh, stat.size)))
        if (json === null) return null
        this.parsed.delete(key)
        this.parsed.set(key, { session: r.session, mtimeMs: stat.mtimeMs, size: stat.size, json })
        while (this.parsed.size > L.viewerAliasCacheMax) this.parsed.delete(this.parsed.keys().next().value as string)
        return { json }
      } finally {
        await fh.close().catch(() => undefined)
      }
    })
  }
}

/** A config's text as JSONC (comments, trailing commas): its object, or null when it does not parse into one. */
export function parseConfig(text: string): Record<string, unknown> | null {
  const errors: ParseError[] = []
  const json: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || typeof json !== 'object' || json === null || Array.isArray(json)) return null
  return json as Record<string, unknown>
}

/** One `paths` pattern: what it matches and the targets it maps to, each resolved from `base`. */
export interface AliasEntry {
  pattern: string
  targets: readonly string[]
  base: string
}

/** The aliases in force for a file: its `paths` patterns and its `baseUrl`. */
export class Aliases {
  readonly entries: readonly AliasEntry[]
  /** Absolute, or null. */
  readonly baseUrl: string | null

  constructor(entries: readonly AliasEntry[], baseUrl: string | null) {
    this.entries = entries
    this.baseUrl = baseUrl
  }

  /**
   * The targets `spec` maps to, in order (absolute, not checked): an exact pattern first, else the matching pattern
   * with the longest prefix (the first of equals), its `*` given what the specifier has in its place.
   */
  match(spec: string): string[] {
    const exact = this.entries.find((e) => e.pattern === spec && !e.pattern.includes('*'))
    if (exact) return exact.targets.map((t) => path.resolve(exact.base, t))
    let best: { e: AliasEntry; star: string; prefix: number } | null = null
    for (const e of this.entries) {
      const at = e.pattern.indexOf('*')
      if (at < 0 || e.pattern.indexOf('*', at + 1) >= 0) continue
      const prefix = e.pattern.slice(0, at)
      const suffix = e.pattern.slice(at + 1)
      if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) continue
      if (!best || prefix.length > best.prefix) best = { e, star: spec.slice(prefix.length, spec.length - suffix.length), prefix: prefix.length }
    }
    if (!best) return []
    const { e, star } = best
    return e.targets.map((t) => path.resolve(e.base, t.replace('*', star)))
  }
}

/** One config of a chain: its folder and what it sets. */
export interface ConfigLayer {
  dir: string
  paths: Readonly<Record<string, unknown>> | null
  baseUrl: string | null
}

export function layerOf(abs: string, json: unknown): ConfigLayer {
  const o = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
  const co = (typeof o.compilerOptions === 'object' && o.compilerOptions !== null ? o.compilerOptions : {}) as Record<string, unknown>
  const paths = typeof co.paths === 'object' && co.paths !== null && !Array.isArray(co.paths) ? (co.paths as Record<string, unknown>) : null
  return { dir: path.dirname(abs), paths, baseUrl: typeof co.baseUrl === 'string' ? co.baseUrl : null }
}

/**
 * What a chain of configs (the first the one the file's chain starts from, then those it extends, nearest first)
 * gives: the `paths` and `baseUrl` of the nearest config that sets each, `${configDir}` being the first one's folder.
 */
export function effectiveAliases(layers: readonly ConfigLayer[]): { entries: AliasEntry[]; baseUrl: string | null } {
  const leaf = layers[0]?.dir ?? ''
  const sub = (s: string): string => (s.startsWith(CONFIG_DIR) ? leaf + s.slice(CONFIG_DIR.length) : s)
  const withBase = layers.find((l) => l.baseUrl !== null)
  const baseUrl = withBase ? path.resolve(withBase.dir, sub(withBase.baseUrl as string)) : null
  const withPaths = layers.find((l) => l.paths !== null)
  if (!withPaths?.paths) return { entries: [], baseUrl }
  const base = baseUrl ?? withPaths.dir
  const entries: AliasEntry[] = []
  for (const [pattern, targets] of Object.entries(withPaths.paths)) {
    if (!Array.isArray(targets)) continue
    const ts = targets.filter((t): t is string => typeof t === 'string' && t !== '' && !t.includes('\0')).map(sub)
    if (ts.length > 0) entries.push({ pattern, targets: ts, base })
  }
  return { entries, baseUrl }
}

/** Where an `extends` value may be, in order: a file, or a package whose package.json names its config in `tsconfig`. */
export type ExtendsTarget = { file: string } | { manifest: string }

/** The places `extends: spec` in a config in `dir` may name, inside the worktree `root`. */
export function extendsTargets(dir: string, spec: string, root: string): ExtendsTarget[] {
  const withJson = (abs: string): ExtendsTarget[] => (abs.toLowerCase().endsWith('.json') ? [{ file: abs }] : [{ file: abs }, { file: `${abs}.json` }])
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || spec === '.' || spec === '..') return withJson(path.resolve(dir, spec))
  const out: ExtendsTarget[] = []
  for (let d = dir; within(root, d); d = path.dirname(d)) {
    const pkg = path.join(d, 'node_modules', spec)
    if (PACKAGE_NAME.test(spec)) out.push({ manifest: pkg }, { file: path.join(pkg, 'tsconfig.json') })
    else out.push(...withJson(pkg))
    if (d === root) break
  }
  return out
}

const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

interface ChainContext {
  configs: ConfigReader
  reader: ReaderContext
  /** The worktree as the session names it. */
  base: string
  /** Configs read for this file so far. */
  count: { n: number }
}

/** The chain from the first of `targets` that is a config: it, then what it extends (nearest first). */
async function chainFrom(targets: readonly ExtendsTarget[], c: ChainContext, visited: Set<string>): Promise<{ abs: string; json: unknown; layers: ConfigLayer[] } | null | NotChecked> {
  for (const t of targets) {
    let abs: string
    if ('manifest' in t) {
      const m = await c.configs.read(c.reader, path.join(t.manifest, 'package.json'))
      if (m === NOT_CHECKED) return NOT_CHECKED
      const named = m && typeof m.json === 'object' && m.json !== null ? (m.json as Record<string, unknown>).tsconfig : undefined
      if (typeof named !== 'string' || named === '') continue
      abs = path.resolve(t.manifest, named)
    } else abs = t.file
    if (visited.has(abs) || c.count.n >= L.viewerAliasExtendsMax || !within(c.base, abs)) return null
    const r = await c.configs.read(c.reader, abs)
    if (r === NOT_CHECKED) return NOT_CHECKED
    if (r === null) continue
    visited.add(abs)
    c.count.n++
    const layers = [layerOf(abs, r.json)]
    const ext = strings((r.json as Record<string, unknown>).extends)
    // a later entry of an `extends` array overrides an earlier one; a link of the chain that is missing drops only itself
    for (const e of ext.reverse()) {
      const sub = await chainFrom(extendsTargets(path.dirname(abs), e, c.base), c, visited)
      if (sub === NOT_CHECKED) return NOT_CHECKED
      if (sub) layers.push(...sub.layers)
    }
    return { abs, json: r.json, layers }
  }
  return null
}

/** A solution file: no files of its own, only references to the configs that have them. */
const isSolution = (json: unknown): boolean => {
  const o = json as Record<string, unknown>
  return Array.isArray(o.files) && o.files.length === 0 && Array.isArray(o.references)
}

/**
 * The aliases for a file in `project` (its nearest config, with `extends` and a solution file's references), and the
 * `$lib` fallback of a SvelteKit project. `NOT_CHECKED` when a config could not be checked.
 */
export async function aliasesFor(project: Project, configs: ConfigReader, reader: ReaderContext, base: string): Promise<Aliases | NotChecked> {
  const entries: AliasEntry[] = []
  let baseUrl: string | null = null
  if (project.config !== null) {
    const c: ChainContext = { configs, reader, base, count: { n: 0 } }
    const leaf = await chainFrom([{ file: project.config }], c, new Set())
    if (leaf === NOT_CHECKED) return NOT_CHECKED
    if (leaf) {
      const own = effectiveAliases(leaf.layers)
      entries.push(...own.entries)
      baseUrl = own.baseUrl
      if (isSolution(leaf.json)) {
        for (const ref of (leaf.json as { references: unknown[] }).references) {
          const p = typeof ref === 'object' && ref !== null ? (ref as Record<string, unknown>).path : undefined
          if (typeof p !== 'string' || p === '') continue
          const abs = path.resolve(path.dirname(leaf.abs), p)
          const targets: ExtendsTarget[] = abs.toLowerCase().endsWith('.json') ? [{ file: abs }] : [{ file: path.join(abs, 'tsconfig.json') }, { file: abs }]
          const sub = await chainFrom(targets, c, new Set([leaf.abs]))
          if (sub === NOT_CHECKED) return NOT_CHECKED
          if (!sub) continue
          const theirs = effectiveAliases(sub.layers)
          entries.push(...theirs.entries)
          baseUrl ??= theirs.baseUrl
        }
      }
    }
  }
  if (project.svelteKit && project.packageDir !== null && !entries.some((e) => e.pattern === '$lib' || e.pattern === '$lib/*')) {
    entries.push({ pattern: '$lib', targets: ['src/lib'], base: project.packageDir }, { pattern: '$lib/*', targets: ['src/lib/*'], base: project.packageDir })
  }
  return new Aliases(entries, baseUrl)
}
