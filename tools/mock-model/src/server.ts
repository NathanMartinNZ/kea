// The mock model endpoint: a local HTTP server that speaks enough of the Anthropic API for the real `claude` binary,
// pointed at it with ANTHROPIC_BASE_URL. Records every request and answers from a script.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib'
import { encodeSse, errorBody, estimateTokens, isErrorReply, type Reply, text, toMessage, toSseEvents } from './reply.ts'
import { type Answer, isAgentLoop, type Matcher, matches, REDACTED_HEADERS, type RecordedRequest, toJson } from './request.ts'

/** A reply waiting in the script queue, with the requests it may answer. */
export type ScriptedReply = Reply & { when?: Matcher }

export interface MockModelOptions {
  /** Answered in order, each to the first request its `when` matches (default: an agent-loop request, `isAgentLoop`). */
  replies?: ScriptedReply[]
  /** Answer when no scripted reply matches (or the queue is empty). Default `text('ok')`. */
  defaultReply?: Reply
  /** `when` for scripted replies that have none. */
  defaultWhen?: Matcher
  /** Models listed by `GET /v1/models`. */
  models?: string[]
  host?: string
  /** 0 = any free port. */
  port?: number
  /** Most requests kept in `requests`; older ones are dropped and counted in `dropped()`. */
  maxRecorded?: number
  /** Called once per request after it is answered (CLI logging). */
  onRequest?: (r: RecordedRequest) => void
}

export interface MockModel {
  /** `http://127.0.0.1:<port>`: the value for ANTHROPIC_BASE_URL. */
  url: string
  port: number
  /** Every request in arrival order. */
  requests: RecordedRequest[]
  /** Requests dropped because `requests` reached `maxRecorded`. */
  dropped(): number
  enqueue(...replies: ScriptedReply[]): void
  /** Scripted replies not yet used. */
  pending(): number
  /** Resolves with the first recorded request (past or future) that matches, or rejects after `timeoutMs`. */
  waitFor(m: Matcher, timeoutMs?: number): Promise<RecordedRequest>
  /** Forget recorded requests and queued replies. */
  reset(): void
  close(): Promise<void>
}

// Tool defaults (not spec numbers).
const DEFAULT_MAX_RECORDED = 1000
const DEFAULT_WAIT_MS = 10_000
const MAX_BODY_BYTES = 64 * 1024 * 1024
export const DEFAULT_MODELS = ['claude-fable-5', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5']

function decode(buf: Buffer, encoding: string | undefined): Buffer {
  switch (encoding?.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(buf)
    case 'deflate':
      return inflateSync(buf)
    case 'br':
      return brotliDecompressSync(buf)
    case 'zstd':
      return zstdDecompressSync(buf)
    default:
      return buf
  }
}

function parseBody(buf: Buffer): unknown {
  if (buf.length === 0) return undefined
  const s = buf.toString('utf8')
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || REDACTED_HEADERS.has(k)) continue
    out[k] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...headers })
  res.end(s)
}


