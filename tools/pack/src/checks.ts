// The release checks that hold on both systems, and the readers of Linux's package listings. Each check returns
// its problems (empty: the line holds); tools/package.ts prints the table and stops at the first line that fails.
import fs from 'node:fs'
import path from 'node:path'
import { asarEntries } from './asar.ts'

/** Every regular file under `dir`, relative to it, in a stable order (links are not followed). */
export function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else if (e.isFile()) out.push(r)
    }
  }
  walk('')
  return out
}

/**
 * What would name the build machine in a shipped file: its home folder, its user as a folder name, its host
 * name (short and full). A name under three characters is left out: it would match by chance.
 */
export function machineNeedles(o: { home: string; user: string; host: string }): string[] {
  const needles = new Set<string>()
  if (o.home.length > 1) needles.add(o.home.replace(/\/+$/, ''))
  if (o.user.length >= 3) needles.add(`/${o.user}/`)
  for (const h of [o.host, o.host.split('.')[0] ?? '']) if (h.length >= 3 && h !== 'localhost') needles.add(h)
  return [...needles]
}

/** Each file under `dir` (the asar's contents included, stored as they are) that holds one of `needles`, with which. */
export function filesNaming(dir: string, needles: readonly string[]): string[] {
  const found: string[] = []
  const bufs = needles.map((n) => Buffer.from(n))
  for (const rel of filesUnder(dir)) {
    const data = fs.readFileSync(path.join(dir, rel))
    const hit = bufs.findIndex((b) => data.includes(b))
    if (hit >= 0) found.push(`${rel} names this machine ("${needles[hit]}")`)
  }
  return found
}

/** Source maps shipped as files or inside the asar (none ship). */
export function sourceMaps(dir: string, asar: string): string[] {
  const loose = filesUnder(dir).filter((f) => f.endsWith('.map'))
  const packed = asarEntries(asar).filter((e) => e.name.endsWith('.map')).map((e) => `app.asar: ${e.name}`)
  return [...loose, ...packed]
}

/** ELF's `e_machine` for each Linux target (every ELF is the target's machine). */
export const ELF_MACHINE: Readonly<Record<'x64' | 'arm64', number>> = { x64: 62, arm64: 183 }

/** An ELF file's `e_machine` (little-endian, as on both targets), or null when the file is not ELF. */
export function elfMachine(file: string): number | null {
  const fd = fs.openSync(file, 'r')
  try {
    const b = Buffer.alloc(20)
    if (fs.readSync(fd, b, 0, 20, 0) < 20 || b.readUInt32BE(0) !== 0x7f454c46) return null
    return b.readUInt16LE(18)
  } finally {
    fs.closeSync(fd)
  }
}

/** Every ELF under `dir` built for another machine than `arch`'s; `count`: how many ELF files there are. */
export function foreignElves(dir: string, arch: 'x64' | 'arm64'): { wrong: string[]; count: number } {
  const wrong: string[] = []
  let count = 0
  for (const rel of filesUnder(dir)) {
    const m = elfMachine(path.join(dir, rel))
    if (m === null) continue
    count++
    if (m !== ELF_MACHINE[arch]) wrong.push(`${rel} is built for ELF machine ${m}, not ${arch} (${ELF_MACHINE[arch]})`)
  }
  return { wrong, count }
}

/** One entry of a package as its archive lists it. */
export interface Listed {
  path: string
  mode: number
  owner: string
  group: string
  dir: boolean
}

const TYPE: Readonly<Record<string, number>> = { '-': 0, d: 0, l: 0 }

/** `drwxr-xr-x`, `-rwsr-xr-x`: the permission bits, set-uid and set-gid included. */
export function modeOf(s: string): number {
  if (s.length !== 10 || !((s[0] ?? '') in TYPE)) throw new Error(`not a mode: ${s}`)
  let m = 0
  const bits = s.slice(1)
  for (let i = 0; i < 9; i++) {
    const c = bits[i] as string
    const bit = 1 << (8 - i)
    if (c === 'r' || c === 'w' || c === 'x' || c === 's' || c === 't') m |= bit
    if (c === 's' || c === 'S') m |= i === 2 ? 0o4000 : i === 5 ? 0o2000 : 0
    if (c === 't' || c === 'T') m |= 0o1000
  }
  return m
}

/** GNU tar's `-tv` lines (`tar -tvzf`, `dpkg-deb -c`): `drwxr-xr-x root/root 0 2026-10-21 12:00 ./opt/Kea/`. */
export function parseTarListing(text: string, strip = 0): Listed[] {
  const out: Listed[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const m = /^([-dl][-rwxsStT]{9})\s+([^/\s]+)\/(\S+)\s+\d+\s+\S+\s+\S+\s+(.+?)(?: -> .*)?$/.exec(line)
    if (!m) throw new Error(`a listing line not understood: ${line}`)
    let p = (m[4] as string).replace(/^\.\//, '').replace(/\/$/, '')
    if (p === '.' || p === '') continue
    if (strip) p = p.split('/').slice(strip).join('/')
    if (p === '') continue
    out.push({ path: `/${p}`, mode: modeOf(m[1] as string), owner: m[2] as string, group: m[3] as string, dir: (m[1] as string).startsWith('d') })
  }
  return out
}

/** `rpm -qp --qf '[%{FILEMODES:perms} %{FILEUSERNAME} %{FILEGROUPNAME} %{FILENAMES}\n]'`. */
export const RPM_QUERY = '[%{FILEMODES:perms} %{FILEUSERNAME} %{FILEGROUPNAME} %{FILENAMES}\\n]'

export function parseRpmListing(text: string): Listed[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const m = /^([-dl][-rwxsStT]{9}) (\S+) (\S+) (\/.*)$/.exec(line)
      if (!m) throw new Error(`an rpm listing line not understood: ${line}`)
      return { path: m[4] as string, mode: modeOf(m[1] as string), owner: m[2] as string, group: m[3] as string, dir: (m[1] as string).startsWith('d') }
    })
}

/**
 * The listing against what was staged: every staged file with its mode, everything owned by root, nothing
 * else outside the folders the system already has. `systemDirs`: folders a package may list without owning them (a tar
 * and a deb list every folder on the way).
 */
export function compareListing(staged: readonly { path: string; mode: number; dir: boolean }[], listed: readonly Listed[], o: { systemDirs: (p: string) => boolean }): string[] {
  const problems: string[] = []
  const got = new Map(listed.map((l) => [l.path, l]))
  for (const s of staged) {
    const l = got.get(s.path)
    if (!l) problems.push(`${s.path} is missing`)
    else if (l.mode !== s.mode) problems.push(`${s.path} has mode ${l.mode.toString(8)}, not ${s.mode.toString(8)}`)
  }
  const known = new Set(staged.map((s) => s.path))
  for (const l of listed) {
    if (l.owner !== 'root' || l.group !== 'root') problems.push(`${l.path} is owned by ${l.owner}:${l.group}, not root:root`)
    if (!known.has(l.path) && !(l.dir && o.systemDirs(l.path))) problems.push(`${l.path} is in the package but was not staged`)
    if (l.dir && !known.has(l.path) && l.mode !== 0o755) problems.push(`${l.path} has mode ${l.mode.toString(8)}, not 755`)
  }
  return problems
}
