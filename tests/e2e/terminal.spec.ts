// The terminal journeys, in the `shells` pane (no project added), with Kea launched through tests/e2e/fixtures.ts
// (unfocused, temp KEA_HOME) and driven as a person drives it: keys, clicks on tabs and links, the Developer menu, the
// window's close button and the Dock icon. The renderer's test probes (app/renderer/src/lib/testProbes.ts) only
// observe, except for `setTheme`, which changes the window's theme colours. Continuity across a reload or a reopened
// window is checked at the seam between snapshot and live stream (`seamContinuous`).

import fs from 'node:fs'
import path from 'node:path'
import { runProcess } from '@kea/kit'
import { L } from '@kea/protocol'
import { BUDGETS } from '../../tools/perf/src/generated/budgets.ts'
import { counterCommand, counterNumbers, PROMPT, ringMax, shq, STEP_MS, until, writeFifo, type Kea, type KeaProbe } from '../support/app.ts'
import { holdersUnharmed, isAlive, lastOnScreen, ringContinuity, ringGrows, seamContinuous, startWorkload } from '../support/app-chaos.ts'
import { skipNote } from '../support/skip.ts'
import { loseWebglContext, startGlWatch, startRenderWatch, stopGlWatch, stopRenderWatch } from '../support/app-render.ts'
import { expect, test } from './fixtures.ts'
import { MOD_CLICK } from '../support/keys.ts'
import { NO_DOCK } from '../support/app-menubar.ts'

/** Counter lines per second: a reload and its recovery stay well inside the scrollback. */
const RATE = 4

test('E-TERM-2 · counters running in the visible and a warm tab, reload the window: both terminals continuous, no number missing or doubled', async ({ run, launch }) => {
  const kea = await launch()
  const w = await startWorkload(kea, RATE)
  // the second tab runs a counter too: it is warm (hidden, alive) when the window reloads
  await kea.clickTab(w.shell)
  await kea.enter(counterCommand(RATE))
  await kea.waitScreen('the warm tab’s counter', (s) => counterNumbers(s).length >= 2)
  await kea.clickTab(w.counter)
  const holders = run.holders()
  const seen = await lastOnScreen(kea)
  const warmSeen = ringMax(run, w.shell)

  await kea.reloadWindow()

  expect(await kea.tabIds(), 'both tabs back, in their order').toEqual([w.counter, w.shell])
  const visible = await seamContinuous(run, kea, w.counter, { before: seen })
  expect(visible.first, 'the buffer holds the visible counter from its first line').toBe(1)
  await kea.clickTab(w.shell)
  const warm = await seamContinuous(run, kea, w.shell, { before: warmSeen })
  expect(warm.first, 'the buffer holds the warm counter from its first line').toBe(1)
  holdersUnharmed(run, holders)
  ringContinuity(run, w.counter)
  ringContinuity(run, w.shell)
  await kea.assertUnfocused()
})

/** The program of E-PTY-1: raw tty, colour-scheme updates on (DECSET 2031), every byte it reads appended to a file. */
const PTY1_PROGRAM = `// E-PTY-1 (tests/e2e/terminal.spec.ts): on D it asks the colour scheme (CSI ? 996 n); on Q it exits
const fs = require('node:fs')
const fd = fs.openSync(process.argv[2], 'a')
process.stdin.setRawMode(true)
process.stdout.write('\\x1b[?2031hE-PTY-1 ready\\r\\n')
process.stdin.on('data', (d) => {
  fs.writeSync(fd, d)
  if (d.includes(0x44)) process.stdout.write('\\x1b[?996n')
  if (d.includes(0x51)) {
    process.stdin.setRawMode(false)
    process.exit(0)
  }
})
`

/** Colours of a light theme, which the test applies to the window's views through the test probe. */
const LIGHT = { background: '#FAFAFA', foreground: '#101010', cursor: '#101010' }

