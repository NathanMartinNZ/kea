// Fixture privacy: a length-preserving scrubber for recorded fixtures and the scan behind the privacy gate (K-FX-8).
// Works on Buffers, byte for byte: cassettes are byte-exact recordings with offsets and screen goldens, so every
// replacement keeps the byte length and nothing outside a match is touched.
//
// Placeholder scheme (identity): a value of n bytes becomes an ASCII tag padded with `_` to n bytes, the tag cut when
// n is shorter than it. Paths keep their `/Users/` (or `/home/`) prefix:
//   home  /Users/alexis          → /Users/HOME__
//   user  alexis                 → USER__
//   host  Alexis-MBP.local      → HOST_____________
//   name  Alexis Example         → NAME__________          (git user.name, macOS full name)
//   email alexis@example.com     → EMAIL_____________      (git user.email)
// Secrets keep a short recognisable prefix and turn the rest into `x` (same length): `sk-ant-xxxx…`, `ghp_xxxx…`,
// `AKIAxxxx…`, `xoxb-xxxx…`, `eyJxxxx.xxxx.xxxx` (dots kept), PEM bodies (line breaks kept), the value of secret-looking
// `KEY=value` lines (every `KEY=value` line in a `.env*` file), secret-looking JSON string fields, URL passwords and
// `Authorization:` header values. A match whose secret part is already all `x` counts as scrubbed.
//
// A user or host name on GENERIC_NAMES (root, runner, ubuntu, …: CI runners, containers, cloud images) is not searched
// for, since it identifies no one and appears in ordinary text; nor is a home outside /Users and /home named after one,
// such as /root. A home under /Users or /home, names and emails are always searched for. Whoever the developer is,
// the scan also reports every home folder under /Users or /home that is not a placeholder or the tests' own account.
import { execFileSync } from 'node:child_process'
import { homedir, hostname, userInfo } from 'node:os'

export type Identity = {
  home?: string
  user?: string
  hosts?: string[]
  /** git user.name, macOS full name */
  names?: string[]
  /** git user.email */
  emails?: string[]
}

export type ScrubContext = {
  identity: Identity
  /** Treat the content as a `.env` file: scrub the value of every `KEY=value` line. */
  envFile?: boolean
}

export type Finding = { kind: 'secret' | 'identity'; label: string; offset: number; line: number; length: number }

export type ScrubResult = { output: Buffer; counts: Record<string, number> }

