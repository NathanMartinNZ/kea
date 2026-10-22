// Leak cycles of the command palette against the real app (tests/support/app.ts), measured with
// tests/support/app-leak.ts. One session of a demo repository, its Agent terminal on screen; the palette is opened and
// closed in each of its five ways, in turn, so a batch is whole rounds of five and every checkpoint is taken in the
// same state: the palette closed, no file tab, the Agent terminal on screen.

import { afterEach, describe, expect, it } from 'vitest'
import type { Page } from '@playwright/test'
import { KeaRun, STEP_MS, until, type Kea } from '../support/app.ts'
import { expectBytesFlat, expectCountsFlat, RendererProbe, runCycles } from '../support/app-leak.ts'
import { finder, finderRows } from '../support/app-files.ts'
import { openPalette, palette, waitPalette } from '../support/app-palette.ts'
import { addProject, agentTerminal, demoRepo, startSession, waitLive } from '../support/app-sessions.ts'
import { closeViewer, viewerRows, waitViewer } from '../support/app-viewer.ts'
import { sysKey } from '../support/keys.ts'

const runs: KeaRun[] = []
const probes: RendererProbe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

const HEAPS = ['renderer.heap', 'core.heap', 'main.heap']
/** The ways the palette is opened and closed, one per cycle, in turn: a batch is a whole number of rounds of these. */
const WAYS = ['esc', 'command', 'file', 'argument', 'outside'] as const
/**
 * Rounds per batch: the test's 200 cycles over ten checkpoints. Fewer would do for the exact counts, but the renderer's
 * heap rises about 1.2 MB over the first fifty cycles and then stays (21 KB a cycle over 50 cycles; 0.7 KB over 200, 1.4 MB
 * in all): only a run this long tells a slope from that settling.
 */
const ROUNDS = 4

type Probe = { rpcPending(): number }
declare const __keaPerf: { resources(): Record<string, number> }

/** The window has no call of its own waiting on core (a finder query, a palette source's answer). */
const atRest = (page: Page) => until('no call of the window waiting on core', () => page.evaluate(() => (globalThis as unknown as { __keaProbe: Probe }).__keaProbe.rpcPending() === 0) || undefined)

/** The renderer's palette and tooltip rows now. */
const paletteRows_ = (page: Page) =>
  page.evaluate(() => {
    const r = __keaPerf.resources()
    return { open: r['renderer.paletteOpen'] ?? r.paletteOpen, candidates: r['renderer.paletteCandidates'] ?? r.paletteCandidates, rows: r['renderer.paletteRows'] ?? r.paletteRows, tooltips: r['renderer.tooltips'] ?? r.tooltips }
  })

/** A click low in the terminal on screen (the palette floats over its top): a press outside the palette. */
async function pressOutside(page: Page): Promise<void> {
  const host = page.locator('.terminal-host.shown')
  const box = await host.boundingBox()
  await host.click({ position: { x: 20, y: Math.max(20, (box?.height ?? 40) - 20) } })
}

