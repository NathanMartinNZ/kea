// Leak cycles of the terminal's theme and screen-reader mode against the real app (tests/support/app.ts), measured with
// tests/support/app-leak.ts. The first test switches the theme the way the Settings sheet does (`settings.set`, core
// writes settings.json and every window follows) with warm terminals holding drawn text; the second visits sessions and
// tabs while main says a screen reader runs (its test seam).

import { afterEach, describe, expect, it } from 'vitest'
import type { Page } from '@playwright/test'
import { L } from '@kea/protocol'
import { THEMES } from '@kea/terminal'
import { median } from '../../tools/perf/src/stats.ts'
import { footprint, KeaRun, PROMPT, STEP_MS, until, type Kea } from '../support/app.ts'
import { expectBytesFlat, expectCountsFlat, RendererProbe, runCycles } from '../support/app-leak.ts'
import { addProject, demoRepo, paneSession, selectSession, startSession, tabOf, waitLive } from '../support/app-sessions.ts'

const runs: KeaRun[] = []
const probes: RendererProbe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

const HEAPS = ['renderer.heap', 'core.heap', 'ptyhost.heap', 'main.heap']
const MiB = 2 ** 20
/**
 * The theme test's own budget for the renderer's and the GPU process's footprints. Each switch makes an atlas of 14–19
 * MiB and lets one go, and the GPU process's footprint read at rest scatters by ±35 MiB from one checkpoint to the next
 * (20 cycles: 267–333 MiB with nothing kept), far past the default BYTE_BUDGET. One atlas kept every tenth switch is
 * still 1.4 MiB a cycle and 80 MiB over the run: it fails this.
 */
const FOOTPRINT = { slopePerCycle: 1 * MiB, absolute: 32 * MiB }

/** `n` animation frames: what the last change asked to draw has been drawn. */
const frames = (page: Page, n = 2): Promise<void> =>
  page.evaluate(
    (k) =>
      new Promise<void>((resolve) => {
        const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
        step(k)
      }),
    n,
  )

/** A WebGL view's atlas (app/renderer/src/lib/testProbes.ts `atlas`): page canvases as numbers. */
type AtlasProbe = { atlas: number; guard: number[]; guardBytes: number; real: number[]; realBytes: number; textures: number[] }
type Probe = {
  atlas(id: string): AtlasProbe | null
  views(): { ptyId: string; shown: boolean; webgl: boolean; cols: number; rows: number }[]
  terminal(id: string): { options: { theme: { background?: string } } } | undefined
  write(d: string): Promise<void>
  call(method: string, args: unknown): Promise<unknown>
}
const probe = (): Probe => (globalThis as unknown as { __keaProbe: Probe }).__keaProbe

/**
 * A screenful of characters in the view on screen, every cell in a colour of its own (an odd multiplier is a bijection
 * on 24 bits, so no colour comes back): each cell a glyph of its own in the atlas. The same screenful every time: drawn
 * after a theme change, every glyph of it is new to the atlas of the new colours, and what that atlas holds then does
 * not depend on whether the frame that redrew the old screen in the new colours came before the write (with a new set
 * of colours each time it did and did not, and the atlas held 14 or 15 pages at random).
 */
async function screenful(page: Page): Promise<void> {
  let nextColour = 1
  const v = await page.evaluate(() => (globalThis as unknown as { __keaProbe: Probe }).__keaProbe.views().find((x) => x.shown))
  if (!v) throw new Error('no terminal on screen')
  const parts: string[] = ['\x1b[H']
  for (let row = 1; row <= v.rows; row++) {
    parts.push(`\x1b[${row};1H`)
    for (let col = 0; col < v.cols; col++, nextColour++) {
      const c = Math.imul(nextColour, 2654435761) & 0xffffff
      parts.push(`\x1b[38;2;${c >> 16};${(c >> 8) & 0xff};${c & 0xff}m${String.fromCharCode(65 + (nextColour % 26))}`)
    }
  }
  parts.push('\x1b[0m')
  await page.evaluate((d) => (globalThis as unknown as { __keaProbe: Probe }).__keaProbe.write(d), parts.join(''))
  await frames(page)
}

