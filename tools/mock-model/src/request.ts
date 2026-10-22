// Recorded requests and how tests read them: what the client sent (minus credentials), which reply it got, and helpers
// to pull out the user text Claude Code put into a Messages request (the exact bytes of an argv prompt).

/** What the mock answered with. */
export type Answer =
  | { kind: 'scripted'; index: number } // index = position in the order scripted replies were enqueued
  | { kind: 'default' }
  | { kind: 'count_tokens' }
  | { kind: 'models' }
  | { kind: 'control' }
  | { kind: 'unknown'; status: number }

export interface RecordedRequest {
  seq: number
  /** `process.hrtime.bigint()` when the request body was fully received (macOS: CLOCK_MONOTONIC_RAW, the same clock as
   * every other process's `hrtime` and `clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)`). */
  mono: bigint
  /** Wall-clock ms. */
  at: number
  method: string
  /** Pathname without the query string, e.g. `/v1/messages`. */
  path: string
  query: Record<string, string>
  /** Lower-cased header names; credentials removed (`REDACTED_HEADERS`). */
  headers: Record<string, string>
  /** Parsed JSON body; the raw text when it is not JSON; undefined when empty. */
  body: unknown
  answer: Answer
}

/** Headers never recorded: they carry credentials. */
export const REDACTED_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'proxy-authorization'])

/** Declarative request matcher, JSON-safe so a script file can carry it. Every given field must hold. */
export interface Match {
  /** Exact pathname (default `/v1/messages`). */
  path?: string
  /** Substring of `body.model`. */
  model?: string
  /** `body.tools` has a tool with this name. */
  tool?: string
  /** `body.tools` is absent or empty. */
  noTools?: boolean
  /** Substring of the system prompt text. */
  system?: string
  /** Substring of the last user message's text. */
  lastUser?: string
  /** Substring of the first user message's typed text (`firstUserTexts`): tells a subagent's requests, whose first
   * message is the subagent prompt, from the main loop's, even when the last message is a tool result. */
  firstUser?: string
  /** `body.stream` equals this. */
  stream?: boolean
}

export type Matcher = Match | ((r: RecordedRequest) => boolean)

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined)

export interface ApiMessage {
  role: string
  content: unknown
}

/** The `messages` array of a Messages request (empty for anything else). */
export function messagesOf(r: RecordedRequest): ApiMessage[] {
  const m = obj(r.body)?.['messages']
  return Array.isArray(m) ? (m.filter((x) => obj(x) !== undefined) as ApiMessage[]) : []
}

/** The text blocks of a message's content, in order (a string content is one block). Other block types are skipped. */
export function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const b of content) {
    const o = obj(b)
    if (o?.['type'] === 'text' && typeof o['text'] === 'string') out.push(o['text'])
  }
  return out
}

/** Whether a text block is client-injected context rather than typed text (`<system-reminder>`, command wrappers…). */
export const isInjected = (t: string): boolean => /^\s*<(system-reminder|local-command-|command-|bash-|user-memory-input|session-start-hook)/.test(t)

/** Text blocks of the first user message that are not injected context: for an argv prompt, normally exactly one. */
export function firstUserTexts(r: RecordedRequest): string[] {
  const first = messagesOf(r).find((m) => m.role === 'user')
  return first ? textBlocks(first.content).filter((t) => !isInjected(t)) : []
}

export function systemText(r: RecordedRequest): string {
  const s = obj(r.body)?.['system']
  return typeof s === 'string' ? s : textBlocks(s).join('\n')
}

export function toolNames(r: RecordedRequest): string[] {
  const t = obj(r.body)?.['tools']
  return Array.isArray(t) ? t.map((x) => obj(x)?.['name']).filter((n): n is string => typeof n === 'string') : []
}

function lastUserText(r: RecordedRequest): string {
  const users = messagesOf(r).filter((m) => m.role === 'user')
  const last = users[users.length - 1]
  return last ? textBlocks(last.content).join('\n') : ''
}

export function matches(m: Matcher, r: RecordedRequest): boolean {
  if (typeof m === 'function') return m(r)
  const body = obj(r.body) ?? {}
  if (r.path !== (m.path ?? '/v1/messages')) return false
  if (m.model !== undefined && !String(body['model'] ?? '').includes(m.model)) return false
  if (m.tool !== undefined && !toolNames(r).includes(m.tool)) return false
  if (m.noTools && toolNames(r).length > 0) return false
  if (m.system !== undefined && !systemText(r).includes(m.system)) return false
  if (m.lastUser !== undefined && !lastUserText(r).includes(m.lastUser)) return false
  if (m.firstUser !== undefined && !firstUserTexts(r).some((t) => t.includes(m.firstUser!))) return false
  if (m.stream !== undefined && (body['stream'] === true) !== m.stream) return false
  return true
}

/** A Messages request from an agent loop (main agent or subagent): it offers tools. Side queries (titles, topic
 * checks) offer none. This is the default matcher for scripted replies. */
export const AGENT_LOOP: Match = { path: '/v1/messages' }
export const isAgentLoop = (r: RecordedRequest): boolean => matches(AGENT_LOOP, r) && toolNames(r).length > 0

/** JSON-safe form of a recorded request (`mono` as a decimal string). */
export const toJson = (r: RecordedRequest) => ({ ...r, mono: r.mono.toString() })
