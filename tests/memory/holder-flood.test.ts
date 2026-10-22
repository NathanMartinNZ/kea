// A holder's memory does not move with what passes through it: gigabytes of output, then a paste far larger than its
// input queue into a child that never reads (L-HLD-1); and the same output through a holder run under macOS
// `leaks -atExit`, which must find nothing leaked when it exits (L-HLD-3).

import { afterEach, describe, expect, it } from 'vitest'
import { ptyId as newPtyId, runDir, runHeld, socketPath, type ProcessResult } from '@kea/kit'
import { L } from '@kea/protocol'
import { HolderConnection } from '../../app/ptyhost/src/holder/connection.ts'
import { launchArgs, parseLaunchOutput, prepareLaunch, type LaunchRequest } from '../../app/ptyhost/src/holder/launch.ts'
import { helperBinary, holderAlive, holderState, killHolder, ptyhostHarness, rawTty, shortKeaHome, testClientRequirement, testEnv, until, type Harness } from '../support/holders.ts'
import { childArgv } from '../integration/ptyhost-child.ts'
import { footprint } from './ptyhost-leak.ts'
import { harnessOs } from '../../tools/perf/src/os/index.ts'
import { needOrSkip } from '../support/skip.ts'

let h: Harness | null = null
const conns: HolderConnection[] = []
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of conns.splice(0)) c.destroy()
  await h?.dispose()
  h = null
  for (const c of cleanups.splice(0).reverse()) await c()
})

const GB = 1 << 30
/** The output volume, and its tolerance: the footprint stays within 100 KB of its start. */
const OUTPUT_BYTES = Number(process.env.KEA_L_HLD_1_BYTES ?? 10 * GB)
const TOLERANCE_BYTES = 100 * 1024
const WARMUP_BYTES = 64 << 20
const PASTE_BYTES = 50 << 20

/** Connect as the holder's client, attach at the start, and ack every OUTPUT as it arrives (no parsing). */
async function drain(sock: string): Promise<{ conn: HolderConnection; received(): number; exited(): boolean }> {
  const { conn } = await HolderConnection.open(sock)
  conns.push(conn)
  let got = 0
  let exited = false
  conn.attach('earliest', 0, {
    output: (seq, data) => {
      got = seq + data.byteLength
      conn.ack(got)
    },
    exit: () => {
      exited = true
    },
    error: () => {},
    close: () => {},
  })
  return { conn, received: () => got, exited: () => exited }
}


/**
 * A non-detached holder (`--no-detach`) started as `leaks -atExit -- kea-helper pty …`: the same argv ptyhost runs,
 * under leaks, which inspects the holder when it exits. `report` settles with leaks's own result (its exit code and the
 * report on stdout) once the holder has exited. `release` closes the holder's stdin (its parent is gone: it ends its
 * child's tree and exits).
 */
async function holderUnderLeaks(leaks: string, r: LaunchRequest): Promise<{ pid: number; release(): void; report: Promise<ProcessResult> }> {
  prepareLaunch(r)
  let closeStdin: (() => void) | null = null
  let line = ''
  let started!: (v: { pid: number }) => void
  let failed!: (e: Error) => void
  const ready = new Promise<{ pid: number }>((resolve, reject) => {
    started = resolve
    failed = reject
  })
  const report = runHeld(leaks, ['-atExit', '--', r.helper, ...launchArgs({ ...r, noDetach: true })], {
    env: r.spec.env, // the holder's environment is its child's; leaks adds its malloc settings
    collect: true,
    onSpawn: (c) => {
      closeStdin = c.closeStdin
    },
    onStdout: (chunk) => {
      if (line.includes('\n')) return
      line += chunk.toString('utf8')
      if (!line.includes('\n')) return
      try {
        started(parseLaunchOutput(line))
      } catch (e) {
        failed(e as Error)
      }
    },
  })
  report.then((res) => failed(new Error(`leaks exited (${res.code}) before the holder was ready: ${res.stderr.slice(-500)}`)), failed)
  const { pid } = await ready
  return { pid, release: () => closeStdin?.(), report }
}

