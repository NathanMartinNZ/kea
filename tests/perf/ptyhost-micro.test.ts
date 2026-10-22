// Ptyhost microbenchmarks: a checkpoint of a full 5 000-line scrollback at 200 columns, and the mirror rebuilt from it.
// Run them on the reference machine with nothing else heavy running: each is timed 5× after one warm-up and the median
// is compared with its budget. Each result is recorded in tools/perf/last.json like the app-level ones.

import { describe, expect, it } from 'vitest'
import { colorThemeOf } from '@kea/terminal'
import { Mirror } from '@kea/ptyhost/src/mirror/mirror.ts'
import { BUDGETS } from '../../tools/perf/src/generated/budgets.ts'
import { check, perfEnv, recordResult, type PerfResult } from '../../tools/perf/src/record.ts'

// The budgets' own scenario: 5 000 lines × 200 columns (P-TERM-10, P-MEM-8).
const SCROLLBACK = 5000
const COLS = 200
const ROWS = 50
const RUNS = 5

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

/** Record a result in tools/perf/last.json as measured here. */
function record(r: PerfResult): boolean {
  return recordResult(r, { env: perfEnv(`in-process microbenchmark: Vitest on Node ${process.version}`) }).pass
}

/**
 * Output that fills every scrollback line. `agent`: log-like lines with a few SGR runs each (bold ids, coloured
 * status words), the shape of agent and build output; this is the budget's case. `dense`: a 24-bit colour change every
 * ten cells, the worst case, reported alongside.
 */
function fill(kind: 'agent' | 'dense'): string {
  const out: string[] = []
  for (let i = 0; i < SCROLLBACK + ROWS; i++) {
    let line = ''
    if (kind === 'dense') {
      for (let c = 0; c < COLS / 10; c++) line += `\x1b[38;2;${(i * 7) % 256};${(c * 13) % 256};200m${String(i).padStart(5, '0')}-cell\x1b[0m`
    } else {
      line = `\x1b[1m${String(i).padStart(5, '0')}\x1b[0m ` + 'src/features/terminal/view.ts: updated '.repeat(4).slice(0, COLS - 20) + ` \x1b[32mok\x1b[0m`
    }
    out.push(line)
  }
  return out.join('\r\n')
}

async function mirrorWith(data: string, restore?: { cols: number; rows: number; data: string }): Promise<{ m: Mirror; ms: number }> {
  let done!: () => void
  const parsed = new Promise<void>((r) => (done = r))
  const bytes = new TextEncoder().encode(data)
  const t0 = performance.now()
  const m = new Mirror({
    cols: COLS,
    rows: ROWS,
    scrollback: SCROLLBACK,
    colors: colorThemeOf('kea-dark'),
    startSeq: 0,
    ...(restore ? { restore } : {}),
    reply: () => {},
    parsed: (seq) => {
      if (seq >= bytes.byteLength) done()
    },
    now: () => performance.now(),
  })
  if (restore) await m.whenRestored()
  else {
    m.write(0, bytes)
    await parsed
  }
  return { m, ms: performance.now() - t0 }
}

describe('ptyhost microbenchmarks', () => {
  it('P-TERM-10 · a checkpoint of a 5 000 × 200 mirror serialises within budget', async () => {
    const results: Record<string, number> = {}
    for (const kind of ['agent', 'dense'] as const) {
      const { m } = await mirrorWith(fill(kind))
      expect(m.atGround).toBe(true)
      const times: number[] = []
      for (let i = 0; i <= RUNS; i++) {
        const t0 = performance.now()
        m.snapshot()
        if (i > 0) times.push(performance.now() - t0) // the first is the warm-up
      }
      m.dispose()
      results[kind] = median(times)
      console.log(`P-TERM-10 checkpoint serialise (${kind}): median ${results[kind]!.toFixed(1)} ms (${times.map((t) => t.toFixed(1)).join(', ')})`)
    }
    const pass = record({
      id: 'P-TERM-10',
      metric: BUDGETS['P-TERM-10'].metric,
      method: `a Mirror (${COLS}×${ROWS}, ${SCROLLBACK} lines of scrollback) filled with agent-like lines (bold ids, coloured status words; and a dense 24-bit case, reported only); m.snapshot() timed ${RUNS}× after one warm-up, median`,
      values: { agentMs: results.agent!, denseMs: results.dense! },
      checks: [check('agentMs', results.agent!, BUDGETS['P-TERM-10'].max, 'max', BUDGETS['P-TERM-10'].unit)],
    })
    expect(results.agent).toBeLessThanOrEqual(BUDGETS['P-TERM-10'].max)
    expect(pass).toBe(true)
  })

  it('P-TERM-11 · a parked 5 000 × 200 mirror is rebuilt from its checkpoint within budget', async () => {
    const { m } = await mirrorWith(fill('agent'))
    const ckpt = m.snapshot()
    m.dispose()
    const times: number[] = []
    for (let i = 0; i <= RUNS; i++) {
      const r = await mirrorWith('', { cols: ckpt.cols, rows: ckpt.rows, data: ckpt.data })
      expect(r.m.isRestoring).toBe(false)
      r.m.dispose()
      if (i > 0) times.push(r.ms)
    }
    const ms = median(times)
    console.log(`P-TERM-11 unpark rebuild: median ${ms.toFixed(1)} ms (${times.map((t) => t.toFixed(1)).join(', ')})`)
    const pass = record({
      id: 'P-TERM-11',
      metric: BUDGETS['P-TERM-11'].metric,
      method: `a ${COLS}×${ROWS} mirror with ${SCROLLBACK} lines of scrollback (agent-like lines) snapshotted, then a new Mirror restored from it until whenRestored(); ${RUNS}× after one warm-up, median`,
      values: { medianMs: ms, maxMs: Math.max(...times) },
      checks: [check('median', ms, BUDGETS['P-TERM-11'].max, 'max', BUDGETS['P-TERM-11'].unit)],
    })
    expect(ms).toBeLessThanOrEqual(BUDGETS['P-TERM-11'].max)
    expect(pass).toBe(true)
  })
})
