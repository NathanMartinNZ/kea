// The dev server: the `server:<sessionId>` store (registered only while its session is visible) and the calls of the
// header control. One row per store, keyed `SERVER_ROW`.

import { z } from 'zod'
import { defineApi } from './rpc.ts'
import { zGrid } from './sessions.ts'
import { zPtyId, zSessionId } from './terminal.ts'

/** The lifecycle's states (the server's `kit/Fsm` table in core, `server/fsm.ts`). */
export const SERVER_STATES = ['stopped', 'starting', 'running', 'stopping', 'crashed'] as const
export type ServerState = (typeof SERVER_STATES)[number]

/** What Run would run. `none`: no `start.sh` and no run command, so the control is hidden. */
export const SERVER_SOURCES = ['runCommand', 'startScript', 'none'] as const
export type ServerSource = (typeof SERVER_SOURCES)[number]

/** The key of the one row a `server:<sessionId>` store holds. */
export const SERVER_ROW = 'server'

/** How a run ended. A death by signal has `signal` and no `code`; a lost holder has neither. */
export const zServerExit = z.object({ code: z.number().int().nullable(), signal: z.number().int().nullable() })
export type ServerExit = z.infer<typeof zServerExit>

/**
 * The one line under the control. `holder` names what holds `port`: another session's dev server (the only kind "Stop
 * it and run here" may stop), another process (named, never stopped), another user's process (Linux: it cannot be
 * named), or nothing Kea could name.
 */
export const zServerHint = z.object({
  port: z.number().int().min(1).max(0xffff),
  holder: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('session'), sessionId: zSessionId, title: z.string() }),
    z.object({ kind: z.literal('process'), name: z.string(), pid: z.number().int() }),
    z.object({ kind: z.literal('otherUser') }),
    z.object({ kind: z.literal('unknown') }),
  ]),
})
export type ServerHint = z.infer<typeof zServerHint>

export const zServerView = z.object({
  state: z.enum(SERVER_STATES),
  source: z.enum(SERVER_SOURCES),
  /** The Server tab's PTY: the running server's, else the last run's; null before the first run. */
  ptyId: zPtyId.nullable(),
  /** The server's own process (its PTY's child) while it is alive. */
  pid: z.number().int().nullable(),
  /** The ports its process tree listens on, lowest first. */
  ports: z.array(z.number().int().min(1).max(0xffff)),
  /** The primary URL; null until a port is found. */
  url: z.string().nullable(),
  /** How the last run ended; null while one runs and before the first. */
  exit: zServerExit.nullable(),
  hint: zServerHint.nullable(),
})
export type ServerView = z.infer<typeof zServerView>

/** What the store shows for a session whose server has never run and has nothing to run. */
export const NO_SERVER: ServerView = { state: 'stopped', source: 'none', ptyId: null, pid: null, ports: [], url: null, exit: null, hint: null }

const SIGNAL_EXIT_BASE = 128

/** `Exited 1`; a death by signal reads as a shell reports it (128 + the signal). */
export function serverExitLabel(exit: ServerExit | null): string {
  if (exit?.code !== null && exit?.code !== undefined) return `Exited ${exit.code}`
  if (exit?.signal !== null && exit?.signal !== undefined) return `Exited ${SIGNAL_EXIT_BASE + exit.signal}`
  return 'Exited'
}

/** The chip's label, `:5173 ↗` without the arrow. */
export function serverPortLabel(port: number): string {
  return `:${port}`
}

/** The URL a listening port opens when it is not the primary one. */
export function serverPortUrl(port: number): string {
  return `http://localhost:${port}`
}

/** "Port 3000 is used by session add-billing". */
export function serverHintText(h: ServerHint): string {
  if (h.holder.kind === 'session') return `Port ${h.port} is used by session ${h.holder.title}`
  if (h.holder.kind === 'process') return `Port ${h.port} is used by ${h.holder.name} (pid ${h.holder.pid})`
  if (h.holder.kind === 'otherUser') return `Port ${h.port} is held by another user's process`
  return `Port ${h.port} is already in use`
}

/**
 * Why a call did nothing. `nothingToRun`: there is nothing to run. `wrongState`: the session cannot run one now
 * (archived, being created, its worktree missing). `portHeld`: a port this project's servers use is held by another
 * session's server; the store's hint says which. `notHeld`: "Stop it and run here" found no dev server of
 * Kea's holding the port.
 */
export const SERVER_REFUSALS = ['nothingToRun', 'wrongState', 'portHeld', 'notHeld'] as const
export type ServerRefusal = (typeof SERVER_REFUSALS)[number]

const zServerResult = z.object({ ok: z.boolean(), state: z.enum(SERVER_STATES), reason: z.enum(SERVER_REFUSALS).nullable() })
export type ServerResult = z.infer<typeof zServerResult>

/** Methods core serves to the renderer for the dev server. */
export const serverApi = defineApi({
  /** Run; a no-op while one is alive. `grid`: the pane's size, so the first screen is not reflowed. */
  'server.run': { args: z.object({ sessionId: zSessionId, grid: zGrid.optional() }), result: zServerResult },
  /** Stop; on a server that is already stopping, skip to `SIGKILL`. Resolves once it has stopped. */
  'server.stop': { args: z.object({ sessionId: zSessionId }), result: zServerResult },
  /** Stop, then Run. */
  'server.restart': { args: z.object({ sessionId: zSessionId, grid: zGrid.optional() }), result: zServerResult },
  /** Stop the other session's dev server the hint names, then run this one. */
  'server.takeOver': { args: z.object({ sessionId: zSessionId, grid: zGrid.optional() }), result: zServerResult },
  /** The Server tab or the port menu was opened, so the ports are scanned once now. */
  'server.scan': { args: z.object({ sessionId: zSessionId }), result: z.object({ ok: z.boolean() }) },
  /** The hint was read and closed. */
  'server.dismissHint': { args: z.object({ sessionId: zSessionId }), result: z.object({ ok: z.boolean() }) },
})
