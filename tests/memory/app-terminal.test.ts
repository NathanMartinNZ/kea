// Leak cycles of the window's terminals against the real app (tests/support/app.ts), measured with
// tests/support/app-leak.ts. Most cycles switch between shell tabs, two between sessions. Every switch past the warm
// set disposes one view and creates another, and the window unmounts one terminal host element and mounts another
// (`TerminalArea.svelte`): the component lifecycle of the terminal views, run for real. The 30-minute atlas test is
// long and runs only with KEA_LONG=1 (`pnpm test:long`).

import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { BUDGETS } from '../../tools/perf/src/generated/budgets.ts'
import { repoRoot, type ProcInfo } from '../../tools/perf/src/launch.ts'
import { median } from '../../tools/perf/src/stats.ts'
import { footprint, KeaRun, PROMPT, STEP_MS, until, type Kea } from '../support/app.ts'
import { byteVerdict, CHECKPOINTS, expectBytesFlat, expectCountsFlat, RendererProbe, runCycles, type LeakRun, type XtermClass } from '../support/app-leak.ts'
import { loseWebglContext, startGlWatch, stopGlWatch } from '../support/app-render.ts'
import { LONG } from '../support/long.ts'
import { activeTabKind, addProject, agentTerminal, demoRepo, paneSession, selectSession, startSession, waitLive } from '../support/app-sessions.ts'
import { sysKey } from '../support/keys.ts'
import { skipWhere } from '../support/skip.ts'

const runs: KeaRun[] = []
const probes: RendererProbe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

/** Kea with `tabs` shell tabs, each at its prompt; the last one opened is on screen. */
async function start(tabs: number, classes: readonly XtermClass[] = ['Terminal']): Promise<{ run: KeaRun; kea: Kea; renderer: RendererProbe; ids: string[] }> {
  const run = KeaRun.create()
  runs.push(run)
  const kea = await run.launch()
  await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
  for (let i = 1; i < tabs; i++) await kea.newTab()
  const renderer = await RendererProbe.open(kea, { classes })
  probes.push(renderer)
  return { run, kea, renderer, ids: await kea.tabIds() }
}

const HEAPS = ['renderer.heap', 'core.heap', 'ptyhost.heap', 'main.heap']
/** Exact counts: all of them but the atlas sizes the views report, which follow what was drawn (L-TERM-3). */
const COUNTS = (key: string) => !/\.atlas(?:Bytes|Pages)$/.test(key)

/** What each cycle of L-TERM-1 writes into the terminal it creates. */
const WRITE_BYTES = 1024 * 1024
/**
 * One tab more than the window keeps alive (the one on screen and L.warmTerminals), so every switch creates and
 * disposes a view.
 */
const ROTATION = 2 + L.warmTerminals
/** The tabs, or sessions, a round-robin cycle goes through. */
const SESSIONS = 12
/**
 * One round of the cycle through sessions with two tabs each. A switch shows the next session on the tab it was left on
 * and moves it to its other tab, so a session is back on the tab it began on after two visits and the window is where
 * it was after every session's two. A checkpoint must be taken in the same state every time, so only after whole
 * rounds: the Agent tab's needs-you dot follows its session's row only while another tab is the one on screen
 * (`TerminalPane.svelte`), and a checkpoint taken on a shell tab therefore counts one store listener more than one
 * taken on an Agent tab.
 */
const ROUND = 2 * SESSIONS
/** The find term has 5 000 matches: 1 000 lines of five matches each. */
const MATCH_LINES = 1000
const FIND_TERM = 'lterm4'

/** The next tab (⌘⇧]) and wait until its terminal is on screen (shown once its snapshot has painted). */
async function nextTab(kea: Kea, id: string): Promise<void> {
  const page = await kea.page()
  await page.keyboard.press(sysKey('Meta+Shift+BracketRight'))
  await page.waitForFunction((x) => document.querySelector('.terminal-host.shown')?.getAttribute('data-pty') === x, id, { polling: 'raf', timeout: STEP_MS })
}

/** A count's reading at each checkpoint (the baseline first). */
function seriesOf(run: LeakRun, key: string): number[] {
  return run.points.map((p) => p.counts[key] ?? NaN)
}

