// Identifiers. Database ids are ULIDs (sortable, generated in core);
// PTY ids are short random [a-z0-9] strings because they are also socket file names.

import { L } from '@kea/protocol/limits'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_CHARS = 10
const RANDOM_CHARS = 16
const TIME_MAX = 2 ** 48 - 1

let lastTime = -1
/** The previous id's random part as 16 base-32 digits (incremented for ids in the same millisecond). */
const lastRandom = new Array<number>(RANDOM_CHARS).fill(0)

function encodeTime(ms: number): string {
  let out = ''
  let t = ms
  for (let i = 0; i < TIME_CHARS; i++) {
    out = CROCKFORD.charAt(t % 32) + out
    t = Math.floor(t / 32)
  }
  return out
}

function freshRandom(): void {
  // 80 random bits → 16 five-bit digits.
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  let acc = 0
  let bits = 0
  let j = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      lastRandom[j++] = (acc >>> bits) & 31
    }
    acc &= (1 << bits) - 1
  }
}

/** Increment the random part; returns false on overflow (all digits were 31). */
function incrementRandom(): boolean {
  for (let i = RANDOM_CHARS - 1; i >= 0; i--) {
    const d = lastRandom[i] as number
    if (d < 31) {
      lastRandom[i] = d + 1
      return true
    }
    lastRandom[i] = 0
  }
  return false
}

/**
 * A ULID: 26 Crockford base-32 chars, 48-bit millisecond time + 80 random bits. Monotonic within
 * the process: ids made in the same millisecond — or after the wall clock stepped back — reuse the
 * last timestamp and increment the random part, so every id sorts after the previous one.
 */
export function ulid(nowMs: number = Date.now()): string {
  if (nowMs > lastTime) {
    lastTime = Math.min(Math.floor(nowMs), TIME_MAX)
    freshRandom()
  } else if (!incrementRandom()) {
    // 2^80 ids in one millisecond cannot happen; stepping time keeps ordering if it ever does.
    lastTime = Math.min(lastTime + 1, TIME_MAX)
    freshRandom()
  }
  let rand = ''
  for (const d of lastRandom) rand += CROCKFORD.charAt(d)
  return encodeTime(lastTime) + rand
}

/** What `ulid()` makes: 26 Crockford base-32 characters. */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** Milliseconds encoded in a ULID. */
export function ulidTime(id: string): number {
  let t = 0
  for (let i = 0; i < TIME_CHARS; i++) {
    const v = CROCKFORD.indexOf(id.charAt(i).toUpperCase())
    if (v < 0) throw new Error(`ulidTime: not a ULID: ${id}`)
    t = t * 32 + v
  }
  return t
}

const PTY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
/** Largest multiple of 36 that fits in a byte — bytes at or above it are rejected (no modulo bias). */
const PTY_REJECT_AT = 256 - (256 % PTY_ALPHABET.length)

/** A PTY id: L.ptyIdLength chars of [a-z0-9] from the CSPRNG. */
export function ptyId(): string {
  let out = ''
  while (out.length < L.ptyIdLength) {
    const bytes = crypto.getRandomValues(new Uint8Array(L.ptyIdLength * 2))
    for (const b of bytes) {
      if (b >= PTY_REJECT_AT) continue
      out += PTY_ALPHABET.charAt(b % PTY_ALPHABET.length)
      if (out.length === L.ptyIdLength) break
    }
  }
  return out
}
