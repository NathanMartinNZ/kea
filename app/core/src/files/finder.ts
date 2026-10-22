// The finder's index, core side: the candidate paths of one session's working directory, held in a worker thread
// (finder-worker.ts) that also does the matching. Built on the first query from `git ls-files -z -co
// --exclude-standard` (a folder that is not a repository: a bounded walk that skips the usual build and dependency
// folders), patched from watcher events, dropped by its owner L.finderDropMs after its last query.
//
// One query runs at a time; a query that arrives while one runs waits, and a later one replaces it (the palette only
// wants the answer to what is typed now).

import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { git, namesAsStored, type Logger } from '@kea/kit'
import { L, type FinderHit } from '@kea/protocol'
import { WORKTREE_EXCLUSIONS } from '../platform/watch/exclusions.ts'
import type { FinderWorkerData, FromWorker, ToWorker } from './finder-worker.ts'
import type { Env } from './status.ts'

export interface FinderAnswer {
  hits: FinderHit[]
  total: number
  truncated: boolean
  superseded: boolean
}

export interface FinderOptions {
  root: string
  /** The working directory is a git work tree. */
  git: boolean
  env: () => Promise<Env>
  log?: Logger | undefined
}

const WORKER_BUNDLE = 'finder-worker.cjs'

/** Start the worker: the build's own bundle beside core.cjs (read here, so it also loads from the asar), else the source file. */
export function startFinderWorker(data: FinderWorkerData, log?: Logger): Worker {
  const bundle = typeof __filename === 'string' ? path.join(path.dirname(__filename), WORKER_BUNDLE) : null
  if (bundle && fs.existsSync(bundle)) {
    log?.info('finder worker started', { file: bundle }) // which copy a build runs (a packaged app: inside app.asar)
    return new Worker(fs.readFileSync(bundle, 'utf8'), { eval: true, workerData: data, name: 'kea-finder' })
  }
  return new Worker(new URL('./finder-worker.ts', import.meta.url), { workerData: data, name: 'kea-finder' })
}

interface Asked {
  msg: Extract<ToWorker, { t: 'query' }>
  changed: ReadonlySet<string>
  resolve(a: FinderAnswer): void
}

export class FinderIndex {
  private worker: Worker | null = null
  private built: Promise<void> | null = null
  private abort: AbortController | null = null
  private inflight: Asked | null = null
  private waiting: Asked | null = null
  private nextId = 1
  private disposed = false
  private readonly o: FinderOptions
  /** Paths in the index as of its last report. */
  paths = 0
  truncated = false
  /** Something happened the patches do not cover (a rescan, the ignore rules changed): rebuilt on the next query. */
  stale = false
  builds = 0
  queries = 0
  /** The worker's time for the last query and the longest so far (P-FIND-1). */
  lastMs = 0
  maxMs = 0

  constructor(o: FinderOptions) {
    this.o = o
  }

  get building(): boolean {
    return this.abort !== null
  }
  get hasWorker(): boolean {
    return this.worker !== null
  }

  private post(m: ToWorker, transfer?: ArrayBuffer[]): void {
    this.worker?.postMessage(m, transfer ?? [])
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    // On Linux names stay as stored; the worker matches their NFC key and answers with the stored path
    const w = startFinderWorker({ maxPaths: L.finderPathsMax, asStored: namesAsStored() }, this.o.log)
    w.unref() // it never keeps core alive
    w.on('message', (m: FromWorker) => this.onMessage(m))
    w.on('error', (e) => {
      this.o.log?.error('finder worker failed', { error: String(e) })
      this.fail()
    })
    this.worker = w
    return w
  }

  private onLoaded: (() => void) | null = null

  private onMessage(m: FromWorker): void {
    if (m.t === 'loaded') {
      this.paths = m.total
      this.truncated ||= m.truncated
      this.onLoaded?.()
      return
    }
    if (m.t !== 'result') return // a size walk's answer is the disk service's worker's, never this one's
    const asked = this.inflight
    if (!asked || asked.msg.id !== m.id) return
    this.inflight = null
    this.paths = m.total
    this.lastMs = m.ms
    this.maxMs = Math.max(this.maxMs, m.ms)
    asked.resolve({ hits: m.hits.map((h) => ({ path: h.path, matched: h.matched, changed: asked.changed.has(h.path) })), total: m.total, truncated: this.truncated || m.truncated, superseded: false })
    this.pump()
  }

  private fail(): void {
    const empty: FinderAnswer = { hits: [], total: 0, truncated: false, superseded: false }
    this.inflight?.resolve(empty)
    this.waiting?.resolve(empty)
    this.inflight = this.waiting = null
    void this.worker?.terminate()
    this.worker = null
    this.built = null
    this.onLoaded?.()
  }