test('E-PTY-1 · a program turns on colour-scheme updates (CSI ? 2031 h), then the theme changes while its terminal is visible: the window writes no CSI ? 997 n and no other reply; the mirror answers the program’s CSI ? 996 n once', async ({ run, launch }) => {
  const kea = await launch()
  await kea.waitScreen('the shell prompt', (s) => s.includes(PROMPT))
  const program = path.join(run.home, 'e-pty-1.cjs')
  const record = path.join(run.home, 'e-pty-1.input')
  fs.writeFileSync(program, PTY1_PROGRAM)
  await kea.enter(`${process.execPath} ${program} ${record}`)
  await kea.waitScreen('the program ready', (s) => s.includes('E-PTY-1 ready'))
  const read = () => (fs.existsSync(record) ? fs.readFileSync(record, 'latin1') : '')

  const page = await kea.page()
  await page.evaluate((theme) => (window as unknown as { __keaProbe: { setTheme(t: unknown): void } }).__keaProbe.setTheme(theme), LIGHT)
  // sentinel: the program asks for the colour scheme; once the mirror's answer is in, the window's input that came
  // before it (typed D) is in too, and Q, typed after, ends the record
  await kea.type('D')
  await expect.poll(read, { message: 'the mirror’s answer to CSI ? 996 n' }).toMatch(/\x1b\[\?997;[12]n/)
  await kea.type('Q')
  await expect.poll(read, { message: 'Q recorded' }).toContain('Q')
  await kea.waitScreen('the shell prompt after the program', (s) => s.trimEnd().endsWith(PROMPT.trimEnd()))
  const got = read()
  // exactly: the typed D, the mirror's one report, the typed Q (no unsolicited report, no second answer, no reply)
  expect(JSON.stringify(got)).toMatch(/^"D\\u001b\[\?997;[12]nQ"$/)
  await kea.assertUnfocused()
})

/** E-TERM-4: terminals visited in turn. */
const TERMINALS = 6

test('E-TERM-4 · WebGL context lost on the terminal on screen, then 6 terminals visited in turn: the DOM renderer stands in at once and the new WebGL renderer paints the next frame; never more contexts than the cap allows; warm terminals kept with WebGL, the others rebuilt from snapshots', async ({ launch }) => {
  const kea = await launch()
  await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
  const ids = [(await kea.shown()) as string]
  for (let i = 1; i < TERMINALS; i++) ids.push(await kea.newTab())
  // every terminal shows its own marker over a screenful of text, so a view rebuilt from a snapshot can be recognised
  for (const [i, id] of ids.entries()) {
    await kea.clickTab(id)
    await kea.enter(`for i in {1..30}; do echo "E-TERM-4 terminal ${i} line $i"; done`)
    await kea.waitScreen(`terminal ${i}'s lines`, (s) => s.includes(`E-TERM-4 terminal ${i} line 30`))
  }
  const noGl = await kea.webglProblem()
  test.skip(noGl !== null, skipNote(noGl ?? ''))
  await startGlWatch(kea)

  // 1. the context of the terminal on screen is lost (as on a GPU reset)
  const shown = ids[ids.length - 1] as string
  const before = (await kea.views()).find((v) => v.ptyId === shown)!
  await startRenderWatch(kea, shown)
  await loseWebglContext(kea, shown)
  await expect.poll(async () => (await kea.views()).find((v) => v.ptyId === shown)?.webgl, { message: 'WebGL back on the terminal on screen' }).toBe(true)
  const ev = await stopRenderWatch(kea)
  const lost = ev.find((e) => e.kind === 'lost')
  expect(lost, `the loss reached the page (${JSON.stringify(ev)})`).toBeDefined()
  const dom = ev.find((e) => e.kind === 'dom')
  const gl = ev.find((e) => e.kind === 'gl')
  // the DOM renderer is installed as the event is handled; in the next frame WebGL is back before xterm renders, so the
  // new WebGL renderer paints the whole terminal in that frame, the frame it is made in (the frames between the loss
  // and the event are Chromium's: it dispatches `webglcontextlost` as a later task)
  expect(dom?.frame, `DOM renderer installed on the event (${JSON.stringify(ev)})`).toBe(lost!.frame)
  const nextPaint = ev.find((e) => e.kind === 'render' && e.frame > lost!.frame)
  expect(nextPaint?.frame, `the terminal painted in the next frame (${JSON.stringify(ev)})`).toBe(lost!.frame + 1)
  expect(gl, `a WebGL canvas again (${JSON.stringify(ev)})`).toBeDefined()
  const glPaint = ev.slice(ev.indexOf(gl!)).find((e) => e.kind === 'render')
  expect(glPaint?.frame, `the new WebGL renderer paints the frame it is made in (${JSON.stringify(ev)})`).toBe(gl!.frame)
  const after = (await kea.views()).find((v) => v.ptyId === shown)!
  expect(after.instance, 'the same terminal, not a new one').toBe(before.instance)
  await kea.waitScreen('the terminal’s text after the loss', (s) => s.includes(`E-TERM-4 terminal ${TERMINALS - 1} line 30`))

  // 2. visit every terminal in turn, then four back. The terminal on screen plus the most recently viewed others that
  // are still alive, up to the warm count, stay alive with WebGL; everything else is rebuilt
  const order = [...ids, ...ids.slice(0, -1).reverse().slice(0, 4)]
  let mru = [shown, ...ids.slice(0, -1).reverse()] // most recently viewed first, as the tabs were opened and visited
  let alive = new Set((await kea.views()).map((v) => v.ptyId))
  expect(alive, 'the terminal on screen and the warm ones').toEqual(new Set(mru.slice(0, 1 + L.warmTerminals)))
  for (const id of order) {
    const i = ids.indexOf(id)
    const prev = (await kea.views()).find((v) => v.ptyId === id)
    await kea.debug('ptyhost', 'streams', 'reset')
    await kea.clickTab(id)
    await kea.waitScreen(`terminal ${i}'s text`, (s) => s.includes(`E-TERM-4 terminal ${i} line 30`))
    const streams = await kea.debug<{ snapshots: number }>('ptyhost', 'streams')
    const views = await kea.views()
    const now = views.find((v) => v.ptyId === id)!
    if (alive.has(id)) {
      expect(now.instance, `warm terminal ${i} kept, not rebuilt`).toBe(prev?.instance)
      expect(streams.snapshots, `no snapshot for warm terminal ${i}`).toBe(0)
    } else {
      expect(prev, `terminal ${i} was not alive`).toBeUndefined()
      expect(streams.snapshots, `terminal ${i} rebuilt from one snapshot`).toBe(1)
    }
    mru = [id, ...mru.filter((x) => x !== id)]
    const warm = mru.slice(1).filter((x) => alive.has(x)).slice(0, L.warmTerminals)
    alive = new Set([id, ...warm])
    expect(new Set(views.map((v) => v.ptyId)), `alive after visiting terminal ${i}: it and the warm ones`).toEqual(alive)
    expect(views.filter((v) => !v.webgl).map((v) => v.ptyId), 'every live terminal holds WebGL').toEqual([])
  }

  const g = await stopGlWatch(kea)
  expect(g.maxCounted, 'contexts counted by the views, at most the cap in every frame').toBeLessThanOrEqual(L.webglContextsMax)
  expect(g.maxAlive, 'contexts alive on the views’ canvases, at most the cap in every frame').toBeLessThanOrEqual(L.webglContextsMax)
  expect(g.maxAlive, 'the cap is reached: visible + warm').toBe(Math.min(TERMINALS, 1 + L.warmTerminals))
  expect(g.releasedAlive, `every released WebGL canvas lost its context first (${g.released} released)`).toBe(0)
  expect(g.lostOnShown, 'one context loss on the terminal on screen: the forced one').toBe(1)
  await kea.assertUnfocused()
})

test('E-TERM-9 · close the window with a counter running, then reopen it from the Dock: the renderer process is released while closed and everything else runs on; the reopened window reattaches within P-START-3, byte-exact at the seam', async ({ run, launch }) => {
  test.skip(NO_DOCK !== null, skipNote(NO_DOCK ?? ''))
  const kea = await launch()
  const w = await startWorkload(kea, RATE)
  const holders = run.holders()
  const before = await kea.processes()
  const seen = await lastOnScreen(kea)

  await kea.closeWindow()
  // No renderer while the window is closed; main, core, ptyhost and every holder run on
  await until('the renderer process to exit', () => !isAlive(before.renderer!.pid) || undefined)
  expect((await kea.appMetrics()).filter((m) => m.type === 'Tab'), 'renderer processes while closed').toEqual([])
  expect((await kea.mainCounts()).windows, 'windows while closed').toBe(0)
  const closed = await kea.processes()
  for (const k of ['main', 'core', 'ptyhost'] as const) expect(closed[k]?.pid, `${k} runs on`).toBe(before[k]?.pid)
  await ringGrows(run, w.counter)
  await until(`the counter past kc ${seen + 2 * RATE} with the window closed`, () => ringMax(run, w.counter) > seen + 2 * RATE || undefined)
  holdersUnharmed(run, holders)

  // "reopening is instant": no budget names it, so it is held to a cold launch's (P-START-3), which it must beat
  const { attachedMs } = await kea.reopenWindow()
  expect(attachedMs, `Dock click → terminal attached (P-START-3: ${BUDGETS['P-START-3'].max} ms)`).toBeLessThanOrEqual(BUDGETS['P-START-3'].max)
  const after = await kea.processes()
  expect(after.renderer?.pid, 'a new renderer').not.toBe(before.renderer?.pid)
  for (const k of ['main', 'core', 'ptyhost'] as const) expect(after[k]?.pid, `${k} untouched`).toBe(before[k]?.pid)
  expect(await kea.tabIds(), 'both tabs back, in their order').toEqual([w.counter, w.shell])
  await seamContinuous(run, kea, w.counter, { before: seen })
  await kea.clickTab(w.shell)
  await kea.echo('eterm9')
  holdersUnharmed(run, holders)
  ringContinuity(run, w.counter)
  await kea.assertUnfocused()
})

/**
 * Where `text` last appears on the terminal on screen (the lowest row: below the command line that printed it), as a
 * point in the middle of its second cell, inside `.xterm-screen`.
 */
async function cellOf(kea: Kea, text: string): Promise<{ x: number; y: number }> {
  return (await kea.page()).evaluate((t) => {
    type Core = { _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } } }
    const probe = (window as unknown as { __keaProbe: KeaProbe }).__keaProbe
    const id = document.querySelector('.terminal-host.shown')?.getAttribute('data-pty') ?? ''
    const term = probe.terminal(id)
    if (!term) throw new Error('no terminal on screen')
    const b = term.buffer.active
    const cell = (term as unknown as Core)._core._renderService.dimensions.css.cell
    for (let r = term.rows - 1; r >= 0; r--) {
      const c = (b.getLine(b.viewportY + r)?.translateToString(true) ?? '').indexOf(t)
      if (c >= 0) return { x: (c + 1.5) * cell.width, y: (r + 0.5) * cell.height }
    }
    throw new Error(`${t} is not on screen`)
  }, text)
}