describe('terminal leaks (app)', () => {
  it('L-TERM-1 · a terminal created from its snapshot, given 1 MB of output and disposed, 300 times, its host element unmounted and mounted each time: Terminal instances and WebGL contexts back to baseline, DOM nodes and listeners equal, heaps within budget', async () => {
    const { kea, renderer, ids } = await start(ROTATION)
    expect(ids).toHaveLength(ROTATION)
    const page = await kea.page()
    let at = ids.length - 1 // the last tab opened is on screen
    const run = await runCycles({
      kea,
      renderer,
      // warm-up: one full rotation, so every tab's view has been created once and the shared atlas holds every glyph
      warmup: ROTATION,
      batch: 30,
      cycle: async (i) => {
        at = (at + 1) % ids.length
        // the next tab's view is created (the oldest warm one is disposed) and attached from its snapshot
        await nextTab(kea, ids[at] as string)
        // 1 MB of coloured lines into it, as output from its PTY
        await page.evaluate(
          ([cycle, bytes]) => {
            const lines: string[] = []
            for (let n = 0, k = 0; n < bytes; k++) {
              // eight colours and a fixed alphabet: after the warm-up the glyph atlas holds them all and stops growing
              // (the long atlas test, L-TERM-3, measures atlas growth)
            const line = `\x1b[3${k % 8}mL-TERM-1 cycle ${cycle} line ${k} ${'abcdefghijklmnopqrstuvwxyz'.repeat(3)}\x1b[0m\r\n`
              lines.push(line)
              n += line.length
            }
            return (window as unknown as { __keaProbe: { write(d: string): Promise<void> } }).__keaProbe.write(lines.join(''))
          },
          [i, WRITE_BYTES] as const,
        )
      },
    })
    expect(run.cycles.at(-1)).toBe(300)
    // at every checkpoint, the terminal on screen and the warm ones, each with its WebGL context; none where Chromium
    // has no WebGL2, since xterm's DOM renderer then draws every one
    const contexts = (await kea.webglProblem()) === null ? 1 + L.warmTerminals : 0
    expect(seriesOf(run, 'renderer.liveTerminal').every((n) => n === 1 + L.warmTerminals), `live Terminal instances: ${seriesOf(run, 'renderer.liveTerminal')}`).toBe(true)
    expect(seriesOf(run, 'renderer.liveWebgl2Contexts').every((n) => n === contexts), `live WebGL contexts (${contexts} expected): ${seriesOf(run, 'renderer.liveWebgl2Contexts')}`).toBe(true)
    expectCountsFlat(run, COUNTS)
    await expectBytesFlat(kea, renderer, run, HEAPS, 'L-TERM-1')
  })

  it('L-TERM-2 · round-robin through 12 terminals, 500 switches: Terminal instances and WebGL contexts at visible + warm at every checkpoint and never above L.webglContextsMax; every released context lost before dispose; no context loss on the visible terminal', async () => {
    const { kea, renderer, ids } = await start(SESSIONS)
    expect(ids).toHaveLength(SESSIONS)
    let at = ids.length - 1
    await startGlWatch(kea)
    const run = await runCycles({
      kea,
      renderer,
      warmup: SESSIONS, // one full rotation
      batch: 50,
      cycle: async () => {
        at = (at + 1) % ids.length
        await nextTab(kea, ids[at] as string)
      },
    })
    const gl = await stopGlWatch(kea)
    expect(run.cycles.at(-1)).toBe(500)
    const live = seriesOf(run, 'renderer.liveTerminal')
    expect(live.every((n) => n === 1 + L.warmTerminals), `live Terminal instances (the one on screen plus the warm ones): ${live}`).toBe(true)
    for (const key of ['renderer.liveWebgl2Contexts', 'renderer.webglContexts']) {
      const s = seriesOf(run, key)
      expect(s.every((n) => n === 1 + L.warmTerminals && n <= L.webglContextsMax), `${key} = visible + warm, within L.webglContextsMax: ${s}`).toBe(true)
    }
    expect(gl.maxCounted, `contexts the views counted, in any of ${gl.frames} frames`).toBeLessThanOrEqual(L.webglContextsMax)
    expect(gl.maxAlive, `contexts alive on the page, in any of ${gl.frames} frames`).toBeLessThanOrEqual(L.webglContextsMax)
    expect(gl.disposed, 'every switch disposed a terminal').toBeGreaterThanOrEqual(500)
    expect(gl.releasedAlive, `released WebGL canvases whose context was still alive (of ${gl.released})`).toBe(0)
    expect(gl.lostOnShown, 'webglcontextlost on the terminal on screen').toBe(0)
    expectCountsFlat(run, COUNTS)
    await expectBytesFlat(kea, renderer, run, HEAPS, 'L-TERM-2')
  })

  it('L-TERM-6 · round-robin through 12 sessions with 2 tabs each, 480 switches, a checkpoint after every two whole rounds (the same session on the same tab each time): Terminal instances at the active session’s tabs + L.warmTerminals at every checkpoint; WebGL contexts at visible + warm, within L.webglContextsMax; the active session’s other tab never holds a context', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    const page = await kea.page()
    await addProject(kea, demoRepo(run).root)
    const ids: string[] = []
    for (let i = 0; i < SESSIONS; i++) ids.push(await startSession(kea, `leak ${i + 1}`, { background: true, open: i === 0 }))
    for (const id of ids) await waitLive(kea, id)
    // each session: its Agent tab and a shell tab
    const tabsOf = new Map<string, [string, string]>()
    for (const id of ids) {
      const agent = await agentTerminal(kea, id)
      await page.keyboard.press(sysKey('Meta+t'))
      const shell = await until(`a shell tab in ${id}`, async () => {
        const x = await kea.shown()
        return x && x !== agent ? x : undefined
      })
      await kea.waitScreen('the shell tab’s prompt', (sc) => sc.includes(PROMPT))
      tabsOf.set(id, [agent, shell])
    }
    const renderer = await RendererProbe.open(kea, { classes: ['Terminal'] })
    probes.push(renderer)
    const shownIs = (x: string) => page.waitForFunction((pty) => document.querySelector('.terminal-host.shown')?.getAttribute('data-pty') === pty, x, { polling: 'raf', timeout: STEP_MS })
    // each session shows the tab it was left on; the cycle moves to the next session, then to its other tab
    const last = new Map(ids.map((id) => [id, tabsOf.get(id)![1]]))
    let at = ids.length - 1
    const pinnedWithContext: string[] = []
    /** What is on screen where each checkpoint is taken: the session and the kind of its tab. */
    const takenOn: string[] = []
    await startGlWatch(kea)
    const leak = await runCycles({
      kea,
      renderer,
      warmup: ROUND, // one whole round: every session has been come back to on each of its tabs
      batch: 2 * ROUND,
      quiesce: async () => {
        takenOn.push(`session ${ids.indexOf((await paneSession(page)) ?? '') + 1}, ${await activeTabKind(page)} tab`)
      },
      cycle: async () => {
        at = (at + 1) % ids.length
        const id = ids[at] as string
        const [agent, shell] = tabsOf.get(id)!
        await selectSession(kea, id)
        await shownIs(last.get(id)!)
        const other = last.get(id) === agent ? shell : agent
        await page.keyboard.press(sysKey('Meta+Shift+BracketRight'))
        await shownIs(other)
        last.set(id, other)
        // the tab it left stays alive, without a context
        const pinned = (await kea.views()).find((v) => v.ptyId === (other === agent ? shell : agent))
        if (!pinned || pinned.webgl) pinnedWithContext.push(`${id}: ${JSON.stringify(pinned ?? null)}`)
      },
    })
    const gl = await stopGlWatch(kea)
    expect(leak.cycles.at(-1)).toBe(480)
    // the same state at every checkpoint: the session the setup ended on, on its shell tab as the setup left it
    expect(takenOn, 'every checkpoint is taken on the same session and the same tab').toEqual(Array(leak.points.length).fill(`session ${SESSIONS}, shell tab`))
    expect(pinnedWithContext, 'the active session’s other tab: alive, never holding a context').toEqual([])
    const live = seriesOf(leak, 'renderer.liveTerminal')
    expect(live.every((n) => n === 2 + L.warmTerminals), `live Terminal instances (the active session’s two tabs, plus the warm ones): ${live}; the registry’s views: ${seriesOf(leak, 'renderer.terminals')}`).toBe(true)
    for (const key of ['renderer.liveWebgl2Contexts', 'renderer.webglContexts']) {
      const sr = seriesOf(leak, key)
      expect(sr.every((n) => n === 1 + L.warmTerminals && n <= L.webglContextsMax), `${key} = visible + warm, within L.webglContextsMax: ${sr}`).toBe(true)
    }
    expect(gl.maxCounted, `contexts the views counted, in any of ${gl.frames} frames`).toBeLessThanOrEqual(L.webglContextsMax)
    expect(gl.maxAlive, `contexts alive on the page, in any of ${gl.frames} frames`).toBeLessThanOrEqual(L.webglContextsMax)
    expect(gl.releasedAlive, `released WebGL canvases whose context was still alive (of ${gl.released})`).toBe(0)
    expect(gl.lostOnShown, 'webglcontextlost on the terminal on screen').toBe(0)
    expectCountsFlat(leak, COUNTS)
    await expectBytesFlat(kea, renderer, leak, HEAPS, 'L-TERM-6')
  })

  it('L-TERM-9 · round-robin through more sessions than Kea keeps warm (L.warmTerminals), each left on a shell tab, so every switch is a cold one from a shell tab into another session: no disposed Terminal stays reachable (live instances = the registry’s views at every checkpoint)', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    const page = await kea.page()
    await addProject(kea, demoRepo(run).root)
    // one more session than the active one plus the warm ones: the session switched to is never warm
    const n = L.warmTerminals + 2
    const ids: string[] = []
    for (let i = 0; i < n; i++) ids.push(await startSession(kea, `cold ${i + 1}`, { background: true, open: i === 0 }))
    for (const id of ids) await waitLive(kea, id)
    // each session left on a shell tab: a shell tab of another session is never warm, so coming back is a cold switch
    const shells = new Map<string, string>()
    for (const id of ids) {
      const agent = await agentTerminal(kea, id)
      await page.keyboard.press(sysKey('Meta+t'))
      const shell = await until(`a shell tab in ${id}`, async () => {
        const x = await kea.shown()
        return x && x !== agent ? x : undefined
      })
      await kea.waitScreen('the shell tab’s prompt', (sc) => sc.includes(PROMPT))
      shells.set(id, shell)
    }
    const renderer = await RendererProbe.open(kea, { classes: ['Terminal'] })
    probes.push(renderer)
    let at = ids.length - 1
    const leak = await runCycles({
      kea,
      renderer,
      warmup: n, // one full rotation
      batch: n, // and a checkpoint after every whole one: the same session on screen each time
      cycle: async () => {
        at = (at + 1) % ids.length
        const id = ids[at] as string
        const shell = shells.get(id)!
        expect((await kea.views()).some((v) => v.ptyId === shell), `${id}’s shell tab is not alive before the switch (a cold one)`).toBe(false)
        await selectSession(kea, id)
        await page.waitForFunction((pty) => document.querySelector('.terminal-host.shown')?.getAttribute('data-pty') === pty, shell, { polling: 'raf', timeout: STEP_MS })
      },
    })
    expect(leak.cycles.at(-1)).toBe(CHECKPOINTS * n)
    const live = seriesOf(leak, 'renderer.liveTerminal')
    const views = seriesOf(leak, 'renderer.terminals')
    expect(live, `live Terminal instances = the registry’s views at every checkpoint (views: ${views})`).toEqual(views)
    expect(views.every((x) => x <= 2 + L.warmTerminals), `views within the active session’s two and L.warmTerminals: ${views}`).toBe(true)
    expectCountsFlat(leak, COUNTS)
  })

  it('L-TERM-4 · open the find bar, search a term with 5 000 matches, close, 200 times: no decorations and no search addon left after each close; every count equal; heaps within budget', async () => {
    const { kea, renderer } = await start(1, ['Terminal', 'SearchAddon'])
    const page = await kea.page()
    await kea.enter(`for i in {1..${MATCH_LINES}}; do echo "${Array(5).fill(FIND_TERM).join(' ')} $i"; done`)
    await kea.waitScreen('the matches printed', (s) => s.includes(`${FIND_TERM} ${MATCH_LINES}`))
    const shown = (await kea.shown()) as string
    const view = () => kea.views().then((vs) => vs.find((v) => v.ptyId === shown)!)
    const run = await runCycles({
      kea,
      renderer,
      batch: 20,
      cycle: async () => {
        await page.keyboard.press(sysKey('Meta+f'))
        // (locators, not `waitForSelector`: an element handle would keep the closed bar's DOM alive in the inspector)
        await page.locator('.find-bar').waitFor({ state: 'attached' })
        // the bar reopens with the last query selected: clear it, then enter the term in one input event
        await page.keyboard.press('Backspace')
        await page.keyboard.insertText(FIND_TERM)
        // the matches are counted and highlighted, the highlights capped
        await page.waitForFunction(() => /\d/.test(document.querySelector('.find-count')?.textContent ?? ''))
        const open = await until('the highlights', async () => {
          const v = await view()
          return v.decorations > 0 ? v : undefined
        })
        expect(open.findOpen).toBe(true)
        expect(open.decorations, 'highlights within L.searchHighlightsMax (plus the active match)').toBeLessThanOrEqual(L.searchHighlightsMax + 1)
        await page.keyboard.press('Escape')
        await page.locator('.find-bar').waitFor({ state: 'detached' })
        const closed = await view()
        expect([closed.findOpen, closed.decorations], 'after close: no search, no decorations').toEqual([false, 0])
      },
    })
    expect(run.cycles.at(-1)).toBe(200)
    expect(seriesOf(run, 'renderer.liveSearchAddon').every((n) => n === 0), `live search addons: ${seriesOf(run, 'renderer.liveSearchAddon')}`).toBe(true)
    expectCountsFlat(run, COUNTS)
    await expectBytesFlat(kea, renderer, run, HEAPS, 'L-TERM-4')
  })
})

