// What the window shows frame by frame while terminals switch: never a blank frame. The renderer's own frames
// are recorded with CDP's screencast (every composited frame Chromium hands out while the test acks each one at once)
// and decoded afterwards by main's `nativeImage`, so the check reads pixels on screen, not DOM state.

import { L } from '@kea/protocol'
import { PROMPT, until, type Kea } from '../support/app.ts'
import { expect, test } from './fixtures.ts'

/** Shell tabs: more than the renderer keeps alive, so visiting them in turn makes every switch a cold one. */
const TABS = 2 + L.warmTerminals
/** Lines each tab prints: a screenful, so every terminal on screen has text over most of its area. */
const LINES = 60
/** Warm switches (back and forth between the two most recent tabs) and cold rounds (every tab in turn). */
const WARM_SWITCHES = 12
const COLD_ROUNDS = 2
/** A pixel is ink when its luminance differs from the area's median (the background) by more than this (0–255). */
const INK_DELTA = 40
/** A frame is blank when its ink is below this share of the median frame's (an empty grid has a prompt at most). */
const BLANK_SHARE = 0.25

type Frame = { data: string; at: number }
type Rect = { x: number; y: number; width: number; height: number }

/** Ink pixels per pixel of `rect` (CSS px of the page) in one screencast frame, decoded in main. */
async function inkOf(kea: Kea, f: Frame, rect: Rect, viewport: { width: number }): Promise<number> {
  return kea.app.evaluate(
    ({ nativeImage }, a) => {
      const img = nativeImage.createFromBuffer(Buffer.from(a.data, 'base64'))
      const { width, height } = img.getSize()
      const px = img.toBitmap() // BGRA
      const k = width / a.viewport.width
      const x0 = Math.max(0, Math.floor(a.rect.x * k))
      const y0 = Math.max(0, Math.floor(a.rect.y * k))
      const x1 = Math.min(width, Math.ceil((a.rect.x + a.rect.width) * k))
      const y1 = Math.min(height, Math.ceil((a.rect.y + a.rect.height) * k))
      // a histogram of luminance: its median is the background, everything far from it is ink
      const hist = new Array<number>(256).fill(0)
      let n = 0
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4
          hist[Math.round((px[i + 2]! * 299 + px[i + 1]! * 587 + px[i]! * 114) / 1000)]!++
          n++
        }
      let bg = 0
      for (let acc = 0; bg < 255 && acc + hist[bg]! <= n / 2; bg++) acc += hist[bg]!
      let ink = 0
      for (let l = 0; l < 256; l++) if (Math.abs(l - bg) > a.delta) ink += hist[l]!
      return n ? ink / n : 0
    },
    { data: f.data, rect, viewport, delta: INK_DELTA },
  )
}

test('E-TERM-8 · switching terminals, warm and cold, shows no blank frame: in every frame the window composites, the terminal area carries a terminal’s text', async ({ launch }) => {
  const kea = await launch()
  await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
  const ids = [(await kea.shown()) as string]
  for (let i = 1; i < TABS; i++) ids.push(await kea.newTab())
  for (const [i, id] of ids.entries()) {
    await kea.clickTab(id)
    await until(`${id} attached`, async () => (await kea.views()).find((v) => v.ptyId === id)?.attached || undefined)
    await kea.enter(`for i in {1..${LINES}}; do echo "E-TERM-8 tab ${i} line $i abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789"; done`)
    await kea.waitScreen(`tab ${i}'s lines`, (s) => s.includes(`E-TERM-8 tab ${i} line ${LINES}`))
  }
  const page = await kea.page()
  const rect: Rect = await page.evaluate(() => {
    const r = document.querySelector('.terminal-area')!.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  const viewport = await page.evaluate(() => ({ width: window.innerWidth }))

  const cdp = await page.context().newCDPSession(page)
  const frames: Frame[] = []
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ data: f.data, at: Date.now() })
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
  })
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 1000, maxHeight: 1000, everyNthFrame: 1 })
  await until('the first screencast frame', () => frames.length > 0 || undefined)

  // the switches, each one's start and end noted so every frame can be told apart
  const switches: { kind: 'warm' | 'cold'; to: string; from: number; until: number }[] = []
  const go = async (kind: 'warm' | 'cold', id: string) => {
    const views = await kea.views()
    expect(views.some((v) => v.ptyId === id), `a ${kind} switch to ${id}`).toBe(kind === 'warm')
    const from = Date.now()
    await kea.clickTab(id)
    await kea.waitScreen(`${id}'s text`, (s) => s.includes(`E-TERM-8 tab ${ids.indexOf(id)} line ${LINES}`))
    switches.push({ kind, to: id, from, until: Date.now() })
  }
  // warm: the two most recently viewed tabs, back and forth (both alive, with WebGL)
  const [a, b] = [ids.at(-2) as string, ids.at(-1) as string]
  for (let i = 0; i < WARM_SWITCHES; i++) await go('warm', i % 2 === 0 ? a : b)
  // cold: always the least recently viewed tab, whose view the renderer has evicted (one more tab than it keeps alive)
  let mru = [b, a, ...ids.slice(0, -2).reverse()]
  for (let i = 0; i < COLD_ROUNDS * TABS; i++) {
    const id = mru.at(-1) as string
    await go('cold', id)
    mru = [id, ...mru.filter((x) => x !== id)]
  }
  await cdp.send('Page.stopScreencast')
  await cdp.detach()
  expect(switches.filter((s) => s.kind === 'cold').length, 'cold switches made').toBeGreaterThanOrEqual(TABS)

  // every frame from the first switch on, read for ink
  const t0 = switches[0]!.from
  const seen = frames.filter((f) => f.at >= t0)
  const ink: number[] = []
  for (const f of seen) ink.push(await inkOf(kea, f, rect, viewport))
  const median = [...ink].sort((p, q) => p - q)[ink.length >> 1] ?? 0
  const blank = ink.flatMap((v, i) => (v < BLANK_SHARE * median ? [`frame ${i} at +${seen[i]!.at - t0} ms: ink ${(v * 100).toFixed(2)} %`] : []))
  const during = switches.map((s) => seen.filter((f) => f.at >= s.from && f.at <= s.until + 50).length)
  console.info(`E-TERM-8: ${switches.length} switches (${switches.filter((s) => s.kind === 'cold').length} cold), ${seen.length} frames, ink median ${(median * 100).toFixed(2)} %, min ${(Math.min(...ink) * 100).toFixed(2)} %; frames per switch ${during.join(' ')}`)
  expect(median, 'a terminal’s text covers part of the terminal area').toBeGreaterThan(0.01)
  expect(during.filter((n) => n > 0).length, 'switches during which the screencast caught a frame').toBeGreaterThanOrEqual(switches.length / 2)
  expect(blank, 'blank frames in the terminal area').toEqual([])
  await kea.assertUnfocused()
})
