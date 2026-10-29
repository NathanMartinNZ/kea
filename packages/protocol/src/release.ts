// Where Kea's releases live: one public GitHub repository, named here once. The packages' apt source and rpm
// repository file, the `latest-mac.yml` feed and install.sh take every release URL from it. Set to null, it names no
// repository: a package then adds none, the feed names no URL and `pnpm package --release` refuses to build.
//
// Also the names of a release's files, which tools/pack gives the files it makes and main's update check looks for in
// a release's `SHA256SUMS`, so the two always agree.

/** `owner/name` of Kea's GitHub repository, or null for none. */
export const RELEASE_REPOSITORY: string | null = 'NathanMartinNZ/kea'

/**
 * Whether the rpm repository (GitHub Pages) is published. Until it is, an rpm's repository file points at nothing, so
 * an rpm install counts as one without a repository: its update is install.sh's, never `dnf upgrade`.
 */
export const RPM_REPOSITORY_PUBLISHED = false

/** The macOS bundle's name and the Linux executable's and package's. */
export const PRODUCT_NAME = 'Kea'
export const LINUX_NAME = 'kea-app'

/** The architectures releases are built for. */
export type ReleaseArch = 'x64' | 'arm64'

export function debArch(arch: ReleaseArch): string {
  return arch === 'x64' ? 'amd64' : 'arm64'
}

export function rpmArch(arch: ReleaseArch): string {
  return arch === 'x64' ? 'x86_64' : 'aarch64'
}

/** A release's file names for one version and architecture (the zip exists for arm64 only). */
export function releaseFileNames(version: string, arch: ReleaseArch): { deb: string; rpm: string; tarball: string; tarDir: string; zip: string } {
  const tarDir = `${LINUX_NAME}-${version}-linux-${arch}`
  return { deb: `${LINUX_NAME}_${version}_${debArch(arch)}.deb`, rpm: `${LINUX_NAME}-${version}-1.${rpmArch(arch)}.rpm`, tarball: `${tarDir}.tar.gz`, tarDir, zip: `${PRODUCT_NAME}-${version}-arm64-mac.zip` }
}

/** Which of a release's files an install updates from. */
export type ReleaseFileKind = 'deb' | 'rpm' | 'tarball' | 'zip'

const VERSION = '(\\d+\\.\\d+\\.\\d+)([~-][0-9A-Za-z.-]+)?'

/** The pattern of one file kind's name for an architecture, with the version as its first group and a prerelease as its second. */
function fileName(kind: ReleaseFileKind, arch: ReleaseArch): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (kind === 'deb') return new RegExp(`^${esc(LINUX_NAME)}_${VERSION}_${esc(debArch(arch))}\\.deb$`)
  if (kind === 'rpm') return new RegExp(`^${esc(LINUX_NAME)}-${VERSION}-\\d+\\.${esc(rpmArch(arch))}\\.rpm$`)
  if (kind === 'tarball') return new RegExp(`^${esc(LINUX_NAME)}-${VERSION}-linux-${arch}\\.tar\\.gz$`)
  return new RegExp(`^${esc(PRODUCT_NAME)}-${VERSION}-arm64-mac\\.zip$`)
}

/**
 * The version a release offers this install: the one in the name of its own file in the release's `SHA256SUMS`
 * (`<sha256>  <name>` per line). Null when the release has no such file (published without this system's files), or
 * only a prerelease (`1.1.0-rc.1`, `1.1.0~rc.1`), which is never offered.
 */
export function offeredVersion(sums: string, kind: ReleaseFileKind, arch: ReleaseArch): string | null {
  const re = fileName(kind, arch)
  for (const line of sums.split('\n')) {
    const m = /^[0-9a-f]{64}\s+\*?(\S+)\s*$/.exec(line)
    const name = m?.[1]
    const v = name ? re.exec(name) : null
    if (v && !v[2]) return v[1] as string
  }
  return null
}

/** `a` compared with `b`, both `major.minor.patch` (a prerelease suffix is ignored): negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.split(/[-~+]/)[0] ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** GitHub's rules for an owner (letters, digits, single hyphens inside) and a repository name. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/

/** `owner/name` read strictly, or null when it is not one. */
export function parseRepository(value: string): { owner: string; name: string } | null {
  const parts = value.split('/')
  if (parts.length !== 2) return null
  const [owner = '', name = ''] = parts
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || name === '.' || name === '..') return null
  return { owner, name }
}

/** The URLs every release file is named by. */
export interface ReleaseUrls {
  /** `…/releases/latest/download/`: the newest release's files, and the flat apt repository. */
  latest: string
  /** `…/releases/download/v<version>/<file>`: one release's file, as the updater's feed names the zip. */
  file(version: string, file: string): string
  /** The rpm repository's base on GitHub Pages, with dnf's `$basearch` left in. */
  rpmBase: string
  /** The repository signing key's public half, a release asset. */
  key: string
  /** A release's page, for its notes. */
  tag(version: string): string
}

export function releaseUrls(repository: string): ReleaseUrls {
  const r = parseRepository(repository)
  if (!r) throw new Error(`"${repository}" is not a GitHub repository (owner/name)`)
  const base = `https://github.com/${r.owner}/${r.name}/releases`
  return {
    latest: `${base}/latest/download/`,
    file: (version, file) => `${base}/download/v${version}/${file}`,
    rpmBase: `https://${r.owner.toLowerCase()}.github.io/${r.name}/rpm/$basearch`,
    key: `${base}/latest/download/kea-app.asc`,
    tag: (version) => `${base}/tag/v${version}`,
  }
}