describe('palette leaks (app)', () => {
  it('L-PAL-1 · the palette opened and closed in turn with ⌘⇧P and Esc, `>` and a command run, ⌘P and a file picked, an argument list (New Session in Project…) and ⌫ back, and a press outside: after each close no palette layer and nothing it held (paletteOpen, paletteCandidates and paletteRows 0, no call waiting), at most one tooltip; no PaletteData alive at any checkpoint; DOM nodes, listeners and every other count equal; heaps within budget', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea: Kea = await run.launch()
    await addProject(kea, demoRepo(run).root)
    const id = await startSession(kea, 'palette')
    await waitLive(kea, id)
    const agent = await agentTerminal(kea, id)
    const page = await kea.page()
    const renderer = await RendererProbe.open(kea, { classes: ['PaletteData', 'EditorView'] })
    probes.push(renderer)
    const closed = () => page.locator('.palette').waitFor({ state: 'detached', timeout: STEP_MS })
    const inTerminal = () => until('the keyboard in the terminal', () => page.evaluate(() => !!document.activeElement?.closest('.terminal-host.shown')) || undefined)
    let maxTooltips = 0
    const ways: Record<(typeof WAYS)[number], () => Promise<void>> = {
      // Esc closes it, the keyboard back where it was
      esc: async () => {
        await openPalette(kea)
        await waitPalette(kea, 'its first rows', (r) => r.length > 0)
        await page.keyboard.press('Escape')
      },
      // `>` lists the commands; ↵ runs the one that leads (it leaves the window as it was)
      command: async () => {
        await openPalette(kea)
        await page.keyboard.type('>focus terminal')
        await waitPalette(kea, 'Focus Terminal leads', (r) => r[0]?.id === 'terminal.focus')
        await page.keyboard.press('Enter')
      },
      // ⌘P is the finder; ↵ shows the file in the viewer's preview tab, closed again with Esc
      file: async () => {
        await openPalette(kea, sysKey('Meta+p'))
        await finder(page).waitFor({ timeout: STEP_MS })
        await page.keyboard.type('math')
        await until('src/math.js leads the finder', async () => (await finderRows(kea))[0]?.path === 'src/math.js' || undefined)
        await page.keyboard.press('Enter')
        await closed()
        await waitViewer(kea, 'src/math.js shown and coloured', (v) => v.ui.path === 'src/math.js' && v.text !== null && v.text.tokenised === v.text.lines && v.highlighter.pending === 0)
        await closeViewer(kea)
      },
      // a command that takes an argument lists its choices in the palette; ⌫ in the empty input goes back
      argument: async () => {
        await openPalette(kea)
        await page.keyboard.type('>new session in')
        await waitPalette(kea, 'New Session in Project… leads', (r) => r[0]?.id === 'session.newInProject')
        await page.keyboard.press('Enter')
        await waitPalette(kea, 'the projects to pick from', (r) => r.length === 1 && r[0]?.kind === 'choice')
        await page.keyboard.press('Backspace')
        await until('the palette back on all it lists', async () => (await page.locator('.palette').getAttribute('data-mode')) === 'all' || undefined)
        await page.keyboard.press('Escape')
      },
      // a press outside closes it, and the press goes where it was aimed
      outside: async () => {
        await openPalette(kea)
        await waitPalette(kea, 'its first rows', (r) => r.length > 0)
        await pressOutside(page)
      },
    }
    const leak = await runCycles({
      kea,
      renderer,
      warmup: WAYS.length,
      batch: ROUNDS * WAYS.length,
      cycle: async (i) => {
        await ways[WAYS[i % WAYS.length]!]()
        await closed()
        await inTerminal()
        await atRest(page)
        // nothing of the palette is held once it is closed (its report rows); one tooltip at most, ever
        const r = await paletteRows_(page)
        maxTooltips = Math.max(maxTooltips, r.tooltips as number)
        expect({ open: r.open, candidates: r.candidates, rows: r.rows }, `after closing it with ${WAYS[i % WAYS.length]}`).toEqual({ open: 0, candidates: 0, rows: 0 })
        expect(await page.locator('.palette, [role=dialog][aria-label="Go to File"]').count(), 'no palette layer').toBe(0)
      },
      // the canonical state: the Agent terminal on screen, no file tab, and only the viewer's own editors alive
      // (CodeMirror can keep one it destroyed for about a second)
      quiesce: async () => {
        expect(await kea.shown(), 'the Agent terminal on screen').toBe(agent)
        await until('only the viewer’s own editors alive', async () => (await renderer.liveObjects('__keaProbe.classes.EditorView')) === (await viewerRows(kea)).viewerEditors || undefined)
        await atRest(page)
      },
    })
    expect(leak.cycles.at(-1)).toBe(200)
    expect(maxTooltips, 'tooltips at any time (one at most)').toBeLessThanOrEqual(1)
    expect(leak.points.map((p) => p.counts['renderer.livePaletteData']), 'PaletteData alive at each checkpoint').toEqual(leak.points.map(() => 0))
    expect(leak.points.map((p) => p.counts['renderer.paletteOpen']), 'the palette open at each checkpoint').toEqual(leak.points.map(() => 0))
    expectCountsFlat(leak, () => true)
    await expectBytesFlat(kea, renderer, leak, HEAPS, 'L-PAL-1')
  })
})