// ── the atlas as the guards see it and as it is ──────────────────────────────────────────────────────────────────────

/** A WebGL view's atlas three ways, page canvases as numbers (app/renderer/src/lib/testProbes.ts `atlas`). */
type AtlasProbe = { atlas: number; guard: number[]; guardBytes: number; real: number[]; realBytes: number; textures: number[] }
type AtlasProbes = { __keaProbe: { atlas(id: string): AtlasProbe | null; glCanvas(id: string): unknown } }

async function atlasOf(kea: Kea, ptyId: string): Promise<AtlasProbe> {
  const a = await (await kea.page()).evaluate((id) => (window as unknown as AtlasProbes).__keaProbe.atlas(id), ptyId)
  if (!a) throw new Error(`${ptyId} has no WebGL atlas`)
  return a
}

/**
 * Every view's atlas read in one task of the page: one instant. The long test samples while the shimmer adds a page
 * about every second, so a call per view (`atlasOf`) can straddle an added page or a clear, and the later views then
 * differ from the first for a reason that is the sampling's, not the guards'.
 */
async function atlasesOf(kea: Kea, ptyIds: readonly string[]): Promise<AtlasProbe[]> {
  const all = await (await kea.page()).evaluate((ids) => ids.map((id) => (window as unknown as AtlasProbes).__keaProbe.atlas(id)), [...ptyIds])
  return all.map((a, i) => {
    if (!a) throw new Error(`${ptyIds[i]} has no WebGL atlas`)
    return a
  })
}

