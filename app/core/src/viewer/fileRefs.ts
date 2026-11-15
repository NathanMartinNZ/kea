// Where a file reference in a file's text leads (`viewer.resolveRefs`): the files it could mean, in order, and the first
// of them that is a regular file inside the worktree. No language server is asked and nothing is run: a reference is
// text, its candidates are paths, and each candidate is checked on disk one at a time through the rationed checks
// (editor/paths.ts), so a list never fires all at once and a volume that does not answer holds only its own place.
//
//   import      TypeScript's order: `.js` → `.ts`, `.tsx`, `.d.ts`, `.js` (and the `.jsx`, `.mjs`, `.cjs` forms);
//               otherwise the exact file, then each extension added, then a folder's package.json (`types`,
//               `typings`, `main`) and its `index`; an alias of the file's config (aliases.ts), then its `baseUrl`; a
//               root path from the nearest package; never a bare package, a `#` import or anything in `node_modules`
//   style       the exact file, then Sass's partials
//   markup      the exact file; a root path from the nearest package, its `public/` and `static/`, then the worktree
//   markdown    the worktree path the window's preview resolver gave
//   json        the exact file
//   extends     the exact file, then with `.json`; a package's config under `node_modules`
//   reference   the exact file, then the folder's `tsconfig.json`
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

/** One thing to try: a file, or a folder's package.json, which gives more files (`manifestSteps`). */
export type Step = { kind: 'file'; abs: string } | { kind: 'manifest'; dir: string; field: 'module' | 'tsconfig' }

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
  if (ref.family === 'import') return !isRelative(ref.spec) && !ref.spec.startsWith('#')
  if (ref.family === 'style' || ref.family === 'markup') return bare(ref.spec).startsWith('/')
  return false
}

function importSteps(spec: string, c: RefContext): Step[] {
  if (spec.startsWith('#')) return []
  if (isRelative(spec)) return probeImport(path.resolve(dirOf(c), spec))
  if (spec.startsWith('/')) return rootBases(c).flatMap((b) => probeImport(path.join(b, spec)))
  const out: Step[] = []
  if (c.aliases) {
    for (const target of c.aliases.match(spec)) out.push(...probeImport(target))
    if (c.aliases.baseUrl) out.push(...probeImport(path.join(c.aliases.baseUrl, spec)))
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
    case 'path':
      return pathSteps(spec, c)
  }
}

/** A package.json's fields as the steps after it: for a module folder its `types`, `typings` and `main`; for a config package its `tsconfig`. */
export function manifestSteps(step: Extract<Step, { kind: 'manifest' }>, manifest: unknown): Step[] {
  if (typeof manifest !== 'object' || manifest === null) return []
  const m = manifest as Record<string, unknown>
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

/** A step is tried only inside the worktree (never the worktree itself), and an import's never in `node_modules`. */
export function keepStep(step: Step, ref: Pick<FileRef, 'family'>, root: string): boolean {
  const abs = step.kind === 'file' ? step.abs : step.dir
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
    const one = async (ref: FileRef): Promise<RefAnswer> => {
      let ctx: RefContext = { root: base, from: fromAbs, home: o.home, project: null, aliases: null }
      if (needsProject(ref)) {
        const p = await projectOnce()
        if (p === NOT_CHECKED) return 'unknown'
        ctx = { ...ctx, ...p }
      }
      const steps = stepsFor(ref, ctx).filter((s) => keepStep(s, ref, base))
      const seen = new Set<string>() // bounded: this reference's steps, at most L.viewerLinkCandidatesMax tried
      let tried = 0
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] as Step
        const key = `${step.kind}\0${step.kind === 'file' ? step.abs : step.dir}`
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
