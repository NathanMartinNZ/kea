// winch: counts the resizes its terminal sees (SIGWINCH), for the resize-drag budget's `max_resizes_per_s` (P-TERM-9).
// Run in a test shell as `node winch.ts [tag] [windowMs]`: it prints `WINCH-READY <tag>` once it counts, counts every
// SIGWINCH with its time, and on a line `q` prints one summary line and exits:
//
//   WINCH <tag> n=<resizes> max1s=<most in any 1 000 ms> maxWin=<most in any windowMs> minGap=<ms> span=<ms first → last> size=<cols>x<rows>
//
// `windowMs` (default 1 000) is the window the test judges by: one second less the delivery jitter it allows
// (stats.ts `maxInWindow`; tests/perf/app-terminal.test.ts P-TERM-9).

import { maxInWindow } from '../stats.ts'

const tag = process.argv[2] ?? '-'
const windowMs = Number(process.argv[3] ?? 1000)
const times: number[] = []
process.on('SIGWINCH', () => times.push(performance.now()))

process.stdout.write(`WINCH-READY ${tag}\n`)
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (d: string) => {
  buf += d
  if (!/^q\s*$/m.test(buf)) return
  const span = times.length > 1 ? Math.round((times.at(-1) as number) - (times[0] as number)) : 0
  let minGap = Infinity
  for (let i = 1; i < times.length; i++) minGap = Math.min(minGap, (times[i] as number) - (times[i - 1] as number))
  process.stdout.write(`WINCH ${tag} n=${times.length} max1s=${maxInWindow(times, 1000)} maxWin=${maxInWindow(times, windowMs)} minGap=${Number.isFinite(minGap) ? Math.round(minGap) : -1} span=${span} size=${process.stdout.columns}x${process.stdout.rows}\n`)
  process.exit(0)
})
