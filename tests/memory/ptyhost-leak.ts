// The leak-test method for the cycles that run without the app (tests/memory/core-*, ptyhost-*, holder-*): warm-up
// cycles, then checkpoints after batches of cycles, each the median of three readings after a forced GC; a Theil–Sen
// slope over the checkpoints; fail only when both the slope and the absolute growth exceed their budgets. Exact
// counts (mirrors, sockets, scopes, timers) are compared by the tests themselves: they must return to baseline.

import v8 from 'node:v8'
import vm from 'node:vm'
import { activeCount, heldCount, queuedCount, runProcess, type Pool } from '@kea/kit'
import { harnessOs } from '../../tools/perf/src/os/index.ts'
import { until } from '../support/holders.ts'

/**
 * The method's own parameters (not product limits, so not in constants/): 2 warm-up cycles, ≥ 10 checkpoints, median
 * of 3 readings; default budgets 2 KB per cycle and 3 MB absolute.
 */
export const METHOD = { warmups: 2, checkpoints: 10, readings: 3, slopeBytesPerCycle: 2 * 1024, absoluteBytes: 3 * 1024 * 1024 } as const

let collect: (() => void) | null = null

const POOLS: readonly Pool[] = ['git', 'ports', 'other']

/**
 * No child process is still running or being let go. Every child of the code under test is kit's (`runProcess`,
 * `runHeld`), so: its pools are empty, and the only process handles this process still holds are those of held
 * children (a holder that is ptyhost's own child lives as long as its PTY).
 *
 * A reading of `process.getActiveResourcesInfo()` needs this first. A child that a call started and did not wait for
 * (a session delete's last `git branch -D`) is still there for a moment after the call has answered: read then, the
 * count has one `ProcessWrap` more, at the baseline or at the end, whichever the machine's load decides.
 */
export function childrenReaped(): boolean {
  if (POOLS.some((p) => activeCount(p) > 0 || queuedCount(p) > 0)) return false
  return process.getActiveResourcesInfo().filter((r) => r === 'ProcessWrap').length <= heldCount()
}

/**
 * Come to rest before a reading: every child process let go (`childrenReaped`), then a full GC, twice, with a turn of
 * the event loop between.
 */
export async function settle(): Promise<void> {
  if (!collect) {
    v8.setFlagsFromString('--expose-gc')
    collect = vm.runInNewContext('gc') as () => void
  }
  await until('every child process to be let go', childrenReaped)
  collect()
  await new Promise((r) => setImmediate(r))
  collect()
  // a child that the turn between the two started (a timer's) is waited for as well
  await until('every child process to be let go', childrenReaped)
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** The median of all pairwise slopes (robust to a few outliers). */
export function theilSen(points: readonly { x: number; y: number }[]): number {
  const slopes: number[] = []
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!
      const b = points[j]!
      if (b.x !== a.x) slopes.push((b.y - a.y) / (b.x - a.x))
    }
  }
  return slopes.length ? median(slopes) : 0
}

/** This process's JS heap after settling: the median of `METHOD.readings` readings. */
export async function heapUsed(): Promise<number> {
  const r: number[] = []
  for (let i = 0; i < METHOD.readings; i++) {
    await settle()
    r.push(v8.getHeapStatistics().used_heap_size)
  }
  return median(r)
}

export interface Growth {
  /** Bytes per cycle (Theil–Sen). */
  slope: number
  /** Last checkpoint − first checkpoint. */
  absolute: number
  points: { x: number; y: number }[]
  ok: boolean
}

/** Judge byte growth: it fails only when both the slope and the absolute growth are over budget. */
export function growth(points: { x: number; y: number }[], budget: { slopeBytesPerCycle: number; absoluteBytes: number } = METHOD): Growth {
  const slope = theilSen(points)
  const absolute = points.length ? points.at(-1)!.y - points[0]!.y : 0
  return { slope, absolute, points, ok: !(slope > budget.slopeBytesPerCycle && absolute > budget.absoluteBytes) }
}

/**
 * Run `total` cycles: `METHOD.warmups` first (not measured), then `METHOD.checkpoints` batches, measuring with
 * `measure` after each batch. Returns the byte growth over the checkpoints.
 */
export async function leakCycles(o: { total: number; cycle: (i: number) => Promise<void>; measure: () => Promise<number>; budget?: { slopeBytesPerCycle: number; absoluteBytes: number } }): Promise<Growth> {
  let i = 0
  for (; i < METHOD.warmups; i++) await o.cycle(i)
  const points: { x: number; y: number }[] = [{ x: i, y: await o.measure() }]
  for (let c = 1; c <= METHOD.checkpoints; c++) {
    // batches split the measured cycles evenly, so exactly `total` run
    const end = METHOD.warmups + Math.round(((o.total - METHOD.warmups) * c) / METHOD.checkpoints)
    for (; i < end; i++) await o.cycle(i)
    points.push({ x: i, y: await o.measure() })
  }
  return growth(points, o.budget)
}

/** `kea-helper footprint <pid>`: the process's physical footprint in bytes. */
export async function footprint(helper: string, pid: number): Promise<number> {
  const r = await runProcess(helper, ['footprint', String(pid)], { pool: 'other' })
  const out = r.stdout?.toString('utf8').trim() ?? ''
  const [, bytes] = out.split(' ')
  const n = Number(bytes)
  if (!Number.isFinite(n)) throw new Error(`footprint ${pid}: ${out}`)
  return n
}

/** Open files of `pid` (macOS: `lsof -p`'s lines; Linux: `/proc/<pid>/fd`). Compared with itself only. */
export function fdCount(pid: number): Promise<number> {
  return harnessOs.openFiles.count(pid)
}
