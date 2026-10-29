// The two files main keeps for updates in its userData folder (one per home): `updates.json`, the marks the update
// state needs across launches (the one-time line was shown; the version Squirrel had ready and how many starts it was
// not running; versions never downloaded again), and `handoff.json`, the window's composer drafts across a restart
// Kea makes itself, read once by the next start if it is younger than L.handoffFileMaxAgeMs and deleted either way.
// Both are written atomically with mode 0600; one that does not parse counts as absent.

import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteSync } from '@kea/kit'
import { L, NO_UPDATE_MARKS, zUpdateMarks, zWindowHandoff, type UpdateMarks, type WindowHandoff } from '@kea/protocol'

const MARKS_FILE = 'updates.json'
const HANDOFF_FILE = 'handoff.json'

export function readMarks(dir: string): UpdateMarks {
  try {
    const r = zUpdateMarks.safeParse(JSON.parse(fs.readFileSync(path.join(dir, MARKS_FILE), 'utf8')))
    return r.success ? r.data : NO_UPDATE_MARKS
  } catch {
    return NO_UPDATE_MARKS
  }
}

export function writeMarks(dir: string, m: UpdateMarks): void {
  fs.mkdirSync(dir, { recursive: true })
  atomicWriteSync(path.join(dir, MARKS_FILE), JSON.stringify(m), { mode: 0o600 })
}

/** Keep the window's drafts for the next start (a restart Kea makes itself). */
export function writeHandoff(dir: string, state: WindowHandoff, now: number): void {
  fs.mkdirSync(dir, { recursive: true })
  atomicWriteSync(path.join(dir, HANDOFF_FILE), JSON.stringify({ t: now, state }), { mode: 0o600 })
}

/** The drafts the last run kept for this start, once: the file is deleted whatever it held. */
export function takeHandoff(dir: string, now: number): WindowHandoff | null {
  const file = path.join(dir, HANDOFF_FILE)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    fs.rmSync(file, { force: true })
  } catch {
    // read once anyway: the age check refuses it next time
  }
  try {
    const j = JSON.parse(raw) as { t?: unknown; state?: unknown }
    if (typeof j.t !== 'number' || now - j.t < 0 || now - j.t > L.handoffFileMaxAgeMs) return null
    const r = zWindowHandoff.safeParse(j.state)
    return r.success ? r.data : null
  } catch {
    return null
  }
}
