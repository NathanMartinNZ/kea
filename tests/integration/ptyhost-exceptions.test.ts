// An exception from inside xterm (the known headless stalls throw from a timer) costs one mirror rebuild, not
// ptyhost. Ptyhost runs in a worker thread with its real `uncaughtException` guard.

import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { holderAlive, rawTty } from '../support/holders.ts'
import { childArgv, talkLines } from './ptyhost-child.ts'
import { PtyhostWorker } from './ptyhost-worker.ts'

const SIGUSR2 = os.constants.signals.SIGUSR2

let w: PtyhostWorker | null = null
afterEach(async () => {
  await w?.dispose()
  w = null
})

/**
 * A batch well past the holder's high watermark (L.holderFlowHighBytes): if acks did not resume after the rebuild, the
 * holder would stop reading.
 */
const WIDTH = 78 // + CR LF: one 80-column row per line
const LINES = Math.ceil((2 * L.holderFlowHighBytes) / (WIDTH + 2))

describe('exceptions inside a mirror', () => {
  it('I-PTY-16 · a mirror exception thrown from a timer rebuilds that mirror; ptyhost stays up, the other PTY is untouched and acks resume', async () => {
    w = await PtyhostWorker.start()
    const a = await w.spawn(rawTty(childArgv('talk', ['--print', 'A ready\\r\\n', '--lines', String(LINES), '--width', String(WIDTH)])))
    const b = await w.spawn(rawTty(childArgv('echo')))
    await w.settled(a, 'A ready', (s) => s.screen?.includes('A ready') ?? false)
    await w.input(b, 'b1 ')
    const bBefore = await w.settled(b, 'b1 echoed', (s) => s.screen?.includes('b1') ?? false)

    // A's parser stalls on its next write and a timer throws; the flood that follows is far past the watermark
    await w.stall(a)
    await w.signal(a, SIGUSR2)
    const expected = 'A ready\r\n'.length + talkLines(0, LINES, WIDTH).length
    const lastLine = talkLines(LINES - 1, 1, WIDTH).trimEnd()
    // within L.holderStaleClientMs: the holder never had to free-run past an unacking client
    const after = await w.settled(a, 'A to be rebuilt and parse the whole flood', (s) => s.flushedSeq === expected && s.stats.rebuilds === 1, L.holderStaleClientMs)
    expect(after.screen).toContain(lastLine)
    expect(after.stats.gaps).toBe(0)
    expect(w.exited).toBeNull()
    const errors = (await w.logs()).filter((e) => e.msg === 'uncaught exception')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.fields.mirrorsRebuilt).toBe(1)

    // B: never rebuilt nor woken, still echoing
    const bNow = await w.state(b)
    expect(bNow.stats).toEqual(bBefore.stats)
    await w.input(b, 'b2 ')
    await w.settled(b, 'b2 echoed', (s) => s.screen?.includes('b1 b2') ?? false)
  })

  it('I-PTY-20 · an exception no mirror can explain ends ptyhost (for its supervisor to restart); the holders keep running', async () => {
    w = await PtyhostWorker.start()
    const a = await w.spawn(rawTty(childArgv('echo')))
    await w.input(a, 'x')
    await w.settled(a, 'x echoed', (s) => s.screen?.includes('x') ?? false)
    await w.throwNow().catch(() => {}) // the worker may exit before it answers
    expect(await w.whenExited).toBe(1)
    expect(holderAlive(w.home, a)).toBe(true) // Holders outlive ptyhost; dispose adopts and ends it
  })
})
