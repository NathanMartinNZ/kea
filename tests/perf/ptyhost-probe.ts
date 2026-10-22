// A ptyhost measured from outside, for the memory budgets and the throughput flood: a Node child process that runs one
// PtyManager against real holders and reports its own physical footprint (`kea-helper footprint`, the measure the
// memory budgets use) and V8's figures, as one JSON line. A process of its own, so nothing of the test runner is
// counted; its only renderer is a stand-in that returns credit at once and keeps nothing, as a renderer in another
// process costs ptyhost nothing but the messages themselves.
//
//   node tests/perf/ptyhost-probe.ts <scenario> '<options json>'      (run by `probe()` below)
//
// Scenarios:
//   flood   one PTY pours `bytes` of `yes`-like lines (the throughput flood, P-TERM-4), `warmups` + `runs` times, with
//           the stand-in renderer attached: footprint before the warm-up, and for each measured run its peak while it
//           runs (sampled) and the footprint after a forced GC; V8's heap at each
//   awake   `n` PTYs, each filled with `lines` lines of `cols` columns, mirrors awake (P-MEM-8)
//   parked  `n` PTYs filled the same way, then parked (P-MEM-9)
//   exited  `n` PTYs filled the same way whose child then exits: final checkpoint, mirror gone (P-MEM-9)
// Each of the last three runs `rounds` rounds of `n` PTYs and reports the footprint after each round, so the cost of
// one more PTY is measured after the first round has paid every one-time cost (code, caches, a heap grown once).
// The KEA_HOME is the caller's: after the probe exits, the caller ends any holder left in it (`endHoldersIn`).

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import v8 from 'node:v8'
import { fileURLToPath } from 'node:url'
import { resources, runProcess, type ResourceReport } from '@kea/kit'
import { channelPair, DEFAULT_TERMINAL_SETTINGS, L, ptyhostV8Flags, type StreamToRenderer } from '@kea/protocol'
import { colorThemeOf } from '@kea/terminal'
import { zooCommand } from '@kea-tools/process-zoo/src/index.ts'
import type { Pty } from '../../app/ptyhost/src/pty.ts'
import { ManualClock } from '../../app/ptyhost/src/test-support.ts'
import { endHoldersIn, ptyhostHarness, until, type Harness } from '../support/holders.ts'
import { footprint, settle } from '../memory/ptyhost-leak.ts'

const SELF = fileURLToPath(import.meta.url)

export type Scenario = 'flood' | 'awake' | 'parked' | 'exited'

export interface FloodOptions {
  /** The Node that runs the flood program in the PTY (the probe itself may be Electron's). */
  childNode: string
  bytes: number
  cols: number
  rows: number
  /** Footprint sampling interval while a flood runs. */
  sampleMs: number
  /** Attach the stand-in renderer (the terminal is visible) or not (a hidden terminal). */
  renderer: boolean
  /** Floods run one after another in the same PTY, as in the app test: `warmups` unmeasured, then `runs` measured. */
  warmups: number
  runs: number
}

export interface FillOptions {
  n: number
  rounds: number
  cols: number
  rows: number
  /** Lines printed into each PTY (scrollback plus a screen fills the mirror's buffer). */
  lines: number
  /** "Keep scrollback on disk" (default on): off keeps checkpoints in ptyhost's memory. */
  diskCheckpoints?: boolean
}

export interface Memory {
  footprint: number
  heapUsed: number
  heapTotal: number
  external: number
  arrayBuffers: number
}

export interface FloodRun {
  /** The highest footprint sampled while the flood ran, and V8's figures at that sample. */
  peak: Memory
  /** After the flood was parsed and a forced GC. */
  after: Memory
  seconds: number
  mbPerS: number
}

export interface FloodResult {
  /** Before the warm-up: the mirror created, nothing printed yet (the idle footprint), after a forced GC. */
  before: Memory
  /** The measured floods, in order. */
  runs: FloodRun[]
  checkpoints: number
  samples: number
}

export interface FillResult {
  /** After the warm-up (one PTY filled, then gone) and before any measured PTY. */
  base: Memory
  /** After each round (each holds `n` more PTYs in the state measured). */
  rounds: Memory[]
  /** The resource report at the end. */
  report: ResourceReport
}

// ── test side ──────────────────────────────────────────────────────────────────────