export async function startMockModel(opts: MockModelOptions = {}): Promise<MockModel> {
  type Queued = { reply: ScriptedReply; index: number }
  const queue: Queued[] = [] // bounded: by what the test enqueues; each entry is consumed by one request
  let enqueued = 0
  const defaultReply = opts.defaultReply ?? text('ok')
  const defaultWhen = opts.defaultWhen ?? isAgentLoop
  const models = opts.models ?? DEFAULT_MODELS
  const maxRecorded = opts.maxRecorded ?? DEFAULT_MAX_RECORDED
  const requests: RecordedRequest[] = [] // bounded: maxRecorded, oldest dropped
  let dropped = 0
  let seq = 0
  type Waiter = { m: Matcher; resolve: (r: RecordedRequest) => void; reject: (e: Error) => void }
  const waiters = new Set<Waiter>() // bounded: one per pending waitFor, removed on resolve or timeout
  // bounded: one per reply held by `delayMs`; removed when it fires or on close
  const delays = new Map<NodeJS.Timeout, (send: boolean) => void>()
  let closed = false

  /** Holds a reply for `ms`; resolves false when the mock closes meanwhile (the reply is then dropped). */
  const delay = (ms: number | undefined): Promise<boolean> =>
    !ms
      ? Promise.resolve(!closed)
      : new Promise((resolve) => {
          const t = setTimeout(() => {
            delays.delete(t)
            resolve(!closed)
          }, ms)
          delays.set(t, resolve)
        })

  function record(r: RecordedRequest): void {
    requests.push(r)
    if (requests.length > maxRecorded) {
      requests.shift()
      dropped++
    }
    for (const w of waiters) {
      if (matches(w.m, r)) {
        waiters.delete(w)
        w.resolve(r)
      }
    }
  }

  /** Take the first queued reply whose matcher accepts the request. */
  function take(r: RecordedRequest): { reply: Reply; answer: Answer } {
    const i = queue.findIndex((q) => matches(q.reply.when ?? defaultWhen, r))
    if (i < 0) return { reply: defaultReply, answer: { kind: 'default' } }
    const [q] = queue.splice(i, 1)
    return { reply: q!.reply, answer: { kind: 'scripted', index: q!.index } }
  }

  /** Writes a Messages reply (a message, its SSE stream, or an API error). */
  function sendReply(r: RecordedRequest, reply: Reply, res: ServerResponse): void {
    const requestId = { 'request-id': `req_mock_${r.seq}` }
    if (isErrorReply(reply)) {
      const e = reply.error
      return sendJson(res, e.status, errorBody(e.type, e.message ?? e.type), { ...requestId, ...reply.headers })
    }
    const body = (r.body ?? {}) as Record<string, unknown>
    const model = typeof body['model'] === 'string' ? body['model'] : 'claude-mock'
    const message = toMessage(reply, r.seq, model, estimateTokens(JSON.stringify(body['messages'] ?? '')))
    if (body['stream'] === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', ...requestId })
      res.end(encodeSse(toSseEvents(message)))
    } else {
      sendJson(res, 200, message, requestId)
    }
  }

  const modelInfo = (id: string) => ({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' })

  /** Picks the answer for a recorded request synchronously, so requests are recorded in arrival order and a test
   * waiting on one sees it while a delayed reply is still pending. Returns how long to wait and what to send. */
  function route(r: RecordedRequest, path: string): { delayMs?: number; send(res: ServerResponse): void } {
    const body = (r.body ?? {}) as Record<string, unknown>
    if (r.method === 'POST' && path === '/v1/messages') {
      const { reply, answer } = take(r)
      r.answer = answer
      return { ...(reply.delayMs === undefined ? {} : { delayMs: reply.delayMs }), send: (res) => sendReply(r, reply, res) }
    }
    if (r.method === 'POST' && path === '/v1/messages/count_tokens') {
      r.answer = { kind: 'count_tokens' }
      return { send: (res) => sendJson(res, 200, { input_tokens: estimateTokens(JSON.stringify([body['system'], body['messages'], body['tools']])) }) }
    }
    if (r.method === 'GET' && path === '/v1/models') {
      r.answer = { kind: 'models' }
      return { send: (res) => sendJson(res, 200, { data: models.map(modelInfo), has_more: false, first_id: models[0] ?? null, last_id: models[models.length - 1] ?? null }) }
    }
    if (r.method === 'GET' && path.startsWith('/v1/models/')) {
      r.answer = { kind: 'models' }
      return { send: (res) => sendJson(res, 200, modelInfo(decodeURIComponent(path.slice('/v1/models/'.length)))) }
    }
    if ((r.method === 'GET' || r.method === 'HEAD') && path === '/') {
      r.answer = { kind: 'unknown', status: 200 }
      return { send: (res) => sendJson(res, 200, { ok: true }) }
    }
    r.answer = { kind: 'unknown', status: 404 }
    return { send: (res) => sendJson(res, 404, errorBody('not_found_error', `mock-model: no route for ${r.method} ${path}`)) }
  }

  async function handle(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
    const mono = process.hrtime.bigint()
    const u = new URL(req.url ?? '/', 'http://mock')
    const method = req.method ?? 'GET'
    const body = parseBody(decode(raw, req.headers['content-encoding']))
    const path = u.pathname.replace(/\/+$/, '') || '/'
    if (path.startsWith('/__mock/')) {
      // Control API for out-of-process harnesses (the CLI): not recorded.
      if (path === '/__mock/requests' && method === 'GET') return sendJson(res, 200, requests.map(toJson))
      if (path === '/__mock/replies' && method === 'POST' && Array.isArray(body)) {
        api.enqueue(...(body as ScriptedReply[]))
        return sendJson(res, 200, { pending: queue.length })
      }
      if (path === '/__mock/reset' && method === 'POST') {
        api.reset()
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 404, errorBody('not_found_error', `mock-model: unknown control path ${method} ${path}`))
    }
    const r: RecordedRequest = {
      seq: ++seq,
      mono,
      at: Date.now(),
      method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: headersOf(req),
      body,
      answer: { kind: 'default' },
    }
    const out = route(r, path)
    record(r)
    if (!(await delay(out.delayMs))) return
    out.send(res)
    opts.onRequest?.(r)
  }

  const server = createServer((req, res) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        sendJson(res, 413, errorBody('request_too_large', 'mock-model: body too large'))
        req.destroy()
      } else parts.push(c)
    })
    req.on('end', () => {
      handle(req, res, Buffer.concat(parts)).catch((err: unknown) => {
        if (!res.headersSent) sendJson(res, 500, errorBody('api_error', `mock-model: ${String(err)}`))
        else res.end()
      })
    })
  })
  server.keepAliveTimeout = 1000

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve())
  })
  const { port, address } = server.address() as AddressInfo
  const host = address.includes(':') ? `[${address}]` : address

  const api: MockModel = {
    url: `http://${host}:${port}`,
    port,
    requests,
    dropped: () => dropped,
    enqueue(...replies) {
      for (const reply of replies) queue.push({ reply, index: enqueued++ })
    },
    pending: () => queue.length,
    waitFor(m, timeoutMs = DEFAULT_WAIT_MS) {
      const hit = requests.find((r) => matches(m, r))
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const w: Waiter = {
          m,
          resolve: (r) => {
            clearTimeout(timer)
            resolve(r)
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          },
        }
        const timer = setTimeout(() => {
          waiters.delete(w)
          reject(new Error(`mock-model: no matching request within ${timeoutMs} ms`))
        }, timeoutMs)
        waiters.add(w)
      })
    },
    reset() {
      requests.length = 0
      queue.length = 0
      enqueued = 0
      dropped = 0
    },
    close: () =>
      new Promise<void>((resolve) => {
        closed = true
        for (const w of waiters) w.reject(new Error('mock-model: closed'))
        waiters.clear()
        for (const [t, resolveDelay] of delays) {
          clearTimeout(t)
          resolveDelay(false)
        }
        delays.clear()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
  api.enqueue(...(opts.replies ?? []))
  return api
}
