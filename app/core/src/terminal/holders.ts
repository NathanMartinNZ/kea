// What is on disk about holders: every `<KEA_HOME>/sessions/<sessionId>/<ptyId>.{json,ring,ckpt}` and every socket in
// the run directory, with each state file judged before anything is believed. Core reads these files but never connects
// to a holder (ptyhost is the only client).
//
// A state file is *trusted* only if it is the one `<ptyId>.json` for that PTY, parses, names the same `ptyId`, names
// as `sessionId` the directory it lives in, and names as `socket` this KEA_HOME's socket path for it. Anything else —
// a copy from another KEA_HOME, a file moved between sessions, garbage — is *foreign*: never signalled, adopted,
// attached or deleted. A trusted holder is *alive* only if its pid still runs `kea-helper` and started when the file
// says (procs.ts), so a reused pid is never mistaken for it.

import fs from 'node:fs'
import path from 'node:path'
import { ensurePrivateDir, isOwnSocket, runDir, socketPath } from '@kea/kit'
import { PTY_ID_PATTERN, PTY_KIND, type PtyKind } from '@kea/protocol'
import { holderAlive, probeable, type ProcessProbe } from './procs.ts'

/** The fields of the holder's state file (`native/kea-helper/README.md`) that core reads. */
export interface HolderJson {
  ptyId: string
  sessionId: string
  kind: PtyKind
  cwd: string
  argv: string[]
  pid: number
  /** µs since the epoch. */
  pidStartTime: number
  /** Linux: the raw start, clock ticks since boot; null in a state file without it (macOS, an older holder). */
  pidStartTicks: number | null
  childPid: number | null
  exited: boolean
  exitCode: number | null
  exitSignal: number | null
  socket: string
}

export type HolderIdentity = 'trusted' | 'missing' | 'foreign'

export interface HolderEntry {
  ptyId: string
  /** The session directories with files of this PTY, and which of `<ptyId>.json|.ring|.ckpt` each holds. */
  dirs: { sessionId: string; files: string[] }[]
  identity: HolderIdentity
  /** Why a state file is foreign (logged). */
  why: string | null
  /** The trusted state file. */
  json: HolderJson | null
  /** An own socket (lstat: a socket owned by this user) is in the run directory. */
  socket: boolean
  /** Trusted state file only: its holder process is alive. Null: not trusted, `kea-helper procs` could not tell, or `/proc` hides it. */
  alive: boolean | null
}

export interface HolderScan {
  entries: Map<string, HolderEntry>
  /** The run directory was refused or unreadable: socket facts are unknown, so no socket is touched. */
  socketsKnown: boolean
  /** `ps` failed: liveness is unknown, so nothing is concluded from it. */
  probeFailed: boolean
}

const SESSION_DIR = /^[0-9A-Za-z_-]{1,64}$/
const STATE_FILE = new RegExp(`^(${PTY_ID_PATTERN})\\.(json|ring|ckpt)$`)
const SOCKET_FILE = new RegExp(`^(${PTY_ID_PATTERN})\\.sock$`)

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

/** Parse a holder state file; null for anything that is not one. */
export function parseHolderJson(text: string): HolderJson | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (typeof o.ptyId !== 'string' || typeof o.sessionId !== 'string' || typeof o.socket !== 'string' || typeof o.cwd !== 'string') return null
  if (!(PTY_KIND as readonly unknown[]).includes(o.kind)) return null
  if (!Array.isArray(o.argv) || !o.argv.every((a) => typeof a === 'string')) return null
  if (!probeable(o.pid) || !isInt(o.pidStartTime) || o.pidStartTime <= 0) return null
  return {
    ptyId: o.ptyId,
    sessionId: o.sessionId,
    kind: o.kind as PtyKind,
    cwd: o.cwd,
    argv: o.argv as string[],
    pid: o.pid,
    pidStartTime: o.pidStartTime,
    pidStartTicks: isInt(o.pidStartTicks) && o.pidStartTicks >= 0 ? o.pidStartTicks : null,
    childPid: isInt(o.childPid) ? o.childPid : null,
    exited: o.exited === true,
    exitCode: isInt(o.exitCode) ? o.exitCode : null,
    exitSignal: isInt(o.exitSignal) ? o.exitSignal : null,
    socket: o.socket,
  }
}

function readDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Judge one PTY's state file against where it was found (see the module comment). */
export function judge(home: string, ptyId: string, dirs: HolderEntry['dirs']): Pick<HolderEntry, 'identity' | 'why' | 'json'> {
  const withJson = dirs.filter((d) => d.files.includes(`${ptyId}.json`))
  if (withJson.length === 0) return { identity: 'missing', why: null, json: null }
  if (withJson.length > 1) return { identity: 'foreign', why: `state file in ${withJson.length} session directories`, json: null }
  const dir = withJson[0]!.sessionId
  let text: string
  try {
    text = fs.readFileSync(path.join(home, 'sessions', dir, `${ptyId}.json`), 'utf8')
  } catch (e) {
    return { identity: 'foreign', why: `unreadable: ${(e as Error).message}`, json: null }
  }
  const json = parseHolderJson(text)
  if (!json) return { identity: 'foreign', why: 'not a holder state file', json: null }
  if (json.ptyId !== ptyId) return { identity: 'foreign', why: `names pty ${json.ptyId}`, json: null }
  if (json.sessionId !== dir) return { identity: 'foreign', why: `names session ${json.sessionId} but lives in ${dir}`, json: null }
  if (json.socket !== socketPath(runDir(home), ptyId)) return { identity: 'foreign', why: 'socket of another KEA_HOME', json: null }
  return { identity: 'trusted', why: null, json }
}

const STATE_EXTS = ['ckpt', 'json', 'ring'] as const

function isRegularFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile()
  } catch {
    return false
  }
}

/** One PTY, judged and probed now: right before core signals a holder by pid, its identity is checked again. */
export async function inspectHolder(home: string, ptyId: string, probe: ProcessProbe): Promise<HolderEntry> {
  const dirs: HolderEntry['dirs'] = []
  for (const d of readDir(path.join(home, 'sessions'))) {
    if (!d.isDirectory() || !SESSION_DIR.test(d.name)) continue
    const files = STATE_EXTS.map((x) => `${ptyId}.${x}`).filter((f) => isRegularFile(path.join(home, 'sessions', d.name, f)))
    if (files.length) dirs.push({ sessionId: d.name, files })
  }
  const e: HolderEntry = { ptyId, dirs, ...judge(home, ptyId, dirs), socket: isOwnSocket(socketPath(runDir(home), ptyId)), alive: null }
  if (e.json) {
    try {
      e.alive = holderAlive(e.json, (await probe([e.json.pid])).get(e.json.pid))
    } catch {
      // unknown: alive stays null
    }
  }
  return e
}

/** Remove a PTY's state files from its session directory (regular files only; a symlink is never followed). */
export function removeStateFiles(home: string, sessionId: string, ptyId: string): string[] {
  const removed: string[] = []
  for (const x of STATE_EXTS) {
    const p = path.join(home, 'sessions', sessionId, `${ptyId}.${x}`)
    if (!isRegularFile(p)) continue
    try {
      fs.unlinkSync(p)
      removed.push(p)
    } catch {
      // gone meanwhile
    }
  }
  return removed
}

/** Scan `home` (see the module comment). */
export async function scanHolders(home: string, probe: ProcessProbe): Promise<HolderScan> {
  const entries = new Map<string, HolderEntry>()
  const entry = (ptyId: string): HolderEntry => {
    let e = entries.get(ptyId)
    if (!e) {
      e = { ptyId, dirs: [], identity: 'missing', why: null, json: null, socket: false, alive: null }
      entries.set(ptyId, e)
    }
    return e
  }
  for (const d of readDir(path.join(home, 'sessions'))) {
    if (!d.isDirectory() || !SESSION_DIR.test(d.name)) continue
    const files = new Map<string, string[]>()
    for (const f of readDir(path.join(home, 'sessions', d.name))) {
      const m = f.isFile() ? STATE_FILE.exec(f.name) : null
      if (m) files.set(m[1] as string, [...(files.get(m[1] as string) ?? []), f.name])
    }
    for (const [ptyId, names] of files) entry(ptyId).dirs.push({ sessionId: d.name, files: names.sort() })
  }

  let socketsKnown = true
  const run = runDir(home)
  try {
    ensurePrivateDir(run) // A symlinked or shared run directory is never trusted
    for (const f of fs.readdirSync(run)) {
      const m = SOCKET_FILE.exec(f)
      if (m && isOwnSocket(path.join(run, f))) entry(m[1] as string).socket = true
    }
  } catch {
    socketsKnown = false
  }

  for (const e of entries.values()) Object.assign(e, judge(home, e.ptyId, e.dirs))

  let probeFailed = false
  const trusted = [...entries.values()].filter((e) => e.json)
  try {
    const procs = await probe(trusted.map((e) => e.json!.pid))
    for (const e of trusted) e.alive = holderAlive(e.json!, procs.get(e.json!.pid))
  } catch {
    probeFailed = true
  }
  return { entries, socketsKnown, probeFailed }
}
