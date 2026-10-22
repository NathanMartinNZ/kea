// Terminal probes, as agent CLIs send them at startup: the query bytes, and a streaming parser that pulls the replies
// out of stdin while leaving keystrokes alone. Every probe batch ends with a DA1 sentinel: every terminal answers DA1,
// so once its reply arrives any query still unanswered is unsupported (the usual TUI trick). Pure: no I/O here.

export type ProbeId = 'da1' | 'da2' | 'cpr' | 'kitty' | 'osc10' | 'osc11' | 'xtversion' | `decrqm-${number}`

const FIXED: Record<string, string> = {
  da1: '\x1b[c',
  da2: '\x1b[>c',
  cpr: '\x1b[6n',
  kitty: '\x1b[?u',
  osc10: '\x1b]10;?\x1b\\',
  osc11: '\x1b]11;?\x1b\\',
  xtversion: '\x1b[>q',
}

export const PROBE_IDS: readonly string[] = [...Object.keys(FIXED), 'decrqm-<mode>']

export function isProbeId(s: string): s is ProbeId {
  return s in FIXED || /^decrqm-\d{1,5}$/.test(s)
}

/** The query bytes for a probe. */
export function probeQuery(id: ProbeId): string {
  const fixed = FIXED[id]
  if (fixed !== undefined) return fixed
  const mode = /^decrqm-(\d+)$/.exec(id)?.[1]
  if (mode === undefined) throw new Error(`unknown probe ${id}`)
  return `\x1b[?${mode}$p`
}

// ── tokenizer ────────────────────────────────────────────────────────────────────────────────────────────

export type Token =
  | { type: 'csi' | 'osc' | 'dcs' | 'ss3' | 'esc'; seq: string }
  | { type: 'text'; seq: string }

/**
 * Split input into escape sequences and plain text. An incomplete sequence at the end is returned as `rest` so the
 * next chunk can complete it — except a lone ESC when `loneEscIsKey` is set (keyboard input: Esc arrives on its own).
 */
export function tokenize(buf: string, loneEscIsKey = false): { tokens: Token[]; rest: string } {
  const tokens: Token[] = []
  let text = ''
  const flushText = () => {
    if (text) tokens.push({ type: 'text', seq: text })
    text = ''
  }
  let i = 0
  while (i < buf.length) {
    const c = buf[i] as string
    if (c !== '\x1b') {
      text += c
      i++
      continue
    }
    const end = sequenceEnd(buf, i)
    if (end === -1) {
      if (loneEscIsKey && i === buf.length - 1) {
        flushText()
        tokens.push({ type: 'esc', seq: '\x1b' })
        i++
        continue
      }
      flushText()
      return { tokens, rest: buf.slice(i) }
    }
    flushText()
    const seq = buf.slice(i, end)
    const k = buf[i + 1]
    tokens.push({ type: k === '[' ? 'csi' : k === ']' ? 'osc' : k === 'P' ? 'dcs' : k === 'O' ? 'ss3' : 'esc', seq })
    i = end
  }
  flushText()
  return { tokens, rest: '' }
}

/** Index just past the sequence starting at `start` (an ESC), or -1 if it is not complete yet. */
function sequenceEnd(buf: string, start: number): number {
  const k = buf[start + 1]
  if (k === undefined) return -1
  if (k === '[') {
    for (let j = start + 2; j < buf.length; j++) {
      const code = buf.charCodeAt(j)
      if (code >= 0x40 && code <= 0x7e) return j + 1
      if (code < 0x20 || code > 0x7e) return j // malformed: end before the stray byte
    }
    return -1
  }
  if (k === ']' || k === 'P' || k === '_' || k === '^') {
    for (let j = start + 2; j < buf.length; j++) {
      if (buf[j] === '\x07' && k === ']') return j + 1
      if (buf[j] === '\x1b') {
        if (j + 1 >= buf.length) return -1
        if (buf[j + 1] === '\\') return j + 2
      }
    }
    return -1
  }
  if (k === 'O') return start + 2 < buf.length ? start + 3 : -1
  return start + 2
}

