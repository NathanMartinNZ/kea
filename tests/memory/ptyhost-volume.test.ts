// A gigabyte through one attached PTY: ptyhost's mirror and the renderer keep bounded scrollback, so the heap stays
// flat; checkpoints come after L.checkpointRingFraction of a ring of output, each at a ground-state seq, never on a
// short timer.

import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import type { Checkpoint } from '../../app/ptyhost/src/checkpoint/store.ts'
import { ptyhostHarness, rawTty, until, type Harness } from '../support/holders.ts'
import { childArgv, FLOOD_READY, floodBlock } from '../integration/ptyhost-child.ts'
import { SIG, TestRenderer } from '../integration/ptyhost-support.ts'
import { heapUsed, leakCycles } from './ptyhost-leak.ts'

let h: Harness | null = null
afterEach(async () => {
  await h?.dispose()
  h = null
})

const GB = 1 << 30
const TOTAL = Number(process.env.KEA_L_PTY_3_BYTES ?? GB)
const CYCLES = 12
const block = floodBlock()
/** Each cycle pours whole blocks, so a seq's place in the output is its offset in the block. */
const PER_CYCLE = Math.max(1, Math.round(TOTAL / CYCLES / block.byteLength)) * block.byteLength

/** `seq` falls inside an escape sequence of the flood (between an ESC and its final byte). */
function insideEscape(seq: number): boolean {
  const pos = (seq - FLOOD_READY.length) % block.byteLength
  if (pos === 0) return false // between two blocks (and lastIndexOf would count a negative offset from the end)
  const esc = block.lastIndexOf(0x1b, pos - 1)
  if (esc < 0) return false
  const end = block.indexOf(0x6d /* m */, esc)
  return end >= pos
}

describe('a gigabyte through one PTY', () => {
  it(`L-PTY-3 · ${Math.round((PER_CYCLE * CYCLES) / (1 << 20))} MB through one attached PTY: heap flat, checkpoints after each L.checkpointRingFraction of a ring of output and at ground-state seqs, never on a short timer`, async () => {
    h = await ptyhostHarness()
    const harness = h
    const p = await harness.spawn({ argv: rawTty(childArgv('flood', [String(PER_CYCLE), '--each'])) })
    const writes: { at: number; seq: number }[] = [] // seqs only: holding the checkpoints would be the leak
    const store = (harness.manager as unknown as { checkpoints: { write(d: string, id: string, c: Checkpoint): void } }).checkpoints
    const real = store.write.bind(store)
    store.write = (d, id, c) => {
      writes.push({ at: performance.now(), seq: c.seq })
      real(d, id, c)
    }
    await until('the flood to be ready', () => (p.currentMirror?.parsedSeq ?? 0) >= FLOOD_READY.length)
    const r = new TestRenderer(harness.manager, p.ptyId, { keepData: false })
    let sent = FLOOD_READY.length
    const g = await leakCycles({
      total: CYCLES,
      cycle: async () => {
        p.signal(SIG.SIGUSR2, 'child')
        sent += PER_CYCLE
        await until('the batch through mirror and renderer', () => p.currentMirror?.parsedSeq === sent && r.writtenSeq === sent, 300_000)
      },
      measure: heapUsed,
    })
    r.close()
    expect(g.ok, `heap: ${Math.round(g.slope)} B per ${PER_CYCLE >> 20} MB, ${g.absolute} B over the run`).toBe(true)
    const halfRing = Math.floor(p.ringCapacity() * L.checkpointRingFraction)
    expect(writes.length, 'checkpoints kept coming under load').toBeGreaterThanOrEqual(CYCLES)
    for (const [i, w] of writes.entries()) {
      expect(insideEscape(w.seq), `checkpoint ${i} at ${w.seq} splits an escape sequence`).toBe(false)
      if (i === 0) continue
      const prev = writes[i - 1]!
      expect(w.at - prev.at, `checkpoint ${i}: ${Math.round(w.at - prev.at)} ms after the previous one`).toBeGreaterThanOrEqual(L.checkpointMinIntervalMs)
      // the output since the previous one reached half a ring, or the max age passed
      const aged = w.at - prev.at >= L.checkpointMaxAgeMs
      expect(aged || w.seq - prev.seq >= halfRing, `checkpoint ${i}: ${w.seq - prev.seq} bytes after the previous one`).toBe(true)
    }
  })
})
