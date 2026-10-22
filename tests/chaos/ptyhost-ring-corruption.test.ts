// A dead holder's ring file with a corrupt header: ptyhost shows no last screen rather than a wrong one, says so in its
// log, and the session starts a new terminal as usual.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { holderAlive, ptyhostHarness, rawTty, until, type Harness } from '../support/holders.ts'
import { childArgv } from '../integration/ptyhost-child.ts'

let h: Harness | null = null
afterEach(async () => {
  await h?.dispose()
  h = null
})

type Handlers = ReturnType<Harness['manager']['handlers']>
const coldScreen = (hh: Harness, a: Parameters<NonNullable<Handlers['pty.lastScreen']>>[0]) => (hh.manager.handlers()['pty.lastScreen'] as (x: typeof a, ctx: never) => ReturnType<NonNullable<Handlers['pty.lastScreen']>>)(a, {} as never)

describe('corrupt ring', () => {
  it('C-COR-3 · a dead holder\'s ring with a corrupt header: cold restore skipped with a note; the session starts a new terminal', async () => {
    h = await ptyhostHarness()
    const harness = h
    for (const corruption of ['magic', 'seqs', 'short'] as const) {
      const p = await harness.spawn({ argv: rawTty(childArgv('talk', ['--print', `last words before ${corruption}\\r\\n`])), sessionId: 's1' })
      await until('the output to be parsed', () => (p.currentMirror?.parsedSeq ?? 0) > 0 && p.pendingWrites === 0)
      const { ptyId } = p
      const stateDir = p.meta.stateDir
      // the holder dies (its child ended, then released): only its files are left
      p.terminate(0)
      await until('the child to exit', () => !p.isRunning)
      expect(p.release()).toBe(true)
      await until('the holder to be gone', () => !holderAlive(harness.home, ptyId) && harness.manager.get(ptyId) === undefined)
      const ring = path.join(stateDir, `${ptyId}.ring`)
      const args = { ptyId, sessionId: 's1', cols: 80, rows: 24 }
      expect((await coldScreen(harness, args))?.data, 'an intact ring restores').toContain(`last words before ${corruption}`)
      // corrupt it
      const fd = fs.openSync(ring, 'r+')
      try {
        if (corruption === 'magic') fs.writeSync(fd, Buffer.from('XXXX'), 0, 4, 0)
        else if (corruption === 'seqs') fs.writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, 16) // earliest/latest beyond any capacity
        else fs.ftruncateSync(fd, L.ringHeaderBytes - 1)
      } finally {
        fs.closeSync(fd)
      }
      const notes = harness.log.entries.length
      expect(await coldScreen(harness, args), corruption).toBeNull()
      expect(harness.log.entries.slice(notes).map((e) => e.msg), corruption).toContain('cold restore skipped: ring header corrupt')
      expect(fs.existsSync(ring), 'the file is evidence, not ptyhost\'s to delete').toBe(true)
    }
    // resumable: the session starts a new terminal as usual
    const next = await harness.spawn({ argv: rawTty(childArgv('talk', ['--print', 'resumed\\r\\n'])), sessionId: 's1' })
    await until('the new terminal to print', () => next.screenText()?.includes('resumed') ?? false)
    expect(next.isRunning).toBe(true)
  })
})
