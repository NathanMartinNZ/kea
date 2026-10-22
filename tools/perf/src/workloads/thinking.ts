// thinking: Claude Code "thinking" while the person types, for the keystroke echo budget during the thinking animation
// (P-TERM-3: the cassette replayed at 1× in the same terminal). Run in a test shell:
//
//   node tools/perf/src/workloads/thinking.ts <file.cast>
//
// It draws the recorded session up to its first spinner frame (the banner and the prompt box, on the alternate screen),
// then loops the recorded thinking animation at its recorded pace: the spinner and shimmer frames (synchronized
// updates, truecolor) and the title spinner. Typed keys are echoed the way the recording shows Claude Code echo them:
// one synchronized update writing the character in the prompt box, its block cursor after it, and the real cursor
// parked just after the character; every animation frame parks the cursor there too, as Claude Code's do. So the
// character before the cursor is always the last one typed (what the echo probe, app/renderer/src/lib/perf.ts, reads).
// Enter clears the prompt line; ⌃C restores the terminal and exits. Escape sequences on the input (the terminal's
// answers to the recording's queries, focus and mouse reports) are parsed and dropped whole: echoed as text, their
// printable bytes would push the typed line past the right edge of a narrower terminal, where no typed key shows.

import fs from 'node:fs'
import { parseCast } from '../../../fake-agent/src/cassette.ts'

const file = process.argv[2]
if (!file) {
  process.stderr.write('usage: thinking.ts <file.cast>\n')
  process.exit(2)
}
const { events } = parseCast(fs.readFileSync(file, 'utf8'), file)

const SYNC_START = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'
const SPINNER = /[·✢✳✶✻✽]/u
/** An animation frame: a small synchronized update in truecolor that ends by parking the cursor (CUP). */
const PARK = /\x1b\[(\d+);(\d+)H\x1b\[\?2026l$/
/** Larger updates in the thinking window are content (a tool call, the answer), not animation. */
const FRAME_MAX_BYTES = 200
const isFrame = (d: string) => d.startsWith(SYNC_START) && d.endsWith(SYNC_END) && d.length < FRAME_MAX_BYTES && d.includes('\x1b[38;2;') && PARK.test(d)
const isTitle = (d: string) => d.startsWith('\x1b]0;')

const first = events.findIndex((e) => isFrame(e.data) && SPINNER.test(e.data))
let last = -1
for (let i = events.length - 1; i >= 0; i--)
  if (isFrame(events[i]!.data) && SPINNER.test(events[i]!.data)) {
    last = i
    break
  }
if (first < 0) {
  process.stderr.write(`thinking: no spinner frames in ${file}\n`)
  process.exit(2)
}
const loop = events.slice(first, last + 1).filter((e) => isFrame(e.data) || isTitle(e.data))
const park = PARK.exec(loop.find((e) => isFrame(e.data))!.data)!
const ROW = Number(park[1])
const COL0 = Number(park[2])
/** Pauses between frames as recorded, but never longer than this (the gaps where content was drawn are skipped). */
const MAX_GAP_MS = 250
const gaps = loop.map((e, i) => (i === 0 ? 0 : Math.min(MAX_GAP_MS, (e.t - loop[i - 1]!.t) * 1000)))

let typed = 0
const cursor = () => `\x1b[${ROW};${COL0 + typed}H`
const write = (s: string) => process.stdout.write(s)

/** Where the input is inside an escape sequence: ESC seen, CSI, SS3, or a string (DCS, OSC, …) and its ESC. */
let seq: 'none' | 'esc' | 'csi' | 'ss3' | 'str' | 'str-esc' = 'none'
/** False while `b` belongs to an escape sequence (which may span several reads). */
function plain(b: number): boolean {
  switch (seq) {
    case 'none':
      if (b !== 0x1b) return true
      seq = 'esc'
      return false
    case 'esc':
      seq = b === 0x5b ? 'csi' : b === 0x4f ? 'ss3' : b === 0x50 || b === 0x5d || b === 0x58 || b === 0x5e || b === 0x5f ? 'str' : 'none'
      return false
    case 'csi':
      if (b >= 0x40 && b <= 0x7e) seq = 'none'
      return false
    case 'ss3':
      seq = 'none'
      return false
    case 'str':
      if (b === 0x07) seq = 'none'
      else if (b === 0x1b) seq = 'str-esc'
      return false
    case 'str-esc':
      seq = b === 0x5c ? 'none' : 'str'
      return false
  }
}

process.stdin.setRawMode(true)
process.stdin.on('data', (d: Buffer) => {
  for (const b of d) {
    if (!plain(b)) continue
    if (b === 3) {
      write('\x1b[0m\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l')
      process.exit(0)
    }
    if (b === 13) {
      typed = 0
      write(`${SYNC_START}${cursor()}\x1b[K\x1b[7m \x1b[27m${cursor()}${SYNC_END}`)
    } else if (b >= 0x20 && b < 0x7f) {
      write(`${SYNC_START}${cursor()}${String.fromCharCode(b)}\x1b[7m \x1b[27m\x1b[${ROW};${COL0 + typed + 1}H${SYNC_END}`)
      typed++
    }
    // any other control byte is dropped
  }
})

// the session as recorded up to its first spinner frame
write(events.slice(0, first).map((e) => e.data).join(''))
let start = Date.now()
let due = 0
for (let n = 0; ; n++) {
  const i = n % loop.length
  due += gaps[i]!
  const wait = start + due - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  const d = loop[i]!.data
  write(isFrame(d) ? d.replace(PARK, `${cursor()}${SYNC_END}`) : d)
  if (i === loop.length - 1) {
    start = Date.now()
    due = 0
  }
}
