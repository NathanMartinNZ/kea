// Rebuilding mirrors after ptyhost restarts: from a valid checkpoint plus the ring, from the ring alone when
// the checkpoint is stale or missing. Output arrives while no ptyhost runs, as when Kea is quit.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_TERMINAL_SETTINGS, L } from '@kea/protocol'
import { createTerminalOptions } from '@kea/terminal'
import headless from '@xterm/headless'
import { RingFile } from '../../app/ptyhost/src/stream/ring.ts'
import { firstLineBoundary, type Pty } from '../../app/ptyhost/src/pty.ts'
import { diskCheckpoints } from '../../app/ptyhost/src/checkpoint/store.ts'
import { BUDGETS } from '../../tools/perf/src/generated/budgets.ts'
import { ptyhostHarness, rawTty, until, WAIT_MS, type Harness } from '../support/holders.ts'
import { childArgv, QUERY_SIGNAL, talkLines } from './ptyhost-child.ts'
import { mirrorTerminal, parsedSeq, SIG, terminalState, viewportText, write, type HeadlessTerminal } from './ptyhost-support.ts'

const { Terminal } = headless

let h: Harness | null = null
afterEach(async () => {
  await h?.dispose()
  h = null
})

/** Lines per batch and their width: a batch stays under half the smallest ring (no automatic checkpoint). */
const LINES = 2000
const WIDTH = 60
const BATCH = talkLines(0, LINES, WIDTH).length
/** Printed once the child's signal handler is installed: no batch is asked for before it. */
const READY = 'ready\r\n'

/** A terminal configured as the mirror is, fed `bytes`: what a mirror that never restarted would hold. */
async function reference(bytes: string | Uint8Array, cols = 80, rows = 24): Promise<HeadlessTerminal> {
  const t = new Terminal(createTerminalOptions({ side: 'mirror', cols, rows, scrollback: DEFAULT_TERMINAL_SETTINGS.scrollback }))
  await write(t, bytes)
  return t
}

async function setup() {
  h = await ptyhostHarness()
  const pty = await h.spawn({ argv: rawTty(childArgv('talk', ['--print', 'ready\\r\\n', '--lines', String(LINES), '--width', String(WIDTH)])), ringBytes: L.ringBytesMin })
  const id = pty.ptyId
  const childPid = pty.info().childPid!
  const ring = new RingFile(path.join(pty.meta.stateDir, `${id}.ring`))
  await until('the child to be ready', () => parsedSeq(pty) === READY.length)
  let batches = 0
  /** One more batch: through ptyhost while it runs, straight to the test's own child while it does not. */
  const batch = async (p: Pty | null) => {
    batches++
    if (p) p.signal(SIG.SIGUSR2, 'child')
    else process.kill(childPid, 'SIGUSR2')
    await until(`batch ${batches} in the ring`, () => ring.header()?.latestSeq === READY.length + batches * BATCH)
    if (p) await until(`batch ${batches} parsed`, () => parsedSeq(p) === READY.length + batches * BATCH)
  }
  return { id, pty, ring, batch, stateDir: pty.meta.stateDir, all: () => READY + talkLines(0, batches * LINES, WIDTH) }
}

/** Ptyhost starts again with `id` visible, so its mirror is rebuilt at once; resolves when the replay is done. */
async function relaunch(id: string, latest: number): Promise<Pty> {
  const m = await h!.restart({ visible: [id] })
  const p = m.get(id)!
  await until('the rebuild', () => p.currentMirror !== null && !p.isReplaying && parsedSeq(p) === latest)
  return p
}

