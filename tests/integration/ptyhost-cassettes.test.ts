// Recorded agent sessions replayed through a real holder into ptyhost's mirror, with renderers attaching mid-stream
// from snapshots. The cassette player (ptyhost-child.ts `play`) stops at every resize and at every attach point, so
// each happens at an exact byte, as a renderer would see it.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ptyhostHarness, rawTty, REPO_ROOT, until, type Harness } from '../support/holders.ts'
import { castPlan, childArgv, type CastPlan } from './ptyhost-child.ts'
import { mirrorTerminal, parsedSeq, SIG, terminalState, TestRenderer, viewportText } from './ptyhost-support.ts'
import type { Pty } from '../../app/ptyhost/src/pty.ts'

const DIR = path.join(REPO_ROOT, 'fixtures/cassettes')
const CASTS = fs.readdirSync(DIR).filter((f) => f.endsWith('.cast')).sort()
/** Attach points per cassette. */
const ATTACHES = 50

let h: Harness | null = null
afterEach(async () => {
  await h?.dispose()
  h = null
})

/**
 * Play `file` in a real PTY and attach a renderer at each pause. Resizes are made by the attached renderer (or, before
 * any attaches, by core's path), at the byte where the cassette made them.
 */
async function replay(file: string, pauses: number[]): Promise<{ pty: Pty; plan: CastPlan; renderers: TestRenderer[] }> {
  h = await ptyhostHarness()
  const plan = castPlan(file, pauses)
  const pty = await h.spawn({ argv: rawTty(childArgv('play', [file, '--pauses', pauses.join(',')])), cols: plan.header.width, rows: plan.header.height })
  const renderers: TestRenderer[] = []
  for (const s of plan.stops) {
    await until(`the mirror to parse up to ${s.at}`, () => parsedSeq(pty) >= s.at)
    expect(parsedSeq(pty)).toBe(s.at) // the player is waiting: nothing past the stop
    if (s.kind === 'resize') {
      const r = renderers.at(-1)
      if (r) {
        for (const x of renderers) await x.untilWritten(s.at)
        r.resize(s.cols, s.rows) // the window resizes its own terminal, then the PTY
        for (const x of renderers.slice(0, -1)) x.term.resize(s.cols, s.rows)
      } else {
        pty.resize(s.cols, s.rows)
      }
    } else {
      renderers.push(new TestRenderer(h.manager, pty.ptyId))
      pty.signal(SIG.SIGUSR2, 'child')
    }
  }
  const total = plan.bytes.byteLength
  await until('the mirror to parse the whole cassette', () => parsedSeq(pty) === total)
  for (const r of renderers) await r.untilWritten(total)
  return { pty, plan, renderers }
}

describe('cassettes through a real holder', () => {
  it('I-PTY-1 · every cassette: a renderer attached mid-stream ends with the mirror\'s screen, scrollback, cursor and modes', async () => {
    expect(CASTS.length).toBeGreaterThan(0)
    for (const name of CASTS) {
      const file = path.join(DIR, name)
      const total = castPlan(file).bytes.byteLength
      const { pty, renderers } = await replay(file, [Math.floor(total / 2)])
      const [r] = renderers
      expect(r!.snapshots, name).toBe(1)
      expect(r!.discontinuities, name).toEqual([])
      expect(r!.sentInput, `${name}: the renderer answered a query itself`).toEqual([])
      const mirror = mirrorTerminal(pty)
      expect(terminalState(r!.term), name).toEqual(terminalState(mirror))
      // the holder passed every byte through unchanged: the mirror ends where the recorded reference screen does
      const ref = JSON.parse(fs.readFileSync(file.replace(/\.cast$/, '.screen.json'), 'utf8')) as { cols: number; rows: number; cursor: [number, number]; altScreen: boolean; text: string[] }
      const b = mirror.buffer.active
      expect({ cols: mirror.cols, rows: mirror.rows, cursor: [b.cursorX, b.cursorY], altScreen: b.type === 'alternate', text: viewportText(mirror) }, name).toEqual({
        cols: ref.cols,
        rows: ref.rows,
        cursor: ref.cursor,
        altScreen: ref.altScreen,
        text: ref.text,
      })
      await h!.dispose()
      h = null
    }
  })

  it(`I-PTY-2 · every cassette, renderers attaching at ${ATTACHES} offsets each (mid-escape, inside DEC 2026 blocks, anywhere): each ends equal to the mirror`, async () => {
    let seed = 0x6b6561 // deterministic: a failure names its offset
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) >>> 0
      return seed % n
    }
    for (const name of CASTS) {
      const file = path.join(DIR, name)
      const bytes = castPlan(file).bytes
      // candidate offsets by kind: just after an ESC (mid-sequence), inside a synchronized-output block, anywhere
      const midEscape: number[] = []
      const inSync: number[] = []
      const text = new TextDecoder('latin1').decode(bytes)
      for (let i = 1; i < bytes.length; i++) if (bytes[i - 1] === 0x1b) midEscape.push(i, i + 1)
      for (let i = text.indexOf('\x1b[?2026h'); i >= 0; i = text.indexOf('\x1b[?2026h', i + 1)) {
        const end = text.indexOf('\x1b[?2026l', i)
        const stop = end < 0 ? bytes.length : end
        for (let j = i + 8; j < stop; j += Math.max(1, Math.floor((stop - i) / 8))) inSync.push(j)
      }
      const picks = new Set<number>()
      const pools = [midEscape, inSync, null]
      for (let k = 0; picks.size < ATTACHES && k < ATTACHES * 4; k++) {
        const pool = pools[k % pools.length]
        const at = pool && pool.length ? pool[rand(pool.length)]! : 1 + rand(bytes.length - 1)
        if (at > 0 && at < bytes.length) picks.add(at)
      }
      const pauses = [...picks].sort((a, b) => a - b)
      expect(pauses.length, name).toBe(ATTACHES)
      const { pty, renderers } = await replay(file, pauses)
      const want = terminalState(mirrorTerminal(pty))
      renderers.forEach((r, i) => {
        expect(r.discontinuities, `${name} @${pauses[i]}`).toEqual([])
        expect(r.sentInput, `${name} @${pauses[i]}`).toEqual([])
        expect(terminalState(r.term), `${name}: renderer attached at byte ${pauses[i]}`).toEqual(want)
      })
      await h!.dispose()
      h = null
    }
  })
})
