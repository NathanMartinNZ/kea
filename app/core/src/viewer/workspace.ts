// The packages of the workspace a file is in, for an import of one by its name (`@acme/ui`, `@acme/ui/button`): the
// nearest folder walking up from the file inside the worktree whose `pnpm-workspace.yaml` lists `packages`, else whose
// package.json has `workspaces` (a list, or `{ packages }`). Its globs (`packages/*`, `apps/**`, `!**/fixtures/**`)
// are expanded inside the worktree only: a literal segment is joined without a listing, `*` and `**` list folders
// (never `node_modules` or a hidden one), at most L.viewerWorkspaceListingsMax listings of at most
// L.viewerWorkspaceEntriesMax entries each, and at most L.viewerWorkspacePackagesMax package folders. A package is
// matched by its package.json's `name`, the folders named as the name's last segment read first; a workspace cut by a
// cap answers "not checked" for a name it did not find, never "no package".
//
// Every file is read through the config reader (aliases.ts: the safe open, its size cap and its cache) and every
// listing is one of the rationed checks, on a folder whose real path is inside the worktree. Nothing is kept past the
// question: the walk and the globs are done again by the next one.

import path from 'node:path'
import { L } from '@kea/protocol'
import { NOT_CHECKED, within, type NotChecked, type PathRequest } from '../editor/paths.ts'
import type { ConfigReader, ReaderContext } from './aliases.ts'

/** A workspace: its folder, the package folders its globs give (absolute, in order), and whether a cap cut them. */
export interface Workspace {
  root: string
  dirs: readonly string[]
  cut: boolean
}

/** A package of the workspace: its folder and its package.json. */
export interface WorkspacePackage {
  dir: string
  manifest: Record<string, unknown>
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null)

