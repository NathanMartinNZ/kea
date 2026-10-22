// Canned Anthropic Messages API replies: the reply types a script uses, small builders, and the encoders that turn a
// reply into a `message` object or into the SSE event sequence a `stream: true` request expects.

/** One content block of a canned assistant message. */
export type ReplyBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; id?: string }

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | 'refusal'

/** A successful assistant message. `stopReason` defaults to `tool_use` when a block is a tool call, else `end_turn`. */
export interface MessageReply {
  content: ReplyBlock[]
  stopReason?: StopReason
  /** Overrides the model echoed back (default: the request's `model`). */
  model?: string
  /** Wait this long before answering (exercises spinners and slow-model paths). */
  delayMs?: number
}

/** An HTTP error in the API's error shape, e.g. `{ status: 429, type: 'rate_limit_error' }`. */
export interface ErrorReply {
  error: { status: number; type: string; message?: string }
  /** Extra response headers, e.g. `{ 'x-should-retry': 'false' }` to stop the client's retries. */
  headers?: Record<string, string>
  delayMs?: number
}

export type Reply = MessageReply | ErrorReply

export const isErrorReply = (r: Reply): r is ErrorReply => 'error' in r

/** A plain text answer. */
export const text = (t: string, opts: Omit<MessageReply, 'content'> = {}): MessageReply => ({ ...opts, content: [{ type: 'text', text: t }] })

/** An answer that calls one tool, optionally after some text. */
export function toolUse(
  name: string,
  input: Record<string, unknown>,
  opts: Omit<MessageReply, 'content'> & { id?: string; before?: string } = {},
): MessageReply {
  const { id, before, ...rest } = opts
  const call: ReplyBlock = id === undefined ? { type: 'tool_use', name, input } : { type: 'tool_use', name, input, id }
  return { ...rest, content: before === undefined ? [call] : [{ type: 'text', text: before }, call] }
}

/** An API error answer. */
export const apiError = (status: number, type: string, message = type, headers?: Record<string, string>): ErrorReply =>
  headers === undefined ? { error: { status, type, message } } : { error: { status, type, message }, headers }

// ── encoding ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

export interface Message {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: ContentBlock[]
  stop_reason: StopReason
  stop_sequence: null
  usage: Usage
}

/** Rough token estimate (4 bytes per token); good enough for usage fields and `count_tokens`. */
export const estimateTokens = (s: string): number => Math.max(1, Math.ceil(Buffer.byteLength(s) / 4))

/** The full `message` object for a reply. `seq` makes the message and tool-use ids unique per request. */
export function toMessage(reply: MessageReply, seq: number, requestModel: string, inputTokens: number): Message {
  const content: ContentBlock[] = reply.content.map((b, i) =>
    b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: b.id ?? `toolu_mock_${seq}_${i}`, name: b.name, input: b.input },
  )
  const stop = reply.stopReason ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn')
  return {
    id: `msg_mock_${seq}`,
    type: 'message',
    role: 'assistant',
    model: reply.model ?? requestModel,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: estimateTokens(JSON.stringify(content)), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }
}

export interface SseEvent {
  event: string
  data: Record<string, unknown>
}

// Text is streamed in deltas of this many characters so clients see a real multi-delta stream.
const TEXT_DELTA_CHARS = 48

function chunks(s: string, n: number): string[] {
  const cps = Array.from(s) // split on code points, never inside a surrogate pair
  const out: string[] = []
  for (let i = 0; i < cps.length; i += n) out.push(cps.slice(i, i + n).join(''))
  return out.length ? out : ['']
}

/** The streaming event sequence: message_start, ping, per block start/delta…/stop, message_delta, message_stop. */
export function toSseEvents(m: Message): SseEvent[] {
  const ev: SseEvent[] = [
    { event: 'message_start', data: { type: 'message_start', message: { ...m, content: [], stop_reason: null, usage: { ...m.usage, output_tokens: 1 } } } },
    { event: 'ping', data: { type: 'ping' } },
  ]
  m.content.forEach((b, index) => {
    if (b.type === 'text') {
      ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } })
      for (const t of chunks(b.text, TEXT_DELTA_CHARS)) {
        ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } } })
      }
    } else {
      ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } } })
      const json = Array.from(JSON.stringify(b.input))
      const half = Math.ceil(json.length / 2) // two partial_json deltas, split on a code point: clients concatenate them
      for (const part of [json.slice(0, half).join(''), json.slice(half).join('')]) {
        if (part) ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } } })
      }
    }
    ev.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } })
  })
  ev.push({
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: m.usage.output_tokens } },
  })
  ev.push({ event: 'message_stop', data: { type: 'message_stop' } })
  return ev
}

export const encodeSse = (events: SseEvent[]): string => events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')

/** The API's error body. */
export const errorBody = (type: string, message: string) => ({ type: 'error', error: { type, message } })
