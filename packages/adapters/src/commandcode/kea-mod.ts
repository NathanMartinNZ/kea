// Kea's session mod for Command Code. Kea starts `cmd` with `--mod <this file>` and one
// `--mod-option kea=<base64url JSON>`; the mod forwards the agent's status events to Kea by running `kea-helper hook`
// once per event, synchronously, with the event on stdin: the same delivery, spool and projection as
// every other agent's hooks. It observes only: it never blocks a tool, changes a prompt or prints anything, and a
// failure here never reaches the agent.
//
// This file is loaded by Command Code itself (in its own Node process), from a copy Kea keeps under KEA_HOME, so it
// imports nothing but Node's own modules and reads every number from its option. The event names it knows are
// Command Code's; U-AGT-12 (contract.test.ts) checks them against contract.ts.
//
//   session ids      `onSessionStart({source, sessionId})` → `session_start`; `onSessionEnd({reason})` → `session_shutdown`
//   forwarded        run_start, run_end (stop reason and final text only: never the conversation), tool_running,
//                    tool_completed, tool_errored, tool_denied, tool_hook_blocked (each with the queued call's input),
//                    interrupted, run_error, session_titled, permission_mode_changed, compaction_start/done, and
//                    model_request_start when the model changed
//   permission       Command Code has no event for its permission prompt. It queues every call of a model step, then
//                    asks about them one after another, in order, and runs nothing until each has its answer; a refusal
//                    is told at once (`tool_denied`) and the next call is asked about, but no call of the batch runs
//                    once one was refused. `tool_queued` starts a timer for the batch; if nothing of the batch has run,
//                    failed or been blocked when it fires, the mod sends `kea_tool_waiting` for the call being asked
//                    about. From then on the batch is known to be at its prompts: when a call is refused and others
//                    still wait for their answer, `kea_tool_waiting` for the next goes out at once, before the refusal,
//                    so that what Kea shows never drops while a prompt is on screen
//   transcript       once the session's file exists (after its first committed turn), its path rides on the next event

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The mod's one option (`--mod-option kea=…`). */
export const OPTION = 'kea'
/** Forwarded as they come. */
export const FORWARDED = ['run_start', 'run_end', 'tool_running', 'tool_completed', 'tool_errored', 'tool_denied', 'tool_hook_blocked', 'interrupted', 'run_error', 'session_titled', 'permission_mode_changed', 'compaction_start', 'compaction_done'] as const
/** Read here, never forwarded: the one event that carries a tool call's input. */
export const QUEUED = 'tool_queued'
/** Forwarded when the model changed. */
export const MODEL = 'model_request_start'
/** They get the queued call's input. */
export const TOOL_EVENTS = ['tool_running', 'tool_completed', 'tool_errored', 'tool_denied', 'tool_hook_blocked'] as const
/** Any of these means the waiting batch's permissions were answered, or the run is over. */
export const BATCH_END = ['tool_running', 'tool_completed', 'tool_errored', 'tool_hook_blocked', 'run_end', 'interrupted', 'run_error'] as const
/** A run is over: nothing of it is kept. */
export const RUN_END = ['run_end', 'interrupted', 'run_error'] as const
/** The transcript is looked for at these (it appears when a turn commits). */
export const LOOK_AT = ['run_start', 'run_end'] as const
/** The events the mod makes. */
export const MADE = { start: 'session_start', end: 'session_shutdown', waiting: 'kea_tool_waiting' } as const
/** Tools that read only: a prompt in a batch is for another one when there is another. */
export const READ_ONLY_TOOLS = ['read_file', 'read_directory', 'glob', 'grep'] as const
/** Where Command Code keeps a session's file: `<home>/.commandcode/projects/<slug>/<id>.jsonl`. */
export const TRANSCRIPTS = ['.commandcode', 'projects'] as const
export const TRANSCRIPT_EXT = '.jsonl'

/** What `--mod-option kea=…` carries (launch.ts builds it). */
export interface KeaModOptions {
  /** kea-helper, absolute. */
  helper: string
  /** Its arguments: `hook <adapter> --session … --home … --project …`. */
  args: string[]
  /** The dotted paths of an event that are sent (the projection's). */
  paths: string[]
  /** Strings are cut to this many characters before they are sent. */
  maxChars: number
  /** A batch queued this long with nothing run: a permission prompt. */
  waitMs: number
  /** One delivery may take this long. */
  timeoutMs: number
  /** Queued calls of one run whose input is kept. */
  maxTools: number
}

type Dict = Record<string, unknown>

