// Session spools: where `kea-helper hook` appends envelopes it could not deliver
// (`<KEA_HOME>/sessions/<id>/spool.ndjson`, O_APPEND, one write per envelope, soft and hard caps). Core drains one by
// renaming it to `spool.draining.ndjson`, reading and applying it in file order, then deleting it — envelopes appended
// during the drain land in a fresh spool, which the next drain takes. The helper holds the spool's flock(2) lock while
// it appends and core takes it before the rename (without waiting: a held lock leaves the spool to a retry), so no line
// is written into a file core has already taken (a helper that opened the spool before the rename reopens the path).
// Where core cannot take that lock (the OS layer's `spoolLock`: Linux) it renames without it, and the helper looks
// again after its write: a line that may have missed the read goes once more into the fresh spool, and the copy that
// comes second is dropped by its id. A draining file left by a core that died mid-drain is applied first. A partial
// last line or a garbage line is skipped and counted (C-COR-4); an envelope whose id the session already took (its line
// also reached core's socket, late) is dropped and counted. The session folder is reachable by the agent (same user),
// so only a regular file is renamed or read, and every open is without waiting (O_NONBLOCK: a FIFO in the spool's place
// would otherwise block core's thread at every start).

import fs from 'node:fs'
import path from 'node:path'
import { isAvailable, L } from '@kea/protocol'
import { coreOs } from '../os/index.ts'
import { parseEnvelope, type Envelope } from './intake.ts'

export const SPOOL_FILE = 'spool.ndjson'
export const DRAINING_FILE = 'spool.draining.ndjson'

export function spoolPath(home: string, sessionId: string): string {
  return path.join(home, 'sessions', sessionId, SPOOL_FILE)
}

export interface DrainResult {
  applied: number
  skipped: number
  /** Envelopes `apply` refused as already taken (a late copy came through core's socket too). */
  duplicates: number
  /** Bytes read (at most the hard cap plus one envelope per file). */
  bytes: number
  /** The spool was left where it is: a helper held its lock (appending). The caller drains again later. */
  locked: boolean
  /**
   * The spool was taken without the helper's lock (no `spoolLock`, Linux): a helper writing at that moment writes its
   * line again into a fresh spool, so the caller drains once more later, as for `locked`.
   */
  unlocked: boolean
}

/** The open flag that takes the lock kea-helper holds while it appends, where there is one (macOS's O_EXLOCK). */
export const SPOOL_LOCK_FLAG = isAvailable(coreOs.spoolLock) ? coreOs.spoolLock.openFlag : 0

/** The most a drain reads of one file: a spool never grows past the hard cap plus the envelope that crossed it. */
const READ_CAP = L.spoolHardBytes + L.hookEnvelopeMaxBytes

function readCapped(file: string): Buffer | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const st = fs.fstatSync(fd)
    if (!st.isFile()) return null
    const len = Math.min(st.size, READ_CAP)
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, got)
      if (n <= 0) break
      got += n
    }
    return buf.subarray(0, got)
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** Takes one envelope; false when it is a duplicate of one already applied. */
export type SpoolApply = (env: Envelope) => boolean | void

function applyFile(file: string, sessionId: string, apply: SpoolApply, r: DrainResult): void {
  const buf = readCapped(file)
  if (buf) {
    r.bytes += buf.length
    const text = buf.toString('utf8')
    const lines = text.split('\n')
    // the last element is after the final newline: empty, or a partial line (skipped)
    const tail = lines.pop() ?? ''
    if (tail.length > 0) r.skipped++
    for (const line of lines) {
      if (line.trim() === '') continue
      const p = parseEnvelope(line)
      // an envelope for another session in this session's spool is not this session's (and not trusted)
      if (!p.ok || p.env.keaSessionId !== sessionId) {
        r.skipped++
        continue
      }
      if (apply(p.env) === false) r.duplicates++
      else r.applied++
    }
  }
  try {
    fs.unlinkSync(file)
  } catch {
    // gone already
  }
}

/**
 * Drain one session's spool: a leftover draining file first, then the spool (renamed before it is read, under the
 * hook's lock where `lockFlag` gives one: the OS layer's by default). Returns null when there was nothing to drain.
 */
export function drainSpool(home: string, sessionId: string, apply: SpoolApply, lockFlag: number = SPOOL_LOCK_FLAG): DrainResult | null {
  const dir = path.join(home, 'sessions', sessionId)
  const spool = path.join(dir, SPOOL_FILE)
  const draining = path.join(dir, DRAINING_FILE)
  const r: DrainResult = { applied: 0, skipped: 0, duplicates: 0, bytes: 0, locked: false, unlocked: false }
  let any = false
  if (isFile(draining)) {
    any = true
    applyFile(draining, sessionId, apply, r)
  }
  // only a regular file is taken (lstat: a FIFO, a symlink or a directory in its place is left alone and never read)
  if (isFile(spool)) {
    const taken = take(spool, draining, lockFlag)
    if (taken === 'locked') r.locked = true
    if (taken === 'taken') {
      any = true
      r.unlocked = lockFlag === 0
      applyFile(draining, sessionId, apply, r)
    }
  }
  return any || r.locked ? r : null
}

/** Rename the spool to the draining file while holding its lock; 'locked' when a helper holds it now. */
function take(spool: string, draining: string, lockFlag: number): 'taken' | 'locked' | 'gone' {
  let fd: number
  try {
    fd = fs.openSync(spool, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | lockFlag)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'EAGAIN' || code === 'EWOULDBLOCK' ? 'locked' : 'gone'
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return 'gone'
    fs.renameSync(spool, draining)
    return 'taken'
  } catch {
    return 'gone'
  } finally {
    fs.closeSync(fd)
  }
}

/** Is there anything to drain for this session? (One lstat; cheap enough per envelope.) */
export function hasSpool(home: string, sessionId: string): boolean {
  const dir = path.join(home, 'sessions', sessionId)
  return isFile(path.join(dir, SPOOL_FILE)) || isFile(path.join(dir, DRAINING_FILE))
}

function isFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile()
  } catch {
    return false
  }
}

/** Sessions with a spool or a draining file under `home` (the launch drain). */
export function spooledSessions(home: string): string[] {
  const root = path.join(home, 'sessions')
  let ids: string[]
  try {
    ids = fs.readdirSync(root)
  } catch {
    return []
  }
  return ids.filter((id) => /^[0-9A-Za-z_-]{1,64}$/.test(id) && hasSpool(home, id))
}
