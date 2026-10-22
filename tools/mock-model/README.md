# tools/mock-model

A local stand-in for the Anthropic Messages API. Point the real `claude` binary at it with `ANTHROPIC_BASE_URL` and it
answers with canned replies, so argv and hook tests against the real CLI cost nothing and never reach the network. It
records every request so a test can check what Claude sent, for example the exact bytes of the first user message.

| Entry | What |
|---|---|
| `startMockModel({ replies, defaultReply, … })` | starts the server on `127.0.0.1:<free port>` and resolves `{ url, port, requests, enqueue, pending, waitFor, dropped, reset, close }`. `url` is the `ANTHROPIC_BASE_URL` value |
| `node tools/mock-model/src/main.ts` | the same as a process: `--port <n>`, `--script <file.json>`, `--text <s>` (default reply), `--log <file.jsonl>`, `--quiet`. Prints `MOCK_MODEL_URL=…` once listening; exits 0 on SIGINT/SIGTERM |
| `text(s)` · `toolUse(name, input, { before?, id? })` · `apiError(status, type, message?, headers?)` | reply builders. Any reply takes `delayMs`; a message reply takes `stopReason` and `model` |
| `firstUserTexts(r)` · `messagesOf` · `systemText` · `toolNames` · `isAgentLoop` · `matches` | read a recorded request. `firstUserTexts` drops injected blocks (`<system-reminder>…`), so for an argv prompt it is exactly the prompt |

**Routes.** `POST /v1/messages` (JSON, or the SSE sequence `message_start`, `ping`, then per block
`content_block_start` / `content_block_delta`… / `content_block_stop`, then `message_delta`, `message_stop` when
`stream: true`; text deltas never split a code point, tool input arrives as `input_json_delta` parts),
`POST /v1/messages/count_tokens`, `GET /v1/models[/<id>]`, `GET /` (200). Anything else gets a 404 in the API's error
shape and is recorded as `unknown`, and the CLI logs it on stderr. Query strings are ignored for routing: Claude Code
2.1.233 calls only `POST /v1/messages?beta=true` with `stream: true`.

**Recording.** Each request is recorded when its body has arrived, in arrival order: `seq`, `mono`
(`process.hrtime.bigint()`, the same clock as `clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)`, so it lines up with hook
stubs), `method`, `path`, `query`, `headers` (lower-case, without `authorization`, `x-api-key`, `cookie`,
`proxy-authorization`), `body` (parsed JSON after gzip/deflate/br/zstd decoding) and `answer`. The list keeps the last
`maxRecorded` (default 1000) requests and counts the rest in `dropped()`.

**Scripted replies.** `replies` is a queue. Each request takes the first queued reply whose `when` matches; unmatched
requests get `defaultReply` (default `text('ok')`). Without `when`, a reply matches an agent-loop request: one that
offers tools. Claude's side queries (session title, topic checks) offer none, so they never eat a scripted reply.
`when` is a function of the recorded request or a JSON-safe `Match`: `path`, `model` (substring), `tool` (offered),
`noTools`, `system` (substring), `lastUser` (substring of the last user message), `firstUser` (substring of the first
user message's typed text), `stream`. A subagent's requests are agent-loop requests too, and their first user message
is the subagent's prompt: tell them apart with `firstUser`, which keeps matching after the first tool result.

**Script file** (`--script`): `{ "default"?: Reply | string, "replies"?: ScriptedReply[] }`, where a reply is
`{ "content": [{ "type": "text", "text": "…" } | { "type": "tool_use", "name": "Bash", "input": {…} }], "when"?: Match }`
or `{ "error": { "status": 429, "type": "rate_limit_error" }, "headers"?: {…} }`.

**Control API** (CLI harnesses in other processes; not recorded): `GET /__mock/requests` (JSON, `mono` as a string),
`POST /__mock/replies` (a JSON array, appended to the queue), `POST /__mock/reset`.

**Running `claude` against it.** Always with a throwaway `HOME` and `CLAUDE_CONFIG_DIR` (both in a fresh `mkdtemp`),
`ANTHROPIC_BASE_URL=<url>`, `ANTHROPIC_API_KEY=sk-ant-test-dummy`, `DISABLE_TELEMETRY=1`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`, `DISABLE_ERROR_REPORTING=1`, in a repo-factory
repo, never in a real project. Seed `$CLAUDE_CONFIG_DIR/.claude.json` with `hasCompletedOnboarding: true` and the key's
last 20 characters in `customApiKeyResponses.approved`, or the TUI stops at onboarding and key-approval screens.

Tests: `reply.test.ts`, `server.test.ts`, `main.test.ts`: `npx vitest run --project unit tools/mock-model`. Node
builtins only.
