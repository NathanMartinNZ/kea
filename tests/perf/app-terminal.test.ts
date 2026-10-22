// Terminal budgets against the real app: the release `kea-helper` holder → ptyhost → sandboxed renderer (xterm +
// WebGL), launched unfocused on a fresh KEA_HOME (tests/perf/app-harness.ts). Most tests use tabs rather than sessions
// (the cold switch uses sessions); a tab that was on screen stays warm, so its output is still parsed by the
// renderer.
//
// The keystroke-echo budgets share one method: tools/perf's echo probe, keydown → the xterm render after which the
// typed character sits just before the cursor; 30 unmeasured keys, then KEYS (1 000 by default) measured ones; p50 and
// p99 over all of them. The other scenarios run once to warm up and then RUNS times, and their median is compared.

import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { PROMPT, until, zooShellCommand, type Kea, type KeaRun } from '../support/app.ts'
import { addProject, demoRepo, paneSession, startSession, tabOf, waitLive } from '../support/app-sessions.ts'
import {
  budget,
  cassetteLoop,
  CASSETTES,
  check,
  disposeRuns,
  dist,
  echoLatencies,
  envNumber,
  footprints,
  frames,
  FULLSCREEN_CASSETTE,
  KEY_WARMUP,
  KEYS,
  measureFor,
  median,
  record,
  RUNS,
  startKea,
  WARMUPS,
  workload,
} from './app-harness.ts'
import { sysKey } from '../support/keys.ts'

afterEach(disposeRuns)

declare const __keaPerf: { now(): number; waitText(t: string, ms?: number): Promise<number>; armSwitch(ms?: number): Promise<number> }
declare const __keaProbe: { terminal(id: string): { onRender(cb: () => void): { dispose(): void }; onWriteParsed(cb: () => void): { dispose(): void } } | undefined }

const MB = 1_000_000
const MIB = 2 ** 20
const ECHO_METHOD = `tools/perf's echo probe: keydown → the xterm render with the typed character before the cursor; ${KEY_WARMUP} unmeasured keys, then ${KEYS}; p50 and p99 over all of them`

/** An endless flood (tools/process-zoo `flood`), ended with ⌃C; its lines are 79 printable characters. */
const ENDLESS_FLOOD = zooShellCommand('flood', ['--bytes', '1000G'])
const FLOOD_LINE = /[!-~]{79}/

/** Output bytes a PTY of the run has produced so far (its ring's latest seq). */
function produced(run: KeaRun, ptyId: string): number {
  return run.ring(ptyId).latest
}

function echoResult(id: 'P-TERM-1' | 'P-TERM-2' | 'P-TERM-3', samples: number[], scenario: string, values: Record<string, number> = {}, idSuffix = '', extra: ReturnType<typeof check>[] = []) {
  const d = dist(samples)
  const b = budget(id)
  const checks = ['p50' in b ? [check('p50', d.p50, b.p50, 'max', b.unit), check('p99', d.p99, b.p99, 'max', b.unit)] : [check('p99', d.p99, b.p99, 'max', b.unit)], extra].flat()
  return record({ id: `${id}${idSuffix}`, metric: b.metric, method: `${scenario}; ${ECHO_METHOD}`, values: { ...d, ...values }, checks })
}

