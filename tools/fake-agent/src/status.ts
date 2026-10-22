// Claude's live status file: `<config dir>/sessions/<pid>.json`, where the config dir is `CLAUDE_CONFIG_DIR` when set
// and `<home>/.claude` otherwise. Claude 2.1.296 registers the file at start (no status), rewrites it in place on every
// change (one inode: `writeFile` truncates and writes), and removes it on a graceful exit; SIGKILL leaves it behind.
// fake-agent writes the same shapes, with the same real-home refusal as transcripts: never under the real `~/.claude*`.
//
// `auto` mode follows what the recording (fixtures/status/claude/2.1.296/sequence.json) shows around each hook:
//   SessionStart                          registered, then idle, before the hook, when not yet registered (an agent
//                                         that awaited trust: the trust dialog writes no file)
//   UserPromptSubmit, PreCompact          busy before the hook
//   PermissionRequest                     waiting "permission prompt" after it (AskUserQuestion: "input needed", before)
//   any other hook while waiting          busy before it (the prompt was answered)
//   Stop, StopFailure, PostCompact        idle after the hook
//   an interrupt (Esc)                    idle, with no Stop (a waiting file goes busy first)
//   a graceful end                        removed before SessionEnd

import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { transcriptLocation } from './transcript.ts'

export type StatusFileMode = 'auto' | 'manual' | 'off'

export type StatusFileLocation = { path: string; writable: true } | { path: string; writable: false; reason: string }

/** Where the file goes; refused under the real home exactly like transcripts (transcript.ts). */
export function statusFileLocation(o: { pid: number; configDir: string | undefined; override: string | null; home: string; realHome: string; cwd: string }): StatusFileLocation {
  const dir = o.configDir && isAbsolute(o.configDir) ? o.configDir : join(o.override ?? o.home, '.claude')
  const path = join(dir, 'sessions', `${o.pid}.json`)
  // the config dir is judged as a fake home would be: `<dir>/..` must not be the real home, nor inside its .claude*
  const asHome = o.configDir && isAbsolute(o.configDir) ? resolve(o.configDir, '..') : (o.override ?? o.home)
  const t = transcriptLocation({ flavour: 'claude', cwd: o.cwd, sessionId: 'x', override: asHome, home: o.home, realHome: o.realHome })
  if (!t.writable) return { path, writable: false, reason: t.reason.replace('transcripts', 'the status file') }
  if (o.configDir && isAbsolute(o.configDir) && resolve(o.configDir) === resolve(o.realHome, '.claude')) return { path, writable: false, reason: 'not writing the status file: CLAUDE_CONFIG_DIR is the real ~/.claude' }
  return { path, writable: true }
}

export interface StatusFileBase {
  pid: number
  sessionId: string
  cwd: string
  version: string
}

/** One status: the file's `status` and `waitingFor` (any string, so a test can write values Kea does not know). */
export interface StatusValue {
  status: string
  waitingFor?: string
}

const QUESTION_TOOL = 'AskUserQuestion'

export class StatusFileWriter {
  readonly path: string
  private readonly base: StatusFileBase
  private readonly now: () => number
  private readonly startedAt: number
  private current: StatusValue | null = null
  private sessionId: string
  private removed = false
  private registered = false

  constructor(path: string, base: StatusFileBase, now: () => number = Date.now) {
    this.path = path
    this.base = base
    this.now = now
    this.startedAt = now()
    this.sessionId = base.sessionId
  }

  get status(): string | null {
    return this.current?.status ?? null
  }

  private record(v: StatusValue | null): Record<string, unknown> {
    const at = this.now()
    const r: Record<string, unknown> = {
      pid: this.base.pid,
      sessionId: this.sessionId,
      cwd: this.base.cwd,
      startedAt: this.startedAt,
      version: this.base.version,
      peerProtocol: 1,
      kind: 'interactive',
      entrypoint: 'cli',
    }
    if (v) {
      r.status = v.status
      r.updatedAt = at
      r.statusUpdatedAt = at
      if (v.waitingFor !== undefined) r.waitingFor = v.waitingFor
    }
    return r
  }

  /** In place (truncate + write, same inode), as Claude's `writeFile` does. */
  private write(text: string): void {
    if (this.removed) return
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, text)
  }

  /** Registered at start (or once trust is given): no status yet. */
  register(): void {
    this.registered = true
    this.write(JSON.stringify(this.record(null)))
  }

  set(v: StatusValue): void {
    if (this.current && this.current.status === v.status && this.current.waitingFor === v.waitingFor) return
    this.registered = true
    this.current = { ...v }
    this.write(JSON.stringify(this.record(this.current)))
  }

  /** The file follows the current conversation (/clear, a resume): the next write carries this id. */
  setSessionId(id: string): void {
    this.sessionId = id
  }

  /** A torn write (a reader caught the file mid-write): the first half of the next record. */
  torn(): void {
    const text = JSON.stringify(this.record(this.current))
    this.write(text.slice(0, Math.floor(text.length / 2)))
  }

  remove(): void {
    if (this.removed) return
    this.removed = true
    try {
      unlinkSync(this.path)
    } catch {
      // gone already
    }
  }

  // ── auto mode ──

  beforeHook(event: string, tool: string | null): void {
    const waiting = this.current?.status === 'waiting'
    if (event === 'SessionStart' && !this.registered) {
      this.register()
      this.set({ status: 'idle' })
    } else if (event === 'UserPromptSubmit' || event === 'PreCompact') {
      if (!waiting) this.set({ status: 'busy' })
    } else if (event === 'PermissionRequest' && tool === QUESTION_TOOL) {
      this.set({ status: 'waiting', waitingFor: 'input needed' })
    } else if (waiting && event !== 'Notification' && event !== 'PermissionRequest') {
      this.set({ status: 'busy' })
    }
  }

  afterHook(event: string, tool: string | null): void {
    if (event === 'PermissionRequest' && tool !== QUESTION_TOOL) this.set({ status: 'waiting', waitingFor: 'permission prompt' })
    else if (event === 'Stop' || event === 'StopFailure' || event === 'PostCompact') this.set({ status: 'idle' })
  }

  interrupted(): void {
    if (this.current?.status === 'waiting') this.set({ status: 'busy' })
    this.set({ status: 'idle' })
  }
}
