// SIGTERM and SIGHUP sent to holders. While the child lives they are ignored — with the terminal at rest, during a
// flood and while keys are being typed — so the child, its output (with no gap) and its input are unaffected and
// ptyhost never sees an exit. Once the child is gone, the same signal ends the lingering holder. Every signal goes only
// to a holder this test started, after its pid, start time and name are checked against its state file
// (`signalHolder`).

import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { StreamToRenderer } from '@kea/protocol'
import { zooCommand } from '@kea-tools/process-zoo/src/index.ts'
import { holderAlive, holderChildAlive, ptyhostHarness, rawTty, signalHolder, until, type Harness } from '../support/holders.ts'
import { childArgv } from '../integration/ptyhost-child.ts'
import { TestRenderer } from '../integration/ptyhost-support.ts'

let h: Harness | null = null
afterEach(async () => {
  await h?.dispose()
  h = null
})

const SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP']
/** During the flood: rounds of both signals, each followed by this many more counter lines before the next. */
const FLOOD_ROUNDS = 3
const LINES_BETWEEN = 20_000
/** While typing: keystrokes sent without waiting for their echo, a signal after every SIGNAL_EVERY of them. */
const KEYS = 500
const SIGNAL_EVERY = 25
/** Counter problems kept for the failure message. */
const PROBLEMS_KEPT = 10

/**
 * Checks a `counter` stream as it arrives: each complete line one more than the line before (no gap and no duplicate).
 * The first line is skipped: the live stream starts where the attach snapshot was cut, which may be mid-line.
 */
class CounterWatch {
  lines = 0
  readonly problems: string[] = [] // bounded: PROBLEMS_KEPT
  private next: number | null = null
  private partial = ''
  private skipped = false
  private readonly dec = new TextDecoder()

  push(b: Uint8Array): void {
    const parts = (this.partial + this.dec.decode(b, { stream: true })).split('\n')
    this.partial = parts.pop()!
    for (const raw of parts) {
      if (!this.skipped) {
        this.skipped = true
        continue
      }
      const line = raw.replace(/\r/g, '')
      if (!/^\d+$/.test(line)) this.problem(`not a counter line: ${JSON.stringify(line.slice(0, 40))}`)
      else {
        const n = Number(line)
        if (this.next !== null && n !== this.next) this.problem(`expected ${this.next}, got ${n}`)
        this.next = n + 1
      }
      this.lines++
    }
  }

  private problem(p: string): void {
    if (this.problems.length < PROBLEMS_KEPT) this.problems.push(p)
  }
}

/** Every data chunk ptyhost sends the renderer, as text. */
function textSpy(): { text: () => string; onPtyhostSend: (m: StreamToRenderer) => void } {
  const dec = new TextDecoder()
  let text = ''
  return { text: () => text, onPtyhostSend: (m) => void (m.k === 'data' && (text += dec.decode(m.b, { stream: true }))) }
}

describe('SIGTERM and SIGHUP to a holder', () => {
  it('C-KILL-7 · at rest: both are ignored and the child keeps working; once the child has exited, SIGTERM ends the lingering holder', async () => {
    h = await ptyhostHarness()
    const harness = h
    const p = await harness.spawn({ argv: rawTty(['/bin/cat']) })
    const spy = textSpy()
    const r = new TestRenderer(harness.manager, p.ptyId, { onPtyhostSend: spy.onPtyhostSend })
    await until('the snapshot', () => r.snapshots === 1)
    for (const sig of SIGNALS) signalHolder(harness.home, p.ptyId, sig)
    // two round trips: the holder's loop has handled both signals by now
    await p.stat()
    await p.stat()
    expect(holderAlive(harness.home, p.ptyId)).toBe(true)
    expect(holderChildAlive(harness.home, p.ptyId)).toBe(true)
    expect(p.isRunning).toBe(true)
    r.input('still here\r')
    await until('the child to echo', () => spy.text().includes('still here'))

    // the child goes; the holder lingers for RELEASE and now the same signal ends it
    p.terminate(0)
    await until('the exit', () => !p.isRunning)
    expect(holderAlive(harness.home, p.ptyId)).toBe(true)
    signalHolder(harness.home, p.ptyId, 'SIGTERM')
    await until('the holder to end', () => !holderAlive(harness.home, p.ptyId))
    await until('ptyhost to let the PTY go', () => p.isDisposed)
    expect(fs.existsSync(p.meta.sock), 'the holder removed its socket').toBe(false)
    expect(harness.notes.filter((n) => n.m === 'pty.exit').map((n) => (n.a as { lost: boolean }).lost)).toEqual([false])
    r.close()
  })

  it(`C-KILL-7 · during a flood: ${FLOOD_ROUNDS} rounds of both while a counter streams as fast as it can; every line arrives once, in order, and the child keeps running`, async () => {
    h = await ptyhostHarness()
    const harness = h
    const counter = zooCommand('counter', ['--forever'])
    const p = await harness.spawn({ argv: [counter.file, ...counter.args] })
    const watch = new CounterWatch()
    const r = new TestRenderer(harness.manager, p.ptyId, {
      credit: 'instant', // never behind, so the stream has no skip-ahead snapshot: every byte is checked
      keepData: false,
      onPtyhostSend: (m) => m.k === 'data' && watch.push(m.b),
    })
    const more = async (what: string) => {
      const want = watch.lines + LINES_BETWEEN
      await until(what, () => watch.lines >= want || watch.problems.length > 0)
    }
    await more('the counter to stream')
    for (let round = 0; round < FLOOD_ROUNDS; round++) {
      for (const sig of SIGNALS) {
        signalHolder(harness.home, p.ptyId, sig)
        await more(`${LINES_BETWEEN} more lines after ${sig} (round ${round + 1})`)
      }
    }
    expect(watch.problems).toEqual([])
    expect(r.snapshots).toBe(1)
    expect(r.discontinuities).toEqual([])
    expect(holderAlive(harness.home, p.ptyId)).toBe(true)
    expect(holderChildAlive(harness.home, p.ptyId)).toBe(true)
    expect(p.isRunning).toBe(true)
    expect(harness.notes.filter((n) => n.m === 'pty.exit')).toEqual([])
    r.close()
  })

  it(`C-KILL-7 · while typing: ${KEYS} keystrokes in flight with a signal after every ${SIGNAL_EVERY}; every key is echoed, in order`, async () => {
    h = await ptyhostHarness()
    const harness = h
    const p = await harness.spawn({ argv: rawTty(childArgv('echo')) })
    const spy = textSpy()
    const r = new TestRenderer(harness.manager, p.ptyId, { onPtyhostSend: spy.onPtyhostSend })
    await until('the snapshot', () => r.snapshots === 1)
    let typed = ''
    for (let k = 0; k < KEYS; k++) {
      const key = String.fromCharCode(0x61 + (k % 26))
      r.input(key)
      typed += key
      if ((k + 1) % SIGNAL_EVERY === 0) signalHolder(harness.home, p.ptyId, SIGNALS[((k + 1) / SIGNAL_EVERY) % SIGNALS.length]!)
    }
    await until('every key to be echoed', () => spy.text().length >= typed.length)
    expect(spy.text()).toBe(typed)
    expect(holderAlive(harness.home, p.ptyId)).toBe(true)
    expect(holderChildAlive(harness.home, p.ptyId)).toBe(true)
    expect(p.isRunning).toBe(true)
    expect(harness.notes.filter((n) => n.m === 'pty.exit')).toEqual([])
    r.close()
  })
})
