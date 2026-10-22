// `kea-file://`: how the window shows a local image. Electron requires protocol handlers to live in main, so this is
// main's one data-path duty. A request is served only when all of this holds, and refused otherwise without saying more
// than a status:
//   · the URL is exactly a `kea-file://f/<absolute path>` (protocol viewer.ts `keaFilePath`: no traversal segment is
//     ever resolved);
//   · the path, and the file it really is, both have an image type's extension (nothing else is ever served: no
//     HTML, no script, no text);
//   · its real path lies inside the real path of a working directory some window shows (the visible set, which core
//     keeps and sends here): a symlink in a worktree that leads out of it resolves to nothing;
//   · it is a regular file (opened without following a link put there since and without waiting on a FIFO) of at
//     most L.imageMaxBytes.
// The handler is not told which window asks, so the directories are those of every window.
// Responses carry `nosniff`, `no-store` and a policy that makes the document inert were it ever navigated to; the
// window shows them through `<img>` only, where an SVG's scripts and external loads do not run.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { imageExtension, keaFilePath, L, type ImageExtension } from '@kea/protocol'

const MIME: Record<ImageExtension, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/** Each window's working directories, as core last said (process.ts `visible`). */
export class VisibleDirs {
  // bounded: one entry per window connection showing a session; dropped with the connection and when core exits
  private readonly byConn = new Map<number, readonly string[]>()

  set(connId: number, dirs: readonly string[]): void {
    const abs = dirs.filter((d) => path.isAbsolute(d))
    if (abs.length === 0) this.byConn.delete(connId)
    else this.byConn.set(connId, abs)
  }

  drop(connId: number): void {
    this.byConn.delete(connId)
  }

  /** Core is gone: what it said is void until the next core says it again. */
  clear(): void {
    this.byConn.clear()
  }

  /** Every directory some window shows, each once. */
  all(): string[] {
    return [...new Set([...this.byConn.values()].flat())]
  }

  get size(): number {
    return this.byConn.size
  }
}

export type KeaFileRefusal = 'url' | 'type' | 'outside' | 'missing' | 'special' | 'large'

export type KeaFileAnswer = { ok: true; real: string; type: string; size: number; fh: fsp.FileHandle } | { ok: false; status: number; why: KeaFileRefusal }

const refuse = (status: number, why: KeaFileRefusal): KeaFileAnswer => ({ ok: false, status, why })
const inside = (root: string, p: string) => p.startsWith(root + path.sep)

/** The file a `kea-file://` URL may show, opened, or why not. The caller closes `fh`. */
export async function resolveKeaFile(url: string, dirs: readonly string[]): Promise<KeaFileAnswer> {
  const asked = keaFilePath(url)
  if (asked === null) return refuse(400, 'url')
  if (imageExtension(asked) === null) return refuse(403, 'type')
  let real: string
  try {
    real = await fsp.realpath(asked)
  } catch {
    return refuse(404, 'missing')
  }
  // where the path really leads decides, never how it was written
  let allowed = false
  for (const dir of dirs) {
    const root = await fsp.realpath(dir).catch(() => null)
    if (root !== null && inside(root, real)) {
      allowed = true
      break
    }
  }
  if (!allowed) return refuse(403, 'outside')
  const ext = imageExtension(real)
  if (ext === null) return refuse(403, 'type')
  let fh: fsp.FileHandle
  try {
    fh = await fsp.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch {
    return refuse(404, 'missing')
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) {
      await fh.close()
      return refuse(403, 'special')
    }
    if (st.size > L.imageMaxBytes) {
      await fh.close()
      return refuse(413, 'large')
    }
    return { ok: true, real, type: MIME[ext], size: st.size, fh }
  } catch {
    await fh.close().catch(() => undefined)
    return refuse(404, 'missing')
  }
}

const HEADERS = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" }

/** The `protocol.handle('kea-file', …)` handler. `onRefused`: for the log (the reason and status only, never the path). */
export async function serveKeaFile(req: { url: string; method: string }, dirs: readonly string[], onRefused?: (why: KeaFileRefusal, status: number) => void): Promise<Response> {
  if (req.method !== 'GET') {
    onRefused?.('url', 405)
    return new Response(null, { status: 405, headers: HEADERS })
  }
  const a = await resolveKeaFile(req.url, dirs)
  if (!a.ok) {
    onRefused?.(a.why, a.status)
    return new Response(null, { status: a.status, headers: HEADERS })
  }
  // at most the size checked above is sent, even if the file grows meanwhile; the stream closes the handle
  const stream = a.fh.createReadStream({ start: 0, end: Math.max(0, a.size - 1), autoClose: true })
  const body = a.size === 0 ? null : (Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>)
  if (a.size === 0) await a.fh.close().catch(() => undefined)
  return new Response(body, { status: 200, headers: { ...HEADERS, 'content-type': a.type, 'content-length': String(a.size) } })
}