/** `n` animation frames: what the last change asked to draw has been drawn, and the guards' queued clears have run. */
async function frames(kea: Kea, n = 2): Promise<void> {
  await (await kea.page()).evaluate(
    (k) =>
      new Promise<void>((resolve) => {
        const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
        step(k)
      }),
    n,
  )
}

/** Every view's guard counts exactly the pages its renderer's atlas holds, and (unless told otherwise) all of them share one atlas. */
async function expectGuardsExact(kea: Kea, ids: readonly string[], when: string, o: { shared?: boolean } = {}): Promise<AtlasProbe[]> {
  const probes = await Promise.all(ids.map((id) => atlasOf(kea, id)))
  for (const [i, a] of probes.entries()) {
    expect(a.guard, `${when}: ${ids[i]}'s guard counts exactly its atlas's pages`).toEqual(a.real)
    expect(a.guardBytes, `${when}: ${ids[i]}'s guard sum is its atlas's bytes`).toBe(a.realBytes)
  }
  if (o.shared !== false) expect(new Set(probes.map((a) => a.atlas)).size, `${when}: the views share one atlas (same font and colours)`).toBe(1)
  return probes
}

const MiB = 2 ** 20
/** Distinct colours for the atlas fill: an odd multiplier is a bijection on 24 bits, so no colour comes back. */
let nextColour = 1

