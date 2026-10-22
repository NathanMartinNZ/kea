// Checkpoints stay out of the way of typing and are cut only where they can be restored exactly: twenty PTYs
// fall due at once while the user types in the visible one.

import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { checkpointStorm } from './ptyhost-checkpoint-storm.ts'

let dispose: (() => Promise<void>) | null = null
afterEach(async () => {
  await dispose?.()
  dispose = null
})

const PTYS = 20
const ROUNDS = 3

/** Gaps between keystrokes: some inside L.checkpointQuietMs, some just past it, some long enough for a few runs. */
const GAPS = [L.checkpointMinIntervalMs, L.checkpointQuietMs / 2, L.checkpointQuietMs + L.checkpointMinIntervalMs, L.checkpointQuietMs - 1, 3 * L.checkpointQuietMs]

describe('checkpoints while typing', () => {
  it(`I-PTY-17 · checkpoints falling due on ${PTYS} PTYs while the user types in the visible one: none within the quiet period after a keystroke, never two within the minimum interval, each at a ground-state seq`, async () => {
    const s = await checkpointStorm({ ptys: PTYS, rounds: ROUNDS, perRound: 30 })
    dispose = () => s.h.dispose()
    const visible = s.ptys[0]!
    for (let r = 0; r < ROUNDS; r++) {
      await s.round(r)
      // every mirror is dirty; let the max age come due while the user types in irregular bursts
      s.step(L.checkpointMaxAgeMs - L.checkpointQuietMs)
      for (let k = 0; k < 4 * PTYS; k++) {
        s.type(visible)
        s.step(GAPS[k % GAPS.length]!)
      }
      s.step(L.checkpointQuietMs + PTYS * L.checkpointMinIntervalMs) // the user stops: the rest catch up
    }
    expect(s.writes.length).toBeGreaterThanOrEqual(PTYS * ROUNDS)
    for (const p of s.ptys) expect(s.writes.filter((w) => w.ptyId === p.pty.ptyId).length, p.pty.ptyId).toBeGreaterThanOrEqual(ROUNDS)
    for (const [i, w] of s.writes.entries()) {
      if (w.lastKey) expect(w.at - w.lastKey.at, `checkpoint ${i} after a keystroke`).toBeGreaterThanOrEqual(L.checkpointQuietMs)
      if (i > 0) expect(w.at - s.writes[i - 1]!.at, `checkpoint ${i} after the previous one`).toBeGreaterThanOrEqual(L.checkpointMinIntervalMs)
      const p = s.ptys.find((x) => x.pty.ptyId === w.ptyId)!
      expect(p.ground.has(w.c.seq), `checkpoint ${i} of ${w.ptyId} at ${w.c.seq}, not a frame boundary`).toBe(true)
    }
  })
})
