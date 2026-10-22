// Keyboard input for fake-agent: bytes → key names, and the queue that hands keys to whichever step is reading.
// Keys typed while no step reads are kept (type-ahead), so a test that answers a prompt slightly early loses nothing.

import { tokenize } from './probes.ts'

/**
 * Key names: a printable character is itself (`y`, `1`, ` `); the rest are `enter`, `tab`, `backspace`, `esc`,
 * `ctrl-<letter>`, `up`/`down`/`right`/`left`, `shift-tab`, `alt-<char>`, `shift-enter`, `paste-start`/`paste-end`;
 * anything else is `seq:<escaped bytes>`.
 */
export type Key = string

const NAMED: Record<string, Key> = { '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x7f': 'backspace', '\b': 'backspace' }
const CSI_FINAL: Record<string, Key> = { A: 'up', B: 'down', C: 'right', D: 'left', Z: 'shift-tab', H: 'home', F: 'end' }

/** Names a scenario may use for `choose` keys besides a single character. */
export const KEY_NAMES: readonly string[] = ['enter', 'tab', 'backspace', 'esc', 'space', 'up', 'down', 'right', 'left', 'shift-tab', 'shift-enter']

/** Normalise a key as written in a scenario (`space` → ` `); null when it is not a key name or a single character. */
export function normaliseKeyName(s: string): Key | null {
  if (s === 'space') return ' '
  if (KEY_NAMES.includes(s)) return s
  if ([...s].length === 1 && s >= ' ') return s
  return null
}

function escape(seq: string): string {
  return JSON.stringify(seq).slice(1, -1)
}

/** Keys in a chunk of terminal input (a lone ESC at the end of a chunk is the Esc key). */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = []
  const { tokens, rest } = tokenize(chunk, true)
  for (const t of tokens) {
    if (t.type === 'text') {
      for (const ch of t.seq) {
        const code = ch.codePointAt(0) as number
        if (NAMED[ch]) keys.push(NAMED[ch] as Key)
        else if (code < 0x20) keys.push(`ctrl-${String.fromCharCode(code + 0x60)}`)
        else keys.push(ch)
      }
      continue
    }
    keys.push(sequenceKey(t.type, t.seq))
  }
  if (rest) keys.push(`seq:${escape(rest)}`)
  return keys
}

function sequenceKey(type: string, seq: string): Key {
  if (type === 'esc') {
    if (seq === '\x1b') return 'esc'
    const ch = seq.slice(1)
    return ch === '\r' ? 'alt-enter' : `alt-${ch}`
  }
  if (type === 'ss3') {
    const k = CSI_FINAL[seq.slice(2)]
    if (k) return k
  }
  if (type === 'csi') {
    const body = seq.slice(2, -1)
    const final = seq.slice(-1)
    if (seq === '\x1b[200~') return 'paste-start'
    if (seq === '\x1b[201~') return 'paste-end'
    if (body === '' || body === '1') {
      const k = CSI_FINAL[final]
      if (k) return k
    }
    // kitty keyboard protocol: CSI code[;mods] u
    const m = /^(\d+)(?:;(\d+))?$/.exec(body)
    if (final === 'u' && m) {
      const code = Number(m[1])
      const mods = m[2] ? Number(m[2]) - 1 : 0
      const base = code === 13 ? 'enter' : code === 27 ? 'esc' : code === 9 ? 'tab' : code === 127 ? 'backspace' : String.fromCodePoint(code)
      if (mods === 0) return base
      if (mods === 1) return `shift-${base}`
      if (mods === 4 && base.length === 1) return `ctrl-${base}`
    }
  }
  return `seq:${escape(seq)}`
}

/** A reader of keys: returns true when it took the key. Untaken keys are dropped (the reader ignores them). */
export type KeyReader = (key: Key) => boolean

/**
 * Keys flow to the current reader; with none installed they wait in `pending` (type-ahead, capped). `global` sees each
 * key first and may claim it (Ctrl-C ends or interrupts the agent whatever is reading).
 */
export class KeyQueue {
  private reader: { take: KeyReader; onClose: () => void } | null = null
  private readonly pending: Key[] = [] // bounded: TYPE_AHEAD_MAX keys; older ones are dropped
  private closed = false
  global: ((key: Key) => boolean) | null = null

  static readonly TYPE_AHEAD_MAX = 4096

  push(keys: readonly Key[]): void {
    for (const k of keys) {
      if (this.global?.(k)) continue
      this.pending.push(k)
      if (this.pending.length > KeyQueue.TYPE_AHEAD_MAX) this.pending.shift()
    }
    this.drain()
  }

  /**
   * Install a reader. It sees the type-ahead from a microtask, after this returns the function that removes it, so a
   * reader that settles on the first key can detach before the next one. `onClose` runs if the input is gone (now or
   * later) while it is installed.
   */
  read(take: KeyReader, onClose: () => void): () => void {
    const r = { take, onClose }
    this.reader = r
    queueMicrotask(() => {
      if (this.reader !== r) return
      this.drain()
      if (this.closed && this.reader === r) onClose()
    })
    return () => {
      if (this.reader === r) this.reader = null
    }
  }

  private drain(): void {
    while (this.reader && this.pending.length > 0) this.reader.take(this.pending.shift() as Key)
  }

  /** The input is gone (EOF/EIO). */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.drain()
    this.reader?.onClose()
  }

  get isClosed(): boolean {
    return this.closed
  }
}
