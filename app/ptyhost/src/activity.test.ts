import { L, type PtyhostNote } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { ActivityNotes, onlyTerminalReports } from './activity.ts'
import { ManualClock } from './test-support.ts'

const R = L.activityReportMs
const WALL0 = 1_790_000_000_000

function setup() {
  const clock = new ManualClock()
  const t0 = clock.now()
  const notes: PtyhostNote[] = []
  const a = new ActivityNotes('abcdefghij', { clock, wall: () => WALL0 + (clock.now() - t0), notify: (n) => notes.push(n) })
  /** Notes as [ms since t0, what]. */
  const seen = () =>
    notes.map((n) => {
      const at = (n.a as { at: number }).at - WALL0
      return n.m === 'pty.activity' ? [at, (n.a as { active: boolean }).active ? 'active' : 'quiet'] : [at, 'key']
    })
  /** Run `fn` at `ms` since t0 (time moves forward, timers fire on the way). */
  const at = (ms: number, fn: () => void = () => undefined) => {
    clock.advance(t0 + ms - clock.now())
    fn()
  }
  return { a, clock, seen, at }
}

describe('ptyhost activity notes', () => {
  it('U-PTY-63 · output flowing → one start note, quiet for L.activityReportMs → one stop note; a start sooner than that is held for the window; keystrokes coalesced to one note per window with the latest time; focus and mouse reports are not typing; no timer once nothing is due', () => {
    const { a, seen, at } = setup()
    // two seconds of output in 50 ms chunks: started at once, stopped one window after the last chunk
    for (let t = 0; t <= 2000; t += 50) at(t, () => a.output())
    at(2000 + 2 * R)
    expect(seen()).toEqual([
      [0, 'active'],
      [2000 + R, 'quiet'],
    ])
    expect(a.armed).toBe(false)
    // output again just after the stop note: held until a window has passed since it, then reported; its stop waits
    // for the next window too (the same notes adapters/kit's `activityNotes` derives from these output times)
    at(2000 + R + 10, () => a.output())
    at(2000 + 4 * R)
    expect(seen().slice(2)).toEqual([
      [2000 + 2 * R, 'active'],
      [2000 + 3 * R, 'quiet'],
    ])
    // whatever the pattern, notes are at least a window apart
    const times = seen().map(([t]) => t as number)
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(R)

    // typing every 40 ms for 400 ms: the first key at once, then one note at each window's end with the latest key's time
    const k0 = 5000
    for (let t = k0; t <= k0 + 400; t += 40) at(t, () => a.input('x'))
    at(k0 + 3 * R)
    const keys = seen().filter(([, w]) => w === 'key')
    // keys at k0, k0+40, …: noted at k0, then at k0+R the latest (k0+240), then at k0+2R the last one (k0+400)
    expect(keys.map(([t]) => t)).toEqual([k0, k0 + 240, k0 + 400])
    // what the terminal sends by itself is not typing
    expect(onlyTerminalReports('\x1b[I')).toBe(true)
    expect(onlyTerminalReports('\x1b[O\x1b[<35;10;4M\x1b[<0;1;1m')).toBe(true)
    expect(onlyTerminalReports(new Uint8Array([0x1b, 0x5b, 0x4d, 0x20, 0x21, 0x21]))).toBe(true)
    expect(onlyTerminalReports('\x1b[A')).toBe(false) // an arrow key is typing
    expect(onlyTerminalReports('y')).toBe(false)
    const before = seen().length
    at(k0 + 2000, () => a.input('\x1b[<35;12;7M'))
    at(k0 + 2000 + 2 * R)
    expect(seen().length, 'a mouse report notes nothing').toBe(before)
    expect(a.armed).toBe(false)
    a.dispose()
    a.output()
    expect(seen().length, 'nothing after dispose').toBe(before)
  })
})
