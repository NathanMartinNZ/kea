// The licences file every package carries, covering every bundled dependency: the npm packages the bundles
// hold (tools/build.ts `--packages-out`), the crates `kea-helper` is built from (cargo metadata: its normal
// dependencies, for the target), and the notices the build ships besides (Kea's licence, Electron's, the syntax
// highlighter's and a font's: notices.ts). Chromium's credits are Electron's `LICENSES.chromium.html`, which every
// package ships too. Pure but for `npmDependency` and the reads it is handed.
import fs from 'node:fs'
import path from 'node:path'

export interface Dependency {
  name: string
  version: string
  /** The licence as the package declares it (an SPDX expression), or null. */
  licence: string | null
  /** Where its licence files are. */
  dir: string
  /** Its source repository as declared, to borrow a sibling's licence text when it ships none (one repository, one licence). */
  repository: string | null
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i

/** A package's repository as one name per repository: a GitHub URL (any form, a monorepo's subfolder too) as `owner/repo`. */
export function repositoryOf(v: unknown): string | null {
  const url = typeof v === 'string' ? v : typeof v === 'object' && v !== null ? (v as { url?: unknown }).url : null
  if (typeof url !== 'string') return null
  const gh = /^(?:github:|(?:git\+)?(?:https?|ssh|git):\/\/(?:git@)?github\.com[/:]|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#].*)?$/i.exec(url)
  return gh ? `${gh[1]}/${gh[2]}`.toLowerCase() : url.replace(/^git\+/, '').replace(/\.git$/, '')
}

export function npmDependency(dir: string): Dependency {
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name: string; version: string; license?: unknown; repository?: unknown }
  return { name: p.name, version: p.version, licence: typeof p.license === 'string' ? p.license : null, dir, repository: repositoryOf(p.repository) }
}

interface CargoMetadata {
  packages: { id: string; name: string; version: string; license: string | null; manifest_path: string; repository?: string | null }[]
  resolve: { root: string; nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] }
}

/** The crates a binary is made of: the root's normal dependencies, transitively (not its build or dev ones). */
export function crates(meta: CargoMetadata): Dependency[] {
  const byId = new Map(meta.packages.map((p) => [p.id, p]))
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  const walk = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    for (const d of nodes.get(id)?.deps ?? []) if (d.dep_kinds.some((k) => k.kind === null)) walk(d.pkg)
  }
  walk(meta.resolve.root)
  seen.delete(meta.resolve.root)
  return [...seen].map((id) => {
    const p = byId.get(id)
    if (!p) throw new Error(`cargo metadata names ${id} but has no package for it`)
    return { name: p.name, version: p.version, licence: p.license, dir: path.dirname(p.manifest_path), repository: repositoryOf(p.repository ?? null) }
  })
}

/**
 * The licence files to quote for `dep`, from the names in its folder: under a choice that offers MIT (`MIT OR
 * Apache-2.0`), only the MIT text when it is there; otherwise every licence file.
 */
export function licenceFiles(dep: Pick<Dependency, 'licence'>, names: readonly string[]): string[] {
  const files = names.filter((n) => LICENCE_FILE.test(n)).sort()
  const offersMit = dep.licence !== null && / OR /.test(dep.licence) && /\bMIT\b/.test(dep.licence)
  const mit = files.filter((n) => /mit/i.test(n))
  return offersMit && mit.length ? mit : files
}

export interface Notice {
  title: string
  text: string
}

/**
 * The file's text. `files(dir)`: the names in a folder; `read(file)`: a file's text. A dependency with no licence file
 * of its own takes the text of one from the same repository; one with neither fails the build.
 */
export function licencesText(o: { product: string; version: string; deps: readonly Dependency[]; notices: readonly Notice[]; files: (dir: string) => string[]; read: (file: string) => string }): string {
  const texts = new Map<Dependency, string>()
  for (const d of o.deps) {
    const own = licenceFiles(d, o.files(d.dir))
    if (own.length) texts.set(d, own.map((f) => o.read(path.join(d.dir, f)).trim()).join('\n\n'))
  }
  const missing: string[] = []
  const sections: string[] = []
  const sorted = [...o.deps].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  const seen = new Set<string>()
  for (const d of sorted) {
    const key = `${d.name}@${d.version}`
    if (seen.has(key)) continue
    seen.add(key)
    let text = texts.get(d)
    let from = ''
    if (text === undefined && d.repository !== null) {
      const sibling = sorted.find((s) => s !== d && s.repository === d.repository && texts.has(s))
      if (sibling) {
        text = texts.get(sibling)
        from = ` (the licence of ${sibling.name}, from the same repository)`
      }
    }
    if (text === undefined) {
      missing.push(key)
      continue
    }
    sections.push(`${key} — ${d.licence ?? 'licence not declared'}${from}\n\n${text}`)
  }
  if (missing.length) throw new Error(`no licence text for ${missing.join(', ')}: add its licence to tools/pack/src/licences.ts's notices`)
  const rule = '-'.repeat(78)
  return [
    `${o.product} ${o.version}: the licences of the software it is made of.`,
    "Chromium's credits are in LICENSES.chromium.html, in Kea's folder (macOS: Kea.app/Contents/Resources).",
    '',
    ...[...o.notices.map((n) => `${n.title}\n\n${n.text.trim()}`), ...sections].flatMap((s) => [rule, s, '']),
  ].join('\n')
}
