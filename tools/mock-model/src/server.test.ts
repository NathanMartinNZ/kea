import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiError, text, toolUse } from './reply.ts'
import { toJson } from './request.ts'
import { type MockModel, type MockModelOptions, startMockModel } from './server.ts'

const open: MockModel[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(open.splice(0).map((m) => m.close()))
})
async function mock(opts: MockModelOptions = {}): Promise<MockModel> {
  const m = await startMockModel(opts)
  open.push(m)
  return m
}

/** The shape of a Claude Code agent-loop request: it offers tools. Side queries (titles) offer none. */
const loopBody = (prompt: string, extra: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5',
  max_tokens: 64000,
  system: [{ type: 'text', text: 'You are Claude Code, main loop' }],
  tools: [{ name: 'Bash', input_schema: {} }, { name: 'Agent', input_schema: {} }],
  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  ...extra,
})
const sideBody = (prompt: string) => ({ model: 'claude-haiku-4-5', max_tokens: 512, messages: [{ role: 'user', content: prompt }] })

async function post(m: MockModel, body: unknown, init: { path?: string; headers?: Record<string, string>; raw?: Buffer } = {}) {
  return fetch(`${m.url}${init.path ?? '/v1/messages?beta=true'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test-dummy', authorization: 'Bearer secret', ...init.headers },
    body: init.raw ? new Uint8Array(init.raw) : JSON.stringify(body),
  })
}

function parseSse(s: string): Array<{ event: string; data: Record<string, unknown> }> {
  return s
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const [ev, data] = frame.split('\n')
      return { event: ev!.replace(/^event: /, ''), data: JSON.parse(data!.replace(/^data: /, '')) as Record<string, unknown> }
    })
}

describe('mock-model server', () => {
  it('U-MOCK-5 · POST /v1/messages answers JSON, or SSE when stream is true; the URL is a loopback ANTHROPIC_BASE_URL', async () => {
    const m = await mock({ defaultReply: text('canned') })
    expect(m.url).toBe(`http://127.0.0.1:${m.port}`)
    const plain = await post(m, loopBody('hi'))
    expect(plain.status).toBe(200)
    expect(plain.headers.get('request-id')).toBe('req_mock_1')
    expect(await plain.json()).toMatchObject({ type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'canned' }], stop_reason: 'end_turn' })
    const streamed = await post(m, loopBody('hi', { stream: true }))
    expect(streamed.headers.get('content-type')).toMatch(/^text\/event-stream/)
    const ev = parseSse(await streamed.text())
    expect(ev.map((e) => e.event)).toEqual(['message_start', 'ping', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    expect(ev[3]!.data).toMatchObject({ delta: { type: 'text_delta', text: 'canned' } })
  })

  it('U-MOCK-6 · records method, path, query, headers without credentials and the JSON body (also gzip-encoded), in arrival order', async () => {
    const m = await mock()
    const prompt = '-x\n"quoted" $(no) 👍🏽'
    await post(m, loopBody(prompt), { headers: { 'x-claude-code-session-id': 'sid-1', cookie: 'c=1' } })
    await post(m, undefined, { raw: gzipSync(JSON.stringify(sideBody('gz'))), headers: { 'content-encoding': 'gzip' } })
    await fetch(`${m.url}/v1/models`)
    expect(m.requests.map((r) => [r.seq, r.method, r.path])).toEqual([
      [1, 'POST', '/v1/messages'],
      [2, 'POST', '/v1/messages'],
      [3, 'GET', '/v1/models'],
    ])
    const [first, second] = m.requests
    expect(first!.query).toEqual({ beta: 'true' })
    expect(first!.headers['x-claude-code-session-id']).toBe('sid-1')
    for (const h of ['x-api-key', 'authorization', 'cookie']) expect(first!.headers).not.toHaveProperty(h)
    expect(JSON.stringify(m.requests.map(toJson))).not.toContain('secret')
    expect((first!.body as ReturnType<typeof loopBody>).messages[0]!.content[0]!.text).toBe(prompt)
    expect(second!.body).toEqual(sideBody('gz'))
    expect(first!.mono < second!.mono).toBe(true)
  })

  it('U-MOCK-7 · scripted replies answer agent-loop requests in order; side queries and unmatched requests get the default', async () => {
    const m = await mock({
      defaultReply: text('default'),
      replies: [
        toolUse('Bash', { command: 'echo 1' }),
        { ...text('sub done'), when: { lastUser: 'SUBTASK' } },
        { ...text('by fn'), when: (r) => r.headers['x-probe'] === 'yes' },
        text('main done'),
      ],
    })
    expect(m.pending()).toBe(4)
    const reply = async (body: unknown, headers: Record<string, string> = {}) => ((await (await post(m, body, { headers })).json()) as { content: Array<Record<string, unknown>> }).content[0]
    expect(await reply(sideBody('title please'))).toEqual({ type: 'text', text: 'default' }) // no tools: not the agent loop
    expect(await reply(loopBody('go'))).toMatchObject({ type: 'tool_use', name: 'Bash', input: { command: 'echo 1' } })
    expect(await reply(loopBody('SUBTASK: list files'))).toEqual({ type: 'text', text: 'sub done' }) // skips ahead to its matcher
    expect(await reply(loopBody('go'), { 'x-probe': 'yes' })).toEqual({ type: 'text', text: 'by fn' })
    expect(await reply(loopBody('go'))).toEqual({ type: 'text', text: 'main done' })
    expect(await reply(loopBody('go'))).toEqual({ type: 'text', text: 'default' })
    expect(m.requests.map((r) => r.answer)).toEqual([
      { kind: 'default' },
      { kind: 'scripted', index: 0 },
      { kind: 'scripted', index: 1 },
      { kind: 'scripted', index: 2 },
      { kind: 'scripted', index: 3 },
      { kind: 'default' },
    ])
    // firstUser follows a subagent past its first request: its last user message is then a tool result.
    m.enqueue({ ...text('sub follow-up'), when: { firstUser: 'SUBTASK' } })
    const followUp = loopBody('SUBTASK: list files')
    followUp.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } as never, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } as never)
    expect(await reply(loopBody('go'))).toEqual({ type: 'text', text: 'default' })
    expect(await reply(followUp)).toEqual({ type: 'text', text: 'sub follow-up' })
    m.enqueue({ ...text('haiku only'), when: { model: 'haiku', noTools: true } })
    expect(await reply(loopBody('go'))).toEqual({ type: 'text', text: 'default' })
    expect(await reply(sideBody('t'))).toEqual({ type: 'text', text: 'haiku only' })
    expect(m.pending()).toBe(0)
  })

  it('U-MOCK-8 · error replies use the API error shape and headers; a delayed reply is recorded before it is answered', async () => {
    const m = await mock({ replies: [apiError(429, 'rate_limit_error', 'slow down', { 'x-should-retry': 'false' }), { ...text('late'), delayMs: 300 }] })
    const err = await post(m, loopBody('a'))
    expect(err.status).toBe(429)
    expect(err.headers.get('x-should-retry')).toBe('false')
    expect(await err.json()).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })
    let answered = false
    const pending = post(m, loopBody('b')).then(async (r) => {
      answered = true
      return r.json()
    })
    const seen = await m.waitFor({ lastUser: 'b' })
    expect(seen.answer).toEqual({ kind: 'scripted', index: 1 })
    expect(answered).toBe(false)
    expect(await pending).toMatchObject({ content: [{ type: 'text', text: 'late' }] })
  })

  it('U-MOCK-9 · count_tokens, model listing and unknown paths answer sensibly and are recorded', async () => {
    const m = await mock({ models: ['claude-a', 'claude-b'] })
    const ct = await post(m, loopBody('count me'), { path: '/v1/messages/count_tokens?beta=true' })
    expect(((await ct.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(0)
    expect(await (await fetch(`${m.url}/v1/models`)).json()).toMatchObject({ data: [{ id: 'claude-a', type: 'model' }, { id: 'claude-b' }], has_more: false, first_id: 'claude-a', last_id: 'claude-b' })
    expect(await (await fetch(`${m.url}/v1/models/claude-x`)).json()).toMatchObject({ id: 'claude-x', type: 'model' })
    const unknown = await fetch(`${m.url}/api/hello`)
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ type: 'error', error: { type: 'not_found_error' } })
    expect(m.requests.map((r) => r.answer.kind)).toEqual(['count_tokens', 'models', 'models', 'unknown'])
    expect(m.requests[3]!.answer).toEqual({ kind: 'unknown', status: 404 })
  })

  it('U-MOCK-10 · waitFor resolves on past and future matches and times out; close rejects waiters and drops held replies', async () => {
    const m = await mock({ replies: [{ ...text('held'), delayMs: 60_000 }] })
    await post(m, sideBody('early'))
    expect((await m.waitFor({ lastUser: 'early' })).seq).toBe(1)
    const future = m.waitFor({ lastUser: 'later' })
    await post(m, sideBody('later'))
    expect((await future).seq).toBe(2)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timedOut = m.waitFor({ lastUser: 'never' }, 1000)
    vi.advanceTimersByTime(1000)
    await expect(timedOut).rejects.toThrow(/no matching request within 1000 ms/)
    vi.useRealTimers()

    const orphan = m.waitFor({ lastUser: 'never' })
    const held = post(m, loopBody('held')).then(
      () => 'answered',
      () => 'dropped',
    )
    await m.waitFor({ lastUser: 'held' })
    await m.close()
    await expect(orphan).rejects.toThrow(/closed/)
    expect(await held).toBe('dropped')
  })

  it('U-MOCK-11 · the record is bounded by maxRecorded (oldest dropped and counted); reset forgets requests and replies', async () => {
    const m = await mock({ maxRecorded: 2, replies: [text('a'), text('b')] })
    for (const p of ['1', '2', '3']) await post(m, sideBody(p))
    expect(m.requests.map((r) => r.seq)).toEqual([2, 3])
    expect(m.dropped()).toBe(1)
    m.reset()
    expect([m.requests.length, m.dropped(), m.pending()]).toEqual([0, 0, 0])
  })
})
