// The sidebar footer's update line in a real window: main's update states, sent to the window as main sends a change,
// drawn at the sidebar's default width and at the narrowest width that is not compact, where the whole line shows and
// its action is never cut or split across lines; in a compact sidebar the line is cut short and its tooltip says it all.

import type { Page } from '@playwright/test'
import type { UpdatePhase, UpdateState } from '@kea/protocol'
import type { Kea } from '../support/app.ts'
import { expect, test } from './fixtures.ts'

/** Main's update state with this phase, sent to every window as main sends a change. */
async function sendState(kea: Kea, phase: UpdatePhase, notice = false): Promise<void> {
  const state: UpdateState = { mode: 'updater', auto: true, command: null, why: null, phase, lastChecked: null, notice }
  await kea.app.evaluate(({ BrowserWindow }, s) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('kea:updateState', { state: s })
  }, state)
}

/**
 * The footer's update line as drawn: its text, the boxes whose text is cut short, those past the sidebar's edge, the lines
 * its action takes, and whether the action goes on from the end of the text (on its line, or at the start of the next).
 */
function drawn(page: Page) {
  return page.evaluate(() => {
    const line = document.querySelector<HTMLElement>('[data-update-line]')
    if (!line) return null
    const edge = line.closest('aside')!.getBoundingClientRect().right
    const boxes = [line, ...line.querySelectorAll<HTMLElement>('*')].filter((e) => (e.textContent ?? '').trim())
    const action = line.querySelector<HTMLElement>('.update-action')
    const lead = document.createRange()
    lead.selectNodeContents(line.querySelector('.update-open')!.firstChild!)
    const rects = [...lead.getClientRects()].filter((r) => r.width > 0)
    const [first, last] = [rects[0]!, rects.at(-1)!]
    const at = action?.getClientRects()[0]
    return {
      kind: line.dataset.updateLine,
      text: (line.textContent ?? '').replace(/\s+/g, ' ').trim(),
      cut: boxes.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.className),
      past: boxes.filter((e) => e.getBoundingClientRect().right > edge).map((e) => e.className),
      action: action ? { text: action.textContent, lines: action.getClientRects().length } : null,
      flows: at ? (Math.abs(at.top - last.top) < 1 && at.left >= last.right - 1) || (Math.abs(at.left - first.left) < 1 && at.top >= last.bottom - 1) : null,
      tip: line.querySelector('.update-open')?.getAttribute('data-tip') ?? null,
    }
  })
}

test('E-DST-5 · the footer’s update line: ready, updated, out and the one-time line show whole at the sidebar’s default width and at the narrowest width that is not compact, the action on one line; a compact sidebar cuts the line short and its tooltip has the whole wording', async ({ launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const size = (name: string) => page.evaluate((n) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--size-${n}`)), name)
  const [wide, compact, min] = await Promise.all(['sidebar', 'sidebar-compact', 'sidebar-min'].map(size))
  // sent until drawn: the window's own first ask for the state may be answered after a state sent at launch
  const show = (phase: UpdatePhase, kind: string, notice = false) =>
    expect
      .poll(async () => {
        await sendState(kea, phase, notice)
        return (await drawn(page))?.kind
      }, { message: `the ${kind} line drawn` })
      .toBe(kind)
  const widthIs = async (w: number) => {
    await kea.setLayout({ sidebarWidth: w })
    await expect.poll(async () => (await kea.layout()).drawn.sidebar, { message: `the sidebar drawn ${w} px wide` }).toBe(w)
  }

  const lines: { phase: UpdatePhase; notice?: boolean; kind: string; text: RegExp; action: string | null }[] = [
    { phase: { k: 'ready', version: '1.0.91' }, kind: 'ready', text: /^Kea 1\.0\.91 is ready — Restart to Update$/, action: 'Restart to Update' },
    { phase: { k: 'upgraded', version: '1.0.91' }, kind: 'upgraded', text: /^Kea was updated — Restart Kea$/, action: 'Restart Kea' },
    { phase: { k: 'available', version: '1.0.91' }, kind: 'out', text: /^Kea 1\.0\.91 is out$/, action: null },
    { phase: { k: 'idle' }, notice: true, kind: 'notice', text: /^Kea checks GitHub .+ for a newer version · Settings$/, action: 'Settings' },
  ]
  for (const width of [wide!, compact!]) {
    await widthIs(width)
    for (const l of lines) {
      await show(l.phase, l.kind, l.notice)
      const d = (await drawn(page))!
      const at = `${l.kind} at ${width} px`
      expect(d.text, at).toMatch(l.text)
      expect(d.cut, `${at}: nothing cut short`).toEqual([])
      expect(d.past, `${at}: nothing past the sidebar's edge`).toEqual([])
      if (l.action) expect(d.action, `${at}: the action whole, on one line`).toEqual({ text: l.action, lines: 1 })
      if (l.action) expect(d.flows, `${at}: the action goes on from the end of the text, or starts the next line under it`).toBe(true)
      expect(d.tip, `${at}: no tooltip where the line shows whole`).toBeNull()
    }
  }

  // compact: one line, cut short inside the sidebar (what is cut is clipped by the button), its whole wording in the tooltip
  await widthIs(min!)
  await show({ k: 'ready', version: '1.0.91' }, 'ready')
  expect((await drawn(page))!.tip).toBe('Kea 1.0.91 is ready — Restart to Update')
  const button = await page.evaluate(() => {
    const b = document.querySelector<HTMLElement>('[data-update-line] .update-open')!
    return { cut: b.scrollWidth > b.clientWidth, inside: b.getBoundingClientRect().right <= b.closest('aside')!.getBoundingClientRect().right, lines: b.getClientRects().length, height: b.clientHeight, line: parseFloat(getComputedStyle(b).lineHeight) }
  })
  expect(button).toEqual({ cut: true, inside: true, lines: 1, height: button.line, line: button.line })
})