  /** Read the candidate list into the worker. */
  private build(): Promise<void> {
    this.ensureWorker()
    this.builds++
    this.stale = false
    this.truncated = false
    const ac = new AbortController()
    this.abort = ac
    this.post({ t: 'reset' })
    const send = (chunk: Buffer): void => {
      // a copy of its own: the stream reuses the chunk's memory, and this one is handed over, not cloned
      const copy = new Uint8Array(chunk.byteLength)
      copy.set(chunk)
      this.post({ t: 'chunk', buf: copy }, [copy.buffer])
    }
    const loaded = new Promise<void>((resolve) => (this.onLoaded = resolve))
    const read = this.o.git ? this.readGit(send, ac) : this.walk(send, ac)
    return read
      .catch((e: unknown) => this.o.log?.warn('finder index build failed', { root: this.o.root, error: String(e) }))
      .then(() => {
        if (this.abort === ac) this.abort = null
        if (this.disposed || !this.worker) return
        this.post({ t: 'end' })
        return loaded
      })
      .then(() => {
        this.onLoaded = null
      })
  }

  private async readGit(send: (b: Buffer) => void, ac: AbortController): Promise<void> {
    let seen = 0
    const r = await git(['ls-files', '-z', '-co', '--exclude-standard'], {
      cwd: this.o.root,
      env: await this.o.env(),
      readOnly: true,
      signal: ac.signal,
      maxBytes: L.gitLsfilesCapBytes,
      timeoutMs: L.gitDefaultTimeoutMs,
      onStdout: (chunk) => {
        if (ac.signal.aborted) return
        send(chunk)
        for (let i = chunk.indexOf(0); i >= 0; i = chunk.indexOf(0, i + 1)) seen++
        if (seen > L.finderPathsMax) {
          this.truncated = true
          ac.abort() // the cap: git is killed, the index holds the first L.finderPathsMax
        }
      },
    })
    if (r.truncated) this.truncated = true
  }

  /** A folder that is not a repository: every file below it, skipping the folders nobody searches, up to the cap. */
  private async walk(send: (b: Buffer) => void, ac: AbortController): Promise<void> {
    const skip = new Set<string>(WORKTREE_EXCLUSIONS)
    // bounded: directories still to read; the walk ends at L.finderPathsMax files
    const queue: string[] = ['']
    let files = 0
    let batch: string[] = []
    const flush = (): void => {
      if (batch.length) send(Buffer.from(`${batch.join('\0')}\0`))
      batch = []
    }
    while (queue.length && !ac.signal.aborted) {
      const dir = queue.pop() as string
      let handle: fs.Dir
      try {
        handle = await fs.promises.opendir(path.join(this.o.root, dir))
      } catch {
        continue
      }
      for await (const d of handle) {
        if (ac.signal.aborted) break
        const rel = dir === '' ? d.name : `${dir}/${d.name}`
        if (d.isDirectory()) {
          if (!skip.has(d.name)) queue.push(rel)
        } else if (d.isFile() || d.isSymbolicLink()) {
          batch.push(rel)
          if (batch.length >= L.watchChunk) flush()
          if (++files >= L.finderPathsMax) {
            this.truncated = true
            flush()
            return
          }
        }
      }
    }
    flush()
  }

  /** Watcher events: created or updated files join (a path the index has stays once), deleted paths (and everything below a deleted folder) leave. */
  patch(add: string[], del: string[]): void {
    if (!this.worker || !this.built || this.stale) return
    if (add.length || del.length) this.post({ t: 'patch', add, del, delBelow: del })
  }

  private pump(): void {
    if (this.inflight || !this.waiting) return
    this.inflight = this.waiting
    this.waiting = null
    this.post(this.inflight.msg)
  }

  /** The best matches for `query`. `changed`: the session's changed paths; `recent`: most recent first. */
  async query(query: string, changed: ReadonlySet<string>, recent: readonly string[]): Promise<FinderAnswer> {
    if (this.disposed) return { hits: [], total: 0, truncated: false, superseded: true }
    this.queries++
    const msg: Asked['msg'] = { t: 'query', id: this.nextId++, query, limit: L.finderResults, changed: [...changed], recent: [...recent] }
    const answer = new Promise<FinderAnswer>((resolve) => {
      // the palette wants the latest query only: one still waiting gives way
      this.waiting?.resolve({ hits: [], total: this.paths, truncated: this.truncated, superseded: true })
      this.waiting = { msg, changed, resolve }
    })
    if (!this.built || this.stale) this.built = this.build()
    await this.built
    this.pump()
    return answer
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort?.abort()
    this.abort = null
    const gone: FinderAnswer = { hits: [], total: 0, truncated: false, superseded: true }
    this.inflight?.resolve(gone)
    this.waiting?.resolve(gone)
    this.inflight = this.waiting = null
    void this.worker?.terminate()
    this.worker = null
    this.onLoaded?.()
  }
}