/** Harness bound, not a product limit: a probe run with a cold helper build and a few hundred holders. */
const PROBE_TIMEOUT_MS = 900_000

/**
 * Run one scenario in a fresh probe process with `home` as its KEA_HOME; every holder left there is ended after. The
 * probe runs on Electron's own Node (`ELECTRON_RUN_AS_NODE`: no app, no window), so ptyhost's memory is measured on
 * the V8 and allocator it runs on in the app (pointer compression included), not on the test runner's Node.
 */
export async function probe<T extends FloodResult | FillResult>(scenario: Scenario, options: FloodOptions | FillOptions, home: string): Promise<T> {
  const electron = createRequire(import.meta.url)('electron') as unknown as string
  try {
    // ptyhost's own V8 flags, as Node takes them
    const r = await runProcess(electron, [...ptyhostV8Flags(), SELF, scenario, JSON.stringify({ ...options, home })], { pool: 'other', timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    const out = r.stdout?.toString('utf8') ?? ''
    const line = out.trim().split('\n').at(-1) ?? ''
    if (r.code !== 0 || !line.startsWith('{')) throw new Error(`ptyhost probe ${scenario} failed (${r.timedOut ? 'timed out' : `exit ${r.code}`}): ${r.stderr.slice(-3000)}`)
    return JSON.parse(line) as T
  } finally {
    await endHoldersIn(home)
  }
}

// ── probe side ─────────────────────────────────────────────────────────────────────

async function memory(h: Harness, gc: boolean): Promise<Memory> {
  if (gc) await settle()
  const m = process.memoryUsage()
  return { footprint: await footprint(h.helper, process.pid), heapUsed: v8.getHeapStatistics().used_heap_size, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers }
}

/** The stand-in renderer: credit back as each message arrives, nothing kept. */
function standInRenderer(h: Harness, ptyId: string): () => void {
  const [mine, theirs] = channelPair()
  theirs.onMessage((m) => {
    const s = m as StreamToRenderer
    if (s.k === 'snapshot') theirs.send({ k: 'credit', n: s.data.length })
    else if (s.k === 'data') theirs.send({ k: 'credit', n: s.b.byteLength })
  })
  h.manager.attachStream(ptyId, mine)
  return () => theirs.close()
}

/** `sh` in raw mode (bytes pass the tty unchanged), waiting for a line on its input before it runs `argv`. */
function startOnInput(argv: string[], after: 'stay' | 'exit'): string[] {
  return ['/bin/sh', '-c', `stty raw -echo && read _ && "$0" "$@"${after === 'stay' ? ' && read _' : ''}`, ...argv]
}

async function flood(o: FloodOptions & { home: string }): Promise<FloodResult> {
  const h = await ptyhostHarness({ home: o.home })
  try {
    // `yes`-like lines, as the throughput flood's: 80 columns, CR LF as a tty's ONLCR would make them; one flood per
    // line typed, as the app test types one command per run
    const cmd = zooCommand('flood', ['--bytes', String(o.bytes), '--line-length', '80', '--eol', 'crlf'], { node: o.childNode })
    const p = await h.spawn({ argv: ['/bin/sh', '-c', 'stty raw -echo && while read _; do "$0" "$@"; done', cmd.file, ...cmd.args], cols: o.cols, rows: o.rows })
    const close = o.renderer ? standInRenderer(h, p.ptyId) : () => {}
    await until('the mirror', () => p.currentMirror !== null && p.pendingWrites === 0)
    const before = await memory(h, true)
    const runs: FloodRun[] = []
    let samples = 0
    for (let i = 0; i < o.warmups + o.runs; i++) {
      let peak: Memory | null = null
      let sampling = true
      const sampler = (async () => {
        while (sampling) {
          const m = await memory(h, false)
          samples++
          if (!peak || m.footprint > peak.footprint) peak = m
          await new Promise((r) => setTimeout(r, o.sampleMs))
        }
      })()
      const t0 = performance.now()
      p.input('\n')
      await until(`flood ${i} parsed`, () => (p.currentMirror?.parsedSeq ?? 0) >= (i + 1) * o.bytes, PROBE_TIMEOUT_MS)
      const seconds = (performance.now() - t0) / 1000
      sampling = false
      await sampler
      const after = await memory(h, true)
      if (i >= o.warmups) runs.push({ peak: peak ?? after, after, seconds, mbPerS: o.bytes / 1e6 / seconds })
    }
    close()
    return { before, runs, checkpoints: p.stats.checkpoints, samples }
  } finally {
    await h.dispose()
  }
}

/** Lines that fill a mirror: log-like, a few SGR runs each, `cols` wide, as in the checkpoint benchmark (P-MEM-8). */
function fillText(lines: number, cols: number): string {
  const out: string[] = []
  const body = 'src/features/terminal/view.ts: updated '
  for (let i = 0; i < lines; i++) out.push(`\x1b[1m${String(i).padStart(5, '0')}\x1b[0m ${body.repeat(Math.ceil(cols / body.length)).slice(0, cols - 9)} \x1b[32mok\x1b[0m`)
  return out.join('\r\n') + '\r\n'
}

async function fill(scenario: 'awake' | 'parked' | 'exited', o: FillOptions & { home: string }): Promise<FillResult> {
  const clock = new ManualClock()
  const h = await ptyhostHarness({ home: o.home, clock })
  try {
    if (o.diskCheckpoints === false) {
      const d = DEFAULT_TERMINAL_SETTINGS
      const t = colorThemeOf(d.theme)
      h.manager.configure({ ...t, palette: [...t.palette], dark: true, scrollback: d.scrollback, diskBackedScrollback: false })
    }
    const file = path.join(o.home, 'fill.txt')
    fs.writeFileSync(file, fillText(o.lines, o.cols))
    const size = fs.statSync(file).size
    const tick = () => clock.advance(L.coalesceWindowMs)
    /**
     * Past the mirror's idle period and the checkpoint's gates (keystroke quiet period, minimum interval),
     * so a park goes ahead.
     */
    const idle = Math.max(L.mirrorParkIdleMs, L.checkpointQuietMs, L.checkpointMinIntervalMs) + 1
    const spawnRound = async (n: number): Promise<Pty[]> => {
      const ptys: Pty[] = []
      for (let i = 0; i < n; i++) {
        ptys.push(await h.spawn({ argv: startOnInput(['/bin/cat', file], scenario === 'exited' ? 'exit' : 'stay'), cols: o.cols, rows: o.rows }))
      }
      for (const p of ptys) p.input('\n')
      for (const p of ptys) {
        await until(`${p.ptyId} filled`, () => scenario === 'exited' ? !p.isRunning && p.flushedSeq() >= size : (p.currentMirror?.parsedSeq ?? 0) >= size && p.pendingWrites === 0, undefined, tick)
      }
      if (scenario === 'parked') {
        clock.advance(idle)
        for (const p of ptys) await until(`${p.ptyId} parked`, () => p.isParked, undefined, () => clock.advance(L.checkpointMinIntervalMs))
      } else if (scenario === 'exited') {
        // the final checkpoints, one per minimum interval, then each mirror goes
        for (const p of ptys) await until(`${p.ptyId}'s final checkpoint`, () => p.isParked, undefined, () => clock.advance(L.checkpointMinIntervalMs))
      }
      return ptys
    }
    // warm-up: one PTY through the whole cycle, then gone, so the rounds measure only what each PTY keeps
    const warm = await spawnRound(1)
    for (const p of warm) {
      if (p.isRunning) p.terminate(0)
      await until('the warm-up PTY to exit', () => !p.isRunning, undefined, tick)
      p.release()
      await until('the warm-up PTY to go', () => p.isDisposed, undefined, tick)
    }
    const base = await memory(h, true)
    const rounds: Memory[] = []
    for (let r = 0; r < o.rounds; r++) {
      await spawnRound(o.n)
      rounds.push(await memory(h, true))
    }
    return { base, rounds, report: resources.report() } // the report main logs
  } finally {
    await h.dispose()
  }
}

if (process.argv[1] === SELF) {
  const [scenario, json] = process.argv.slice(2)
  const o = JSON.parse(json ?? '{}')
  const run = scenario === 'flood' ? flood(o) : scenario === 'awake' || scenario === 'parked' || scenario === 'exited' ? fill(scenario, o) : Promise.reject(new Error(`unknown scenario ${scenario}`))
  run.then(
    (r) => {
      process.stdout.write(`${JSON.stringify(r)}\n`)
      process.exit(0)
    },
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
      process.exit(1)
    },
  )
}