describe('terminal latency (app)', () => {
  it(
    'P-TERM-1 · keydown → glyph painted in an idle shell running cat: p50 and p99 within budget over 1 000 keys',
    async () => {
      const { kea } = await startKea()
      await kea.enter('cat')
      const samples = await echoLatencies(kea, KEYS)
      await kea.press('Control+c')
      const e = echoResult('P-TERM-1', samples, 'cat in the only terminal')
      expect(e.pass, JSON.stringify(e.values)).toBe(true)
    },
    10 * 60_000,
  )

  it(
    'P-TERM-2 · keydown → glyph while a second (warm) terminal floods: p99 within budget over 1 000 keys, and the window at or above the flood frame-rate floor meanwhile',
    async () => {
      const { run, kea } = await startKea()
      const typing = (await kea.shown()) as string
      const flooder = await kea.newTab()
      await kea.enter(ENDLESS_FLOOD)
      await kea.select(typing) // the flooding tab stays warm: the renderer keeps parsing its output
      await kea.enter('cat')
      const before = produced(run, flooder)
      const t0 = performance.now()
      // Typing has no perceptible lag (the p99) and the app stays at ≥ 50 fps; rAF frames over the same keys
      const f = await frames(kea, () => echoLatencies(kea, KEYS))
      const samples = f.result
      const floodMBps = (produced(run, flooder) - before) / MB / ((performance.now() - t0) / 1000)
      await kea.press('Control+c')
      await kea.select(flooder)
      await kea.press('Control+c')
      // the frame-rate floor is the one the throughput budget sets for the renderer under a flood (P-TERM-4):
      // budgets.toml gives this budget no fps of its own
      const minFps = budget('P-TERM-4').min_fps
      const e = echoResult('P-TERM-2', samples, `cat in the terminal on screen while a warm second tab runs an endless process-zoo flood; renderer rAF frames over the same keys (≥ ${minFps} fps)`, { floodMBps, fps: f.fps, maxFrameGapMs: f.maxGapMs }, '', [check('fps', f.fps, minFps, 'min', 'fps')])
      expect(floodMBps, 'the flood ran while the keys were measured').toBeGreaterThan(1)
      expect(e.pass, JSON.stringify(e.values)).toBe(true)
    },
    10 * 60_000,
  )

  it(
    'P-TERM-3 · keydown → glyph during Claude Code’s thinking animation replayed at 1× in the same terminal: p99 within budget over 1 000 keys',
    async () => {
      const { run, kea } = await startKea()
      const id = (await kea.shown()) as string
      await kea.enter(workload('thinking', [FULLSCREEN_CASSETTE]))
      await kea.waitScreen('the recorded Claude Code screen', (s) => s.includes('Claude Code'))
      const before = produced(run, id)
      const t0 = performance.now()
      const samples = await echoLatencies(kea, KEYS, KEY_WARMUP, 'app')
      const animationKBps = (produced(run, id) - before) / 1000 / ((performance.now() - t0) / 1000)
      await kea.press('Control+c')
      const e = echoResult('P-TERM-3', samples, `tools/perf/src/workloads/thinking.ts: ${FULLSCREEN_CASSETTE.split('/').pop()}'s spinner and title frames looped at their recorded pace, typed keys echoed in its prompt box as Claude Code does`, { animationKBps })
      expect(animationKBps, 'the animation ran while the keys were measured').toBeGreaterThan(0)
      expect(e.pass, JSON.stringify(e.values)).toBe(true)
    },
    10 * 60_000,
  )

  it.runIf(process.env.KEA_PERF_CONTENTION === '1')(
    'P-TERM-1 · (contention, opt-in: KEA_PERF_CONTENTION=1 [KEA_PERF_BUSY=<ms>:<everyMs>]) keydown → glyph in cat while five other terminals replay Claude Code cassettes',
    async () => {
      const busy = process.env.KEA_PERF_BUSY
      const { run, kea } = await startKea(busy ? { args: [`--kea-perf-busy=${busy}`] } : {})
      const typing = (await kea.shown()) as string
      const replaying: string[] = []
      for (let i = 0; i < 5; i++) {
        replaying.push(await kea.newTab())
        await kea.enter(cassetteLoop(run, [CASSETTES[i % CASSETTES.length] as string], `replay-${i}`))
      }
      await kea.select(typing)
      await kea.enter('cat')
      const out = () => replaying.reduce((n, id) => n + produced(run, id), 0)
      const before = out()
      const t0 = performance.now()
      const samples = await echoLatencies(kea, KEYS)
      const replayKBps = (out() - before) / 1000 / ((performance.now() - t0) / 1000)
      const e = echoResult('P-TERM-1', samples, `contention: five other tabs replay fixtures/cassettes in loops through fake-agent${busy ? `, ptyhost stalled ${busy.replace(':', ' ms every ')} ms` : ''}`, { replayKBps }, ' (contention)')
      expect(replayKBps, 'the replays ran while the keys were measured').toBeGreaterThan(1)
      expect(e.pass, JSON.stringify(e.values)).toBe(true)
    },
    10 * 60_000,
  )
})