describe('rebuild after a ptyhost restart', () => {
  it('I-PTY-6 · valid checkpoint, stale checkpoint (ckpt.seq < earliestSeq), no checkpoint: each mirror equals a never-restarted one', async () => {
    // valid: checkpointed on shutdown, more output while ptyhost is away, then checkpoint + ring delta
    {
      const s = await setup()
      await s.batch(s.pty)
      h!.manager.shutdown() // checkpoints every dirty mirror
      const ckpt = diskCheckpoints.read(s.stateDir, s.id)
      expect(ckpt?.seq).toBe(READY.length + BATCH)
      await s.batch(null)
      const p = await relaunch(s.id, READY.length + 2 * BATCH)
      expect(p.currentMirror!.startSeq).toBe(READY.length + BATCH) // rebuilt from it
      const ref = await reference(s.all())
      expect(terminalState(mirrorTerminal(p))).toEqual(terminalState(ref))
      ref.dispose()
      s.ring.close()
      await h!.dispose()
      h = null
    }
    // stale: the ring has overwritten what followed the checkpoint, so it is ignored; the ring alone still holds more
    // lines than the scrollback, so the rebuilt mirror equals the never-restarted one exactly
    {
      const s = await setup()
      await s.batch(s.pty)
      h!.manager.shutdown()
      expect(diskCheckpoints.read(s.stateDir, s.id)?.seq).toBe(READY.length + BATCH)
      while ((s.ring.header()?.earliestSeq ?? 0) <= READY.length + BATCH) await s.batch(null)
      const latest = s.ring.header()!.latestSeq
      const p = await relaunch(s.id, latest)
      // the stale checkpoint was not used: the mirror starts at the ring's first line boundary (and, having parsed half a
      // ring since, has been checkpointed afresh)
      const head = s.ring.header()!
      expect(p.currentMirror!.startSeq).toBe(firstLineBoundary(s.ring, head.earliestSeq, head.latestSeq))
      const ref = await reference(s.all())
      expect(terminalState(mirrorTerminal(p))).toEqual(terminalState(ref))
      ref.dispose()
      s.ring.close()
      await h!.dispose()
      h = null
    }
    // none: ptyhost dies without a checkpoint and the ring wraps; the mirror is the ring from its first line boundary
    {
      const s = await setup()
      await s.batch(s.pty)
      h!.stop() // no checkpoint written
      expect(diskCheckpoints.read(s.stateDir, s.id)).toBeNull()
      while ((s.ring.header()?.earliestSeq ?? 0) === 0) await s.batch(null)
      const head = s.ring.header()!
      const p = await relaunch(s.id, head.latestSeq)
      const from = firstLineBoundary(s.ring, head.earliestSeq, head.latestSeq)
      expect(from).toBeGreaterThan(head.earliestSeq)
      expect(p.currentMirror!.startSeq).toBe(from)
      const tail = s.ring.read(from, head.latestSeq, head.latestSeq - from)!
      const ref = await reference(tail)
      const mirror = mirrorTerminal(p)
      expect(terminalState(mirror)).toEqual(terminalState(ref))
      // and what is on screen is what a never-restarted terminal shows
      const never = await reference(s.all())
      expect(viewportText(mirror)).toEqual(viewportText(never))
      ref.dispose()
      never.dispose()
      s.ring.close()
    }
  })
})