/** The OSC 52 payload: a clipboard write a program in a terminal asks for. */
const OSC52_TEXT = 'kea-test osc52 payload'

test('E-TERM-10 · untrusted output: OSC 52 from a background terminal never reaches the clipboard; ⌘-click on an OSC 8 link to a non-web scheme opens nothing and offers Copy link, while a web link opens', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  // nothing here may reach the person's clipboard or browser: both ends are recorders from the start
  await page.evaluate(() => {
    const w = window as unknown as { __keaClipboard: string[]; __keaOpened: string[] }
    w.__keaClipboard = []
    w.__keaOpened = []
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (t: string) => void w.__keaClipboard.push(t) })
    window.open = (url?: string | URL) => (w.__keaOpened.push(String(url)), null)
  })
  const recorded = () =>
    page.evaluate(() => {
      const w = window as unknown as { __keaClipboard: string[]; __keaOpened: string[] }
      return { __keaClipboard: [...w.__keaClipboard], __keaOpened: [...w.__keaOpened] }
    })
  const dropped: string[] = []
  page.on('console', (m) => void (m.text().includes('OSC 52 clipboard write dropped') && dropped.push(m.text())))

  const shown = (await kea.shown()) as string
  await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
  const file = path.join(run.home, 'osc52.txt')
  fs.writeFileSync(file, `\x1b]52;c;${Buffer.from(OSC52_TEXT).toString('base64')}\x07osc52-done\n`)

  // a background terminal: a second tab, left warm (its view alive and parsing) when the first is shown again
  const bg = await kea.newTab()
  const fifo = path.join(run.home, 'go.fifo')
  expect((await runProcess('/usr/bin/mkfifo', [fifo], { pool: 'other' })).code).toBe(0) // os-ok: in /usr/bin on both systems
  await kea.enter(`read x < ${shq(fifo)} && cat ${shq(file)}`)
  await kea.clickTab(shown)
  expect((await kea.views()).find((v) => v.ptyId === bg), 'the background terminal is warm, not shown').toMatchObject({ shown: false, attached: true })
  await writeFifo(fifo, 'go\n')
  await until('the background terminal to have parsed the file', async () => (await kea.terminalText(bg)).includes('osc52-done') || undefined)
  await until('the dropped write to be logged', () => dropped.some((d) => d.includes(`terminal ${bg}`) && d.includes('(hidden)')) || undefined)

  // (The other dropped write, from a visible terminal in an unfocused window, cannot be seen from here: Playwright
  // emulates focus for the page it drives, so document.hasFocus() says yes. osc52Decision's unit tests cover it.)
  expect((await recorded()).__keaClipboard, 'clipboard writes').toEqual([])

  // OSC 8: a non-web target is shown on hover and offered for copying, never opened; a web link is opened
  await kea.enter('clear')
  await kea.enter(`printf '\\e]8;;x-kea-test://evil/path\\e\\\\evil-link\\e]8;;\\e\\\\  \\e]8;;https://example.invalid/kea-test\\e\\\\web-link\\e]8;;\\e\\\\\\n'`)
  // the output line itself (the command line above it names both words too)
  await kea.waitScreen('both links on screen', (s) => s.split('\n').some((l) => l.startsWith('evil-link  web-link')))
  const screen = page.locator('.terminal-host.shown .xterm-screen')
  const evil = await cellOf(kea, 'evil-link')
  await screen.hover({ position: evil })
  await expect(page.locator('[role=tooltip]', { hasText: 'x-kea-test://evil/path' }), 'the full target on hover').toBeVisible({ timeout: STEP_MS })
  await screen.click({ position: evil, modifiers: [MOD_CLICK] })
  await expect(page.locator('[role=menu]', { hasText: 'Copy link' }), '⌘-click offers Copy link').toBeVisible({ timeout: STEP_MS })
  expect((await recorded()).__keaOpened, 'opened by ⌘-click on the non-web link').toEqual([])
  await kea.press('Escape')
  await expect(page.locator('[role=menu]')).toHaveCount(0, { timeout: STEP_MS })
  const web = await cellOf(kea, 'web-link')
  await screen.hover({ position: web })
  await expect(page.locator('[role=tooltip]', { hasText: 'https://example.invalid/kea-test' })).toBeVisible({ timeout: STEP_MS })
  await screen.click({ position: web, modifiers: [MOD_CLICK] })
  await until('the web link to be opened', async () => (await recorded()).__keaOpened.length > 0 || undefined)
  expect((await recorded()).__keaOpened, 'only the web link opened').toEqual(['https://example.invalid/kea-test'])
  expect(kea.logLines('main').filter((l) => l.msg === 'link not opened'), 'no link reached main').toEqual([])
  expect((await recorded()).__keaClipboard, 'clipboard writes').toEqual([])
  await kea.assertUnfocused()
})
