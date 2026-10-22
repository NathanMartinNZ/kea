// prober: sends terminal queries one at a time and records every reply with its timing as JSON lines (the mirror must
// give exactly one reply per query). The queries are the examples of packages/terminal's QUERY_TABLE, or
// sequences given on the command line. Each query is followed by a DA1 sentinel: every terminal answers DA1, so the
// sentinel's reply closes the query's window and anything else seen in the window is that query's reply. Input that
// arrives outside a window (a late duplicate, say) is recorded as a stray.

import { appendFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { tokenize } from '../../fake-agent/src/probes.ts'
import { type Answerer, QUERY_TABLE } from '../../../packages/terminal/src/queries.ts'
import { intFlag, parseFlags, runMain, unescape, UsageError } from './cli.ts'

export const SENTINEL = '\x1b[c'
const DA1_REPLY = /^\x1b\[\?[\d;]*c$/
const DA1_QUERY = /^\x1b\[0?c$/

export interface ProbeItem {
  id: string
  query: string
  /** Who should answer (QUERY_TABLE); null for a sequence given with --send (no expectation). */
  answeredBy: Answerer | null
  /** What the reply must look like (QUERY_TABLE); null: anything, or nothing expected. */
  reply: RegExp | null
}

export interface ReplyRecord {
  seq: string
  /** ms from sending the query. */
  ms: number
}

export interface ProbeRecord {
  t: 'reply'
  id: string
  query: string
  answeredBy: Answerer | null
  replies: ReplyRecord[]
  /** ms from sending to the sentinel's reply; null without a sentinel or when it never came. */
  sentinelMs: number | null
  timedOut: boolean
  /** Exactly one reply matching the table (none for `nobody` entries), and the sentinel came; null for --send. */
  ok: boolean | null
}

export interface StrayRecord {
  t: 'stray'
  seq: string
  /** ms since the run started. */
  ms: number
  /** The query whose window had closed before it arrived, if any. */
  after: string | null
}

export interface DoneRecord {
  t: 'done'
  queries: number
  ok: number
  notOk: string[]
  strays: number
  ms: number
}

export const PROBER_USAGE = `prober: sends terminal queries and records the replies as JSON lines (tools/process-zoo/README.md)

usage: node tools/process-zoo/src/prober.ts [options]
  --query ID         a QUERY_TABLE entry (repeatable); default: every entry
                     (${QUERY_TABLE.map((e) => e.id).join(', ')})
  --send SEQ         send this sequence too (repeatable); \\e \\a \\xHH escapes; reported as send-1, send-2, …
  --timeout-ms N     how long to wait for one query's window (default 1000)
  --settle-ms N      after the last query, how long to keep listening for strays (default 200)
  --no-sentinel      no DA1 after each query: every window lasts --timeout-ms
  --out FILE         append the JSON lines to FILE instead of stdout
  -h, --help         this text

Lines (on stdout: all at the end, after a newline): {"t":"reply","id","query","answeredBy","replies":[{"seq","ms"}],"sentinelMs","timedOut","ok"} per query,
{"t":"stray","seq","ms","after"} per stray, then {"t":"done","queries","ok","notOk","strays","ms"}. Stdin is put in raw
mode when it is a terminal. Exits 0 (2 for a usage error) whatever the replies were.
`

/** Items for `--query` ids (all of QUERY_TABLE when none) and `--send` sequences. */
export function selectQueries(ids: readonly string[], sends: readonly string[]): ProbeItem[] {
  const table = (ids.length === 0 && sends.length === 0 ? QUERY_TABLE.map((e) => e.id) : ids).map((id) => {
    const e = QUERY_TABLE.find((q) => q.id.toLowerCase() === id.toLowerCase())
    if (!e) throw new UsageError(`--query: unknown id "${id}" (known: ${QUERY_TABLE.map((q) => q.id).join(', ')})`)
    return { id: e.id, query: e.example, answeredBy: e.answeredBy, reply: e.reply }
  })
  const custom = sends.map((s, i) => {
    const query = unescape(s)
    if (query === '') throw new UsageError('--send needs a non-empty sequence')
    return { id: `send-${i + 1}`, query, answeredBy: null, reply: null }
  })
  return [...table, ...custom]
}

interface Window {
  item: ProbeItem
  sentAt: number
  replies: ReplyRecord[]
  /** DA1 replies the window needs: the sentinel's, plus the query's own when the query is DA1. */
  da1Needed: number
  da1Seen: number
  sentinelMs: number | null
  done: boolean
}

/** The pure part: what to send per query and which input belongs to which query. */
export class ProbeSession {
  private rest = ''
  private window: Window | null = null
  private lastId: string | null = null
  readonly strays: StrayRecord[] = [] // bounded: by the input a terminal sends during one prober run
  private readonly sentinel: boolean
  private readonly t0: number

  constructor(o: { sentinel: boolean; t0: number }) {
    this.sentinel = o.sentinel
    this.t0 = o.t0
  }

  /** Open the window for `item`; returns the bytes to write. */
  begin(item: ProbeItem, now: number): string {
    const ownDa1 = this.sentinel && DA1_QUERY.test(item.query) ? 1 : 0
    this.window = { item, sentAt: now, replies: [], da1Needed: this.sentinel ? 1 + ownDa1 : 0, da1Seen: 0, sentinelMs: null, done: false }
    return this.sentinel ? item.query + SENTINEL : item.query
  }

  /** True once the open window's sentinel has been answered. */
  get windowDone(): boolean {
    return this.window?.done ?? false
  }

  feed(chunk: string, now: number): void {
    const { tokens, rest } = tokenize(this.rest + chunk)
    this.rest = rest
    for (const t of tokens) this.take(t.seq, now)
  }

  private take(seq: string, now: number): void {
    const w = this.window
    if (!w || w.done) {
      this.strays.push({ t: 'stray', seq, ms: round(now - this.t0), after: w ? w.item.id : this.lastId })
      return
    }
    if (w.da1Needed > 0 && DA1_REPLY.test(seq)) {
      w.da1Seen++
      if (w.da1Seen === w.da1Needed) {
        w.done = true
        w.sentinelMs = round(now - w.sentAt)
        return
      }
    }
    w.replies.push({ seq, ms: round(now - w.sentAt) })
  }

  /** Close the open window and return its record. `timedOut`: the wait ended without the sentinel. */
  finish(timedOut: boolean): ProbeRecord {
    const w = this.window
    if (!w) throw new Error('no open window')
    if (this.rest !== '' && !w.done) {
      w.replies.push({ seq: this.rest, ms: NaN }) // an unfinished sequence
      this.rest = ''
    }
    this.window = null
    this.lastId = w.item.id
    const sentinelOk = !this.sentinel || !timedOut
    let ok: boolean | null = null
    if (w.item.answeredBy === 'nobody') ok = w.replies.length === 0 && sentinelOk
    else if (w.item.answeredBy !== null) ok = w.replies.length === 1 && (w.item.reply?.test((w.replies[0] as ReplyRecord).seq) ?? true) && sentinelOk
    return {
      t: 'reply',
      id: w.item.id,
      query: w.item.query,
      answeredBy: w.item.answeredBy,
      replies: w.replies.map((r) => (Number.isNaN(r.ms) ? { seq: r.seq, ms: -1 } : r)),
      sentinelMs: w.sentinelMs,
      timedOut: this.sentinel ? timedOut && !w.done : false,
      ok,
    }
  }

  /** Input still held back at the end (an unfinished sequence), as a stray. */
  flush(now: number): void {
    if (this.rest) this.strays.push({ t: 'stray', seq: this.rest, ms: round(now - this.t0), after: this.lastId })
    this.rest = ''
  }
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100
}

export function summarise(records: readonly ProbeRecord[], strays: number, ms: number): DoneRecord {
  return {
    t: 'done',
    queries: records.length,
    ok: records.filter((r) => r.ok === true).length,
    notOk: records.filter((r) => r.ok === false).map((r) => r.id),
    strays,
    ms: round(ms),
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const p = parseFlags(argv, { '--query': 'list', '--send': 'list', '--timeout-ms': 'value', '--settle-ms': 'value', '--no-sentinel': 'bool', '--out': 'value' })
  const items = selectQueries(p.lists.get('--query') ?? [], p.lists.get('--send') ?? [])
  const timeoutMs = intFlag(p, '--timeout-ms', 1000, 1)
  const settleMs = intFlag(p, '--settle-ms', 200, 0)
  const out = p.values.get('--out') ?? null
  // to a file: a line as each window closes; to stdout (the terminal being probed): all lines at the end, after a
  // newline, so the query bytes never interleave with them
  const held: string[] = [] // bounded: one line per query and stray of this run
  const emit = (r: object) => {
    const line = `${JSON.stringify(r)}\n`
    if (out) appendFileSync(out, line)
    else held.push(line)
  }

  const t0 = performance.now()
  const now = () => performance.now()
  const session = new ProbeSession({ sentinel: !p.bools.has('--no-sentinel'), t0 })
  const { stdin, stdout } = process
  const raw = stdin.isTTY === true
  if (raw) stdin.setRawMode(true)
  const decoder = new StringDecoder('utf8')
  let wake: (() => void) | null = null
  stdin.on('data', (b: Buffer) => {
    session.feed(decoder.write(b), now())
    if (session.windowDone) wake?.()
  })
  stdin.on('error', () => {})
  stdout.on('error', () => {})
  const wait = (ms: number, early: () => boolean) =>
    new Promise<boolean>((resolve) => {
      if (early()) return resolve(false)
      const timer = setTimeout(() => {
        wake = null
        resolve(true)
      }, ms)
      wake = () => {
        clearTimeout(timer)
        wake = null
        resolve(false)
      }
    })

  const records: ProbeRecord[] = []
  for (const item of items) {
    stdout.write(session.begin(item, now()))
    const timedOut = await wait(timeoutMs, () => session.windowDone)
    const r = session.finish(timedOut)
    records.push(r)
    emit(r)
  }
  if (settleMs > 0) await wait(settleMs, () => false)
  session.flush(now())
  for (const s of session.strays) emit(s)
  emit(summarise(records, session.strays.length, now() - t0))
  if (!out) await new Promise<void>((resolve) => stdout.write(`\n${held.join('')}`, () => resolve()))
  if (raw) {
    try {
      stdin.setRawMode(false)
    } catch {
      // the terminal is gone
    }
  }
  stdin.destroy()
}

if (import.meta.main) runMain(PROBER_USAGE, process.argv.slice(2), main)
