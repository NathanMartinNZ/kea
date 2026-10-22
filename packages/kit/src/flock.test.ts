import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tryLock } from './flock.ts'
import { kitOs } from './os/index.ts'
import { runProcess } from './runProcess.ts'

let tmp: string
const FLOCK_TS = new URL('./flock.ts', import.meta.url).href

beforeAll(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'kea-kit-flock-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** A child Node process that tries the lock, prints `locked` or `busy`, and (with `hold`) keeps it. */
function childScript(hold: boolean): string {
  return [
    `import { tryLock } from ${JSON.stringify(FLOCK_TS)}`,
    'const lock = tryLock(process.argv[1])',
    "console.log(lock ? 'locked' : 'busy')",
    hold ? 'setInterval(() => {}, 1 << 30)' : 'lock?.dispose()',
  ].join('\n')
}

async function tryInChild(path: string): Promise<string> {
  const res = await runProcess(process.execPath, ['--input-type=module', '-e', childScript(false), path], { pool: 'other' })
  expect(res.stderr).toBe('')
  return res.stdout?.toString().trim() ?? ''
}

describe('tryLock', () => {
  it('U-FAIL-2 · a second tryLock fails (in another process and in this one) while held, succeeds after dispose', async () => {
    const path = join(tmp, 'core.lock')
    const lock = tryLock(path)
    expect(lock).not.toBeNull()
    // the lock is the file, 0600: on macOS with the holder's pid in it for diagnostics, on Linux empty
    expect(fs.statSync(path).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path, 'utf8')).toBe(kitOs.system === 'darwin' ? `${process.pid}\n` : '')
    expect(tryLock(path)).toBeNull()
    expect(await tryInChild(path)).toBe('busy')
    lock?.dispose()
    expect(await tryInChild(path)).toBe('locked')
    const again = tryLock(path)
    expect(again).not.toBeNull()
    again?.dispose()
  })

  it('U-FAIL-2 · the lock is released when the holding process dies', async () => {
    const path = join(tmp, 'ptyhost.lock')
    const ctrl = new AbortController()
    let locked!: () => void
    const isLocked = new Promise<void>((r) => (locked = r))
    const holder = runProcess(process.execPath, ['--input-type=module', '-e', childScript(true), path], {
      pool: 'other',
      signal: ctrl.signal,
      onStdout: (c) => {
        if (c.toString().includes('locked')) locked()
      },
    })
    await isLocked
    expect(tryLock(path)).toBeNull()
    ctrl.abort() // SIGTERM to the holder's process group
    const res = await holder
    expect(res.cancelled).toBe(true)
    const mine = tryLock(path)
    expect(mine).not.toBeNull()
    mine?.dispose()
  })
})
