// stubborn: ignores SIGINT, SIGTERM and SIGHUP (reporting each), so only SIGKILL ends it, as a holder's
// terminate-after-grace and the dev server's INT → TERM → KILL escalation need. It also outlives its terminal.

import { appendFileSync } from 'node:fs'
import { intFlag, parseFlags, runMain, UsageError } from './cli.ts'

export const STUBBORN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2'] as const
export type StubbornSignal = (typeof STUBBORN_SIGNALS)[number]

export const STUBBORN_USAGE = `stubborn: ignores SIGINT, SIGTERM and SIGHUP so only SIGKILL ends it (tools/process-zoo/README.md)

usage: node tools/process-zoo/src/stubborn.ts [options]
  --ignore LIST      signals to ignore, comma-separated, from ${STUBBORN_SIGNALS.map((s) => s.slice(3)).join(', ')}
                     (default INT,TERM,HUP)
  --log FILE         also append the JSON lines to FILE (a PTY may be gone when the signal comes)
  --lifetime SEC     exit 0 after SEC seconds, a guard against leaked test processes; 0 = never (default 600)
  -h, --help         this text

Prints one JSON line when ready, {"stubborn":"ready","pid":…}, and one per signal it ignores,
{"stubborn":"signal","signal":"SIGTERM","pid":…,"ms":…} (ms since start).
`

export interface StubbornOptions {
  ignore: StubbornSignal[]
  log: string | null
  lifetimeSec: number
}

export function parseStubbornArgs(argv: readonly string[]): StubbornOptions {
  const p = parseFlags(argv, { '--ignore': 'value', '--log': 'value', '--lifetime': 'value' })
  const names = (p.values.get('--ignore') ?? 'INT,TERM,HUP').split(',').map((s) => s.trim().toUpperCase())
  const ignore = names.map((n) => {
    const sig = (n.startsWith('SIG') ? n : `SIG${n}`) as StubbornSignal
    if (!STUBBORN_SIGNALS.includes(sig)) throw new UsageError(`--ignore: unknown or uncatchable signal "${n}" (one of ${STUBBORN_SIGNALS.join(', ')})`)
    return sig
  })
  return { ignore: [...new Set(ignore)], log: p.values.get('--log') ?? null, lifetimeSec: intFlag(p, '--lifetime', 600, 0, 1_000_000) }
}

function main(argv: readonly string[]): void {
  const o = parseStubbornArgs(argv)
  const t0 = performance.now()
  process.stdout.on('error', () => {}) // the terminal went away: keep ignoring signals regardless
  const emit = (record: Record<string, unknown>) => {
    const line = `${JSON.stringify(record)}\n`
    // the log first: a test that saw the line on stdout may SIGKILL at once, and the log must already have it
    if (o.log) {
      try {
        appendFileSync(o.log, line)
      } catch {
        // a log that cannot be written changes nothing
      }
    }
    try {
      process.stdout.write(line)
    } catch {
      // no terminal
    }
  }
  for (const sig of o.ignore) process.on(sig, () => emit({ stubborn: 'signal', signal: sig, pid: process.pid, ms: Math.round((performance.now() - t0) * 10) / 10 }))
  // keeps the event loop alive; with a lifetime, exits after it
  if (o.lifetimeSec > 0) setTimeout(() => process.exit(0), o.lifetimeSec * 1000)
  else setInterval(() => {}, 1 << 30)
  emit({ stubborn: 'ready', pid: process.pid, ppid: process.ppid, ignoring: o.ignore })
}

if (import.meta.main) runMain(STUBBORN_USAGE, process.argv.slice(2), main)