/** What the mod needs from outside: stubbed in tests. */
export interface KeaModIo {
  deliver(o: KeaModOptions, payload: Dict): void
  transcriptOf(sessionId: string): string | null
  setTimeout(f: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
}

/** The part of Command Code's ModApi the mod uses. */
export interface ModApiLike {
  addFlag(name: string, o: { type: 'string'; default: string }): unknown
  getFlag(name: string): unknown
  on(event: string, handler: (e: unknown) => void): unknown
  hooks(h: Record<string, (a: unknown) => void>): unknown
}

export function decodeOptions(v: unknown): KeaModOptions | null {
  if (typeof v !== 'string' || v === '') return null
  try {
    const o = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as Partial<KeaModOptions>
    const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((s) => typeof s === 'string')
    const count = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
    if (typeof o.helper !== 'string' || !path.isAbsolute(o.helper) || !strings(o.args) || !strings(o.paths)) return null
    if (!count(o.maxChars) || !count(o.waitMs) || !count(o.timeoutMs) || !count(o.maxTools)) return null
    return { helper: o.helper, args: o.args, paths: o.paths, maxChars: o.maxChars, waitMs: o.waitMs, timeoutMs: o.timeoutMs, maxTools: o.maxTools }
  } catch {
    return null
  }
}

function get(v: unknown, dotted: string): unknown {
  for (const k of dotted.split('.')) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
    v = (v as Dict)[k]
  }
  return v
}

function put(out: Dict, dotted: string, val: unknown): void {
  const parts = dotted.split('.')
  let cur = out
  for (const k of parts.slice(0, -1)) {
    const next = cur[k]
    if (next === undefined) cur[k] = {}
    else if (next === null || typeof next !== 'object') return
    cur = cur[k] as Dict
  }
  const last = parts[parts.length - 1] as string
  if (!(last in cur)) cur[last] = val
}

/** Only the named paths of an event, strings cut: what is sent is small whatever the event holds. */
export function pick(e: unknown, paths: readonly string[], maxChars: number): Dict {
  const out: Dict = {}
  for (const p of paths) {
    const v = get(e, p)
    if (typeof v === 'string') put(out, p, v.length > maxChars ? [...v.slice(0, maxChars * 2)].slice(0, maxChars).join('') : v)
    else if (typeof v === 'number' || typeof v === 'boolean') put(out, p, v)
  }
  return out
}

