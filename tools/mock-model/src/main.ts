// `node tools/mock-model/src/main.ts`: run the mock model endpoint until SIGINT/SIGTERM.
//
//   --port <n>            listen port (default: any free port)
//   --script <file.json>  { "default"?: Reply | string, "replies"?: ScriptedReply[] } (README: Script file)
//   --text <s>            default reply text (default "ok")
//   --log <file.jsonl>    append every recorded request as one JSON line
//   --quiet               no per-request line on stderr
//
// Prints `MOCK_MODEL_URL=http://127.0.0.1:<port>` on stdout once listening. Control API for harnesses in other
// processes: GET /__mock/requests, POST /__mock/replies (JSON array), POST /__mock/reset.
import { appendFileSync, readFileSync } from 'node:fs'
import { type Reply, text } from './reply.ts'
import { toJson } from './request.ts'
import { type ScriptedReply, startMockModel } from './server.ts'

const usage = 'usage: node tools/mock-model/src/main.ts [--port <n>] [--script <file.json>] [--text <s>] [--log <file.jsonl>] [--quiet]'
const args = process.argv.slice(2)
const opt: { port?: number; script?: string; text?: string; log?: string; quiet: boolean } = { quiet: false }
for (let i = 0; i < args.length; i++) {
  const a = args[i]!
  const v = () => {
    const x = args[++i]
    if (x === undefined) fail(`${a} needs a value`)
    return x
  }
  if (a === '--port') opt.port = Number(v())
  else if (a === '--script') opt.script = v()
  else if (a === '--text') opt.text = v()
  else if (a === '--log') opt.log = v()
  else if (a === '--quiet') opt.quiet = true
  else fail(`unknown argument ${a}`)
}

function fail(msg: string): never {
  console.error(`mock-model: ${msg}\n${usage}`)
  process.exit(2)
}

let replies: ScriptedReply[] = []
let defaultReply: Reply = text(opt.text ?? 'ok')
if (opt.script) {
  const s = JSON.parse(readFileSync(opt.script, 'utf8')) as { default?: Reply | string; replies?: ScriptedReply[] }
  if (typeof s.default === 'string') defaultReply = text(s.default)
  else if (s.default) defaultReply = s.default
  replies = s.replies ?? []
}

const mock = await startMockModel({
  replies,
  defaultReply,
  ...(opt.port === undefined ? {} : { port: opt.port }),
  onRequest(r) {
    if (opt.log) appendFileSync(opt.log, JSON.stringify(toJson(r)) + '\n')
    if (!opt.quiet) {
      const body = (r.body ?? {}) as Record<string, unknown>
      const model = typeof body['model'] === 'string' ? ` model=${body['model']}` : ''
      const how = r.answer.kind === 'scripted' ? `scripted#${r.answer.index}` : r.answer.kind === 'unknown' ? `unknown(${r.answer.status})` : r.answer.kind
      const q = Object.keys(r.query).length ? `?${new URLSearchParams(r.query)}` : ''
      console.error(`mock-model #${r.seq} ${r.method} ${r.path}${q}${model}${body['stream'] === true ? ' stream' : ''} → ${how}`)
    }
  },
})
console.log(`MOCK_MODEL_URL=${mock.url}`)
const stop = () => void mock.close().then(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
