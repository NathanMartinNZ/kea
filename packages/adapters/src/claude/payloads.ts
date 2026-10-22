// The hook payloads Claude Code sends for the events Kea injects, as zod schemas per event: the fields the mapping
// reads, with their types. Anything else is allowed, as payloads gain fields every release. The fixture contract
// (K-FX-1) checks every recorded payload against these; the mapping itself reads fields defensively (a field of the
// wrong type is as good as absent), so a drift shows up here first, as a red test with a name.

import { z } from 'zod'
import { FIELDS, HOOK_EVENTS, START_SOURCES, type HookEvent } from './contract.ts'

/** The top-level key of a dotted field (`tool_input.command` → `tool_input`). */
const top = (f: string) => f.split('.')[0]!

const common = {
  [FIELDS.event]: z.string().min(1),
  [FIELDS.sessionId]: z.string().min(1),
  [FIELDS.cwd]: z.string().min(1),
  [FIELDS.transcriptPath]: z.string(),
}
const mode = { [FIELDS.permissionMode]: z.string().min(1) }
const tool = { ...mode, [FIELDS.toolName]: z.string().min(1), [top(FIELDS.toolCommand)]: z.record(z.string(), z.unknown()) }
const subagent = { [FIELDS.agentId]: z.string().optional(), [FIELDS.agentType]: z.string().optional() }
const list = z.array(z.unknown())

export const HOOK_PAYLOADS: Readonly<Record<HookEvent, z.ZodType>> = {
  SessionStart: z.looseObject({ ...common, [FIELDS.source]: z.enum(START_SOURCES), [FIELDS.model]: z.string().optional() }),
  UserPromptSubmit: z.looseObject({ ...common, ...mode, [FIELDS.prompt]: z.string() }),
  PreToolUse: z.looseObject({ ...common, ...tool, ...subagent, [FIELDS.toolUseId]: z.string().min(1) }),
  PostToolUse: z.looseObject({ ...common, ...tool, ...subagent, [FIELDS.toolUseId]: z.string().min(1) }),
  PostToolUseFailure: z.looseObject({ ...common, ...tool, ...subagent, [FIELDS.error]: z.string().optional() }),
  PermissionRequest: z.looseObject({ ...common, ...tool }),
  PermissionDenied: z.looseObject({ ...common, ...tool }),
  Notification: z.looseObject({ ...common, [FIELDS.notificationType]: z.string().min(1), [FIELDS.message]: z.string() }),
  Stop: z.looseObject({ ...common, ...mode, [FIELDS.lastAssistantMessage]: z.string().optional(), [FIELDS.backgroundTasks]: list.optional(), [FIELDS.sessionCrons]: list.optional() }),
  StopFailure: z.looseObject({ ...common, [FIELDS.error]: z.string().optional(), [FIELDS.lastAssistantMessage]: z.string().optional() }),
  PreCompact: z.looseObject({ ...common }),
  PostCompact: z.looseObject({ ...common }),
  SessionEnd: z.looseObject({ ...common, [FIELDS.reason]: z.string().min(1) }),
}

/** The schema of an injected event, or null for one Kea does not inject (its payloads are not read). */
export function payloadSchema(event: string): z.ZodType | null {
  return (HOOK_EVENTS as readonly string[]).includes(event) ? HOOK_PAYLOADS[event as HookEvent] : null
}
