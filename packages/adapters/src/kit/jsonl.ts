// The JSONL tailer: every transcript read goes through here. Reconcile reads at most the last
// L.transcriptTailBytes; a watcher reads only what was appended since its last read, in reads of at most that many
// bytes. A transcript is never loaded whole (they reach hundreds of MB). A transcript path is the agent's to name, so
// a file is opened without waiting (O_NONBLOCK: a FIFO would block core's thread for good) and read only when it is a
// regular file. Text is decoded across read boundaries (a character split between two reads stays one).

import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { L } from '@kea/protocol'

/** An fd on `file` if it is a regular file, opened without waiting (a FIFO or a device never blocks the thread); else null. */
function openRegular(file: string): { fd: number; size: number } | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    const st = fs.fstatSync(fd)
    if (!st.isFile()) {
      fs.closeSync(fd)
      return null
    }
    return { fd, size: st.size }
  } catch {
    if (fd !== null) fs.closeSync(fd)
    return null
  }
}

/** The complete lines in the last `maxBytes` of `file` (the first, cut, line dropped unless the read began at 0). Null when unreadable. */
export function readTail(file: string, maxBytes: number = L.transcriptTailBytes): { lines: string[]; bytesRead: number; size: number } | null {
  const f = openRegular(file)
  if (!f) return null
  const { fd, size } = f
  try {
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, start + got)
      if (n <= 0) break
      got += n
    }
    let text = buf.subarray(0, got).toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl < 0 ? '' : text.slice(nl + 1)
    }
    const lines = text.split('\n')
    // the last element is a partial line (or empty after the final newline)
    lines.pop()
    return { lines: lines.filter((l) => l.length > 0), bytesRead: got, size }
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * A small file of the agent's, whole (a session's meta file): null when it is not a regular file, is larger than
 * `maxBytes`, or cannot be read. Opened like a transcript: never with an open that can wait.
 */
export function readSmall(file: string, maxBytes: number): string | null {
  const f = openRegular(file)
  if (!f) return null
  try {
    if (f.size > maxBytes) return null
    const buf = Buffer.alloc(f.size)
    let got = 0
    while (got < f.size) {
      const n = fs.readSync(f.fd, buf, got, f.size - got, got)
      if (n <= 0) break
      got += n
    }
    return buf.subarray(0, got).toString('utf8')
  } catch {
    return null
  } finally {
    fs.closeSync(f.fd)
  }
}

/**
 * The last line of `file`, whether or not a newline ends it (a file written as lines joined by newlines), read from its
 * last `maxBytes`: null when the file is unreadable or empty, or the line is longer than that.
 */
export function readLastLine(file: string, maxBytes: number): string | null {
  const f = openRegular(file)
  if (!f) return null
  try {
    const start = Math.max(0, f.size - maxBytes)
    const len = f.size - start
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) {
      const n = fs.readSync(f.fd, buf, got, len - got, start + got)
      if (n <= 0) break
      got += n
    }
    const text = buf.subarray(0, got).toString('utf8').replace(/\n+$/, '')
    const nl = text.lastIndexOf('\n')
    if (nl < 0 && start > 0) return null
    const line = text.slice(nl + 1)
    return line === '' ? null : line
  } catch {
    return null
  } finally {
    fs.closeSync(f.fd)
  }
}

/** Parse a JSONL line into an object, or null (a bad line is skipped, never fatal). */
export function parseLine(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Reads what a file gained since the last read, line by line. Starts at the end of the file as it is when created
 * (what was there before is reconcile's), or at `from`. A partial last line waits for its newline; a line longer than
 * the read cap is skipped whole. A file that shrank (rewritten) is followed from its new end.
 */
export class JsonlTailer {
  readonly file: string
  private offset: number
  private pending = ''
  /** Keeps a character's first bytes when a read ends inside it (U-AGT-29). */
  private decoder = new StringDecoder('utf8')
  /** Skipping a line longer than the cap until its newline. */
  private skipping = false
  private readonly maxRead: number
  /** Bytes read in all (U-AGT-17). */
  bytesRead = 0

  constructor(file: string, o: { from?: number; maxReadBytes?: number } = {}) {
    this.file = file
    this.maxRead = o.maxReadBytes ?? L.transcriptTailBytes
    this.offset = o.from ?? sizeOf(file)
  }

  /** Where the next read starts. */
  get position(): number {
    return this.offset
  }

  /** The complete lines appended since the last read (at most `maxReadBytes` read per call; call again for more). */
  read(): string[] {
    const f = openRegular(this.file)
    if (!f) return []
    const { fd, size } = f
    try {
      if (size < this.offset) {
        // rewritten: follow from its new end
        this.offset = size
        this.pending = ''
        this.decoder = new StringDecoder('utf8')
        this.skipping = false
        return []
      }
      const len = Math.min(size - this.offset, this.maxRead)
      if (len <= 0) return []
      const buf = Buffer.alloc(len)
      let got = 0
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, this.offset + got)
        if (n <= 0) break
        got += n
      }
      this.offset += got
      this.bytesRead += got
      return this.split(this.decoder.write(buf.subarray(0, got)))
    } catch {
      return []
    } finally {
      fs.closeSync(fd)
    }
  }

  /** Is there more to read than the last call took? */
  get behind(): boolean {
    return sizeOf(this.file) > this.offset
  }

  private split(text: string): string[] {
    const parts = (this.pending + text).split('\n')
    this.pending = parts.pop() ?? ''
    const out: string[] = []
    for (const p of parts) {
      if (this.skipping) {
        this.skipping = false // this part ends the over-long line
        continue
      }
      if (p.length > 0) out.push(p)
    }
    if (this.pending.length > this.maxRead) {
      // a line longer than the cap: dropped, up to its newline
      this.pending = ''
      this.skipping = true
    }
    return out
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}