describe('terminal throughput and control (app)', () => {
  it(
    'P-TERM-4 · 100 MB of ASCII through holder → ptyhost → renderer: throughput, renderer frame rate and ptyhost footprint growth within budget, median of the runs after a warm-up',
    async () => {
      const bytes = envNumber('KEA_PERF_FLOOD_MB', 100) * MIB // the budget's 100 MB (`pnpm perf --flood-mb`)
      const { kea } = await startKea()
      const page = await kea.page()
      const ptyhost = await kea.pid('ptyhost')
      const view = (await kea.views()).find((v) => v.visible)
      const base = (await footprints([ptyhost])).get(ptyhost.pid) ?? NaN
      const runs: { mbPerS: number; fps: number; maxGapMs: number; growthMb: number }[] = []
      for (let i = 0; i < WARMUPS + RUNS; i++) {
        await kea.type(`${zooShellCommand('flood', ['--bytes', String(bytes)])}; echo FLOOD${i}-$((40+2))-DONE`)
        let peak = base
        let sampling = true
        // ptyhost's footprint every 250 ms while the flood runs (its peak is the growth the budget bounds)
        const sampler = (async () => {
          while (sampling) {
            peak = Math.max(peak, (await footprints([ptyhost])).get(ptyhost.pid) ?? 0)
            await measureFor(250)
          }
        })()
        const f = await frames(kea, async () => {
          const t0 = await page.evaluate(() => __keaPerf.now())
          await kea.press('Enter')
          const t1 = await page.evaluate((tag) => __keaPerf.waitText(tag, 300_000), `FLOOD${i}-42-DONE`)
          return (t1 - t0) / 1000
        })
        sampling = false
        await sampler
        if (i >= WARMUPS) runs.push({ mbPerS: bytes / MB / f.result, fps: f.fps, maxGapMs: f.maxGapMs, growthMb: (peak - base) / MIB })
      }
      const b = budget('P-TERM-4')
      const values = { mbPerS: median(runs.map((r) => r.mbPerS)), fps: median(runs.map((r) => r.fps)), maxFrameGapMs: Math.max(...runs.map((r) => r.maxGapMs)), ptyhostGrowthMb: median(runs.map((r) => r.growthMb)), ptyhostMaxGrowthMb: Math.max(...runs.map((r) => r.growthMb)), ptyhostBaseMb: base / MIB, bytes, cols: view?.cols ?? NaN, rows: view?.rows ?? NaN }
      const e = record({
        id: 'P-TERM-4',
        metric: b.metric,
        method: `process-zoo flood --bytes ${bytes} in the terminal on screen, Enter → its end marker painted; renderer rAF frames meanwhile; ptyhost footprint every 250 ms, peak − idle footprint before the warm-up; ${WARMUPS} warm-up + ${RUNS} runs, medians`,
        values,
        checks: [check('mbPerS', values.mbPerS, b.min, 'min', b.unit), check('fps', values.fps, b.min_fps, 'min', 'fps'), check('ptyhostGrowthMb', values.ptyhostGrowthMb, b.max_ptyhost_growth_mb, 'max', 'MiB')],
      })
      expect(e.pass, JSON.stringify(e.values)).toBe(true)
    },
    15 * 60_000,
  )

  it(
    'P-TERM-5 · ⌃C during a flood → output stops on screen within budget, median of the runs after a warm-up',
    async () => {
      /** The flood runs this long before ⌃C, so every buffer on the way is full. */
      const FLOODING_MS = 1000
      /** Output has stopped once nothing was written to or rendered by the terminal for this long. */
      const QUIET_MS = 1000
      const { kea } = await startKea()
      const page = await kea.page()
      const id = (await kea.shown()) as string
      const runs: { render: number; write: number }[] = []
      for (let i = 0; i < WARMUPS + RUNS; i++) {
        await kea.enter('clear')
        await kea.waitScreen('a cleared screen', (s) => !FLOOD_LINE.test(s))
        await kea.enter(ENDLESS_FLOOD)
        await kea.waitScreen('the flood on screen', (s) => FLOOD_LINE.test(s))
        await measureFor(FLOODING_MS)
        await page.evaluate((ptyId) => {
          const t = __keaProbe.terminal(ptyId)
          if (!t) throw new Error(`no view of ${ptyId}`)
          const st = { down: -1, render: -1, write: -1, off: [] as (() => void)[] }
          const onKey = (e: KeyboardEvent) => {
            if (st.down < 0 && e.ctrlKey && e.key.toLowerCase() === 'c') st.down = e.timeStamp
          }
          window.addEventListener('keydown', onKey, true)
          const r = t.onRender(() => {
            if (st.down >= 0) st.render = performance.now()
          })
          const w = t.onWriteParsed(() => {
            if (st.down >= 0) st.write = performance.now()
          })
          st.off = [() => window.removeEventListener('keydown', onKey, true), () => r.dispose(), () => w.dispose()]
          ;(window as unknown as { __keaStop: typeof st }).__keaStop = st
        }, id)
        await kea.press('Control+c')
        const r = await page.evaluate(
          (quietMs) =>
            new Promise<{ render: number; write: number }>((resolve) => {
              const st = (window as unknown as { __keaStop: { down: number; render: number; write: number; off: (() => void)[] } }).__keaStop
              const tick = () => {
                if (performance.now() - Math.max(st.down, st.render, st.write) < quietMs) return void setTimeout(tick, 50)
                for (const off of st.off) off()
                resolve({ render: st.render - st.down, write: st.write - st.down })
              }
              tick()
            }),
          QUIET_MS,
        )
        await kea.waitScreen('the prompt after ⌃C', (s) => s.trimEnd().endsWith('kea$'))
        if (i >= WARMUPS) runs.push(r)
      }
      const b = budget('P-TERM-5')
      const values = { median: median(runs.map((r) => r.render)), max: Math.max(...runs.map((r) => r.render)), lastWriteMedian: median(runs.map((r) => r.write)) }
      const e = record({
        id: 'P-TERM-5',
        metric: b.metric,
        method: `endless process-zoo flood in the terminal on screen for ${FLOODING_MS} ms, then ⌃C: keydown → the last xterm render (nothing written or rendered for ${QUIET_MS} ms after it); ${WARMUPS} warm-up + ${RUNS} runs, median`,
        values,
        checks: [check('median', values.median, b.max, 'max', b.unit)],
      })
      expect(e.pass, JSON.stringify(e.values)).toBe(true)
    },
    10 * 60_000,
  )

  it(
    'P-TERM-9 · a continuous window resize: renderer frame rate and PTY resizes per second within budget, median of the drags after a warm-up',
    async () => {
      /** One drag: the window's size changes every DRAG_STEP_MS (a pointer's event rate) for DRAG_MS. */
      const DRAG_MS = 3000
      const DRAG_STEP_MS = 16
      /** How far the drag moves the window's edge (px), back and forth. */
      const DRAG_PX = 300
      /**
       * Ptyhost sends a resize at most once per L.resizeDebounceMs, which is exactly the budget's 20 per
       * second, and the child sees each one a little after it was sent (holder → TIOCSWINSZ → SIGWINCH → its
       * event loop). Counted in plain one-second windows, the arrivals of sends 50 ms apart read 21 whenever the first
       * of 21 is delivered a few ms later than the last. So arrivals are counted in windows one second less a delivery
       * jitter allowance of half a debounce period: sends that keep their spacing can never read more than 20 there,
       * whatever the jitter up to that allowance, while a sender that breaks the spacing (sends ≤ 48 ms apart on
       * average over a second, or no throttle at all) still reads more (stats.ts `maxInWindow`, U-PERF-5). Every drag
       * is judged, not their median. The plain one-second count is recorded alongside.
       */
      const JITTER_MS = L.resizeDebounceMs / 2
      const WINDOW_MS = 1000 - JITTER_MS
      const { kea } = await startKea()
      const runs: { fps: number; maxGapMs: number; resizesMax1s: number; resizesInWindow: number; minGapMs: number; resizes: number; steps: number }[] = []
      for (let i = 0; i < WARMUPS + RUNS; i++) {
        await kea.enter(workload('winch', [`d${i}`, String(WINDOW_MS)]))
        await kea.waitScreen('winch ready', (s) => s.includes(`WINCH-READY d${i}`))
        // main changes the window's size as a drag would (setSize from main's event loop: no CDP round trip per step)
        const f = await frames(kea, () =>
          kea.app.evaluate(
            async ({ BrowserWindow }, o) => {
              const w = BrowserWindow.getAllWindows()[0]
              if (!w) throw new Error('no window')
              const [w0, h0] = w.getSize() as [number, number]
              const [minW, minH] = w.getMinimumSize() as [number, number]
              const t0 = Date.now()
              let steps = 0
              while (Date.now() - t0 < o.ms) {
                const phase = ((Date.now() - t0) % (o.ms / 2)) / (o.ms / 2) // a triangle wave, twice per drag
                const d = Math.round(o.px * (phase < 0.5 ? phase * 2 : 2 - phase * 2))
                w.setSize(Math.max(minW, w0 - d), Math.max(minH, h0 - Math.round(d / 2)))
                steps++
                await new Promise((r) => setTimeout(r, o.stepMs))
              }
              w.setSize(w0, h0)
              return steps
            },
            { ms: DRAG_MS, stepMs: DRAG_STEP_MS, px: DRAG_PX },
          ),
        )
        await measureFor(4 * L.resizeDebounceMs) // the last debounced resize reaches the PTY
        await kea.enter('q')
        const count = new RegExp(`WINCH d${i} n=(\\d+) max1s=(\\d+) maxWin=(\\d+) minGap=(-?\\d+)`)
        const m = count.exec(await kea.waitScreen('the resize count', (x) => count.test(x))) as RegExpExecArray
        if (i >= WARMUPS) runs.push({ fps: f.fps, maxGapMs: f.maxGapMs, resizes: Number(m[1]), resizesMax1s: Number(m[2]), resizesInWindow: Number(m[3]), minGapMs: Number(m[4]), steps: f.result })
      }
      const b = budget('P-TERM-9')
      const values = {
        fps: median(runs.map((r) => r.fps)),
        maxFrameGapMs: Math.max(...runs.map((r) => r.maxGapMs)),
        resizesPerSecondMax: Math.max(...runs.map((r) => r.resizesInWindow)),
        resizesPerPlainSecondMax: Math.max(...runs.map((r) => r.resizesMax1s)),
        minResizeGapMs: Math.min(...runs.map((r) => r.minGapMs)),
        resizesPerDrag: median(runs.map((r) => r.resizes)),
        stepsPerDrag: median(runs.map((r) => r.steps)),
      }
      const e = record({
        id: 'P-TERM-9',
        metric: b.metric,
        method: `main resizes the window every ${DRAG_STEP_MS} ms for ${DRAG_MS} ms (edge moving ${DRAG_PX} px back and forth; a scripted drag, not macOS live resize); renderer rAF frames meanwhile, median over drags; PTY resizes counted as SIGWINCH by tools/perf/src/workloads/winch.ts: the most arriving within any ${WINDOW_MS} ms (one second less a ${JITTER_MS} ms delivery jitter allowance), the largest over drags; ${WARMUPS} warm-up + ${RUNS} drags`,
        values,
        checks: [check('fps', values.fps, b.min, 'min', b.unit), check('resizesPerSecondMax', values.resizesPerSecondMax, b.max_resizes_per_s, 'max', 'per s')],
      })
      expect(e.pass, JSON.stringify(e.values)).toBe(true)
    },
    10 * 60_000,
  )
})

