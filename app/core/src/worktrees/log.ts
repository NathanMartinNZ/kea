// A session's creation log, `<KEA_HOME>/sessions/<id>/creation.log`: every pipeline step, git's output, the
// names of copied files (never contents), and the setup and teardown scripts' outcomes. Once it passes
// L.creationLogMaxBytes it keeps its newest half, so it never grows without bound; it goes with the session's directory
// when the session is deleted.

import fs from 'node:fs'
import path from 'node:path'
import { L } from '@kea/protocol'

export const CREATION_LOG = 'creation.log'

export function creationLogPath(home: string, sessionId: string): string {
  return path.join(home, 'sessions', sessionId, CREATION_LOG)
}

/** Append lines (each stamped); trims to the newest half past the cap. Returns the file's size. */
export function appendLog(home: string, sessionId: string, text: string, now: number = Date.now()): number {
  const file = creationLogPath(home, sessionId)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const stamp = new Date(now).toISOString()
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l, i, a) => l !== '' || i < a.length - 1)
    .map((l) => `${stamp} ${l}\n`)
    .join('')
  fs.appendFileSync(file, lines, { mode: 0o600 })
  let size = fs.statSync(file).size
  if (size > L.creationLogMaxBytes) {
    const buf = fs.readFileSync(file)
    let keep = buf.subarray(buf.length - Math.floor(L.creationLogMaxBytes / 2))
    const nl = keep.indexOf(0x0a)
    if (nl >= 0) keep = keep.subarray(nl + 1)
    fs.writeFileSync(file, keep, { mode: 0o600 })
    size = keep.length
  }
  return size
}

/** The newest L.creationLogMaxBytes of the log. */
export function readLog(home: string, sessionId: string): { text: string; truncated: boolean; bytes: number } {
  const file = creationLogPath(home, sessionId)
  try {
    const buf = fs.readFileSync(file)
    const truncated = buf.length > L.creationLogMaxBytes
    const tail = truncated ? buf.subarray(buf.length - L.creationLogMaxBytes) : buf
    return { text: tail.toString('utf8'), truncated, bytes: buf.length }
  } catch {
    return { text: '', truncated: false, bytes: 0 }
  }
}

export function logBytes(home: string, sessionId: string): number {
  try {
    return fs.statSync(creationLogPath(home, sessionId)).size
  } catch {
    return 0
  }
}
