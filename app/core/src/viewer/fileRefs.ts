// Where a file reference in a file's text leads (`viewer.resolveRefs`): the files it could mean, in order, and the first
// of them that is a regular file inside the worktree. No language server is asked and nothing is run: a reference is
// text, its candidates are paths, and each candidate is checked on disk one at a time through the rationed checks
// (editor/paths.ts), so a list never fires all at once and a volume that does not answer holds only its own place.
//
//   import      TypeScript's order: `.js` → `.ts`, `.tsx`, `.d.ts`, `.js` (and the `.jsx`, `.mjs`, `.cjs` forms);
//               otherwise the exact file, then each extension added, then a folder's package.json (`types`,
//               `typings`, `main`) and its `index`; an alias of the file's config (aliases.ts), then its `baseUrl`; a
//               `#` import then by the nearest package.json's `imports`, a bare one by the package of the file's
//               workspace with its name (workspace.ts: `exports`, else `types`, `typings`, `main` and `index`); a root
//               path from the nearest package; never another bare package or anything in `node_modules`
//   style       the exact file, then Sass's partials
//   markup      the exact file; a root path from the nearest package, its `public/` and `static/`, then the worktree
//   markdown    the worktree path the window's preview resolver gave
//   json        the exact file
//   extends     the exact file, then with `.json`; a package's config under `node_modules`
//   reference   the exact file, then the folder's `tsconfig.json`
//   python      `name.py`, then `name/__init__.py`: a relative module from the folder its dots name (one dot the
//               file's own), else from the folder above the file's top package (the highest of an unbroken chain of
//               folders holding `__init__.py`; the file's own folder outside a package), the worktree's root and `src/`
//   rust        `name.rs`, then `name/mod.rs`: beside a crate root (`lib.rs`, `main.rs`, `build.rs`) or a `mod.rs`,
//               else in the declaring file's own folder (`a.rs` → `a/name.rs`); a file in `bin/`, `tests/`,
//               `examples/` or `benches/` tries beside it, then its own folder
//   include     from the file's folder, then the worktree's root, its `include/` and its `src/`
//   ruby        from the file's folder, `.rb` added unless it is there, then as written
//   path        from the file's folder, then the worktree's root; absolute, `~/` and `file:` as written
//
// Every candidate outside the worktree is dropped before it is asked about, and at most L.viewerLinkCandidatesMax are
// tried; a list cut there answers `unknown`, never "no file". The pure part (`stepsFor`, `manifestSteps`) is apart from
// the run (`resolveRefs`), which is given the checks and the config reader.

import path from 'node:path'
import { isWorktreePath, L, type FileRef, type RefAnswer } from '@kea/protocol'
import type { Logger } from '@kea/kit'
import { absoluteOf, NOT_CHECKED, within, type NotChecked, type PathRequest } from '../editor/paths.ts'
import { aliasesFor, extendsTargets, findProject, type Aliases, type ConfigReader, type Project } from './aliases.ts'
import { findWorkspace, packageNamed, packageOf, type Workspace } from './workspace.ts'

/**
 * One thing to try: a file; a folder's package.json, which gives more files (`manifestSteps`): a module folder's
 * entry, a config package's `tsconfig`, or what a package's `imports` maps the `#` import `spec` to; or the package
 * of the file's workspace named `name`, whose files for the subpath `sub` follow (`packageSteps`).
 */
export type Step =
  | { kind: 'file'; abs: string }
  | { kind: 'manifest'; dir: string; field: 'module' | 'tsconfig' }
  | { kind: 'manifest'; dir: string; field: 'imports'; spec: string }
  | { kind: 'workspace'; name: string; sub: string }

/** What the steps of a reference are made from. */
export interface RefContext {
  /** The worktree as the session names it (absolute, resolved). */
  root: string
  /** The file the reference is in (absolute). */
  from: string
  home: string
  /** The nearest package and its config, for root paths and aliases; null when the reference does not need them. */
  project: Project | null
  aliases: Aliases | null
  /** The folder above the file's top Python package (`pythonBase`), for a Python module that is not relative; null otherwise. */
  pythonBase?: string | null
}

