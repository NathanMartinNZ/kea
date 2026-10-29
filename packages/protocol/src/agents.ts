// The `agents` feature's messages: what core's adapter registry tells the window about each agent — whether its CLI
// is installed and logged in, and the knobs the composer can offer — as the `agents` store (detection results and
// options per adapter), snapshot + deltas. Detection is cached in core and refreshed in the background; the composer
// never waits for it.
import { z } from 'zod'
import { defineApi } from './rpc.ts'
import { zSessionId } from './terminal.ts'

export const AGENTS_STORE = 'agents'

/** One model the composer offers: `efforts` may be empty (the model has none). */
export const zModelOption = z.object({ id: z.string().min(1), label: z.string(), efforts: z.array(z.string()), isDefault: z.boolean() })
export type ModelOption = z.infer<typeof zModelOption>

/** One permission mode; `dangerous` ones are listed only when allowed. */
export const zPermissionModeOption = z.object({ id: z.string().min(1), label: z.string(), dangerous: z.boolean() })
export type PermissionModeOption = z.infer<typeof zPermissionModeOption>

/** What `adapter.options(detection)` returns: unsupported knobs are omitted, not disabled. */
export const zAgentOptions = z.object({
  models: z.array(zModelOption),
  /** A free-text model id is accepted. */
  allowCustomModel: z.boolean(),
  permissionModes: z.array(zPermissionModeOption),
})
export type AgentOptions = z.infer<typeof zAgentOptions>

/**
 * Detection, as the window sees it. `state`: `detecting` before the first result; `ready` (installed and supported),
 * `outdated` (installed, below the minimum: usable with a notice), `missing` (not found: the install command
 * is offered), `pseudo` (no CLI: the `shell` pseudo-agent).
 */
export const AGENT_STATES = ['detecting', 'ready', 'outdated', 'missing', 'pseudo'] as const
export type AgentState = (typeof AGENT_STATES)[number]

/** One row of the `agents` store, by adapter id. */
export const zAgentInfo = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  state: z.enum(AGENT_STATES),
  version: z.string().nullable(),
  path: z.string().nullable(),
  loggedIn: z.boolean().nullable(),
  /** One line: outdated, signed out, detection failed. */
  notice: z.string().nullable(),
  /** What to copy when the CLI is missing; null for the pseudo-agent. */
  installCommand: z.string().nullable(),
  /** What to run when the CLI is signed out (`signed out — run claude auth login`); null when the agent has none. */
  loginCommand: z.string().nullable(),
  /** In its tab a plain right-click opens Kea's terminal menu, though the agent captures the mouse (the adapter's `rightButtonMenu`). */
  rightButtonMenu: z.boolean(),
  options: zAgentOptions,
  /** The adapter's defaults merged with `agents.<id>.defaults` (what the composer falls back to). */
  defaults: z.object({ model: z.string().optional(), effort: z.string().optional(), permissionMode: z.string().optional() }),
  /** Wall ms of the detection shown; null while detecting. */
  detectedAt: z.number().int().nullable(),
  /** Registry order (the composer lists agents in it). */
  order: z.number().int(),
})
export type AgentInfo = z.infer<typeof zAgentInfo>

// ── hook envelopes: kea-helper hook → core's socket, or the session spool ───────────────────────────────

const zHookId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/)

/**
 * The byte core answers each envelope line with: the helper counts a line as delivered only once this comes back within
 * `L.hookBoundMs`, and spools it otherwise (kea-helper's `hook::ACK`).
 */
export const HOOK_ACK_BYTE = 0x06

/** One envelope, as kea-helper writes it (native/kea-helper/README.md `hook`): one line, at most L.hookEnvelopeMaxBytes. */
export const zHookEnvelope = z.object({
  keaSessionId: zHookId,
  adapter: zHookId,
  /**
   * 16 hex digits, random per hook run: core applies each id once, so a line a busy or hung core took late and the
   * helper also spooled counts once. Absent from an older helper's envelopes (a holder of an earlier build).
   */
  id: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  /**
   * ns on the helper's monotonic clock, taken when the hook started: `CLOCK_UPTIME_RAW` on macOS, `CLOCK_MONOTONIC` on
   * Linux, both of which stop while the machine sleeps.
   */
  mono: z.number().nonnegative(),
  /** Wall ms. */
  receivedAt: z.number().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
  /** stdin was not JSON: the payload is `{}`. */
  malformed: z.literal(true).optional(),
  /** stdin was over L.hookStdinMaxBytes: drained and dropped, the payload is `{}`. */
  oversize: z.literal(true).optional(),
})
export type HookEnvelope = z.infer<typeof zHookEnvelope>

/** Methods core serves for agents. */
export const agentsApi = defineApi({
  /** Detect every agent again now (Settings' refresh; a composer opened on a missing agent asks once). */
  'agents.refresh': { args: z.object({}), result: z.object({ ok: z.boolean() }) },
  /**
   * How the session's agent is told about the file at `path` (relative to its working directory) at its prompt:
   * `@path`, or the agent's quoted form where the bare one would not read back as that path (a space in the name).
   * `text` has no trailing space; null: the agent has no form for this name (a control character, a quote where quotes
   * are needed), and nothing is to be typed.
   */
  'agents.mention': { args: z.object({ sessionId: zSessionId, path: z.string().min(1) }), result: z.object({ text: z.string().nullable() }) },
})