describe('relaunch with many live holders', () => {
  it('I-PTY-18 · relaunch with 20 holders whose rings are full and checkpoints stale: the visible terminal is rebuilt first and typeable within P-START-4; the others are rebuilt one at a time; a parked PTY that sends a query is rebuilt next, ahead of the queue, and answered once', async () => {
    h = await ptyhostHarness()
    const N = 20
    // a batch of about 2 MB: three of them more than fill a ring of the default size
    const BIG_LINES = 20_000
    const BIG_WIDTH = 100
    const BIG = talkLines(0, BIG_LINES, BIG_WIDTH).length
    const QUERY = '\\e[5n' // DSR "status": the mirror answers `CSI 0 n`
    const all: { id: string; childPid: number; rec: string; ring: RingFile; stateDir: string }[] = []
    for (let i = 0; i < N; i++) {
      const rec = path.join(h.home, `input-${i}.bin`)
      const p = await h.spawn({ argv: rawTty(childArgv('talk', ['--print', 'ready\\r\\n', '--lines', String(BIG_LINES), '--width', String(BIG_WIDTH), '--record', rec, '--query', QUERY])), ringBytes: L.ringBytesDefault })
      all.push({ id: p.ptyId, childPid: p.info().childPid!, rec, ring: new RingFile(path.join(p.meta.stateDir, `${p.ptyId}.ring`)), stateDir: p.meta.stateDir })
    }
    try {
      await until('every child ready', () => all.every((x) => (h!.manager.get(x.id) ? parsedSeq(h!.manager.get(x.id)!) : 0) >= READY.length))
      // Kea quits: every dirty mirror checkpointed; then, while no ptyhost runs, each ring fills and wraps past
      // its checkpoint (stale: ckpt.seq < earliestSeq)
      h.manager.shutdown()
      h.stop()
      for (const x of all) {
        const ckpt = diskCheckpoints.read(x.stateDir, x.id)?.seq ?? 0
        while ((x.ring.header()?.earliestSeq ?? 0) <= ckpt) {
          const before = x.ring.header()!.latestSeq
          process.kill(x.childPid, 'SIGUSR2')
          await until(`a batch in ${x.id}'s ring`, () => x.ring.header()!.latestSeq === before + BIG)
        }
      }
      const [visible, ...rest] = all as [(typeof all)[number], ...typeof all]

      // relaunch with one terminal on screen; watch every rebuild as it starts and ends
      const t0 = performance.now()
      const restarting = h.restart({ visible: [visible.id] })
      const m = h.manager
      const order: string[] = [] // rebuilds, in the order they started
      const adopted: string[] = [] // adoptions, in order
      let queueConcurrent = 0
      let query: string | null = null
      const watch = setInterval(() => {
        let n = 0
        for (const x of all) {
          const p = m.get(x.id)
          if (p && !adopted.includes(x.id)) adopted.push(x.id)
          if (!p?.isReplaying) continue
          if (!order.includes(x.id)) order.push(x.id)
          if (x.id !== visible.id && x.id !== query) n++
        }
        queueConcurrent = Math.max(queueConcurrent, n)
      }, 1)
      try {
        // the visible terminal: rebuilt first, then a key typed into it reaches its program, within P-START-4
        await until('the visible terminal rebuilt', () => {
          const p = m.get(visible.id)
          return !!p && p.currentMirror !== null && !p.isReplaying
        })
        m.get(visible.id)!.input('k')
        await until('the key typed into the visible terminal read by its program', () => fs.existsSync(visible.rec) && fs.readFileSync(visible.rec, 'latin1') === 'k')
        const visibleMs = performance.now() - t0
        expect(visibleMs, 'visible terminal attached and typeable (P-START-4)').toBeLessThanOrEqual(BUDGETS['P-START-4'].max)
        expect(order[0], 'the visible terminal is rebuilt first').toBe(visible.id)

        // a parked PTY prints a query: it is rebuilt at once, ahead of the idle queue, and the query answered once. The
        // one picked is the last adopted of those parked while the queue still has a few to go, so its turn is last
        const parked = () => adopted.filter((id) => id !== visible.id && m.get(id)?.isParked)
        await until('a few terminals parked, waiting for their turn', () => parked().length >= 3, WAIT_MS, () => undefined)
        const q = all.find((x) => x.id === parked().at(-1))!
        query = q.id
        process.kill(q.childPid, QUERY_SIGNAL)
        await until('the query answered', () => fs.existsSync(q.rec) && fs.readFileSync(q.rec, 'latin1').includes('\x1b[0n'))
        const notYet = rest.filter((x) => x.id !== q.id && (m.get(x.id)?.isParked ?? true)).length
        expect(notYet, 'answered before the idle queue reached it').toBeGreaterThan(0)
        await restarting

        // the rest: rebuilt in idle time, one at a time, every one in the end
        await until('every mirror rebuilt', () => all.every((x) => !m.get(x.id)!.isParked && !m.get(x.id)!.isReplaying))
        expect(queueConcurrent, 'idle-time rebuilds one at a time').toBe(1)
        expect(fs.readFileSync(q.rec, 'latin1'), 'answered exactly once, nothing else sent').toBe('\x1b[0n')
        for (const x of rest) if (x.id !== q.id) expect(fs.existsSync(x.rec) ? fs.readFileSync(x.rec, 'latin1') : '', `${x.id}: nothing sent to it`).toBe('')
      } finally {
        clearInterval(watch)
      }
    } finally {
      for (const x of all) x.ring.close()
    }
  })
})
