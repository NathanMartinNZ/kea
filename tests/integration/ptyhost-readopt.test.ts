// A real holder closing ptyhost's connection while its child runs: another admitted client replaced it, so ptyhost
// re-adopts the holder instead of declaring the PTY lost while the agent keeps running. A holder that is really gone is
// still reported lost. This Node process satisfies the test holders' client requirement (tests/support/holders.ts), so
// it can play the other client.

import { afterEach, describe, expect, it } from 'vitest'
import { HolderConnection } from '../../app/ptyhost/src/holder/connection.ts'
import { holderState, ptyhostHarness, rawTty, signalHolder, until, type Harness } from '../support/holders.ts'

let h: Harness | null = null
afterEach(async () => {
  await h?.dispose()
  h = null
})

describe('re-adoption after an unexpected close', () => {
  it('I-PTY-31 · another client replacing ptyhost at a live holder is undone: re-adopted, no exit reported, typing echoes; a SIGKILLed holder is still lost', async () => {
    h = await ptyhostHarness()
    const p = await h.spawn({ argv: rawTty(['/bin/cat']) })
    const echoed = (s: string) => (p.screenText() ?? '').includes(s)
    p.input('before\r\n')
    await until('the first line to echo', () => echoed('before'))

    // the holder admits this process and replaces ptyhost's connection with it
    const { conn: other } = await HolderConnection.open(p.meta.sock)
    await until('ptyhost to re-adopt the holder', () => p.stats.readopts === 1)
    await until('the re-adoption to replace the other client in turn', () => other.isClosed)
    p.input('after\r\n')
    await until('typing to echo again', () => echoed('after'))
    expect(h.manager.get(p.ptyId)).toBe(p)
    expect(p.isRunning).toBe(true)
    expect(h.notes.filter((n) => n.m === 'pty.exit'), 'no exit, lost or not').toEqual([])
    expect((holderState(h.home, p.ptyId) as { refusals?: number }).refusals, 'every connection was admitted').toBe(0)

    // a holder that is really gone: lost, as before
    signalHolder(h.home, p.ptyId, 'SIGKILL')
    await until('the PTY to be reported lost', () => h!.notes.some((n) => n.m === 'pty.exit' && n.a.ptyId === p.ptyId && n.a.lost))
    expect(h.manager.get(p.ptyId)).toBeUndefined()
    expect(p.stats.readopts).toBe(1)
  })
})
