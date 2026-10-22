// Reads a byte range of a holder's ring file, for a renderer catching up after its credit ran out and for snapshots
// that are older than the live stream. The holder writes data before it updates the header, so a range is valid only if
// it is still at or above `earliestSeq` *after* the read: a range overwritten while it was being read is reported as
// gone.

import fs from 'node:fs'
import { L, parseRingHeader, type RingHeader } from '@kea/protocol'

export class RingFile {
  readonly path: string
  private fd: number | null = null
  private readonly head = new Uint8Array(L.ringHeaderBytes)

  constructor(path: string) {
    this.path = path
  }

  header(): RingHeader | null {
    const fd = this.open()
    if (fd === null) return null
    try {
      if (fs.readSync(fd, this.head, 0, this.head.byteLength, 0) !== this.head.byteLength) return null
    } catch {
      return null
    }
    const h = parseRingHeader(this.head)
    // seqs past 2^53 cannot be real (and are not exact as numbers): a corrupt header (C-COR-3)
    return h && Number.isSafeInteger(h.latestSeq) && Number.isSafeInteger(h.capacity) ? h : null
  }

  /**
   * Bytes `[from, min(to, from + max))`, or null when the ring no longer holds `from` (or has no file).
   * `to` beyond the ring's `latestSeq` is clamped.
   */
  read(from: number, to: number, max: number): Uint8Array<ArrayBuffer> | null {
    const h = this.header()
    if (!h || from < h.earliestSeq) return null
    const end = Math.min(to, h.latestSeq, from + max)
    if (end <= from) return new Uint8Array(0)
    const out = new Uint8Array(end - from)
    const fd = this.fd as number
    let s = from
    let o = 0
    try {
      while (s < end) {
        const pos = s % h.capacity
        const n = Math.min(h.capacity - pos, end - s)
        const got = fs.readSync(fd, out, o, n, L.ringHeaderBytes + pos)
        if (got !== n) return null
        o += n
        s += n
      }
    } catch {
      return null
    }
    const after = this.header()
    if (!after || from < after.earliestSeq) return null
    return out
  }

  close(): void {
    if (this.fd === null) return
    try {
      fs.closeSync(this.fd)
    } catch {
      // already gone
    }
    this.fd = null
  }

  private open(): number | null {
    if (this.fd !== null) return this.fd
    try {
      this.fd = fs.openSync(this.path, 'r')
    } catch {
      return null
    }
    return this.fd
  }
}