// ── replies ──────────────────────────────────────────────────────────────────────────────────────────────

export interface Reply {
  id: ProbeId
  seq: string
  /** A short parsed value: DA1/DA2 params, DECRPM state, kitty flags, the colour spec, `row;col`, the version. */
  value: string
}

/** Which probe a sequence answers, or null when it is not a probe reply (a key, say). */
export function classifyReply(seq: string): Reply | null {
  let m: RegExpExecArray | null
  if ((m = /^\x1b\[\?([\d;]*)c$/.exec(seq))) return { id: 'da1', seq, value: m[1] as string }
  if ((m = /^\x1b\[>([\d;]*)c$/.exec(seq))) return { id: 'da2', seq, value: m[1] as string }
  if ((m = /^\x1b\[\?(\d+);(\d)\$y$/.exec(seq))) return { id: `decrqm-${Number(m[1])}`, seq, value: m[2] as string }
  if ((m = /^\x1b\[\?(\d+)u$/.exec(seq))) return { id: 'kitty', seq, value: m[1] as string }
  if ((m = /^\x1b\](1[01]);([^\x07\x1b]*)(?:\x07|\x1b\\)$/.exec(seq))) return { id: m[1] === '10' ? 'osc10' : 'osc11', seq, value: m[2] as string }
  if ((m = /^\x1b\[(\d+;\d+)R$/.exec(seq))) return { id: 'cpr', seq, value: m[1] as string }
  if ((m = /^\x1bP>\|([^\x1b]*)\x1b\\$/.exec(seq))) return { id: 'xtversion', seq, value: m[1] as string }
  return null
}

export interface ProbeResult {
  id: ProbeId
  /** Reply sequence, or null when the terminal did not answer before the sentinel (or the timeout). */
  reply: string | null
  value: string | null
  /** Milliseconds from sending to the reply. */
  ms: number | null
}

/**
 * One probe batch: `start` gives the bytes to write (the queries, then the DA1 sentinel); `feed` takes stdin chunks
 * and returns the bytes that were not replies (keystrokes typed meanwhile); `done` turns true at the sentinel's reply.
 */
export class ProbeBatch {
  readonly ids: readonly ProbeId[]
  private readonly results = new Map<ProbeId, ProbeResult>() // bounded: one entry per query in the batch
  private sentAt = 0
  private rest = ''
  private da1Seen = 0
  private readonly da1Needed: number
  done = false

  constructor(ids: readonly ProbeId[]) {
    this.ids = [...new Set(ids)]
    // an explicit da1 query and the sentinel both reply with DA1: the first answers the query, the second ends it
    this.da1Needed = this.ids.includes('da1') ? 2 : 1
  }

  start(now: number): string {
    this.sentAt = now
    return this.ids.map(probeQuery).join('') + probeQuery('da1')
  }

  feed(chunk: string, now: number): string {
    const { tokens, rest } = tokenize(this.rest + chunk)
    this.rest = rest
    let keys = ''
    for (const t of tokens) {
      const r = this.done ? null : classifyReply(t.seq)
      if (!r) {
        keys += t.seq
        continue
      }
      if (r.id === 'da1') {
        this.da1Seen++
        if (this.da1Seen === this.da1Needed) this.done = true
        if (this.da1Seen === 1 && this.da1Needed === 2) this.record(r, now)
        continue
      }
      if (this.ids.includes(r.id) && !this.results.has(r.id)) this.record(r, now)
      else keys += t.seq // not asked for, or a second answer: leave it to the key reader
    }
    if (this.done && this.rest) {
      keys += this.rest
      this.rest = ''
    }
    return keys
  }

  private record(r: Reply, now: number): void {
    this.results.set(r.id, { id: r.id, reply: r.seq, value: r.value, ms: now - this.sentAt })
  }

  /** Results in query order; unanswered queries have `reply: null`. Bytes still held back are returned as keys. */
  finish(): { results: ProbeResult[]; leftover: string } {
    const leftover = this.rest
    this.rest = ''
    return { results: this.ids.map((id) => this.results.get(id) ?? { id, reply: null, value: null, ms: null }), leftover }
  }
}