describe('terminal switching (app)', () => {
  it(
    'P-TERM-7 · switching to a warm terminal (tab form): keydown → its first visible frame within budget, median of 60 switches after 4 unmeasured ones',
    async () => {
      const SWITCHES = 60
      const WARMUP_SWITCHES = 4
      const { kea } = await startKea()
      const page = await kea.page()
      await kea.enter('seq 1 3000')
      // the visible terminal and the warm ones, each with a screenful of output
      for (let i = 0; i < L.warmTerminals; i++) {
        await kea.newTab()
        await kea.enter('seq 1 3000')
      }
      await kea.waitScreen('the last tab’s output', (s) => s.includes('3000'))
      const samples: number[] = []
      for (let i = 0; i < WARMUP_SWITCHES + SWITCHES; i++) {
        const switched = page.evaluate(() => __keaPerf.armSwitch())
        await kea.press(i % 2 ? sysKey('Meta+Shift+BracketLeft') : sysKey('Meta+Shift+BracketRight'))
        const ms = await switched
        if (i >= WARMUP_SWITCHES) samples.push(ms)
      }
      const d = dist(samples)
      const b = budget('P-TERM-7')
      const e = record({
        id: 'P-TERM-7',
        metric: `${b.metric} (tab form)`,
        method: `${1 + L.warmTerminals} tabs with output, all warm; ⌘⇧] / ⌘⇧[ alternately; keydown → the first frame with the newly active terminal laid out and visible (__keaPerf.armSwitch); ${WARMUP_SWITCHES} unmeasured + ${SWITCHES} switches, median (p99 reported)`,
        values: { ...d },
        checks: [check('median', d.p50, b.max, 'max', b.unit)],
      })
      expect(e.pass, JSON.stringify(e.values)).toBe(true)
    },
    10 * 60_000,
  )

  it(
    'P-TERM-8 · switching to a session whose terminal is cold (rebuilt from a snapshot of 5 000 lines × 200 columns): keydown → its first painted frame within budget, median of 20 switches after 5 unmeasured ones',
    async () => {
      const COLS = 200
      const LINES = 5000
      const SWITCHES = 20
      const WARMUP_SWITCHES = 5
      // one more session than are kept warm besides the one shown: visited in turn, the next is always cold
      const SESSIONS = L.warmTerminals + 2
      // 200 columns on a laptop's display: a smaller font and the sidebar hidden (⌘B; ⌘1…⌘n still select)
      const { run, kea } = await startKea({ settings: { terminal: { fontSize: FONT_SIZE } } })
      const page = await kea.page()
      await addProject(kea, demoRepo(run).root)
      const ids: string[] = []
      for (let i = 0; i < SESSIONS; i++) ids.push(await startSession(kea, `cold ${i + 1}`, { background: true, open: i === 0 }))
      for (const id of ids) await waitLive(kea, id)
      // the background starts left the composer open: while it has the keyboard, ⌘1…⌘4 are its selectors
      await kea.press('Escape')
      await until('the composer closed', async () => (await page.getByRole('region', { name: 'New session' }).count()) === 0 || undefined)
      const order = await page.evaluate(() => [...document.querySelectorAll('[role=treeitem][data-session-id]')].map((e) => e.getAttribute('data-session-id') ?? ''))
      expect(order.length).toBe(SESSIONS)
      await kea.press(sysKey('Meta+b'))
      await until('the sidebar hidden', async () => (await page.getByRole('complementary', { name: 'Sidebar' }).isVisible()) === false || undefined)
      const showRow = async (k: number): Promise<string> => {
        await kea.press(sysKey(`Meta+${k + 1}`))
        await until(`row ${k + 1} in the main pane`, async () => (await paneSession(page)) === order[k] || undefined)
        const pty = await tabOf(kea, 'agent')
        await until(`row ${k + 1}'s Agent terminal on screen`, async () => (await kea.shown()) === pty || undefined)
        return pty
      }
      await showRow(0)
      await kea.waitScreen('the first Agent terminal’s prompt', (sc) => sc.includes(PROMPT))
      await fitColumns(kea, COLS)
      // every Agent terminal: COLS columns, scrollback full of COLS-wide coloured lines, then its prompt
      const agents: string[] = []
      for (const k of order.keys()) {
        agents.push(await showRow(k))
        await kea.waitScreen(`row ${k + 1}: its prompt`, (sc) => sc.includes(PROMPT))
        await kea.enter('stty size')
        await kea.waitScreen(`row ${k + 1}: ${COLS} columns`, (sc) => new RegExp(`^\\d+ ${COLS}$`, 'm').test(sc))
        await kea.enter(fillCommand(LINES + 100, COLS, k + 1))
        await kea.waitScreen(`row ${k + 1}: its last line`, (sc) => sc.includes(`${k + 1}:${String(LINES + 100).padStart(5, '0')} `) && sc.trimEnd().endsWith(PROMPT.trimEnd()))
      }
      // the shown one is the last row; visiting in ⌘1…⌘n order, the next is never among the warm ones
      const samples: number[] = []
      for (let i = 0; i < WARMUP_SWITCHES + SWITCHES; i++) {
        const k = i % SESSIONS
        const target = agents[k]!
        expect((await kea.views()).some((v) => v.ptyId === target), `row ${k + 1}'s terminal is cold (no view) before the switch`).toBe(false)
        const switched = page.evaluate(() => __keaPerf.armSwitch(10_000))
        await kea.press(sysKey(`Meta+${k + 1}`))
        const ms = await switched
        if (i >= WARMUP_SWITCHES) samples.push(ms)
        await until(`row ${k + 1}'s terminal on screen`, async () => (await kea.shown()) === target || undefined)
        const v = (await kea.views()).find((x) => x.ptyId === target)
        expect(v?.cols, 'the rebuilt terminal is COLS wide').toBe(COLS)
      }
      // what the snapshot rebuilt: the whole scrollback, every line one full row
      const lines = (await kea.terminalText(agents[(WARMUP_SWITCHES + SWITCHES - 1) % SESSIONS]!)).split('\n').filter((l) => l.length === COLS)
      expect(lines.length, 'full rows in the rebuilt terminal').toBeGreaterThanOrEqual(LINES)
      const d = dist(samples)
      const b = budget('P-TERM-8')
      const e = record({
        id: 'P-TERM-8',
        metric: b.metric,
        method: `${SESSIONS} sessions (${L.warmTerminals} other Agent terminals stay warm), font size ${FONT_SIZE} and the sidebar hidden so the window fits a laptop's display, each Agent terminal ${COLS} columns with ${LINES + 100} coloured ${COLS}-character lines (scrollback full); ⌘1…⌘${SESSIONS} in turn, so every switch goes to a terminal with no view: keydown → the first frame with it painted from ptyhost's snapshot (__keaPerf.armSwitch); ${WARMUP_SWITCHES} unmeasured + ${SWITCHES} switches, median (p99 reported)`,
        values: { ...d },
        checks: [check('median', d.p50, b.max, 'max', b.unit)],
      })
      expect(e.pass, JSON.stringify(e.values)).toBe(true)
    },
    10 * 60_000,
  )
})