/** The extensions TypeScript adds to a specifier without one it owns, in its order. */
export const TS_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'] as const
/** An extension TypeScript writes for a source of another: what it tries in its place. */
const REWRITTEN: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.d.ts', '.js'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.d.mts', '.mjs'],
  '.cjs': ['.cts', '.d.cts', '.cjs'],
}
const STYLE_EXT = /\.(css|scss|sass|less)$/i
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

const file = (abs: string): Step => ({ kind: 'file', abs })
const isRelative = (spec: string): boolean => spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')
const dirOf = (c: RefContext): string => path.dirname(c.from)
/** A query and a fragment are not part of a file's name. */
const bare = (spec: string): string => spec.replace(/[?#].*$/, '')

/** The extension of `abs` that TypeScript rewrites, if any. */
function rewritten(abs: string): string | null {
  const lower = abs.toLowerCase()
  for (const ext of Object.keys(REWRITTEN)) if (lower.endsWith(ext)) return ext
  return null
}

/** A file named as an import names it: the rewritten extension's sources, or the exact file then each extension added. */
function probeFile(abs: string): Step[] {
  const ext = rewritten(abs)
  if (ext) return (REWRITTEN[ext] as readonly string[]).map((e) => file(abs.slice(0, -ext.length) + e))
  return [file(abs), ...TS_EXTENSIONS.map((e) => file(abs + e))]
}

/** An import's target: as a file, and (unless its extension is a rewritten one) as a folder: its package.json, then `index`. */
export function probeImport(abs: string): Step[] {
  if (rewritten(abs)) return probeFile(abs)
  return [...probeFile(abs), { kind: 'manifest', dir: abs, field: 'module' }, ...TS_EXTENSIONS.map((e) => file(path.join(abs, `index${e}`)))]
}

/** Where a root path (`/x`) is looked for: the nearest package's folder, its `public/` and `static/`, then the worktree's root. */
export function rootBases(c: RefContext): string[] {
  const pkg = c.project?.packageDir ?? null
  return [...new Set([...(pkg ? [pkg, path.join(pkg, 'public'), path.join(pkg, 'static')] : []), c.root])]
}

/** Whether the steps of `ref` need the nearest package and config (`RefContext.project`, `.aliases`). */
export function needsProject(ref: Pick<FileRef, 'family' | 'spec'>): boolean {
  if (ref.family === 'import') return !isRelative(ref.spec)
  if (ref.family === 'style' || ref.family === 'markup') return bare(ref.spec).startsWith('/')
  return false
}

function importSteps(spec: string, c: RefContext): Step[] {
  if (isRelative(spec)) return probeImport(path.resolve(dirOf(c), spec))
  if (spec.startsWith('/')) return rootBases(c).flatMap((b) => probeImport(path.join(b, spec)))
  const out: Step[] = []
  if (c.aliases) {
    for (const target of c.aliases.match(spec)) out.push(...probeImport(target))
    if (c.aliases.baseUrl) out.push(...probeImport(path.join(c.aliases.baseUrl, spec)))
  }
  // after the config's `paths` and `baseUrl`, as TypeScript tries them: a `#` import by the nearest package's
  // `imports`; a bare one by the workspace's package of that name, where TypeScript would look in `node_modules`
  const pkg = c.project?.packageDir ?? null
  if (spec.startsWith('#')) {
    if (pkg !== null) out.push({ kind: 'manifest', dir: pkg, field: 'imports', spec })
    return out
  }
  const named = packageOf(spec)
  if (named) out.push({ kind: 'workspace', ...named })
  return out
}

/** A target or a matched part with a `.`, `..` or `node_modules` segment, which Node refuses. */
const BAD_SEGMENT = /(?:^|\/)(?:\.\.?|node_modules)(?:\/|$)/i

/**
 * The files `spec` maps to by `imports` or `exports` (a `#` import, or a package's subpath `.` or `./x`), a
 * package.json's field in `dir`, as Node matches its keys (absolute, in order, not checked): the exact key, else of the keys with one `*` that match (the `*` one character at
 * least) the one with the longest part before it, then the longer key. A target is a path starting `./`, every `*`
 * given the matched part; a list's targets and a conditions object's, every condition in the order written (the first
 * that is a file wins, so none is chosen), are each followed; `null`, a package name and a target out of `dir` give
 * none. At most L.viewerLinkCandidatesMax are given, as no more can be tried.
 */
export function subpathTargets(dir: string, field: unknown, spec: string): string[] {
  if (typeof field !== 'object' || field === null || Array.isArray(field)) return []
  const map = field as Record<string, unknown>
  let key: string | null = Object.hasOwn(map, spec) && !spec.includes('*') ? spec : null
  let star = ''
  if (key === null) {
    for (const k of Object.keys(map)) {
      const at = k.indexOf('*')
      if (at < 0 || k.indexOf('*', at + 1) >= 0 || spec.length < k.length) continue
      const before = k.slice(0, at)
      const after = k.slice(at + 1)
      if (!spec.startsWith(before) || !spec.endsWith(after)) continue
      const bestAt = key === null ? -1 : key.indexOf('*')
      if (key === null || at > bestAt || (at === bestAt && k.length > key.length)) {
        key = k
        star = spec.slice(at, spec.length - after.length)
      }
    }
  }
  if (key === null) return []
  const isPattern = key !== spec
  if (isPattern && BAD_SEGMENT.test(star)) return []
  const out: string[] = []
  // depth first in the order written, without recursion: the file is at most L.viewerAliasFileMaxBytes
  const stack: unknown[] = [map[key]]
  while (stack.length > 0 && out.length < L.viewerLinkCandidatesMax) {
    const t = stack.pop()
    if (typeof t === 'string') {
      if (!t.startsWith('./') || t.includes('\0') || BAD_SEGMENT.test(t.slice(2))) continue
      const abs = path.resolve(dir, isPattern ? t.replaceAll('*', star) : t)
      if (within(dir, abs) && abs !== dir) out.push(abs)
      continue
    }
    const next = Array.isArray(t) ? t : typeof t === 'object' && t !== null ? Object.values(t) : []
    for (let i = next.length - 1; i >= 0; i--) stack.push(next[i])
  }
  return out
}

function styleSteps(spec: string, c: RefContext): Step[] {
  const s = bare(spec)
  if (s === '' || s.startsWith('~') || s.startsWith('//') || HAS_SCHEME.test(s)) return []
  const bases = s.startsWith('/') ? rootBases(c) : [dirOf(c)]
  return bases.flatMap((b) => {
    const abs = s.startsWith('/') ? path.join(b, s) : path.resolve(b, s)
    const dir = path.dirname(abs)
    const name = path.basename(abs)
    if (STYLE_EXT.test(name)) return [file(abs), file(path.join(dir, `_${name}`))]
    return [abs, path.join(dir, `_${name}.scss`), path.join(dir, `${name}.scss`), path.join(dir, `_${name}.sass`), path.join(dir, `${name}.sass`), path.join(dir, `${name}.css`), path.join(abs, '_index.scss'), path.join(abs, 'index.scss')].map(file)
  })
}

function markupSteps(spec: string, c: RefContext): Step[] {
  const s = bare(spec)
  if (s === '' || s.startsWith('//') || HAS_SCHEME.test(s)) return []
  if (s.startsWith('/')) return rootBases(c).map((b) => file(path.join(b, s)))
  return [file(path.resolve(dirOf(c), s))]
}

function extendsSteps(spec: string, c: RefContext): Step[] {
  return extendsTargets(dirOf(c), spec, c.root).map((t): Step => ('file' in t ? file(t.file) : { kind: 'manifest', dir: t.manifest, field: 'tsconfig' }))
}

function pathSteps(spec: string, c: RefContext): Step[] {
  if (/^file:/i.test(spec) || spec.startsWith('/') || spec === '~' || spec.startsWith('~/')) {
    const abs = absoluteOf(c.root, spec, c.home)
    return abs === null ? [] : [file(abs)]
  }
  if (spec.includes('\0')) return []
  return [file(path.resolve(dirOf(c), spec)), file(path.resolve(c.root, spec))]
}

/** A Python module (`.a.b`, `..`, `a.b`): `b.py`, then `b/__init__.py` (a package alone: its `__init__.py`). */
function pythonSteps(spec: string, c: RefContext): Step[] {
  const dots = (/^\.*/.exec(spec) as RegExpExecArray)[0].length
  const parts = spec.slice(dots).split('.').filter((p) => p !== '')
  const moduleIn = (dir: string): Step[] => {
    if (parts.length === 0) return [file(path.join(dir, '__init__.py'))]
    const p = path.join(dir, ...parts)
    return [file(`${p}.py`), file(path.join(p, '__init__.py'))]
  }
  if (dots > 0) {
    let dir = dirOf(c)
    for (let i = 1; i < dots; i++) dir = path.dirname(dir)
    return moduleIn(dir)
  }
  if (parts.length === 0) return []
  return [...new Set([c.pythonBase ?? dirOf(c), c.root, path.join(c.root, 'src')])].flatMap(moduleIn)
}

const RUST_ROOTS = new Set(['lib.rs', 'main.rs', 'build.rs', 'mod.rs'])
const RUST_TARGETS = new Set(['bin', 'tests', 'examples', 'benches'])

/** A Rust `mod name;`: `name.rs`, then `name/mod.rs`, beside a crate root or `mod.rs`, else in the file's own folder. */
function rustSteps(name: string, c: RefContext): Step[] {
  if (!/^[A-Za-z_]\w*$/.test(name)) return []
  const dir = dirOf(c)
  const own = path.basename(c.from)
  const nested = path.join(dir, own.replace(/\.rs$/i, ''))
  const at = (d: string): Step[] => [file(path.join(d, `${name}.rs`)), file(path.join(d, name, 'mod.rs'))]
  if (RUST_ROOTS.has(own)) return at(dir)
  // a target's own crate root (`src/bin/tool.rs`, `tests/api.rs`) declares its modules beside it
  if (RUST_TARGETS.has(path.basename(dir))) return [...at(dir), ...at(nested)]
  return at(nested)
}

function includeSteps(spec: string, c: RefContext): Step[] {
  if (spec.includes('\0')) return []
  if (path.isAbsolute(spec)) return [file(spec)]
  return [...new Set([dirOf(c), c.root, path.join(c.root, 'include'), path.join(c.root, 'src')])].map((b) => file(path.resolve(b, spec)))
}

function rubySteps(spec: string, c: RefContext): Step[] {
  if (spec.includes('\0')) return []
  const abs = path.resolve(dirOf(c), spec)
  return abs.toLowerCase().endsWith('.rb') ? [file(abs)] : [file(`${abs}.rb`), file(abs)]
}

/** The steps of one reference, in order, before they are kept (`keepStep`) and capped. */
export function stepsFor(ref: Pick<FileRef, 'family' | 'spec'>, c: RefContext): Step[] {
  const spec = ref.spec
  switch (ref.family) {
    case 'import':
      return importSteps(spec, c)
    case 'style':
      return styleSteps(spec, c)
    case 'markup':
      return markupSteps(spec, c)
    case 'markdown':
      return isWorktreePath(spec) ? [file(path.join(c.root, spec))] : []
    case 'json':
      return isRelative(spec) ? [file(path.resolve(dirOf(c), spec))] : []
    case 'extends':
      return extendsSteps(spec, c)
    case 'reference': {
      const abs = path.resolve(dirOf(c), spec)
      return abs.toLowerCase().endsWith('.json') ? [file(abs)] : [file(abs), file(path.join(abs, 'tsconfig.json'))]
    }
    case 'python':
      return pythonSteps(spec, c)
    case 'rust':
      return rustSteps(spec, c)
    case 'include':
      return includeSteps(spec, c)
    case 'ruby':
      return rubySteps(spec, c)
    case 'path':
      return pathSteps(spec, c)
  }
}

/**
 * The files of a workspace's package in `dir` for the subpath `sub` (`''` or `/x`), each tried as an import is: by its
 * `exports` (a string, a list or conditions alone are its `.`); without them `.` is its `types`, `typings`, `main`,
 * then its `index`, and `/x` is that path in its folder.
 */
export function packageSteps(dir: string, manifest: Record<string, unknown>, sub: string): Step[] {
  const exp = manifest.exports
  if (exp !== undefined && exp !== null) {
    const isMap = typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith('.'))
    return subpathTargets(dir, isMap ? exp : { '.': exp }, sub === '' ? '.' : `.${sub}`).flatMap((abs) => probeImport(abs))
  }
  if (sub !== '') return probeImport(path.join(dir, sub))
  return [...manifestSteps({ kind: 'manifest', dir, field: 'module' }, manifest), ...TS_EXTENSIONS.map((e) => file(path.join(dir, `index${e}`)))]
}

/** Whether a reference needs the folder above the file's top Python package: a module that is not relative. */
export const needsPythonBase = (ref: Pick<FileRef, 'family' | 'spec'>): boolean => ref.family === 'python' && !ref.spec.startsWith('.')

/**
 * The folder above the top of the unbroken chain of folders holding `__init__.py` from the file `fromAbs` up, inside
 * the worktree `base` (the file's own folder when it holds none): where its package's absolute imports start. One check
 * per folder; `NOT_CHECKED` when one could not be checked.
 */
export async function pythonBase(fromAbs: string, base: string, req: PathRequest): Promise<string | NotChecked> {
  let top: string | null = null
  for (let dir = path.dirname(fromAbs); within(base, dir); dir = path.dirname(dir)) {
    const has = await req.check(dir, () => req.fs.stat(path.join(dir, '__init__.py')).then((s) => s.isFile(), () => false), true)
    if (has === NOT_CHECKED) return NOT_CHECKED
    if (!has) break
    top = dir
    if (dir === base) break
  }
  return top === null ? path.dirname(fromAbs) : path.dirname(top)
}

/**
 * A package.json's fields as the steps after it: for a module folder its `types`, `typings` and `main`; for a config
 * package its `tsconfig`; for a `#` import what its `imports` maps it to, each tried as an import is.
 */
export function manifestSteps(step: Extract<Step, { kind: 'manifest' }>, manifest: unknown): Step[] {
  if (typeof manifest !== 'object' || manifest === null) return []
  const m = manifest as Record<string, unknown>
  if (step.field === 'imports') return subpathTargets(step.dir, m.imports, step.spec).flatMap((abs) => probeImport(abs))
  const fields = step.field === 'module' ? ['types', 'typings', 'main'] : ['tsconfig']
  const out: Step[] = []
  for (const f of fields) {
    const v = m[f]
    if (typeof v !== 'string' || v === '' || v.includes('\0')) continue
    const abs = path.resolve(step.dir, v)
    out.push(...(step.field === 'module' ? probeFile(abs) : [file(abs)]))
  }
  return out
}

/**
 * A step is tried only inside the worktree (never the worktree itself), and an import's never in `node_modules`. A
 * package's `imports` is its package.json's, so the worktree's own is read.
 */
export function keepStep(step: Step, ref: Pick<FileRef, 'family'>, root: string): boolean {
  // a workspace's package is looked for inside the worktree, and its files are kept by this as they come
  if (step.kind === 'workspace') return true
  const abs = step.kind === 'file' ? step.abs : step.field === 'imports' ? path.join(step.dir, 'package.json') : step.dir
  if (!within(root, abs) || abs === root) return false
  return ref.family !== 'import' || !path.relative(root, abs).split(path.sep).includes('node_modules')
}

/** Case and Unicode normalisation folded, so two spellings of one name on a volume that ignores both compare equal. */
const folded = (p: string): string => p.normalize('NFC').toLowerCase()

/**
 * The worktree path a reference answers with, given the candidate `abs` that passed and its real path: the candidate's
 * own spelling (a link inside the worktree keeps its name), except where the two differ only in case or Unicode
 * normalisation, which gives the real file's name (a tab's id is its path). Null when it is no worktree path.
 */
export function answerPath(base: string, rootReal: string, abs: string, real: string): string | null {
  const asReal = path.relative(rootReal, real)
  const asWritten = within(base, abs) ? path.relative(base, abs) : asReal
  const rel = asWritten !== asReal && folded(asWritten) === folded(asReal) ? asReal : asWritten
  return isWorktreePath(rel) ? rel : null
}

export interface ResolveOptions {
  /** The session's working directory (absolute). */
  cwd: string
  /** The file the references are in, relative to it. */
  from: string
  refs: readonly FileRef[]
  /** A viewer request of the rationed checks; `resolveRefs` ends it. */
  req: PathRequest
  configs: ConfigReader
  /** The session, which the parsed configs are kept for. */
  session: string
  home: string
  log: Logger
}

/**
 * One answer per reference, in order: its file, null (every candidate checked, none a file), or `unknown`. The
 * references run side by side, each trying its candidates one at a time; the nearest package and the aliases are looked
 * for once, for the references that need them.
 */
export async function resolveRefs(o: ResolveOptions): Promise<RefAnswer[]> {
  const { req } = o
  try {
    const base = path.resolve(o.cwd)
    const rootReal = await req.check(base, () => req.fs.realpath(o.cwd), true)
    if (rootReal === NOT_CHECKED) return o.refs.map(() => 'unknown')
    if (rootReal === null) return o.refs.map(() => null)
    const fromAbs = path.join(base, o.from)
    const reader = { req, root: rootReal, session: o.session }
    let project: Promise<{ project: Project; aliases: Aliases } | NotChecked> | null = null
    const projectOnce = () =>
      (project ??= (async () => {
        const p = await findProject(fromAbs, base, req)
        if (p === NOT_CHECKED) return NOT_CHECKED
        const a = await aliasesFor(p, o.configs, reader, base)
        return a === NOT_CHECKED ? NOT_CHECKED : { project: p, aliases: a }
      })())
    let python: Promise<string | NotChecked> | null = null
    const pythonOnce = () => (python ??= pythonBase(fromAbs, base, req))
    let workspace: Promise<Workspace | null | NotChecked> | null = null
    const workspaceOnce = () => (workspace ??= findWorkspace(fromAbs, base, req, o.configs, reader))
    const one = async (ref: FileRef): Promise<RefAnswer> => {
      let ctx: RefContext = { root: base, from: fromAbs, home: o.home, project: null, aliases: null }
      if (needsProject(ref)) {
        const p = await projectOnce()
        if (p === NOT_CHECKED) return 'unknown'
        ctx = { ...ctx, ...p }
      }
      if (needsPythonBase(ref)) {
        const b = await pythonOnce()
        if (b === NOT_CHECKED) return 'unknown'
        ctx = { ...ctx, pythonBase: b }
      }
      const steps = stepsFor(ref, ctx).filter((s) => keepStep(s, ref, base))
      const seen = new Set<string>() // bounded: this reference's steps, at most L.viewerLinkCandidatesMax tried
      let tried = 0
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] as Step
        const key = step.kind === 'file' ? `file\0${step.abs}` : step.kind === 'workspace' ? `workspace\0${step.name}` : `${step.field}\0${step.dir}`
        if (seen.has(key)) continue
        seen.add(key)
        if (tried >= L.viewerLinkCandidatesMax) {
          o.log.debug('file reference candidates cut', { family: ref.family, max: L.viewerLinkCandidatesMax })
          return 'unknown'
        }
        tried++
        if (step.kind === 'manifest') {
          const m = await o.configs.read(reader, path.join(step.dir, 'package.json'))
          if (m === NOT_CHECKED) return 'unknown'
          if (m !== null) steps.splice(i + 1, 0, ...manifestSteps(step, m.json).filter((s) => keepStep(s, ref, base)))
          continue
        }
        if (step.kind === 'workspace') {
          // one step for the walk, the globs and the package.json reads, each capped on its own (workspace.ts)
          const ws = await workspaceOnce()
          if (ws === NOT_CHECKED) return 'unknown'
          if (ws === null) continue
          const pkg = await packageNamed(ws, step.name, o.configs, reader)
          if (pkg === NOT_CHECKED) return 'unknown'
          if (pkg !== null) steps.splice(i + 1, 0, ...packageSteps(pkg.dir, pkg.manifest, step.sub).filter((s) => keepStep(s, ref, base)))
          continue
        }
        const abs = step.abs
        const real = await req.check(abs, async () => {
          if (!(await req.fs.stat(abs)).isFile()) return null
          const r = await req.fs.realpath(abs)
          return within(rootReal, r) && r !== rootReal ? r : null
        })
        if (real === NOT_CHECKED) return 'unknown'
        if (real === null) continue
        const rel = answerPath(base, rootReal, abs, real)
        if (rel === null) continue
        return { path: rel, ...(ref.line !== undefined ? { line: ref.line } : {}), ...(ref.line !== undefined && ref.col !== undefined ? { col: ref.col } : {}) }
      }
      return null
    }
    return await Promise.all(o.refs.map(one))
  } finally {
    req.end()
  }
}