/**
 * Write screens of characters into the view on screen, every cell in a colour of its own (each glyph and colour is
 * rasterised into the atlas once), until its atlas holds at least `bytes`.
 */
async function fillAtlas(kea: Kea, ptyId: string, bytes: number): Promise<AtlasProbe> {
  const page = await kea.page()
  for (let screens = 0; ; screens++) {
    const a = await atlasOf(kea, ptyId)
    if (a.realBytes >= bytes) return a
    expect(screens, `the atlas reaches ${bytes / MiB} MiB (now ${(a.realBytes / MiB).toFixed(1)} MiB)`).toBeLessThan(64)
    const v = (await kea.views()).find((x) => x.ptyId === ptyId)!
    const parts: string[] = []
    for (let row = 1; row <= v.rows; row++) {
      parts.push(`\x1b[${row};1H`)
      for (let col = 0; col < v.cols; col++, nextColour++) {
        const c = Math.imul(nextColour, 2654435761) & 0xffffff
        parts.push(`\x1b[38;2;${c >> 16};${(c >> 8) & 0xff};${c & 0xff}m${String.fromCharCode(65 + (nextColour % 26))}`)
      }
    }
    parts.push('\x1b[0m')
    await page.evaluate((d) => (window as unknown as { __keaProbe: { write(d: string): Promise<void> } }).__keaProbe.write(d), parts.join(''))
    await frames(kea)
  }
}

/** Run a command as the menu bar does (main's menu item), once the renderer's menu state has enabled it. */
async function menuCommand(kea: Kea, id: string): Promise<void> {
  await until(`the menu bar's ${id} item, enabled`, () =>
    kea.app.evaluate(({ Menu }, cmd) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(cmd)
      if (!item?.enabled) return undefined
      item.click()
      return true
    }, id),
  )
}

/** The GPU helper's footprint: the median of three readings. */
async function gpuFootprint(gpu: ProcInfo): Promise<number> {
  const r: number[] = []
  for (let i = 0; i < 3; i++) r.push(await footprint(gpu))
  return median(r)
}

