import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMemoryLogger } from '@kea/kit'
import { HOOK_ACK_BYTE } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HookIntake, type Envelope } from './intake.ts'

/** A short idle limit for these tests (production: L.hookConnectionIdleMs). */
const IDLE_MS = 300
/** Writes come faster than IDLE_MS. */
const DRIP_MS = IDLE_MS / 3
/** Only turns a missing close or answer into a failure. */
const WAIT_MS = 10_000

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
})

async function intake(): Promise<{ intake: HookIntake; got: Envelope[] }> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-intake-')))
  const got: Envelope[] = []
  const i = new HookIntake({ home, log: createMemoryLogger({ process: 'core' }), onEnvelope: (e) => got.push(e), idleMs: IDLE_MS })
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }))
  cleanup.push(() => i.dispose())
  expect(await i.start()).toBe(true)
  return { intake: i, got }
}

describe('the hook intake', () => {
  it('U-AGT-27 · a connection that sends no complete envelope for the idle limit is closed, though it drips bytes faster than that; one that sends complete lines is kept between them', async () => {
    const { intake: i, got } = await intake()
    // a byte at a time, never a newline: closed one idle limit after it connected
    const drip = net.connect(i.socketPath).on('error', () => undefined)
    const timer = setInterval(() => drip.write('x'), DRIP_MS)
    cleanup.push(() => clearInterval(timer))
    const opened = performance.now()
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the dripping connection was never closed')), WAIT_MS)
      drip.on('close', () => {
        clearTimeout(t)
        resolve()
      })
    })
    clearInterval(timer)
    expect(performance.now() - opened).toBeLessThan(IDLE_MS * 4)
    // complete lines, each within the limit, keep their connection: the timer restarts at each one
    const ok = net.connect(i.socketPath).on('error', () => undefined)
    let closed = false
    ok.on('close', () => (closed = true))
    const acks: number[] = []
    ok.on('data', (b: Buffer) => acks.push(...b))
    const line = (n: number) => `${JSON.stringify({ keaSessionId: 'abc', adapter: 'claude', id: `00000000000000${String(n).padStart(2, '0')}`, mono: n, receivedAt: Date.now(), payload: {} })}\n`
    // a line every DRIP_MS, over several idle limits
    const LINES = 9
    let n = 0
    const lines = setInterval(() => {
      if (n < LINES) ok.write(line(++n))
    }, DRIP_MS)
    cleanup.push(() => clearInterval(lines))
    const started = performance.now()
    await vi.waitFor(() => expect(acks.length).toBe(LINES), { timeout: WAIT_MS })
    clearInterval(lines)
    expect(performance.now() - started).toBeGreaterThan(IDLE_MS * 2)
    expect(closed, 'kept while complete lines come within the limit').toBe(false)
    expect(acks.every((b) => b === HOOK_ACK_BYTE)).toBe(true)
    expect(got.map((e) => e.mono)).toEqual(Array.from({ length: LINES }, (_, k) => k + 1))
    ok.destroy()
  })
})