/** A name's letters and digits, lower case: what a working directory and the slug Command Code makes of it share. */
export function spelling(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

const nodeIo: KeaModIo = {
  deliver(o, payload) {
    // synchronous, like a hook: the helper answers in a few milliseconds, or spools and exits
    spawnSync(o.helper, o.args, { input: JSON.stringify(payload), stdio: ['pipe', 'ignore', 'ignore'], timeout: o.timeoutMs })
  },
  transcriptOf(sessionId) {
    if (!/^[0-9A-Za-z_-]{1,128}$/.test(sessionId)) return null
    const root = path.join(process.env.HOME || os.homedir(), ...TRANSCRIPTS)
    const at = (dir: string): string | null => {
      const file = path.join(root, dir, sessionId + TRANSCRIPT_EXT)
      return fs.existsSync(file) ? file : null
    }
    try {
      // the session's folder is named after the working directory (a slug of it): the folders that spell it first,
      // every folder only when none does (a name Command Code transliterated)
      const dirs = fs.readdirSync(root)
      const want = spelling(process.cwd())
      const likely = dirs.filter((d) => spelling(d) === want)
      for (const d of likely) {
        const f = at(d)
        if (f) return f
      }
      if (likely.length === 0) {
        for (const d of dirs) {
          const f = at(d)
          if (f) return f
        }
      }
    } catch {
      // no sessions folder yet
    }
    return null
  },
  setTimeout(f, ms) {
    const t = setTimeout(f, ms)
    t.unref()
    return t
  },
  clearTimeout(t) {
    clearTimeout(t as ReturnType<typeof setTimeout>)
  },
}

export function keaMod(cmd: ModApiLike, io: KeaModIo = nodeIo): void {
  /** undefined: not read yet (the option is only there once the session is bound); null: absent or unusable. */
  let options: KeaModOptions | null | undefined
  let sessionId: string | null = null
  let transcript: string | null = null
  let model: string | null = null
  // bounded: at most `maxTools` queued calls of the current run; emptied when the run ends
  const inputs = new Map<string, unknown>()
  /**
   * The calls queued and not yet run. `next`: the first of `calls` that may still wait for its answer (the CLI asks in
   * order: a refusal says that call and those before it have theirs). `waiting`: the wait is over, a prompt is up.
   */
  let batch: { ids: Set<string>; calls: { id: string; name: string }[]; timer: unknown; waiting: boolean; next: number } | null = null

  const opts = (): KeaModOptions | null => {
    if (options === undefined) options = decodeOptions(cmd.getFlag(OPTION))
    return options
  }
  const send = (o: KeaModOptions, e: unknown, input?: unknown): void => {
    const payload = pick(input === undefined ? e : { ...(e as Dict), input }, o.paths, o.maxChars)
    if (sessionId !== null && payload.sessionId === undefined) payload.sessionId = sessionId
    io.deliver(o, payload)
  }
  const look = (): string | undefined => {
    if (transcript !== null || sessionId === null) return undefined
    transcript = io.transcriptOf(sessionId)
    return transcript ?? undefined
  }
  const endBatch = (): void => {
    if (!batch) return
    io.clearTimeout(batch.timer)
    batch = null
  }
  /** The batch is at a prompt: name the call being asked about, of those that may still wait for their answer. */
  const waiting = (o: KeaModOptions): void => {
    if (!batch) return
    batch.waiting = true
    const left = batch.calls.slice(batch.next)
    const call = left.find((c) => !(READ_ONLY_TOOLS as readonly string[]).includes(c.name)) ?? left[0]
    if (call) send(o, { type: MADE.waiting, toolCallId: call.id, toolName: call.name }, inputs.get(call.id))
  }
  const safely = (f: () => void): void => {
    try {
      f()
    } catch {
      // never the agent's problem
    }
  }

  const onEvent = (name: string, e: Dict): void => {
    const o = opts()
    if (!o) return
    const id = typeof e.toolCallId === 'string' ? e.toolCallId : null
    if (name === QUEUED) {
      if (id === null) return
      if (inputs.size < o.maxTools) inputs.set(id, e.input)
      batch ??= { ids: new Set(), calls: [], waiting: false, next: 0, timer: io.setTimeout(() => safely(() => waiting(o)), o.waitMs) }
      batch.ids.add(id)
      if (batch.calls.length < o.maxTools) batch.calls.push({ id, name: typeof e.toolName === 'string' ? e.toolName : '' })
      return
    }
    if (name === 'run_start') {
      if (typeof e.sessionId === 'string' && e.sessionId !== sessionId) {
        sessionId = e.sessionId
        transcript = null
      }
      inputs.clear()
      endBatch()
    }
    if (name === MODEL) {
      if (typeof e.model !== 'string' || e.model === model) return
      model = e.model
    }
    let input: unknown
    if (id !== null && (TOOL_EVENTS as readonly string[]).includes(name)) {
      input = inputs.get(id)
      if (name !== 'tool_running') inputs.delete(id)
    }
    if (name === 'tool_denied') {
      if (batch && id !== null) {
        // asked in order: this call and those before it have their answer; those after it may still wait for theirs
        const at = batch.calls.findIndex((c) => c.id === id)
        for (const c of batch.calls.slice(0, at + 1)) batch.ids.delete(c.id)
        batch.ids.delete(id)
        batch.next = Math.max(batch.next, at + 1)
        if (batch.ids.size === 0) endBatch()
        // a prompt was up and the next one is now: say so before the refusal, so the item moves and never drops
        else if (batch.waiting) waiting(o)
      }
    } else if ((BATCH_END as readonly string[]).includes(name)) {
      endBatch()
    }
    const found = (LOOK_AT as readonly string[]).includes(name) ? look() : undefined
    send(o, found === undefined ? e : { ...e, transcript: found }, input)
    if ((RUN_END as readonly string[]).includes(name)) inputs.clear()
  }

  safely(() => cmd.addFlag(OPTION, { type: 'string', default: '' }))
  for (const name of [...FORWARDED, QUEUED, MODEL]) {
    safely(() => cmd.on(name, (e) => safely(() => onEvent(name, e !== null && typeof e === 'object' ? (e as Dict) : {}))))
  }
  safely(() =>
    cmd.hooks({
      onSessionStart: (a) =>
        safely(() => {
          const o = opts()
          const s = (a ?? {}) as Dict
          sessionId = typeof s.sessionId === 'string' ? s.sessionId : null
          transcript = null
          model = null
          inputs.clear()
          endBatch()
          if (o) send(o, { type: MADE.start, sessionId, source: s.source, transcript: look() })
        }),
      onSessionEnd: (a) =>
        safely(() => {
          const o = opts()
          endBatch()
          if (o) send(o, { type: MADE.end, reason: ((a ?? {}) as Dict).reason })
        }),
    }),
  )
}

export default function (cmd: ModApiLike): void {
  keaMod(cmd)
}
