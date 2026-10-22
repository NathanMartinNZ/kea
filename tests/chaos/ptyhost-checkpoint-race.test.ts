// Keystrokes racing checkpoints on twenty PTYs at once: a checkpoint never starts within the quiet period after a
// keystroke, is cut only at a ground-state seq, and restores to exactly the screen at its seq.

import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { checkpointStorm, referenceAt, restored } from '../integration/ptyhost-checkpoint-storm.ts'

let dispose: (() => Promise<void>) | null = null
afterEach(async () => {
  await dispose?.()
  dispose = null
})

const PTYS = 20
const ROUNDS = 4

describe('checkpoint races', () => {
  it(`C-RACE-6 · keystrokes to ${PTYS} PTYs while their checkpoints are due: none starts within the quiet period, each at a ground-state seq, each restores exactly`, async () => {
    const s = await checkpointStorm({ ptys: PTYS, rounds: ROUNDS, perRound: 25 })
    dispose = () => s.h.dispose()
    for (let r = 0; r < ROUNDS; r++) {
      await s.round(r)
      s.step(L.checkpointMaxAgeMs - L.checkpointQuietMs)
      // every PTY gets keys, landing just before, at and just after the moments checkpoints would run
      for (let k = 0; k < 3 * PTYS; k++) {
        s.type(s.ptys[(k * 7 + r) % PTYS]!)
        s.step(k % 3 === 0 ? L.checkpointMinIntervalMs : k % 3 === 1 ? L.checkpointQuietMs - 1 : L.checkpointQuietMs + 1)
      }
      s.step(L.checkpointQuietMs + PTYS * L.checkpointMinIntervalMs)
    }
    expect(s.writes.length).toBeGreaterThanOrEqual(PTYS * ROUNDS)
    for (const [i, w] of s.writes.entries()) {
      if (w.lastKey) expect(w.at - w.lastKey.at, `checkpoint ${i} (${w.ptyId}) after a keystroke to ${w.lastKey.ptyId}`).toBeGreaterThanOrEqual(L.checkpointQuietMs)
      const p = s.ptys.find((x) => x.pty.ptyId === w.ptyId)!
      expect(p.ground.has(w.c.seq), `checkpoint ${i} of ${w.ptyId} at ${w.c.seq}, not a frame boundary`).toBe(true)
      expect(await restored(w.c), `checkpoint ${i} of ${w.ptyId} restored`).toEqual(await referenceAt(p.out, w.c.seq, w.c.cols, w.c.rows))
    }
  })
})