describe('terminal modes (app)', () => {
  it('L-TERM-10 · the theme switched Kea Dark ↔ Kea Light ×60 with the terminal on screen and three warm ones holding drawn text, a screenful of new glyphs drawn between switches: at every checkpoint one glyph atlas, its bytes and pages those of the first, no context holding a texture of a page that is not the atlas’s, live canvases equal; every count equal; heaps within budget, the renderer’s and the GPU process’s footprints within the row’s own', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea: Kea = await run.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    for (let i = 0; i < L.warmTerminals; i++) {
      await kea.newTab()
      await kea.waitScreen('the new tab’s prompt', (s) => s.includes(PROMPT))
    }
    const page = await kea.page()
    const ids = await kea.tabIds()
    expect(ids).toHaveLength(1 + L.warmTerminals)
    // every tab drawn with text of its own, so the three that are not on screen are warm (alive, WebGL loaded) and hold it
    for (const id of ids) {
      await kea.clickTab(id)
      await screenful(page)
    }
    const shown = ids.at(-1) as string
    await kea.clickTab(shown)
    const views = await page.evaluate(() => (globalThis as unknown as { __keaProbe: Probe }).__keaProbe.views())
    expect(views.filter((v) => ids.includes(v.ptyId)).map((v) => v.webgl), 'the terminal on screen and the warm ones hold WebGL').toEqual(ids.map(() => true))
    const renderer = await RendererProbe.open(kea, { classes: ['Terminal', 'WebglAddon'] })
    probes.push(renderer)
    const gpu = await kea.pid('gpu')
    const rendererProc = await kea.pid('renderer')

    const setTheme = (theme: 'kea-dark' | 'kea-light') => page.evaluate((t) => (globalThis as unknown as { __keaProbe: Probe }).__keaProbe.call('settings.set', { key: 'terminal.theme', value: t }), theme)
    const themed = (theme: 'kea-dark' | 'kea-light') =>
      until(`every terminal drawn with ${theme}`, () =>
        page.evaluate(
          ([want, all]) => all.every((id) => ((globalThis as unknown as { __keaProbe: Probe }).__keaProbe.terminal(id)?.options.theme.background ?? '').toLowerCase() === want.toLowerCase()) || undefined,
          [THEMES[theme].background, ids] as const,
        ),
      )
    const atlases = (): Promise<AtlasProbe[]> =>
      page.evaluate((all) => all.map((id) => (globalThis as unknown as { __keaProbe: Probe }).__keaProbe.atlas(id)).filter((a): a is AtlasProbe => a !== null), ids)
    const median3 = async (f: () => Promise<number>): Promise<number> => median([await f(), await f(), await f()])

    const leak = await runCycles({
      kea,
      renderer,
      // a round is there and back: every checkpoint is taken on Kea Dark, as the baseline is; three rounds a batch, so
      // a footprint's slope is read over 60 switches (30 are too few to tell one from the GPU process's scatter)
      warmup: 4,
      batch: 6,
      cycle: async (i) => {
        const to = i % 2 === 0 ? 'kea-light' : 'kea-dark'
        await setTheme(to)
        await themed(to)
        await frames(page)
        await screenful(page)
      },
      quiesce: async () => {
        expect(await kea.shown()).toBe(shown)
        await frames(page)
      },
      extra: async () => {
        const as = await atlases()
        const current = new Set(as.find((_, n) => ids[n] === shown)?.real ?? [])
        const counts = {
          // one atlas for every view at rest (same font, same colours), and what it holds
          'renderer.atlasesAtRest': new Set(as.map((a) => a.atlas)).size,
          'renderer.atlasRealPages': as[0]?.real.length ?? 0,
          'renderer.atlasRealBytes': as[0]?.realBytes ?? 0,
          // the guards count exactly that atlas
          'renderer.guardsOff': as.filter((a) => a.guardBytes !== a.realBytes || a.guard.join() !== a.real.join()).length,
          // textures of a page that is not the atlas's: of an atlas left behind
          // (so every texture a context holds is of a page of the one atlas, whose pages are counted above; how many
          // of them a context holds follows what it drew last: a page added after it drew is one it does not have yet)
          'renderer.staleTextures': as.reduce((n, a) => n + a.textures.filter((p) => !current.has(p)).length, 0),
          // every canvas alive in the page: the views' WebGL canvases and the atlas's page canvases
          'renderer.liveCanvases': await renderer.liveObjects('HTMLCanvasElement'),
        }
        await renderer.settle()
        return { counts, bytes: { 'renderer.footprint': await median3(() => footprint(rendererProc)), 'gpu.footprint': await median3(() => footprint(gpu)) } }
      },
    })
    expect(leak.cycles.at(-1)).toBe(60)
    const series = (k: string) => leak.points.map((p) => p.counts[k])
    expect(series('renderer.atlasesAtRest'), 'glyph atlases at rest').toEqual(leak.points.map(() => 1))
    expect(series('renderer.staleTextures'), 'textures of pages left behind').toEqual(leak.points.map(() => 0))
    expect(series('renderer.guardsOff'), 'guards that do not count their atlas').toEqual(leak.points.map(() => 0))
    expectCountsFlat(leak, () => true)
    const mib = (k: string) => leak.points.map((p) => ((p.bytes[k] ?? NaN) / 2 ** 20).toFixed(1)).join(' ')
    console.log(`L-TERM-10: footprints at each checkpoint (MiB): renderer ${mib('renderer.footprint')}; GPU ${mib('gpu.footprint')}`)
    await expectBytesFlat(kea, renderer, leak, HEAPS, 'L-TERM-10')
    await expectBytesFlat(kea, renderer, leak, ['renderer.footprint', 'gpu.footprint'], 'L-TERM-10 (footprints)', FOOTPRINT)
  })

  it('L-TERM-11 · with a screen reader reported on, 100 visits across two sessions and their tabs, more terminals than Kea keeps warm (L.warmTerminals): at each only the terminal on screen holds a screen-reader copy, and the copy of each terminal that left the screen is released (DOM nodes, listeners and every other count equal at every checkpoint); with the screen reader off no terminal holds one; heaps within budget', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea: Kea = await run.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    await addProject(kea, demoRepo(run).root)
    const page = await kea.page()
    const sessions: string[] = []
    for (const name of ['reader one', 'reader two']) {
      const id = await startSession(kea, name)
      await waitLive(kea, id)
      sessions.push(id)
    }
    // each session's Agent tab and a shell tab of its own: four terminals to visit, five with the first shell
    const visits: { session: string; pty: string }[] = []
    for (const id of sessions) {
      await selectSession(kea, id)
      visits.push({ session: id, pty: await tabOf(kea, 'agent') })
      visits.push({ session: id, pty: await kea.newTab() })
    }
    expect(run.holders().length, 'more terminals than the warm set and the one on screen').toBeGreaterThan(1 + L.warmTerminals)
    const screenReader = (on: boolean) => kea.app.evaluate((_e, v) => (globalThis as unknown as { __keaTest: { screenReader(on: boolean): void } }).__keaTest.screenReader(v), on)
    const copies = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.terminal-host[data-pty]')].filter((h) => h.querySelector('.xterm-accessibility') !== null).map((h) => h.dataset.pty ?? ''))
    await screenReader(true)
    const visit = async (v: { session: string; pty: string }): Promise<void> => {
      if ((await paneSession(page)) !== v.session) await selectSession(kea, v.session)
      if ((await kea.shown()) !== v.pty) await kea.clickTab(v.pty)
      await until(`${v.pty} on screen`, async () => (await kea.shown()) === v.pty || undefined)
      // the terminal on screen keeps the copy, and no other one does
      await until(`the screen-reader copy in ${v.pty} alone`, async () => {
        const c = await copies()
        return (c.length === 1 && c[0] === v.pty) || undefined
      })
    }
    const renderer = await RendererProbe.open(kea, { classes: ['Terminal'] })
    probes.push(renderer)
    const leak = await runCycles({
      kea,
      renderer,
      // a batch is one round of the four visits, so every checkpoint finds the same terminal on screen
      warmup: visits.length,
      batch: visits.length,
      cycle: async (i) => visit(visits[i % visits.length]!),
    })
    expect(leak.cycles.at(-1)).toBe(10 * visits.length)
    expectCountsFlat(leak, () => true)
    await expectBytesFlat(kea, renderer, leak, HEAPS, 'L-TERM-11')
    // the screen reader stops: no terminal keeps a copy, at once
    await screenReader(false)
    await until('no screen-reader copy left', async () => (await copies()).length === 0 || undefined, STEP_MS)
  })
})