/** The developer's identity, from the OS and git config. Missing values are skipped. */
export function currentIdentity(cwd: string = process.cwd()): Identity {
  const git = (key: string) => {
    try {
      return execFileSync('git', ['config', '--get', key], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return ''
    }
  }
  let fullName = ''
  if (process.platform === 'darwin') { // os-ok: `id -F` (the full name) exists on macOS only
    try {
      fullName = execFileSync('id', ['-F'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      fullName = ''
    }
  }
  const host = hostname()
  const hosts = [host, host.replace(/\.local$/i, '')].filter((h, i, a) => h && a.indexOf(h) === i)
  const names = [git('user.name'), fullName].filter((n, i, a) => n && a.indexOf(n) === i)
  const emails = [git('user.email')].filter(Boolean)
  return { home: homedir(), user: userInfo().username, hosts, names, emails }
}

// ── identity ─────────────────────────────────────────────────────────────────────────────────────

/** An ASCII placeholder of exactly `bytes` bytes: the tag padded with `_`, or cut. */
export function placeholder(tag: string, bytes: number): string {
  return bytes <= tag.length ? tag.slice(0, bytes) : tag + '_'.repeat(bytes - tag.length)
}

const latin1 = (s: string) => Buffer.from(s, 'utf8').toString('latin1')
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

type Needle = { label: string; re: RegExp; replace: (m: string) => string }

/** Account and host names of CI runners, containers and cloud images, compared without case. */
export const GENERIC_NAMES: ReadonlySet<string> = new Set([
  'root', 'admin', 'user', 'runner', 'ubuntu', 'debian', 'fedora', 'ec2-user', 'vagrant', 'pi', 'dev', 'node', 'vscode',
  'codespace', 'gitpod', 'app', 'build', 'builder', 'test', 'jenkins', 'localhost',
])
const isGeneric = (name: string) => GENERIC_NAMES.has(name.toLowerCase())

function identityNeedles(id: Identity): Needle[] {
  const out: { label: string; value: string; bounded: boolean; tag: string; keepPrefix?: string }[] = []
  if (id.home && id.home.length >= 4) {
    const m = /^(\/Users\/|\/home\/)(.+)$/.exec(id.home)
    // a home such as /root would also match inside ordinary paths (/mnt/root); one under /Users or /home cannot
    if (m || !isGeneric(id.home.slice(id.home.lastIndexOf('/') + 1))) {
      out.push({ label: 'home path', value: id.home, bounded: false, tag: 'HOME', ...(m ? { keepPrefix: m[1]! } : {}) })
    }
  }
  for (const e of id.emails ?? []) if (e.length >= 5) out.push({ label: 'email', value: e, bounded: false, tag: 'EMAIL' })
  for (const n of id.names ?? []) if (n.length >= 3) out.push({ label: 'name', value: n, bounded: true, tag: 'NAME' })
  for (const h of id.hosts ?? []) if (h.length >= 3 && !isGeneric(h)) out.push({ label: 'host name', value: h, bounded: true, tag: 'HOST' })
  if (id.user && id.user.length >= 3 && !isGeneric(id.user)) out.push({ label: 'user name', value: id.user, bounded: true, tag: 'USER' })
  // longest first, so `/Users/alexis` is replaced before `alexis`
  out.sort((a, b) => Buffer.byteLength(b.value) - Buffer.byteLength(a.value))
  return out.map((o) => {
    const v = escapeRe(latin1(o.value))
    const re = new RegExp(o.bounded ? `(?<![A-Za-z0-9])${v}(?![A-Za-z0-9])` : v, 'gi')
    return {
      label: o.label,
      re,
      replace: (m: string) => (o.keepPrefix ? o.keepPrefix + placeholder(o.tag, m.length - o.keepPrefix.length) : placeholder(o.tag, m.length)),
    }
  })
}

// ── secrets ──────────────────────────────────────────────────────────────────────────────────────

type SecretPattern = { label: string; re: RegExp; keep?: RegExp }

const SECRET_KEY_PART = '(?:API_?KEY|KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|AUTH|CREDENTIALS?|PRIVATE|DSN|COOKIE)'
const JSON_SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|cookie|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token|auth[_-]?token)(?:[_-]|$)/i

/** Each pattern's `body` group is the secret part; it becomes `x`s (dots and line breaks kept). */
export const SECRET_PATTERNS: SecretPattern[] = [
  { label: 'Anthropic key (sk-ant-)', re: /sk-ant-(?<body>[A-Za-z0-9_-]{8,})/dg },
  { label: 'GitHub token (ghp_…)', re: /(?<![A-Za-z0-9])gh[pousr]_(?<body>[A-Za-z0-9]{20,})/dg },
  { label: 'GitHub token (github_pat_)', re: /github_pat_(?<body>[A-Za-z0-9_]{20,})/dg },
  { label: 'AWS access key (AKIA)', re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)(?<body>[0-9A-Z]{16})(?![A-Za-z0-9])/dg },
  { label: 'Slack token (xoxb-/xoxp-)', re: /(?<![A-Za-z0-9])xox[abposr]-(?<body>[A-Za-z0-9-]{10,})/dg },
  { label: 'JWT', re: /(?<![A-Za-z0-9_-])eyJ(?<body>[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})/dg },
  { label: 'PEM block', re: /-----BEGIN (?<lbl>[A-Z0-9 ]{3,40})-----(?<body>[\s\S]*?)-----END \k<lbl>-----/dg },
  { label: 'URL password', re: /(?<![A-Za-z0-9])[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"\x00-\x1f]+:(?<body>[^\s@/'"\x00-\x1f]+)@/dgi },
  { label: 'Authorization header', re: /\b(?:Proxy-)?Authorization\s*:\s*(?:Bearer|Basic|Token)\s+(?<body>[A-Za-z0-9._~+/=-]{8,})/dgi },
  {
    label: 'secret KEY=value',
    re: new RegExp(`(?<![A-Za-z0-9_])(?:[A-Z0-9]+_)*${SECRET_KEY_PART}(?:_[A-Z0-9]+)*=(?<q>["']?)(?<body>[^\\s"'\\x00-\\x1f\\x7f]+)\\k<q>`, 'dg'),
  },
  {
    label: 'secret JSON field',
    re: /"(?<key>[A-Za-z0-9_-]{2,64})"\s*:\s*"(?<body>[^"\\\x00-\x1f]*(?:\\.[^"\\\x00-\x1f]*)*)"/dg,
    keep: JSON_SECRET_KEY,
  },
]

const ENV_LINE = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?<q>["']?)(?<body>[^\r\n"']*)\k<q>/dgm

function scrubbedAlready(body: string): boolean {
  return /^[x.\r\n\s]*$/.test(body)
}

function xOut(body: string): string {
  return body.replace(/[^.\r\n]/g, 'x')
}

type Hit = { label: string; kind: 'secret' | 'identity'; start: number; end: number; replacement: string; done: boolean }

function secretHits(text: string, envFile: boolean): Hit[] {
  const hits: Hit[] = []
  const patterns = envFile ? [...SECRET_PATTERNS, { label: '.env value', re: ENV_LINE }] : SECRET_PATTERNS
  for (const p of patterns) {
    p.re.lastIndex = 0
    for (const m of text.matchAll(p.re)) {
      const g = m.indices?.groups?.body
      const body = m.groups?.body
      if (!g || body === undefined || body.length === 0) continue
      if (p.keep && !p.keep.test(m.groups?.key ?? '')) continue
      if (/^\$\{?[A-Za-z_]/.test(body)) continue // a reference (`$OTHER`, `${OTHER}`), not a value
      hits.push({ label: p.label, kind: 'secret', start: g[0], end: g[1], replacement: xOut(body), done: scrubbedAlready(body) })
    }
  }
  return hits
}

function identityHits(text: string, id: Identity): Hit[] {
  const hits: Hit[] = []
  for (const n of identityNeedles(id)) {
    for (const m of text.matchAll(n.re)) {
      hits.push({ label: n.label, kind: 'identity', start: m.index, end: m.index + m[0].length, replacement: n.replace(m[0]), done: false })
    }
  }
  return hits
}

// `/Users/<name>` or `/home/<name>` where a path starts, its slashes JSON-escaped or not
const HOME_FOLDER_RE = /(?<![\w.~-])\\?\/(?:Users|home)\\?\/([^/\\\s'"`<>|;,:)\]}\x00-\x1f\x7f]+)/g

/** A home folder a fixture may name: a placeholder (`HOME___`, `USER__`, `xxxx`) or the tests' own account. */
function allowedHome(name: string): boolean {
  return name === placeholder('HOME', name.length) || name === placeholder('USER', name.length) || /^x+$/.test(name) || name === 'kea-test'
}

/** Home folders of anyone, found without knowing who: what the identity hits miss, such as another person's home. */
function homeFolderHits(text: string): Hit[] {
  const hits: Hit[] = []
  for (const m of text.matchAll(HOME_FOLDER_RE)) {
    if (!allowedHome(m[1]!)) hits.push({ label: 'home folder', kind: 'identity', start: m.index, end: m.index + m[0].length, replacement: m[0], done: false })
  }
  return hits
}

/** Drop hits that overlap an earlier (longer or earlier-listed) hit. */
function nonOverlapping(hits: Hit[]): Hit[] {
  const sorted = [...hits].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const out: Hit[] = []
  let end = -1
  for (const h of sorted) {
    if (h.start < end) continue
    out.push(h)
    end = h.end
  }
  return out
}

/** Scrub a buffer. Output has exactly the input's byte length. */
export function scrubBuffer(input: Buffer, ctx: ScrubContext): ScrubResult {
  let text = input.toString('latin1')
  const counts: Record<string, number> = {}
  // identity first (paths inside secrets are rare; secrets inside paths rarer), then secrets on the result
  for (const pass of [() => identityHits(text, ctx.identity), () => secretHits(text, ctx.envFile ?? false)]) {
    const hits = nonOverlapping(pass().filter((h) => !h.done))
    if (hits.length === 0) continue
    const parts: string[] = []
    let last = 0
    for (const h of hits) {
      parts.push(text.slice(last, h.start), h.replacement)
      last = h.end
      counts[h.label] = (counts[h.label] ?? 0) + 1
    }
    parts.push(text.slice(last))
    text = parts.join('')
  }
  const output = Buffer.from(text, 'latin1')
  if (output.length !== input.length) throw new Error(`scrubber changed the length (${input.length} → ${output.length})`)
  return { output, counts }
}

function lineAt(text: string, offset: number): number {
  let n = 1
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/**
 * The gate (K-FX-8): every match of a secret pattern that is not scrubbed, every occurrence of the developer's home
 * path, user name, host name, name or email, and every other home folder under /Users or /home that is not a
 * placeholder or the tests' account. Findings name the kind, never the value.
 */
export function scanForPrivateData(input: Buffer, ctx: ScrubContext): Finding[] {
  const text = input.toString('latin1')
  // the developer's own home is listed before the home-folder hit at the same place, so it keeps its own label
  const hits = [...identityHits(text, ctx.identity), ...homeFolderHits(text), ...secretHits(text, ctx.envFile ?? false).filter((h) => !h.done)]
  return nonOverlapping(hits).map((h) => ({ kind: h.kind, label: h.label, offset: h.start, line: lineAt(text, h.start), length: h.end - h.start }))
}

// ── absolute paths ───────────────────────────────────────────────────────────────────────────────

const ABS_PATH_RE = /(?<![\w.~-])\/(?:Users|home|private|var|tmp|Volumes|opt|Library|Applications|System|usr)\/[^\s'"`<>|;,)\]}\x00-\x1f\x7f]*/g
const SYSTEM_PREFIXES = ['/usr/', '/System/', '/Library/', '/opt/homebrew/', '/Applications/', '/private/etc/', '/var/db/'] // os-ok: the system prefixes the scrubber leaves as they are

/** Absolute paths outside the demo repo(s) and the system folders, for review. */
export function findAbsolutePaths(input: Buffer, demoRoots: string[] = []): { path: string; line: number }[] {
  const text = input.toString('latin1')
  const out: { path: string; line: number }[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(ABS_PATH_RE)) {
    const p = m[0].replace(/[.:]+$/, '')
    if (SYSTEM_PREFIXES.some((s) => p.startsWith(s))) continue
    if (demoRoots.some((r) => p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`))) continue
    if (seen.has(p)) continue
    seen.add(p)
    out.push({ path: Buffer.from(p, 'latin1').toString('utf8'), line: lineAt(text, m.index) })
  }
  return out
}

/** Is this file `.env`-style content (every `KEY=value` line is a secret)? */
export function isEnvFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return /^\.env(?:\..+)?$/.test(base) && !/\.(?:example|sample|template)$/.test(base)
}
