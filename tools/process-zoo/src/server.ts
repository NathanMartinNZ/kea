// server: a stand-in dev server. It listens on loopback only, on `--port` or `$PORT`, prints its URL the way a dev
// server does (optionally coloured, like Vite's), answers every HTTP request with one line, and exits 0 on SIGINT or
// SIGTERM. `--exit CODE` makes it the server that exits at once.

import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { intFlag, parseFlags, runMain, UsageError } from './cli.ts'

export const SERVER_ANNOUNCE = ['url', 'listening', 'none'] as const
export type ServerAnnounce = (typeof SERVER_ANNOUNCE)[number]

const MAX_PORT = 65535
const LOOPBACK = '127.0.0.1'

export const SERVER_USAGE = `server: a stand-in dev server on 127.0.0.1 (tools/process-zoo/README.md)

usage: node tools/process-zoo/src/server.ts [options]
  --port N           the port to listen on (default: $PORT); 0: one the system picks
  --announce HOW     what it prints once listening: url (default; "  ➜  Local:   http://localhost:N/"),
                     listening ("Server listening on port N", no URL), none
  --print-host HOST  the host in the printed URL (default localhost; 0.0.0.0, 127.0.0.1, [::1])
  --color            print the URL as Vite does: coloured, the port in bold
  --delay MS         wait MS before listening (default 0)
  --exit CODE        do not listen: print "exiting CODE" and exit with CODE (after --delay)
  --exit-after MS    once listening, exit with --exit-code after MS
  --exit-code CODE   the code for --exit-after and for a failed listen (default 1)
  --log FILE         also append the JSON lines to FILE
  --lifetime SEC     exit 0 after SEC seconds, a guard against leaked test processes; 0 = never (default 600)
  -h, --help         this text

Prints "PORT=<$PORT or empty>" first, then JSON lines: {"server":"ready","pid":…,"port":N} once listening,
{"server":"signal","signal":"SIGINT"} before it exits 0 on SIGINT or SIGTERM. A port in use prints Node's own error
("Error: listen EADDRINUSE: address already in use 127.0.0.1:N") and exits with --exit-code.
Every request is answered "ok <pid> <port> PORT=<$PORT> FORCE_COLOR=<$FORCE_COLOR>".
`

export interface ServerOptions {
  port: number | null
  announce: ServerAnnounce
  printHost: string
  color: boolean
  delayMs: number
  exit: number | null
  exitAfterMs: number | null
  exitCode: number
  log: string | null
  lifetimeSec: number
}

const HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]']

export function parseServerArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): ServerOptions {
  const p = parseFlags(argv, {
    '--port': 'value',
    '--announce': 'value',
    '--print-host': 'value',
    '--color': 'bool',
    '--delay': 'value',
    '--exit': 'value',
    '--exit-after': 'value',
    '--exit-code': 'value',
    '--log': 'value',
    '--lifetime': 'value',
  })
  const announce = (p.values.get('--announce') ?? 'url') as ServerAnnounce
  if (!SERVER_ANNOUNCE.includes(announce)) throw new UsageError(`--announce must be one of ${SERVER_ANNOUNCE.join(', ')}, got "${announce}"`)
  const printHost = p.values.get('--print-host') ?? 'localhost'
  if (!HOSTS.includes(printHost)) throw new UsageError(`--print-host must be one of ${HOSTS.join(', ')}, got "${printHost}"`)
  const exit = p.values.has('--exit') ? intFlag(p, '--exit', 0, 0, 255) : null
  let port: number | null = p.values.has('--port') ? intFlag(p, '--port', 0, 0, MAX_PORT) : null
  if (port === null && exit === null) {
    const fromEnv = env.PORT
    if (!fromEnv || !/^\d+$/.test(fromEnv) || Number(fromEnv) < 1 || Number(fromEnv) > MAX_PORT) throw new UsageError(`no port: give --port, or set PORT (got "${fromEnv ?? ''}")`)
    port = Number(fromEnv)
  }
  return {
    port,
    announce,
    printHost,
    color: p.bools.has('--color'),
    delayMs: intFlag(p, '--delay', 0, 0, 600_000),
    exit,
    exitAfterMs: p.values.has('--exit-after') ? intFlag(p, '--exit-after', 0, 0, 600_000) : null,
    exitCode: intFlag(p, '--exit-code', 1, 0, 255),
    log: p.values.get('--log') ?? null,
    lifetimeSec: intFlag(p, '--lifetime', 600, 0, 1_000_000),
  }
}

/** The line a listening server prints, which Kea reads the URL from: Vite's, with its colours when asked. */
export function announceLine(o: Pick<ServerOptions, 'announce' | 'printHost' | 'color'>, port: number): string {
  if (o.announce === 'none') return ''
  if (o.announce === 'listening') return `Server listening on port ${port}\n`
  if (!o.color) return `  ➜  Local:   http://${o.printHost}:${port}/\n`
  return `  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://${o.printHost}:\x1b[1m${port}\x1b[22m/\x1b[39m\n`
}

function main(argv: readonly string[]): void {
  const o = parseServerArgs(argv)
  process.stdout.on('error', () => {}) // the terminal went away
  const say = (text: string) => {
    try {
      process.stdout.write(text)
    } catch {
      // no terminal
    }
  }
  const emit = (record: Record<string, unknown>) => {
    const line = `${JSON.stringify(record)}\n`
    if (o.log) {
      try {
        appendFileSync(o.log, line) // the log first: whoever saw the line may kill at once
      } catch {
        // a log that cannot be written changes nothing
      }
    }
    say(line)
  }
  say(`PORT=${process.env.PORT ?? ''}\n`)
  if (o.lifetimeSec > 0) setTimeout(() => process.exit(0), o.lifetimeSec * 1000).unref()
  const start = () => {
    if (o.exit !== null) {
      say(`exiting ${o.exit}\n`)
      process.exit(o.exit)
    }
    let port = o.port as number
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' })
      res.end(`ok ${process.pid} ${port} PORT=${process.env.PORT ?? ''} FORCE_COLOR=${process.env.FORCE_COLOR ?? ''}\n`)
    })
    server.on('error', (e) => {
      say(`${String(e)}\n`)
      process.exit(o.exitCode)
    })
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => {
        emit({ server: 'signal', signal: sig })
        server.close()
        process.exit(0)
      })
    }
    server.listen(port, LOOPBACK, () => {
      const at = server.address()
      if (at && typeof at === 'object') port = at.port
      emit({ server: 'ready', pid: process.pid, port })
      say(announceLine(o, port))
      if (o.exitAfterMs !== null) setTimeout(() => process.exit(o.exitCode), o.exitAfterMs)
    })
  }
  if (o.delayMs > 0) setTimeout(start, o.delayMs)
  else start()
}

if (import.meta.main) runMain(SERVER_USAGE, process.argv.slice(2), main)