describe('holder memory under volume', () => {
  it(`L-HLD-1 · ${OUTPUT_BYTES / GB} GB of output, then a ${PASTE_BYTES >> 20} MB paste into a child that never reads: footprint within ${TOLERANCE_BYTES >> 10} KB, input queue capped, socket back-pressured`, async () => {
    h = await ptyhostHarness()
    const harness = h
    const p = await harness.spawn({ argv: rawTty(childArgv('flood', [String(WARMUP_BYTES + OUTPUT_BYTES)])), ringBytes: L.ringBytesMin })
    const { sock } = p.meta
    const pid = holderState(harness.home, p.ptyId)!.pid!
    harness.stop() // from here the test is the holder's only client
    const out = await drain(sock)
    await until('the warm-up output', () => out.received() >= WARMUP_BYTES, 120_000)
    const start = await footprint(harness.helper, pid)
    await until(`${OUTPUT_BYTES} bytes through the holder`, () => out.received() >= WARMUP_BYTES + OUTPUT_BYTES, 1_800_000)
    const after = await footprint(harness.helper, pid)
    expect(after - start, `footprint ${start} → ${after}`).toBeLessThanOrEqual(TOLERANCE_BYTES)

    // a child that never reads: the holder queues at most L.holderInputCapBytes, then stops reading its socket
    const q = await (async () => {
      await harness.restart({ adopt: false })
      return harness.spawn({ argv: ['/bin/sleep', '1000000'] })
    })()
    const qpid = holderState(harness.home, q.ptyId)!.pid!
    const qsock = q.meta.sock
    harness.stop()
    const { conn } = await HolderConnection.open(qsock)
    conns.push(conn)
    conn.attach('latest', 0, { output: () => {}, exit: () => {}, error: () => {}, close: () => {} })
    const before = await footprint(harness.helper, qpid)
    const chunk = new Uint8Array(L.holderReadBufferBytes).fill(0x61)
    let accepted = 0
    let refused = 0
    let peak = before
    for (let sent = 0; sent < PASTE_BYTES; sent += chunk.byteLength) {
      if (conn.input(chunk)) accepted += chunk.byteLength
      else refused++
      if (sent % (4 << 20) === 0) {
        await new Promise((r) => setImmediate(r))
        peak = Math.max(peak, await footprint(harness.helper, qpid))
      }
    }
    peak = Math.max(peak, await footprint(harness.helper, qpid))
    expect(refused, 'the socket pushed back').toBeGreaterThan(0)
    expect(accepted).toBeLessThan(PASTE_BYTES)
    expect(peak - before, `footprint ${before} → peak ${peak}`).toBeLessThanOrEqual(L.holderInputCapBytes + TOLERANCE_BYTES)
  })

  it(`L-HLD-3 · the ${OUTPUT_BYTES / GB} GB of L-HLD-1 through a holder run under leaks -atExit: leaks reports 0 leaks`, async (ctx) => {
    // macOS's leak checker; Linux has none the tests use
    const leaks = needOrSkip(ctx, harnessOs.leaks).file
    const own = shortKeaHome()
    const { home } = own
    const id = newPtyId()
    const [file, ...args] = rawTty(childArgv('flood', [String(WARMUP_BYTES + OUTPUT_BYTES)]))
    const req: LaunchRequest = {
      helper: await helperBinary(),
      ptyId: id,
      sessionId: 's1',
      kind: 'shell',
      stateDir: `${home}/sessions/s1`,
      sock: socketPath(runDir(home), id),
      cols: 80,
      rows: 24,
      client: await testClientRequirement(),
      ringBytes: L.ringBytesMin,
      keaVersion: 'test',
      spec: { file: file!, args, env: testEnv(), cwd: home },
    }
    const holder = await holderUnderLeaks(leaks, req)
    cleanups.push(async () => {
      holder.release() // the holder ends its child and exits; leaks then reports and exits
      await until('the holder to exit', () => !holderAlive(home, id), L.holderLaunchTimeoutMs).catch(() => killHolder(home, id))
      await holder.report
      own.dispose()
    })
    expect(holderState(home, id)?.pid).toBe(holder.pid)

    const out = await drain(req.sock)
    await until(`${WARMUP_BYTES + OUTPUT_BYTES} bytes through the holder`, () => out.received() >= WARMUP_BYTES + OUTPUT_BYTES, 1_800_000)
    // the child goes and the holder is released: it exits, and leaks inspects it
    out.conn.terminate(0)
    await until('the exit', () => out.exited())
    out.conn.release()
    const res = await holder.report
    const report = res.stdout?.toString('utf8') ?? ''
    const summary = /^Process (\d+): (\d+) leaks? for (\d+) total leaked bytes\.$/m.exec(report)
    expect(summary, `no leak summary from leaks (exit ${res.code}):\n${report.slice(-2000)}\n${res.stderr.slice(-500)}`).not.toBeNull()
    console.log(`L-HLD-3 ${/^Process \d+: .*nodes malloced.*$/m.exec(report)?.[0] ?? ''} · ${summary![0]}`)
    expect({ pid: Number(summary![1]), leaks: Number(summary![2]), bytes: Number(summary![3]), exit: res.code }, report.slice(-4000)).toEqual({ pid: holder.pid, leaks: 0, bytes: 0, exit: 0 })
  })
})
