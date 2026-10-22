// agent-loop: a stand-in for a working Claude Code session, run in a test shell by the perf tests, the GPU memory run
// included (tests/perf/app-gpu-soak.ts): recorded Claude Code cassettes (fixtures/cassettes) replayed at 1× in a loop,
// optionally with a truecolor shimmer phase after each one, and optionally switched on and off on a shared clock or in
// bursts.
//
//   node tools/perf/src/workloads/agent-loop.ts --cast <file.cast> [--cast …] [options]
//     --max-idle-ms N      cap every pause of a recording at N ms (default 1500)
//     --shimmer-ms N       after each cassette, N ms of truecolor shimmer (default 0: none)
//     --shimmer-fps N      shimmer frames per second (default 30, Claude Code's spinner rate)
//     --duty-on-ms N --duty-off-ms M --epoch T
//                          output only while (now − T) mod (N + M) < N (T: ms since the epoch, shared by several
//                          terminals so they switch together); paused output resumes where it stopped
//     --gap-ms N           after each cassette (and shimmer), N ms of silence (a burst every N ms: an idle mirror parks
//                          after its idle time, and the next burst unparks it)
//     --delay-ms N         silence before the first cassette (staggers bursts across terminals)
//
// The shimmer is tests/support/shimmer.ts's unbounded one: every frame's colours are new, so every frame adds glyphs to
// the WebGL atlas, which @xterm/addon-webgl grows with per-cell truecolor (xtermjs/xterm.js#6074). That is the
// worst case the atlas guard must keep in check; the recorded cassettes' own spinner uses a handful of
// colours. The terminal is in raw mode, input is read and dropped (a cassette turns on focus and mouse reports); ⌃C
// exits.

import fs from 'node:fs'
import { castSchedule, parseCast } from '../../../fake-agent/src/cassette.ts'

const argv = process.argv.slice(2)
const casts: string[] = []
const num = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = Number(argv[i + 1])
  if (!Number.isFinite(v) || v < 0) usage(`--${name} needs a number ≥ 0`)
  return v
}
function usage(msg: string): never {
  process.stderr.write(`agent-loop: ${msg}\nusage: agent-loop.ts --cast <file> [--cast …] [--max-idle-ms N] [--shimmer-ms N] [--shimmer-fps N] [--duty-on-ms N --duty-off-ms M --epoch T] [--gap-ms N] [--delay-ms N]\n`)
  process.exit(2)
}
for (let i = 0; i < argv.length; i++) if (argv[i] === '--cast') casts.push(argv[++i] ?? usage('--cast needs a file'))
if (casts.length === 0) usage('at least one --cast')
const MAX_IDLE = num('max-idle-ms', 1500)
const SHIMMER_MS = num('shimmer-ms', 0)
const SHIMMER_FPS = num('shimmer-fps', 30) || 30
const ON = num('duty-on-ms', 0)
const OFF = num('duty-off-ms', 0)
const EPOCH = num('epoch', 0)
const GAP = num('gap-ms', 0)
const DELAY = num('delay-ms', 0)

const schedules = casts.map((f) => {
  const { header, events } = parseCast(fs.readFileSync(f, 'utf8'), f)
  return castSchedule(events, { speed: 1, maxIdleMs: MAX_IDLE, header })
})

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)))
const out = (s: string) => new Promise<void>((r) => (process.stdout.write(s) ? r() : process.stdout.once('drain', r)))

/** Resolves at once in an "on" phase, else when the next one starts. */
async function on(): Promise<void> {
  if (!(ON > 0 && OFF > 0)) return
  const period = ON + OFF
  const at = (((Date.now() - EPOCH) % period) + period) % period
  if (at >= ON) await sleep(period - at)
}

/** Waits until `ms` after `start` (absolute, so the replay does not drift), counting only "on" time. */
async function until(start: number, ms: number): Promise<number> {
  const due = start + ms
  if (Date.now() < due) await sleep(due - Date.now())
  const before = Date.now()
  await on()
  return start + (Date.now() - before) // a pause in an off phase shifts the rest of the schedule
}

async function replay(i: number): Promise<void> {
  let start = Date.now()
  for (const e of schedules[i % schedules.length]!) {
    start = await until(start, e.atMs)
    await out(e.data)
  }
}

/** HSL (h in turns) to RGB bytes (tests/support/shimmer.ts). */
function rgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [f(0), f(8), f(4)]
}

const TEXT = 'Shimmering through the glyph atlas while the guard watches'
let frame = 0
async function shimmer(ms: number): Promise<void> {
  await out('\r\n\x1b[?25l')
  const period = 1000 / SHIMMER_FPS
  let start = Date.now()
  for (let n = 0; n * period < ms; n++) {
    start = await until(start, n * period)
    const t = frame++
    let line = '\r'
    for (let i = 0; i < TEXT.length; i++) {
      const [r, g, b] = rgb((t * 0.0037 + i * 0.013) % 1, 0.7, 0.45 + 0.2 * Math.sin(t * 0.00071 + i * 0.05))
      line += `\x1b[38;2;${r};${g};${b}m${TEXT[i]}`
    }
    await out(`${line}\x1b[0m`)
  }
  await out('\x1b[0m\x1b[?25h\r\n')
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
  process.stdin.on('data', (d: Buffer) => {
    if (d.includes(3)) process.exit(130) // ⌃C
  })
}
process.on('exit', () => {
  if (process.stdout.isTTY) process.stdout.write('\x1b[0m\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l')
})

await sleep(DELAY)
for (let i = 0; ; i++) {
  await on()
  await replay(i)
  if (SHIMMER_MS > 0) await shimmer(SHIMMER_MS)
  if (GAP > 0) await sleep(GAP)
}
