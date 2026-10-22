// Where Kea's releases live: one public GitHub repository, named here once. The packages' apt source and rpm
// repository file, the `latest-mac.yml` feed and install.sh take every release URL from it. Set to null, it names no
// repository: a package then adds none, the feed names no URL and `pnpm package --release` refuses to build.

/** `owner/name` of Kea's GitHub repository, or null for none. */
export const RELEASE_REPOSITORY: string | null = 'NathanMartinNZ/kea'

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
  }
}