/** A YAML scalar as written: quotes taken off (`''` in single quotes is one `'`), a trailing comment dropped. */
function scalar(raw: string): string {
  const t = raw.trim()
  if (t.startsWith("'")) {
    let out = ''
    for (let i = 1; i < t.length; i++) {
      if (t[i] !== "'") out += t[i]
      else if (t[i + 1] === "'") {
        out += "'"
        i++
      } else return out
    }
    return out
  }
  if (t.startsWith('"')) {
    const close = t.indexOf('"', 1)
    return close < 0 ? t.slice(1) : t.slice(1, close)
  }
  const hash = t.search(/\s#/)
  return (hash < 0 ? t : t.slice(0, hash)).trim()
}

/**
 * The `packages` of a `pnpm-workspace.yaml`, read as the file's YAML subset pnpm documents: a top-level `packages:`
 * key with a block list (`- glob`, indented or not) or a flow list on its line (`[a, b]`). `{ packages }`, or null when
 * the file has no such key.
 */
export function parseWorkspaceYaml(text: string): { packages: string[] } | null {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const key = /^packages[ \t]*:(.*)$/.exec(lines[i] as string)
    if (!key) continue
    const rest = (key[1] as string).replace(/(^|\s)#.*$/, '').trim()
    if (rest.startsWith('[')) {
      const close = rest.lastIndexOf(']')
      if (close < 0) return null
      const items = rest.slice(1, close).split(',').map(scalar).filter((s) => s !== '')
      return { packages: items }
    }
    if (rest !== '') return null
    const packages: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] as string
      if (/^\s*(#.*)?$/.test(line)) continue
      const item = /^[ \t]*-[ \t]+(.*)$/.exec(line)
      if (!item) break
      const glob = scalar(item[1] as string)
      if (glob !== '') packages.push(glob)
    }
    return { packages }
  }
  return null
}

/** A package.json's `workspaces`: a list, or `{ packages }`; null when it has none. */
export function packageWorkspaces(manifest: unknown): string[] | null {
  if (!isObject(manifest)) return null
  const w = manifest.workspaces
  return strings(w) ?? (isObject(w) ? strings(w.packages) : null)
}

/**
 * A glob of a workspace as a pattern of its relative paths: `**` any folders (a trailing `/**` none too, so
 * `**\/fixtures/**` matches `fixtures` itself), `*` and `?` within one name.
 */
export function globPattern(glob: string): RegExp {
  let out = ''
  let g = glob.replace(/^\.\//, '').replace(/\/+$/, '')
  const anyBelow = g.endsWith('/**')
  if (anyBelow) g = g.slice(0, -3)
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string
    if (c === '*' && g[i + 1] === '*') {
      const slash = g[i + 2] === '/'
      out += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}${anyBelow ? '(?:/.*)?' : ''}$`)
}

/** The segments of an include glob, relative to the workspace; null for one that is absolute or climbs out. */
function segmentsOf(glob: string): string[] | null {
  const g = glob.replace(/^\.\//, '').replace(/\/+$/, '')
  if (g === '' || g.startsWith('/') || g.includes('\0')) return null
  const segs = g.split('/').filter((s) => s !== '' && s !== '.')
  return segs.some((s) => s === '..') ? null : segs
}

interface Walk {
  req: PathRequest
  reader: ReaderContext
  listings: number
  cut: boolean
}

/** The subfolders of `dir` (sorted, `node_modules` and hidden ones left out), or null when it cannot be listed. */
async function subfolders(dir: string, w: Walk): Promise<string[] | null | NotChecked> {
  if (w.listings >= L.viewerWorkspaceListingsMax) {
    w.cut = true
    return null
  }
  w.listings++
  const { req, reader } = w
  const open = req.fs.opendir
  if (!open) return null
  return req.check(
    dir,
    async () => {
      const real = await req.fs.realpath(dir)
      if (!within(reader.root, real)) return null
      const names: string[] = []
      let seen = 0
      for await (const e of await open(dir)) {
        if (++seen > L.viewerWorkspaceEntriesMax) {
          w.cut = true
          break
        }
        if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) names.push(e.name)
      }
      return names.sort()
    },
    true,
  )
}

/**
 * The package folders `globs` give from the workspace `root` (absolute, in the globs' order, each once), inside `base`;
 * a glob starting `!` leaves out what it matches. `NOT_CHECKED` when a listing could not be checked.
 */
export async function expandGlobs(root: string, globs: readonly string[], base: string, req: PathRequest, reader: ReaderContext): Promise<{ dirs: string[]; cut: boolean } | NotChecked> {
  const w: Walk = { req, reader, listings: 0, cut: false }
  const excludes = globs.filter((g) => g.startsWith('!')).map((g) => globPattern(g.slice(1)))
  const found = new Set<string>() // bounded: L.viewerWorkspacePackagesMax
  const add = (dir: string): boolean => {
    const rel = path.relative(root, dir)
    if (!within(base, dir) || rel.split(path.sep).includes('node_modules') || excludes.some((x) => x.test(rel.split(path.sep).join('/')))) return true
    if (found.size >= L.viewerWorkspacePackagesMax) {
      w.cut = true
      return false
    }
    found.add(dir)
    return true
  }
  for (const glob of globs) {
    if (glob.startsWith('!')) continue
    const segs = segmentsOf(glob)
    if (!segs) continue
    // depth first in order, without recursion: each listing is counted against its cap
    const stack: { dir: string; at: number }[] = [{ dir: root, at: 0 }]
    while (stack.length > 0) {
      const { dir, at } = stack.pop() as { dir: string; at: number }
      if (at === segs.length) {
        if (!add(dir)) return { dirs: [...found], cut: true }
        continue
      }
      const seg = segs[at] as string
      if (!seg.includes('*') && !seg.includes('?')) {
        stack.push({ dir: path.join(dir, seg), at: at + 1 })
        continue
      }
      const subs = await subfolders(dir, w)
      if (subs === NOT_CHECKED) return NOT_CHECKED
      if (!subs) continue
      const next: { dir: string; at: number }[] = []
      if (seg === '**') {
        // `**` is no folder at all, or any folder below with `**` still to match
        next.push({ dir, at: at + 1 })
        for (const s of subs) next.push({ dir: path.join(dir, s), at })
      } else {
        const one = globPattern(seg)
        for (const s of subs) if (one.test(s)) next.push({ dir: path.join(dir, s), at: at + 1 })
      }
      for (let i = next.length - 1; i >= 0; i--) stack.push(next[i] as { dir: string; at: number })
    }
  }
  return { dirs: [...found], cut: w.cut }
}

/**
 * The workspace of the file `fromAbs`: the nearest folder up to the worktree `base` with a `pnpm-workspace.yaml`
 * listing packages, else a package.json with `workspaces`; null when there is none. `NOT_CHECKED` when a folder or a
 * listing could not be checked.
 */
export async function findWorkspace(fromAbs: string, base: string, req: PathRequest, configs: ConfigReader, reader: ReaderContext): Promise<Workspace | null | NotChecked> {
  for (let dir = path.dirname(fromAbs); within(base, dir); dir = path.dirname(dir)) {
    const here = await req.check(
      dir,
      async () => {
        const has = (name: string): Promise<boolean> => req.fs.stat(path.join(dir, name)).then((s) => s.isFile(), () => false)
        return { yaml: await has('pnpm-workspace.yaml'), pkg: await has('package.json') }
      },
      true,
    )
    if (here === NOT_CHECKED) return NOT_CHECKED
    let globs: string[] | null = null
    if (here?.yaml) {
      const y = await configs.read(reader, path.join(dir, 'pnpm-workspace.yaml'), parseWorkspaceYaml)
      if (y === NOT_CHECKED) return NOT_CHECKED
      globs = y && isObject(y.json) ? strings(y.json.packages) : null
    }
    if (globs === null && here?.pkg) {
      const m = await configs.read(reader, path.join(dir, 'package.json'))
      if (m === NOT_CHECKED) return NOT_CHECKED
      globs = m ? packageWorkspaces(m.json) : null
    }
    if (globs !== null) {
      const e = await expandGlobs(dir, globs, base, req, reader)
      return e === NOT_CHECKED ? NOT_CHECKED : { root: dir, ...e }
    }
    if (dir === base) break
  }
  return null
}

/**
 * A bare import as a package's name and the subpath after it (`''` or `/x`); null when it names no package (`$lib/x`,
 * `~/x`, `node:fs`, `virtual:x`).
 */
export function packageOf(spec: string): { name: string; sub: string } | null {
  const m = /^((?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(\/.*)?$/i.exec(spec)
  return m ? { name: m[1] as string, sub: m[2] ?? '' } : null
}

/**
 * The package named `name` in `ws`: each folder's package.json read once, the folders named as the name's last segment
 * first. Null when none has the name; `NOT_CHECKED` when a read could not be checked, or the workspace was cut.
 */
export async function packageNamed(ws: Workspace, name: string, configs: ConfigReader, reader: ReaderContext): Promise<WorkspacePackage | null | NotChecked> {
  const last = name.slice(name.lastIndexOf('/') + 1)
  const order = [...ws.dirs.filter((d) => path.basename(d) === last), ...ws.dirs.filter((d) => path.basename(d) !== last)]
  for (const dir of order) {
    const m = await configs.read(reader, path.join(dir, 'package.json'))
    if (m === NOT_CHECKED) return NOT_CHECKED
    if (m && isObject(m.json) && m.json.name === name) return { dir, manifest: m.json }
  }
  return ws.cut ? NOT_CHECKED : null
}