describe('terminal atlas guards (app)', () => {
  it('L-TERM-7 · every WebGL view’s guard counts exactly the pages of the atlas it shares — the view that created it, three that join it, one whose context was lost and reloaded — and after a clear no WebGL context, shown or warm, keeps a texture of an evicted page', async (ctx) => {
    const { kea, ids } = await start(1)
    skipWhere(ctx, await kea.webglProblem())
    const page = await kea.page()
    const first = ids[0] as string
    // 1. the view that created the atlas: its renderer made it in its constructor, before the addon's forwards existed
    await fillAtlas(kea, first, 2 * MiB)
    await expectGuardsExact(kea, [first], 'the view that created the atlas')
    // 2. three more views, each created while the atlas has pages, join it (same font and colours); the first is warm
    const all = [first]
    for (let i = 0; i < L.warmTerminals; i++) {
      all.push(await kea.newTab())
      await kea.waitScreen('the new tab’s prompt', (s) => s.includes(PROMPT))
      await frames(kea)
      await expectGuardsExact(kea, all, `${all.length} views on the atlas`)
    }
    const shown = all.at(-1) as string
    // 3. the context of the view on screen is lost: the DOM renderer draws, WebGL comes back the next frame and its
    // renderer joins the atlas the warm views still hold
    await page.evaluate((id) => ((window as unknown as { __lterm7Canvas: unknown }).__lterm7Canvas = (window as unknown as AtlasProbes).__keaProbe.glCanvas(id)), shown)
    await loseWebglContext(kea, shown)
    await page.waitForFunction(
      (id) => {
        const c = (window as unknown as AtlasProbes).__keaProbe.glCanvas(id)
        return c !== null && c !== (window as unknown as { __lterm7Canvas: unknown }).__lterm7Canvas
      },
      shown,
      { polling: 'raf', timeout: STEP_MS },
    )
    await frames(kea)
    await expectGuardsExact(kea, all, 'after the context-loss reload')
    // 4. a bigger atlas, drawn by every view in turn, so each WebGL context holds a texture of every page
    await fillAtlas(kea, shown, 48 * MiB)
    for (const id of [...all.slice(0, -1), shown]) {
      await kea.clickTab(id)
      await frames(kea)
    }
    const drawn = await expectGuardsExact(kea, all, 'after every view drew the atlas')
    // (a page added after a view drew, by the next one's prompt, is the only one it may lack)
    for (const [i, a] of drawn.entries()) expect(a.real.filter((p) => !a.textures.includes(p)).length, `${all[i]}'s context holds a texture of every page`).toBeLessThanOrEqual(1)
    const gpu = await kea.pid('gpu')
    const gpuBefore = await gpuFootprint(gpu)
    // 5. "Reset Terminal Rendering" clears the atlas: every page is evicted and the warm contexts, which draw nothing
    // while hidden, must still let go of their textures of those pages
    const evicted = new Set(drawn[0]!.real)
    await menuCommand(kea, 'terminal.resetRendering')
    await until('the atlas evicted', async () => (await atlasOf(kea, shown)).real.every((p) => !evicted.has(p)) || undefined)
    await frames(kea)
    const after = await expectGuardsExact(kea, all, 'after the clear')
    const views = await kea.views()
    for (const id of all) expect(views.find((v) => v.ptyId === id)?.atlas.clears.reset, `${id} cleared its atlas on the command`).toBe(1)
    const gpuAfter = await gpuFootprint(gpu)
    const held = after.map((a, i) => `${all[i]}: ${a.textures.filter((p) => evicted.has(p)).length} of ${evicted.size} evicted pages`)
    console.info(
      `L-TERM-7: atlas ${(drawn[0]!.realBytes / MiB).toFixed(0)} MiB in ${evicted.size} pages, drawn by ${all.length} contexts; GPU helper ${(gpuBefore / MiB).toFixed(0)} MiB before the clear, ${(gpuAfter / MiB).toFixed(0)} MiB after; textures of evicted pages still held: ${held.join(', ')}`,
    )
    for (const [i, a] of after.entries()) expect(a.textures.filter((p) => evicted.has(p)), `${all[i]}'s context holds no texture of an evicted page`).toEqual([])
    await kea.assertUnfocused()
  })

  it('L-TERM-8 · each atlas clear through its real trigger — the window’s pixel ratio changing and changing back, a font size change and back, the machine waking, “Reset Terminal Rendering” — clears the atlas of every WebGL view, shown or warm, once per event: the pages it had are gone, every guard counts exactly the atlas that follows, and no context keeps a texture of a page that went', async (ctx) => {
    const { kea, ids } = await start(2)
    skipWhere(ctx, await kea.webglProblem())
    const page = await kea.page()
    const shown = ids.at(-1) as string
    const views = async () => (await kea.views()).filter((v) => ids.includes(v.ptyId))
    expect((await views()).map((v) => v.webgl), 'the terminal on screen and the warm one hold WebGL').toEqual([true, true])
    /** Each view's clears for one reason, by ptyId. */
    const clearsOf = async (reason: string) => Object.fromEntries((await views()).map((v) => [v.ptyId, v.atlas.clears[reason] ?? 0]))
    const cdp = await page.context().newCDPSession(page)
    const dpr = await page.evaluate(() => window.devicePixelRatio)
    const ratioIs = (want: number) => until(`devicePixelRatio ${want}`, async () => (await page.evaluate(() => window.devicePixelRatio)) === want || undefined)
    const triggers: { reason: string; what: string; events: number; fire: () => Promise<void> }[] = [
      {
        // moving the window to a display of another density, as Chromium sees it: the device scale factor changes
        reason: 'dpr',
        what: 'the pixel ratio changing and changing back',
        events: 2,
        fire: async () => {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: dpr === 1 ? 2 : 1, mobile: false })
          await ratioIs(dpr === 1 ? 2 : 1)
          await frames(kea)
          await cdp.send('Emulation.clearDeviceMetricsOverride')
          await ratioIs(dpr)
        },
      },
      {
        reason: 'font',
        what: '“Increase Font Size” and “Reset Font Size”',
        events: 2,
        fire: async () => {
          await menuCommand(kea, 'terminal.fontBigger')
          await frames(kea)
          await menuCommand(kea, 'terminal.fontReset')
        },
      },
      {
        // main's powerMonitor `resume`, as the system sends it on wake
        reason: 'wake',
        what: 'the machine waking',
        events: 1,
        fire: async () => {
          await kea.app.evaluate(({ powerMonitor }) => {
            powerMonitor.emit('resume')
          })
        },
      },
      { reason: 'reset', what: '“Reset Terminal Rendering”', events: 1, fire: () => menuCommand(kea, 'terminal.resetRendering') },
    ]
    for (const t of triggers) {
      // an atlas with pages and glyphs, drawn by both contexts (the warm one draws only while it is on screen)
      await fillAtlas(kea, shown, 2 * MiB)
      for (const id of [...ids.filter((x) => x !== shown), shown]) {
        await kea.clickTab(id)
        await frames(kea)
      }
      const before = await expectGuardsExact(kea, ids, `before ${t.what}`)
      for (const [i, a] of before.entries()) expect(a.textures.length, `${ids[i]}'s context holds textures before ${t.what}`).toBeGreaterThan(0)
      const clears = await clearsOf(t.reason)
      const want = Object.fromEntries(ids.map((id) => [id, (clears[id] ?? 0) + t.events]))
      await t.fire()
      await until(`every WebGL view cleared its atlas on ${t.what}`, async () => {
        const now = await clearsOf(t.reason)
        return ids.every((id) => (now[id] ?? 0) >= want[id]!) || undefined
      })
      await frames(kea)
      expect(await clearsOf(t.reason), `${t.reason} clears per view after ${t.what}, once per event`).toEqual(want)
      const gone = new Set(before.flatMap((a) => a.real))
      // (a hidden view measures a font change only once it is shown again, so the two may be on different atlases here)
      const after = await expectGuardsExact(kea, ids, `after ${t.what}`, { shared: false })
      for (const [i, a] of after.entries()) {
        expect(a.real.filter((p) => gone.has(p)), `${ids[i]}'s atlas after ${t.what} keeps none of the pages it had`).toEqual([])
        expect(a.textures.filter((p) => gone.has(p)), `${ids[i]}'s context after ${t.what} holds no texture of a page that went`).toEqual([])
      }
    }
    await cdp.detach()
    await kea.assertUnfocused()
  })
})

