import { describe, expect, it } from 'vitest'
import { encodeSse, type Message, text, toMessage, toolUse, toSseEvents } from './reply.ts'
import { firstUserTexts, isInjected, messagesOf, type RecordedRequest, systemText, toolNames } from './request.ts'

/** Rebuilds the content blocks a client assembles from the stream (text deltas and partial JSON concatenated). */
function assemble(events: ReturnType<typeof toSseEvents>): Array<{ type: string; text?: string; json?: string; name?: string; id?: string }> {
  const blocks: Array<{ type: string; text?: string; json?: string; name?: string; id?: string }> = []
  for (const { data } of events) {
    if (data['type'] === 'content_block_start') {
      const b = data['content_block'] as { type: string; name?: string; id?: string }
      blocks[data['index'] as number] = b.type === 'text' ? { type: 'text', text: '' } : { type: b.type, json: '', name: b.name!, id: b.id! }
    } else if (data['type'] === 'content_block_delta') {
      const d = data['delta'] as { type: string; text?: string; partial_json?: string }
      const b = blocks[data['index'] as number]!
      if (d.type === 'text_delta') b.text += d.text!
      else b.json += d.partial_json!
    }
  }
  return blocks
}

const recorded = (body: unknown): RecordedRequest => ({ seq: 1, mono: 0n, at: 0, method: 'POST', path: '/v1/messages', query: {}, headers: {}, body, answer: { kind: 'default' } })

describe('mock-model replies', () => {
  it('U-MOCK-1 · a text reply becomes a Messages API message: ids, echoed model, end_turn, usage', () => {
    const m = toMessage(text('hello'), 7, 'claude-opus-5', 12)
    expect(m).toMatchObject({ id: 'msg_mock_7', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', stop_sequence: null })
    expect(m.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(m.usage).toMatchObject({ input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
    expect(m.usage.output_tokens).toBeGreaterThan(0)
    expect(toMessage(text('x', { model: 'pinned', stopReason: 'max_tokens' }), 1, 'req', 1)).toMatchObject({ model: 'pinned', stop_reason: 'max_tokens' })
  })

  it('U-MOCK-2 · the stream is message_start, ping, block start/delta…/stop, message_delta, message_stop; deltas never split a code point', () => {
    const long = `${'a'.repeat(47)}👩‍💻 then 🇳🇿 and more text past the second chunk boundary ${'b'.repeat(60)}`
    const m = toMessage(text(long), 3, 'claude-opus-5', 5)
    const ev = toSseEvents(m)
    const names = ev.map((e) => e.event)
    expect(names.slice(0, 3)).toEqual(['message_start', 'ping', 'content_block_start'])
    expect(names.slice(-3)).toEqual(['content_block_stop', 'message_delta', 'message_stop'])
    expect(names.filter((n) => n === 'content_block_delta').length).toBeGreaterThan(1)
    const start = ev[0]!.data['message'] as Message
    expect(start).toMatchObject({ id: 'msg_mock_3', content: [], stop_reason: null })
    expect(ev.find((e) => e.event === 'message_delta')!.data).toMatchObject({ delta: { stop_reason: 'end_turn', stop_sequence: null } })
    for (const e of ev.filter((x) => x.event === 'content_block_delta')) {
      const t = (e.data['delta'] as { text: string }).text
      expect(t).toBe(Array.from(t).join('')) // well-formed: no lone surrogate
      expect(t).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
    }
    expect(assemble(ev)).toEqual([{ type: 'text', text: long }])
    // SSE framing: `event:` line, `data:` line with one JSON object, blank line.
    const wire = encodeSse(ev)
    expect(wire.startsWith('event: message_start\ndata: {"type":"message_start"')).toBe(true)
    expect(wire.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true)
    expect(wire.split('\n\n').filter(Boolean)).toHaveLength(ev.length)
  })

  it('U-MOCK-3 · a tool_use reply stops with tool_use; its partial JSON concatenates back to the input', () => {
    const input = { command: 'echo "kea" — 日本 🦜', description: 'Echo probe', nested: { n: 1, list: [true, null] } }
    const m = toMessage(toolUse('Bash', input, { before: 'Running it.' }), 9, 'claude-opus-5', 1)
    expect(m.stop_reason).toBe('tool_use')
    expect(m.content).toEqual([
      { type: 'text', text: 'Running it.' },
      { type: 'tool_use', id: 'toolu_mock_9_1', name: 'Bash', input },
    ])
    const blocks = assemble(toSseEvents(m))
    expect(blocks[0]).toEqual({ type: 'text', text: 'Running it.' })
    expect(blocks[1]).toMatchObject({ type: 'tool_use', id: 'toolu_mock_9_1', name: 'Bash' })
    expect(JSON.parse(blocks[1]!.json!)).toEqual(input)
    expect(toMessage(toolUse('Read', {}, { id: 'toolu_fixed' }), 1, 'm', 1).content[0]).toMatchObject({ id: 'toolu_fixed', input: {} })
  })

  it('U-MOCK-4 · firstUserTexts returns the typed prompt byte-exact and skips injected context blocks', () => {
    const prompt = '-x\nline "two" $(echo no) `id`\r\n  👩‍💻 \n'
    const body = {
      system: [{ type: 'text', text: 'You are Claude Code' }, { type: 'text', text: 'more' }],
      tools: [{ name: 'Bash' }, { name: 'Agent' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: '<system-reminder>\ncontext\n</system-reminder>' }, { type: 'text', text: prompt }] },
        { role: 'system', content: 'mid-conversation system text' },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      ],
    }
    const r = recorded(body)
    expect(firstUserTexts(r)).toEqual([prompt])
    expect(Buffer.from(firstUserTexts(r)[0]!).equals(Buffer.from(prompt))).toBe(true)
    expect(messagesOf(r).map((m) => m.role)).toEqual(['user', 'system', 'assistant'])
    expect(systemText(r)).toBe('You are Claude Code\nmore')
    expect(toolNames(r)).toEqual(['Bash', 'Agent'])
    expect(firstUserTexts(recorded({ messages: [{ role: 'user', content: 'plain string' }] }))).toEqual(['plain string'])
    expect(firstUserTexts(recorded('not json'))).toEqual([])
    expect(isInjected('  <system-reminder>x')).toBe(true)
    expect(isInjected('<command-name>/x</command-name>')).toBe(true)
    expect(isInjected('a <system-reminder> later')).toBe(false)
  })
})
