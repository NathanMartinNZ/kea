// NUL-separated records out of a byte stream: git's `-z` output arrives in chunks of any size and is cut into records
// as it comes, never held whole. A record is a path or a header line; one longer than L.gitRecordMaxBytes is not git's
// doing, so the parse ends there, truncated.

import { L } from '@kea/protocol'

export class ZRecords {
  private rest: Buffer | null = null
  /** A record passed L.gitRecordMaxBytes: nothing more is read. */
  overlong = false
  /** The consumer stopped the parse (`onRecord` returned false). */
  stopped = false
  records = 0
  private readonly onRecord: (rec: Buffer) => boolean | void
  private readonly max: number

  /** `onRecord` gets each record without its NUL; returning false stops the parse (the caller kills the child). */
  constructor(onRecord: (rec: Buffer) => boolean | void, maxRecordBytes: number = L.gitRecordMaxBytes) {
    this.onRecord = onRecord
    this.max = maxRecordBytes
  }

  get done(): boolean {
    return this.overlong || this.stopped
  }

  /** Bytes of an unfinished record held between chunks. */
  get held(): number {
    return this.rest?.length ?? 0
  }

  /** Feed a chunk. False once the parse is over (stopped or overlong): feed nothing more. */
  push(chunk: Buffer): boolean {
    if (this.done) return false
    let from = 0
    for (;;) {
      const nul = chunk.indexOf(0, from)
      if (nul < 0) break
      let rec = chunk.subarray(from, nul)
      if (this.rest) {
        rec = Buffer.concat([this.rest, rec])
        this.rest = null
      }
      from = nul + 1
      if (rec.length > this.max) {
        this.overlong = true
        return false
      }
      this.records++
      if (this.onRecord(rec) === false) {
        this.stopped = true
        return false
      }
    }
    if (from < chunk.length) {
      const tail = chunk.subarray(from)
      // a copy: the chunk's memory is the stream's to reuse
      this.rest = this.rest ? Buffer.concat([this.rest, tail]) : Buffer.from(tail)
      if (this.rest.length > this.max) {
        this.rest = null
        this.overlong = true
        return false
      }
    }
    return true
  }

  /** The stream ended: an unfinished last record (output cut at a byte cap) is dropped, never parsed as a whole one. */
  end(): void {
    this.rest = null
  }
}
