// The end-to-end install test's stand-in for GitHub (E-DST-3): one HTTPS server, with a test CA's certificate,
// answering for the three hosts a release is fetched from, as GitHub answers them. Test tooling only: it serves a
// stand-in release made by `standin-release.sh` and nothing else.
//
//   github.com/<owner>/<name>/releases/latest/download/<file>  302 → …/releases/download/v<version>/<file>
//   github.com/<owner>/<name>/releases/download/v<version>/<file>  302 → release-assets.githubusercontent.com/…?<signature>
//   release-assets.githubusercontent.com/github-production-release-asset/<id>/<token>?…  the file
//   <owner>.github.io/<name>/rpm/…  the rpm repository's metadata (GitHub Pages)
//
// `--also <version>=<dir>` serves another release at its tag only (the tampered releases, for `--version`).
//
// Every request is logged as one line (host, method, the path as sent, status, where it was sent), so a run shows what
// apt, dnf, zypper and curl asked for: a `/./` in a path is logged as sent, then served as `/` (what GitHub itself does
// with one, only the real repository can show).
//
//   node release-standin.ts --release <dir> --pages <dir> --repository <owner/name> --version <v> --cert <pem> --key <pem>
//                           [--also <version>=<dir>]… [--listen 127.0.0.1] [--port 443] [--log <file>]
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

interface Options {
  release: string
  pages: string
  owner: string
  name: string
  version: string
  cert: string
  key: string
  listen: string
  port: number
  log: string | null
  /** Each tag's release folder: the latest's first. */
  releases: Map<string, string>
}

function readOptions(argv: string[]): Options {
  const o: Record<string, string> = { listen: '127.0.0.1', port: '443' }
  const also: [string, string][] = []
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]
    const v = argv[i + 1]
    if (!k?.startsWith('--') || v === undefined) throw new Error(`bad arguments near ${k ?? 'the end'}`)
    if (k === '--also') {
      const [version = '', dir = ''] = v.split('=')
      if (!version || !dir) throw new Error(`--also ${v}: <version>=<dir>`)
      also.push([version, path.resolve(dir)])
    } else o[k.slice(2)] = v
  }
  for (const k of ['release', 'pages', 'repository', 'version', 'cert', 'key']) if (!o[k]) throw new Error(`--${k} is needed`)
  const [owner = '', name = ''] = (o.repository as string).split('/')
  const release = path.resolve(o.release as string)
  const releases = new Map([[o.version as string, release], ...also]) // bounded: the latest and the --also folders, fixed at start
  return { release, pages: path.resolve(o.pages as string), owner, name, version: o.version as string, cert: o.cert as string, key: o.key as string, listen: o.listen as string, port: Number(o.port), log: o.log ?? null, releases }
}

const TYPES: Record<string, string> = { '.xml': 'text/xml', '.asc': 'text/plain', '.gz': 'application/gzip', '.zst': 'application/zstd', '.json': 'application/json' }

export function main(argv: string[]): void {
  const o = readOptions(argv)
  const tokens = new Map<string, string>() // bounded: one per file of the stand-in releases, made as each is first asked for
  const tokenFor = (file: string) => {
    for (const [t, f] of tokens) if (f === file) return t
    const t = randomUUID()
    tokens.set(t, file)
    return t
  }
  const releaseFile = (dir: string | undefined, name: string): string | null => {
    if (!dir || !/^[A-Za-z0-9._+~-]+$/.test(name) || name.startsWith('.')) return null
    const f = path.join(dir, name)
    return fs.existsSync(f) && fs.statSync(f).isFile() ? f : null
  }
  const log = (line: string) => {
    const l = `${new Date().toISOString()} ${line}\n`
    if (o.log) fs.appendFileSync(o.log, l)
    else process.stdout.write(l)
  }
  const pagesHost = `${o.owner.toLowerCase()}.github.io`
  const repoPath = `/${o.owner}/${o.name}/releases`

  const server = https.createServer({ cert: fs.readFileSync(o.cert), key: fs.readFileSync(o.key) }, (req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()
    const sent = req.url ?? '/'
    const url = new URL(sent, `https://${host}`)
    // `/./` as a server would read it; `..` never
    const p = url.pathname.replace(/\/(\.\/)+/g, '/')
    const done = (status: number, extra = '') => log(`${host} ${req.method} ${sent} ${status}${extra}`)
    const redirect = (to: string) => {
      res.writeHead(302, { location: to, 'content-length': 0 })
      res.end()
      done(302, ` → ${to}`)
    }
    const notFound = () => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not Found')
      done(404)
    }
    const serve = (file: string) => {
      const st = fs.statSync(file)
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'content-length': st.size, 'last-modified': st.mtime.toUTCString() })
      if (req.method === 'HEAD') res.end()
      else fs.createReadStream(file).pipe(res)
      done(200)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound()
    if (p.includes('/../') || p.endsWith('/..')) return notFound()

    if (host === 'github.com') {
      const latest = `${repoPath}/latest/download/`
      const tagged = /^\/[^/]+\/[^/]+\/releases\/download\/v([^/]+)\/([^/]+)$/.exec(p)
      if (p.startsWith(latest)) {
        const name = p.slice(latest.length)
        return releaseFile(o.release, name) ? redirect(`https://github.com${repoPath}/download/v${o.version}/${name}`) : notFound()
      }
      if (tagged && p.startsWith(`${repoPath}/download/`)) {
        const [, version = '', name = ''] = tagged
        const file = releaseFile(o.releases.get(version), name)
        if (!file) return notFound()
        const q = new URLSearchParams({ sp: 'r', sv: '2018-11-09', sr: 'b', spr: 'https', se: new Date(Date.now() + 300_000).toISOString(), rscd: `attachment; filename=${name}`, rsct: 'application/octet-stream', sig: randomUUID() })
        return redirect(`https://release-assets.githubusercontent.com/github-production-release-asset/1/${tokenFor(file)}?${q}`)
      }
      return notFound()
    }
    if (host === 'release-assets.githubusercontent.com') {
      const m = /^\/github-production-release-asset\/1\/([0-9a-f-]+)$/.exec(p)
      const file = m && url.searchParams.get('sig') ? tokens.get(m[1] as string) : undefined
      return file ? serve(file) : notFound()
    }
    if (host === pagesHost && p.startsWith(`/${o.name}/rpm/`)) {
      const file = path.join(o.pages, p)
      if (!file.startsWith(`${o.pages}/`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return notFound()
      return serve(file)
    }
    return notFound()
  })
  server.listen(o.port, o.listen, () => {
    log(`stand-in for ${o.owner}/${o.name} v${o.version}: https on ${o.listen}:${o.port} (github.com, release-assets.githubusercontent.com, ${pagesHost})`)
    // the one line on stdout, which a runner waits for (with --log every request goes to the file)
    if (o.log) process.stdout.write('ready\n')
  })
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(`release-standin: ${(e as Error).message}`)
    process.exit(1)
  }
}