// L-TERM-3: a synthetic shimmer (tests/support/shimmer.ts) stands in for the recorded Claude Code cassette. The
// cassette's shimmer has only 7 colours, so its atlas stops growing at about 1 MiB and never reaches L.atlasGuardBytes;
// the synthetic one never repeats a colour, so the atlas grows without end (the worst case of xterm's per-cell
// truecolor atlas growth, https://github.com/xtermjs/xterm.js/issues/6074) and the guard has to keep clearing it.
// It runs 30 minutes, not the 2 hours of the GPU soak (`pnpm perf --long`): the guard cycles about every second once
// the atlas is past the threshold, so the GPU helper's level and flatness show well within the run.

/** L-TERM-3: its duration, the stretch over which the GPU helper must be flat, and the sampling period. */
const SHIMMER_MS = 30 * 60_000
const FLAT_MS = 20 * 60_000
const SAMPLE_MS = 10_000
/**
 * "No upward trend" of the GPU helper (P-GPU-2). The helper's footprint is a sawtooth: it rises about 250 MiB with
 * the atlas and falls at each guard clear, so a line through raw samples, or its last sample less its first, says where
 * in a tooth the window began and ended (the leak suites' default byte budget, BYTE_BUDGET, failed 18–37 % of the
 * 20-minute windows of two flat runs). The trend is judged on whole guard cycles instead, clear to clear, each one's
 * samples averaged. Those averages still scatter by about 10 MiB, so over FLAT_MS nothing under a slope of 1 MiB a
 * minute, 20 MiB in all, can be told from none: that is the budget, and the leak suites' rule stays (fail only if slope
 * and growth both exceed it). Slower growth is left to the hourly resource log of a day's use.
 */
const GPU_TREND = { slopePerMinute: 1 * MiB, absolute: 20 * MiB, minCycles: 6 }
/** Shimmer frames per second (Claude Code animates its spinner at about this rate). */
const SHIMMER_FPS = 30
/** L-TERM-3 needs the visible terminal plus the warm ones. */
const WARM_SET = 1 + L.warmTerminals

/** One sample: the visible terminal's real atlas, the views whose guard did not match it, every view's guard clears, the GPU helper. */
type Sample = { t: number; atlasBytes: number; atlasPages: number; mismatched: string[]; guardClears: number; gpu: number }

/**
 * The whole guard cycles in `samples` (a cycle: the samples between one guard clear and the next), each as its start
 * and its mean GPU-helper footprint. The first and the last group are cut by the window's ends, so they are left out.
 */
function guardCycles(samples: readonly Sample[]): { t: number; gpu: number }[] {
  const groups: Sample[][] = []
  for (const s of samples) {
    const g = groups.at(-1)
    if (g && g[0]!.guardClears === s.guardClears) g.push(s)
    else groups.push([s])
  }
  return groups.slice(1, -1).map((g) => ({ t: g[0]!.t, gpu: g.reduce((n, s) => n + s.gpu, 0) / g.length }))
}