/**
 * A command printing `lines` lines of exactly `cols` characters: a coloured `<tag>:<n>` and letters (as agent output
 * is: mostly text, some colour). The terminal is `cols` wide, so each fills one row without wrapping.
 */
function fillCommand(lines: number, cols: number, tag: number): string {
  const head = `${tag}:00000 `.length
  // os-ok: in /usr/bin on both systems
  return `/usr/bin/awk 'BEGIN { s = ""; for (i = 0; i < ${cols - head}; i++) s = s sprintf("%c", 97 + i % 26); for (n = 1; n <= ${lines}; n++) printf "\\033[3%dm${tag}:%05d\\033[0m %s\\n", n % 7 + 1, n, s }'`
}

/**
 * Size the window so the terminal on screen is `cols` columns wide (200 for the cold switch), within its display's work
 * area: two widths give the cell width, then the width is set and corrected a column at a time.
 */
async function fitColumns(kea: Kea, cols: number): Promise<void> {
  const shownCols = async () => (await kea.views()).find((v) => v.shown)?.cols ?? 0
  const setWidth = (width: number) =>
    kea.app.evaluate(({ BrowserWindow, screen }, w) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('no window')
      const area = screen.getDisplayMatching(win.getBounds()).workArea
      if (w > area.width) throw new Error(`the display's work area is ${area.width} px wide, ${w} px are needed`)
      const b = win.getBounds()
      win.setBounds({ x: Math.max(area.x, Math.min(b.x, area.x + area.width - w)), y: b.y, width: w, height: b.height })
      return win.getBounds().width
    }, width)
  // a resize lands in steps (the window, then the fit): the same new value on two polls in a row
  const settle = (before: number) => {
    let last = -1
    return until('the terminal to take its new width', async () => {
      const c = await shownCols()
      const done = c !== before && c === last
      last = c
      return done ? c : undefined
    })
  }
  const width0 = await kea.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds().width)
  const cols0 = await shownCols()
  if (cols0 === cols) return
  const width1 = await setWidth(width0 + FIT_STEP_PX)
  const cols1 = await settle(cols0)
  const cell = (width1 - width0) / (cols1 - cols0)
  let width = width1
  let now = cols1
  for (let i = 0; i < FIT_TRIES && now !== cols; i++) {
    width = await setWidth(Math.round(width + (cols - now) * cell))
    now = await settle(now).catch(() => shownCols())
  }
  if (now !== cols) throw new Error(`the terminal is ${now} columns at ${width} px, not ${cols}`)
}
/** The cold switch's terminal font size (`terminal.fontSize`): small enough for 200 columns on a laptop's display. */
const FONT_SIZE = 10
/** fitColumns: the first widening, and how many corrections it makes at most. */
const FIT_STEP_PX = 200
const FIT_TRIES = 8
