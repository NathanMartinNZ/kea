import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Envelope } from './intake.ts'
import { drainSpool, hasSpool, SPOOL_LOCK_FLAG } from './spool.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('session spools', () => {
  // where core can take the hook's lock (macOS's O_EXLOCK); on Linux the hook looks again after its write instead
  // (R-AGT-3): a named skip there
  it.runIf(SPOOL_LOCK_FLAG !== 0)('U-AGT-32 · core takes the spool’s lock before renaming it: while a helper holds it (between its open and its write) the spool is left for the next drain, so no envelope lands in a file core has already read', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-spool-')))
    dirs.push(home)
    const id = '01SPOOLLOCK000000000000000'
    const spool = path.join(home, 'sessions', id, 'spool.ndjson')
    fs.mkdirSync(path.dirname(spool), { recursive: true })
    const env: Envelope = { keaSessionId: id, adapter: 'claude', id: '00000000000000a1', mono: 1, receivedAt: 1, payload: {} }
    fs.writeFileSync(spool, `${JSON.stringify(env)}\n`)
    const got: Envelope[] = []
    // a helper is appending: it holds the lock
    const helper = fs.openSync(spool, fs.constants.O_WRONLY | fs.constants.O_APPEND | SPOOL_LOCK_FLAG | fs.constants.O_NONBLOCK)
    try {
      expect(drainSpool(home, id, (e) => void got.push(e)), 'nothing taken while the helper holds the lock').toMatchObject({ applied: 0, locked: true })
      expect(fs.existsSync(spool)).toBe(true)
      expect(hasSpool(home, id)).toBe(true)
      // its write lands in the spool, which core has not taken
      fs.writeSync(helper, `${JSON.stringify({ ...env, id: '00000000000000a2', mono: 2 })}\n`)
    } finally {
      fs.closeSync(helper)
    }
    expect(drainSpool(home, id, (e) => void got.push(e))).toMatchObject({ applied: 2, locked: false })
    expect(got.map((e) => e.id)).toEqual(['00000000000000a1', '00000000000000a2'])
    expect(hasSpool(home, id)).toBe(false)
  })

  // Without the lock (Linux) a hook that was writing as core took the spool writes its line again into a fresh one,
  // which nothing would drain before the session's next envelope: a spool taken so asks for one more drain, as a locked
  // one does. With the lock nothing is asked.
  it('U-AGT-32 · a spool taken without the hook’s lock asks for one more drain; one taken under it does not', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-spool-')))
    dirs.push(home)
    const id = '01SPOOLNOLOCK0000000000000'
    const spool = path.join(home, 'sessions', id, 'spool.ndjson')
    fs.mkdirSync(path.dirname(spool), { recursive: true })
    const env: Envelope = { keaSessionId: id, adapter: 'claude', id: '00000000000000b1', mono: 1, receivedAt: 1, payload: {} }
    fs.writeFileSync(spool, `${JSON.stringify(env)}\n`)
    expect(drainSpool(home, id, () => {}, 0)).toMatchObject({ applied: 1, locked: false, unlocked: true })
    expect(drainSpool(home, id, () => {}, 0), 'nothing left: nothing asked').toBeNull()
    if (SPOOL_LOCK_FLAG !== 0) {
      fs.writeFileSync(spool, `${JSON.stringify({ ...env, id: '00000000000000b2' })}\n`)
      expect(drainSpool(home, id, () => {})).toMatchObject({ applied: 1, locked: false, unlocked: false })
    }
  })
})