describe('terminal atlas (app, Tier B, long)', () => {
  it.runIf(LONG)(
    'L-TERM-3 · 30 minutes of truecolor shimmer in the visible terminal with 3 warm terminals holding WebGL: every view’s guard counts exactly the pages of the atlas they share; each time the atlas passes L.atlasGuardBytes a guard clears it and its pages are released, so the atlas itself is never found above it; the GPU helper within P-GPU-2 and flat over the last 20 minutes',
    async () => {
      const { kea, ids } = await start(WARM_SET)
      // every tab visited once, so the other three are warm (alive, WebGL loaded); the first one shimmers on screen
      for (const id of ids) await kea.clickTab(id)
      const visible = ids[0] as string
      await kea.clickTab(visible)
      const views = await kea.views()
      expect(views.filter((v) => v.webgl).map((v) => v.ptyId).sort(), 'the visible terminal and three warm ones hold WebGL').toEqual([...ids].sort())
      await kea.enter(`${process.execPath} ${path.join(repoRoot, 'tests/support/shimmer.ts')} ${SHIMMER_FPS}`)
      const gpu = await kea.pid('gpu')
      const samples: Sample[] = []
      const t0 = Date.now()
      // the atlas as its renderer holds it, not as the guards count it (they share it, and each guard must match it);
      // all four views at one instant (atlasesOf)
      const sample = async () => {
        const atlases = await atlasesOf(kea, ids)
        const real = atlases[0]!
        const mismatched = ids.filter((_, i) => JSON.stringify(atlases[i]!.guard) !== JSON.stringify(real.real) || atlases[i]!.atlas !== real.atlas)
        const clears = (await kea.views()).reduce((n, v) => n + (v.atlas.clears.guard ?? 0), 0)
        samples.push({ t: Date.now() - t0, atlasBytes: real.realBytes, atlasPages: real.real.length, mismatched, guardClears: clears, gpu: await footprint(gpu) })
      }
      // a measurement window the test defines, not a wait for a condition: a sample every SAMPLE_MS for SHIMMER_MS
      while (Date.now() - t0 < SHIMMER_MS) {
        await sample()
        await new Promise((r) => setTimeout(r, SAMPLE_MS))
      }
      await sample()
      const mib = (b: number) => (b / 2 ** 20).toFixed(0)
      const report = samples.map((s) => `${Math.round(s.t / 1000)}s atlas ${mib(s.atlasBytes)} MiB/${s.atlasPages}p${s.mismatched.length ? ` guards off: ${s.mismatched.join(' ')}` : ''} clears ${s.guardClears} gpu ${mib(s.gpu)} MiB`).join('\n')
      const tail = samples.filter((s) => s.t >= SHIMMER_MS - FLAT_MS)
      const gpuOf = (ss: Sample[]) => ss.map((s) => s.gpu)
      console.info(
        `L-TERM-3: atlas max ${mib(Math.max(...samples.map((s) => s.atlasBytes)))} MiB, ${samples.at(-1)?.guardClears} guard clears (all views); GPU helper ${mib(Math.min(...gpuOf(samples)))}–${mib(Math.max(...gpuOf(samples)))} MiB, last ${FLAT_MS / 60_000} min ${mib(Math.min(...gpuOf(tail)))}–${mib(Math.max(...gpuOf(tail)))} MiB\n${report}`,
      )
      // every view's guard counts exactly the atlas's pages; an added page that takes the sum past the threshold queues
      // a clear, which runs before anything else does, and a clear evicts every page (patches/): no sample finds the
      // atlas itself above the threshold
      const off = samples.filter((s) => s.mismatched.length > 0).map((s) => `${Math.round(s.t / 1000)}s ${s.mismatched.join(' ')}`)
      expect(off, `samples where a guard's pages were not the atlas's:\n${report}`).toEqual([])
      const over = samples.filter((s) => s.atlasBytes > L.atlasGuardBytes).map((s) => `${Math.round(s.t / 1000)}s ${mib(s.atlasBytes)} MiB`)
      expect(over, `atlas samples above L.atlasGuardBytes:\n${report}`).toEqual([])
      expect(samples.at(-1)!.guardClears, `the shimmer took the atlas past L.atlasGuardBytes:\n${report}`).toBeGreaterThan(0)
      expect(tail.at(-1)!.guardClears, `the guard still clears in the last ${FLAT_MS / 60_000} minutes:\n${report}`).toBeGreaterThan(tail[0]!.guardClears)
      // the GPU helper: no upward trend over the last FLAT_MS, judged on whole guard cycles (GPU_TREND), and within
      // P-GPU-2; both are checked and reported
      const cycles = guardCycles(tail)
      expect.soft(cycles.length, `whole guard cycles in the last ${FLAT_MS / 60_000} minutes, enough to judge a trend:\n${report}`).toBeGreaterThanOrEqual(GPU_TREND.minCycles)
      const flat = byteVerdict({ cycles: cycles.map((c) => c.t / 60_000), points: cycles.map((c) => ({ counts: {}, bytes: { gpu: c.gpu } })) }, 'gpu', { slopePerCycle: GPU_TREND.slopePerMinute, absolute: GPU_TREND.absolute })
      expect
        .soft(
          flat.ok,
          `GPU helper without an upward trend over the last ${FLAT_MS / 60_000} minutes: per guard cycle ${cycles.map((c) => mib(c.gpu)).join(' ')} MiB (slope ${(flat.slopePerCycle / 2 ** 20).toFixed(2)} MiB/min, first to last ${(flat.growth / 2 ** 20).toFixed(1)} MiB):\n${report}`,
        )
        .toBe(true)
      expect.soft(Math.max(...gpuOf(samples)) / 2 ** 20, `GPU helper footprint within P-GPU-2:\n${report}`).toBeLessThanOrEqual((BUDGETS['P-GPU-2'] as { max: number }).max)
      await kea.assertUnfocused()
    },
    SHIMMER_MS + 5 * 60_000,
  )
})
