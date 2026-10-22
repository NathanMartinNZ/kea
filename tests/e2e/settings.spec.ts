// Settings: the sheet on ⌘, driven as a person drives it (the section list, a generated row's control, Esc), with the
// terminal behind it read through the renderer's probes and through the shell itself (`stty size` is the PTY's own
// answer). Kea runs through tests/e2e/fixtures.ts: unfocused, on the test's own KEA_HOME, whose HOME is the run's own
// empty folder, so the Ghostty config these tests write is the only one Kea can read.

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_TERMINAL_SETTINGS, L, PLATFORM_LINES, protocolOs, type PlatformReport } from '@kea/protocol'
import { THEMES } from '@kea/terminal'
import type { Locator, Page } from '@playwright/test'
import { harnessUserHome } from '../../tools/perf/src/launch.ts'
import { PROMPT, STEP_MS, until, type Kea, type KeaRun } from '../support/app.ts'
import { AGENT_MARK, claudeByDefault, fakeAgentTerminal, startFakeSession } from '../support/app-fake-agent.ts'
import { addProject, demoRepo, waitRow } from '../support/app-sessions.ts'
import { notifications } from '../support/app-status.ts'
import { expect, test } from './fixtures.ts'
import { sysKey } from '../support/keys.ts'
import { skipNote } from '../support/skip.ts'

/** What the harness writes (the shell pseudo-agent by default), as a person keeps it: with comments, a trailing comma and a key Kea does not know. */
const COMMENTED = `// my Kea settings
{
  "general": { "defaultAgent": "shell" },   // no agent CLI here
  /* the terminal */
  "terminal": {
    "cursorBlink": false, // steady
  },
  "zzz": { "keep": "me" },
}
`
const KEPT = ['// my Kea settings', '// no agent CLI here', '/* the terminal */', '"cursorBlink": false, // steady', '"zzz": { "keep": "me" }']

const settingsFile = (run: KeaRun) => path.join(run.home, 'settings.json')
const lower = (c: string) => c.toLowerCase()

/** The Settings sheet, opened with ⌘, on `section`. */
async function openSettings(page: Page, section: string): Promise<Locator> {
  await page.keyboard.press(sysKey('Meta+,'))
  const sheet = page.getByRole('dialog', { name: /^Settings: / })
  await expect(sheet).toBeVisible({ timeout: STEP_MS })
  await sheet.getByRole('tab', { name: section, exact: true }).click()
  await expect(page.getByRole('dialog', { name: `Settings: ${section}`, exact: true })).toBeVisible()
  return sheet
}

/** What every live terminal view draws with: its grid, its font size and its background, by ptyId. */
function drawn(kea: Kea): Promise<Record<string, { cols: number; rows: number; fontSize: number; background: string; instance: number }>> {
  return kea.page().then((page) =>
    page.evaluate(() => {
      const probe = (window as unknown as { __keaProbe: { views(): { ptyId: string; cols: number; rows: number; instance: number }[]; terminal(id: string): unknown } }).__keaProbe
      return Object.fromEntries(
        probe.views().map((v) => {
          const o = (probe.terminal(v.ptyId) as { options: { fontSize: number; theme: { background: string } } }).options
          return [v.ptyId, { cols: v.cols, rows: v.rows, instance: v.instance, fontSize: o.fontSize, background: o.theme.background }]
        }),
      )
    }),
  )
}

/** The PTY's own size, asked of the shell in the terminal on screen: `<tag> <rows> <cols>`. */
async function ptySize(kea: Kea, tag: string): Promise<{ rows: number; cols: number }> {
  await kea.enter(`echo ${tag} $(stty size)`)
  const re = new RegExp(`^${tag} (\\d+) (\\d+)$`, 'm')
  const screen = await kea.waitScreen(`the PTY's size (${tag})`, (s) => re.test(s))
  const m = re.exec(screen)!
  return { rows: Number(m[1]), cols: Number(m[2]) }
}

test('E-SET-1 · change the font size and the theme in Settings: every open terminal re-renders at once, the PTY sizes follow, nothing restarts; a value out of range is refused at its row and never written; the comments in settings.json are still there', async ({ run, launch }) => {
  fs.writeFileSync(settingsFile(run), COMMENTED)
  const kea = await launch()
  await kea.waitScreen('the shell prompt', (s) => s.includes(PROMPT))
  const page = await kea.page()
  const first = (await kea.shown()) as string
  const second = await kea.newTab()
  await kea.waitScreen('the second tab’s prompt', (s) => s.includes(PROMPT))
  const before = await drawn(kea)
  expect(Object.keys(before).sort(), 'both terminals are alive: one on screen, one warm').toEqual([first, second].sort())
  const size0 = await ptySize(kea, 'size0')
  expect(size0, 'the PTY has the size the terminal shows').toEqual({ rows: before[second]!.rows, cols: before[second]!.cols })
  const pids = { core: (await kea.pid('core')).pid, ptyhost: (await kea.pid('ptyhost')).pid }
  const holders = run.holders().map((h) => ({ ptyId: h.ptyId, pid: h.pid, childPid: h.childPid }))
  expect(holders).toHaveLength(2)

  // ── the font size ────────────
  const bigger = DEFAULT_TERMINAL_SETTINGS.fontSize + 6
  let sheet = await openSettings(page, 'Terminal')
  const fontSize = sheet.getByRole('spinbutton', { name: 'Font size' })
  await expect(fontSize).toHaveValue(String(DEFAULT_TERMINAL_SETTINGS.fontSize))
  await expect(sheet.getByRole('button', { name: 'Reset Font size to its default' }), 'at its default a row offers no Reset').toHaveCount(0)
  await fontSize.fill(String(bigger))
  await fontSize.press('Enter')
  // no Save button: it is in force at once, in the file and in every live terminal (the warm one too)
  await until('both terminals drawn with the new font size', async () => Object.values(await drawn(kea)).every((v) => v.fontSize === bigger) || undefined)
  await until('the terminal on screen refitted to fewer columns and rows', async () => {
    const now = (await drawn(kea))[second]!
    return (now.cols < before[second]!.cols && now.rows < before[second]!.rows) || undefined
  })
  await expect(sheet.getByRole('button', { name: 'Reset Font size to its default' })).toBeVisible()
  expect(fs.readFileSync(settingsFile(run), 'utf8')).toContain(`"fontSize": ${bigger}`)

  // a value outside the range is refused at the row, with the schema's message, and is never written
  await fontSize.fill(String(L.settingsFontSizeMax + 1))
  await fontSize.press('Enter')
  const refusal = sheet.locator('[data-setting="terminal.fontSize"]').getByRole('alert')
  await expect(refusal).toBeVisible({ timeout: STEP_MS })
  await expect(refusal).toContainText(String(L.settingsFontSizeMax))
  expect(fs.readFileSync(settingsFile(run), 'utf8')).toContain(`"fontSize": ${bigger}`)
  expect(Object.values(await drawn(kea)).map((v) => v.fontSize)).toEqual([bigger, bigger])
  await fontSize.fill(String(bigger))
  await fontSize.press('Enter')
  await expect(refusal).toHaveCount(0)

  // Esc closes the sheet and the keyboard is back in the terminal: the shell says what size its PTY has now
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  const after = (await drawn(kea))[second]!
  const size1 = await ptySize(kea, 'size1')
  expect(size1, 'the PTY was resized to the refitted grid').toEqual({ rows: after.rows, cols: after.cols })
  expect(size1.cols).toBeLessThan(size0.cols)
  // the warm terminal takes its new grid when it is shown (a hidden tab has no size), and its PTY follows
  await kea.clickTab(first)
  await until('the first terminal refitted', async () => (await drawn(kea))[first]!.cols === after.cols || undefined)
  expect(await ptySize(kea, 'size2'), 'the first terminal’s PTY too').toEqual({ rows: after.rows, cols: after.cols })

  // ── the theme ─────────────────
  sheet = await openSettings(page, 'Terminal')
  const preview = sheet.getByRole('img', { name: 'Preview' })
  await expect(preview).toHaveAttribute('data-theme', 'kea-dark')
  const theme = sheet.getByRole('combobox', { name: 'Theme' })
  await expect(theme.getByRole('option')).toHaveText(['Kea Dark', 'Kea Light', 'Match Ghostty config'])
  await theme.selectOption({ label: 'Kea Light' })
  const light = THEMES['kea-light'].background
  await until('both terminals drawn with the light theme', async () => Object.values(await drawn(kea)).every((v) => lower(v.background) === lower(light)) || undefined)
  await expect(preview, 'the preview follows').toHaveAttribute('data-theme', 'kea-light')
  await expect(preview).toHaveAttribute('data-background', light)
  // the padding around a terminal is its theme's background; Kea's own chrome keeps its tokens
  expect(lower(await page.evaluate(() => document.documentElement.style.getPropertyValue('--terminal-canvas')))).toBe(lower(light))

  // Reset: the font size is the default again, the key leaves the file, the grid comes back
  await sheet.getByRole('button', { name: 'Reset Font size to its default' }).click()
  await expect(sheet.getByRole('spinbutton', { name: 'Font size' })).toHaveValue(String(DEFAULT_TERMINAL_SETTINGS.fontSize))
  await until('the terminal on screen back on its first grid', async () => {
    const now = (await drawn(kea))[first]!
    return (now.cols === before[first]!.cols && now.rows === before[first]!.rows && now.fontSize === DEFAULT_TERMINAL_SETTINGS.fontSize) || undefined
  })
  await page.getByRole('dialog', { name: /^Settings: / }).getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toHaveCount(0)
  expect(await ptySize(kea, 'size3')).toEqual({ rows: before[first]!.rows, cols: before[first]!.cols })

  // ── One key changed at a time; the rest of the file is as the person wrote it ──
  const text = fs.readFileSync(settingsFile(run), 'utf8')
  for (const kept of KEPT) expect(text, `kept: ${kept}`).toContain(kept)
  expect(text).toContain('"theme": "kea-light"')
  expect(text, 'a reset key leaves the file').not.toContain('fontSize')
  expect(text.indexOf('"general"')).toBeLessThan(text.indexOf('"terminal"'))
  expect(text.indexOf('"terminal"')).toBeLessThan(text.indexOf('"zzz"'))

  // ── nothing restarted: the same processes, the same holders and programs, the same terminals ──────────
  expect({ core: (await kea.pid('core')).pid, ptyhost: (await kea.pid('ptyhost')).pid }).toEqual(pids)
  expect(run.holders().map((h) => ({ ptyId: h.ptyId, pid: h.pid, childPid: h.childPid }))).toEqual(holders)
  for (const h of run.holders()) expect(run.holderAlive(h), `holder ${h.ptyId}`).toBe(true)
  const end = await drawn(kea)
  for (const id of [first, second]) expect(end[id]!.instance, `terminal ${id} is the one it was`).toBe(before[id]!.instance)
  await kea.assertUnfocused()
})

/** The Settings sections, in the order the sheet lists them. */
const SECTIONS = ['General', 'Terminal', 'Agents', 'Notifications', 'Files', 'Keyboard', 'Projects', 'Disk', 'Advanced', 'About']

test('E-SET-2 · Settings by keyboard, and Advanced: ⌘, opens the sheet on General with the keyboard in the section list; ↓, End and Home walk the sections and each one draws; Advanced lists exactly the holders that run and Terminate ends one; Reload shell environment says what it found; Open logs folder asks main; Esc closes and the keyboard is back in the terminal', async ({ run, launch }) => {
  const kea = await launch()
  await kea.waitScreen('the shell prompt', (s) => s.includes(PROMPT))
  const page = await kea.page()
  const first = (await kea.shown()) as string
  const second = await kea.newTab()
  await kea.waitScreen('the second tab’s prompt', (s) => s.includes(PROMPT))
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(e.message))

  // ── the keyboard alone: ⌘, then the arrow keys ──
  await page.keyboard.press(sysKey('Meta+,'))
  const sheet = page.getByRole('dialog', { name: /^Settings: / })
  const named = (section: string) => page.getByRole('dialog', { name: `Settings: ${section}`, exact: true })
  await expect(named('General')).toBeVisible({ timeout: STEP_MS })
  await expect(sheet.getByRole('tab').filter({ hasText: /./ })).toHaveText(SECTIONS)
  await expect(sheet.getByRole('tab', { name: 'General', exact: true }), 'the keyboard is in the section list').toBeFocused()
  for (const section of SECTIONS.slice(1)) {
    await page.keyboard.press('ArrowDown')
    await expect(named(section)).toBeVisible()
    const tab = sheet.getByRole('tab', { name: section, exact: true })
    await expect(tab).toBeFocused()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    // the section draws something: its panel is named by its tab and is not empty
    await expect(sheet.getByRole('tabpanel', { name: section, exact: true })).not.toBeEmpty()
  }
  await page.keyboard.press('ArrowDown')
  await expect(named('About'), '↓ on the last section stays').toBeVisible()
  await page.keyboard.press('Home')
  await expect(named('General')).toBeVisible()
  // every generated row can be reached by Tab: the first control after the list is General's first row
  await page.keyboard.press('Tab')
  await expect(sheet.locator('[data-setting]').first().locator('input, select, textarea')).toBeFocused()
  await sheet.getByRole('tab', { name: 'General', exact: true }).focus()
  await page.keyboard.press('End')
  await expect(named('About')).toBeVisible()
  // About is last, with the version (E-SET-6 reads the rest of it); ↑ is Advanced
  await expect(sheet.locator('[data-version]')).toContainText(/^Kea \d+\.\d+\.\d+/)
  await page.keyboard.press('ArrowUp')
  await expect(named('Advanced')).toBeVisible()

  // ── Advanced: what Kea keeps running, as found on disk ──────────
  const rows = sheet.locator('[data-holder]')
  await expect(rows).toHaveCount(2, { timeout: STEP_MS })
  const holders = run.holders()
  expect((await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-holder')))).sort()).toEqual(holders.map((h) => h.ptyId).sort())
  expect(holders.map((h) => h.ptyId).sort()).toEqual([first, second].sort())
  for (const h of holders) await expect(sheet.locator(`[data-holder="${h.ptyId}"]`)).toContainText(`pid ${h.childPid}`)
  // Terminate the tab that is not on screen: its program ends, its holder goes, and the list is the one that is left
  const gone = holders.find((h) => h.ptyId === first)!
  await sheet.locator(`[data-holder="${first}"]`).getByRole('button', { name: /^Terminate / }).click()
  await expect(rows).toHaveCount(1, { timeout: STEP_MS })
  await expect(rows).toHaveAttribute('data-holder', second)
  await until('the terminated holder to be gone', () => !run.holderAlive(gone) || undefined)
  expect(run.holderAlive(holders.find((h) => h.ptyId === second)!), 'the other one runs on').toBe(true)

  // Reload shell environment: the line under the button says what the login shell gave
  const status = sheet.locator('[data-env-reload]')
  await expect(status).toHaveAttribute('data-env-reload', 'idle')
  // pressed by key: the button keeps the keyboard while the reload runs and after it (a button that disabled itself
  // meanwhile would drop it, and Esc would then no longer close the sheet)
  const reload = sheet.getByRole('button', { name: 'Reload shell environment' })
  await reload.focus()
  await page.keyboard.press('Enter')
  await expect(status).toHaveAttribute('data-env-reload', 'done', { timeout: STEP_MS })
  await expect(status).toContainText('Reloaded from your login shell')
  expect(await reload.evaluate((e) => e === document.activeElement), 'the keyboard is still on the button').toBe(true)

  // Open logs folder goes through main, which opens nothing under test and says so
  await sheet.getByRole('button', { name: 'Open logs folder' }).click()
  await until('main asked for the logs folder', () => kea.logLines('main').some((l) => l.msg === 'home item not opened (perf)' && l.item === 'logs') || undefined)

  // Esc: the sheet goes and the keyboard is where it was, in the terminal on screen
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await kea.echo('back')
  expect(problems, 'no page error on any section').toEqual([])
  await kea.assertUnfocused()
})

/** The program of E-PTY-2: raw tty, colour-scheme updates on (DECSET 2031), every byte it reads appended to a file. */
const PTY2_PROGRAM = `// E-PTY-2 (tests/e2e/settings.spec.ts): on D it asks the colour scheme (CSI ? 996 n); on Q it exits
const fs = require('node:fs')
const fd = fs.openSync(process.argv[2], 'a')
process.stdin.setRawMode(true)
process.stdout.write('\\x1b[?2031hE-PTY-2 ready\\r\\n')
process.stdin.on('data', (d) => {
  fs.writeSync(fd, d)
  if (d.includes(0x44)) process.stdout.write('\\x1b[?996n')
  if (d.includes(0x51)) {
    process.stdin.setRawMode(false)
    process.exit(0)
  }
})
`

const DARK_REPORT = '\x1b[?997;1n'
const LIGHT_REPORT = '\x1b[?997;2n'

test('E-PTY-2 · a program turns on colour-scheme updates (CSI ? 2031 h), then the theme is switched in Settings, to Kea Light and to a Ghostty config that changes on disk: the window writes no CSI ? 997 n and no other reply; each CSI ? 996 n the program sends is answered once, by the mirror, with the scheme of the theme in force', async ({ run, launch }) => {
  const kea = await launch()
  await kea.waitScreen('the shell prompt', (s) => s.includes(PROMPT))
  const page = await kea.page()
  const shown = (await kea.shown()) as string
  const program = path.join(run.home, 'e-pty-2.cjs')
  const record = path.join(run.home, 'e-pty-2.input')
  fs.writeFileSync(program, PTY2_PROGRAM)
  await kea.enter(`${process.execPath} ${program} ${record}`)
  await kea.waitScreen('the program ready', (s) => s.includes('E-PTY-2 ready'))
  const read = () => (fs.existsSync(record) ? fs.readFileSync(record, 'latin1') : '')
  const background = async () => lower((await drawn(kea))[shown]!.background)
  /** The program asks (typed D); the mirror's answer is the record's next bytes. */
  const ask = async (want: string, sofar: string, what: string) => {
    await kea.type('D')
    await expect.poll(read, { message: `the mirror’s answer to CSI ? 996 n (${what})`, timeout: STEP_MS }).toBe(`${sofar}D${want}`)
    return `${sofar}D${want}`
  }
  /** Choose a theme in Settings › Terminal, as a person does; Esc gives the keyboard back to the program. */
  const choose = async (label: string) => {
    const sheet = await openSettings(page, 'Terminal')
    await sheet.getByRole('combobox', { name: 'Theme' }).selectOption({ label })
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
  }

  // Kea Dark, the default: dark
  let got = await ask(DARK_REPORT, '', 'Kea Dark')

  // Kea Light, chosen in Settings while the program's terminal is on screen
  await choose('Kea Light')
  await until('the terminal drawn with Kea Light', async () => (await background()) === lower(THEMES['kea-light'].background) || undefined)
  got = await ask(LIGHT_REPORT, got, 'Kea Light')

  // "Match Ghostty config" with no config: Kea Dark, silently
  await choose('Match Ghostty config')
  await until('the terminal drawn with Kea Dark again', async () => (await background()) === lower(THEMES['kea-dark'].background) || undefined)
  got = await ask(DARK_REPORT, got, 'no Ghostty config')

  // the config appears, light: Kea reads it (its colours reach the terminal and the mirror) without being asked
  const config = path.join(harnessUserHome(run.home), '.config', 'ghostty', 'config')
  fs.mkdirSync(path.dirname(config), { recursive: true })
  fs.writeFileSync(config, '# a light palette\nbackground = fdf6e3\nforeground = #657b83\ncursor-color = #dc322f\n')
  await until('the terminal drawn with the config’s background', async () => (await background()) === '#fdf6e3' || undefined)
  got = await ask(LIGHT_REPORT, got, 'a light Ghostty config')

  // the config changes on disk, to dark: followed again
  fs.writeFileSync(config, 'background = #002b36\nforeground = #93a1a1\n')
  await until('the terminal drawn with the changed config', async () => (await background()) === '#002b36' || undefined)
  got = await ask(DARK_REPORT, got, 'the Ghostty config changed to dark')

  await kea.type('Q')
  await expect.poll(read, { message: 'Q recorded' }).toBe(`${got}Q`)
  await kea.waitScreen('the shell prompt after the program', (s) => s.trimEnd().endsWith(PROMPT.trimEnd()))
  // exactly: each typed D followed by the mirror's one report, then the typed Q. Four theme changes, two of them from
  // a file, wrote nothing by themselves: no unsolicited report, no second answer, no reply from the window
  expect(JSON.stringify(read())).toBe(JSON.stringify(`D${DARK_REPORT}D${LIGHT_REPORT}D${DARK_REPORT}D${LIGHT_REPORT}D${DARK_REPORT}Q`))
  await kea.assertUnfocused()
})

test('E-SET-5 · macOS not showing Kea’s notifications: while they show, Settings › Notifications says nothing of it; a notification that fails to show makes the page say so, with a link that asks main for macOS’s Notification Settings (asked, and never opened under the harness); once a notification shows again the line is gone', async ({ run, launch }) => {
  // Linux's notification service has no permission state, so the page has no such line
  test.skip(!protocolOs.window.notificationSettings, skipNote('the desktop’s notification service has no permission state to say a notification was refused'))
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  await addProject(kea, demoRepo(run).root)
  const note = page.locator('[data-notifications="denied"]')
  /** Settings › Notifications, opened afresh (the page asks main as it opens). */
  const openPage = async (): Promise<void> => {
    await openSettings(page, 'Notifications')
    await expect(page.getByRole('spinbutton').or(page.getByRole('switch')).first(), 'the section’s rows are drawn').toBeVisible({ timeout: STEP_MS })
  }
  const closePage = async (): Promise<void> => {
    await page.getByRole('dialog', { name: /^Settings: / }).getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('dialog', { name: /^Settings: / })).toHaveCount(0)
  }
  /** What macOS answers a post with, for this run: the recorder's stand-in (no test changes the system's setting). */
  const deny = (on: boolean): Promise<void> => kea.app.evaluate((_e, v) => (globalThis as unknown as { __keaTest: { denyNotifications(on: boolean): void } }).__keaTest.denyNotifications(v), on)
  const shown = async (): Promise<number> => (await notifications(kea)).log.filter((r) => r.k === 'show').length

  await openPage()
  await expect(note, 'nothing to say while notifications show').toHaveCount(0)
  await closePage()

  // a session that asks twice; the window is not focused, so each question posts a notification
  const frame = (...lines: string[]) => `frame: ${JSON.stringify([AGENT_MARK, '', '> {{prompt}}', '', ...lines])}`
  await deny(true)
  const s = await startFakeSession(
    kea,
    'e-set-5',
    'push and tag',
    `steps:
  - hook: UserPromptSubmit
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "git push" } }
  - ${frame('Bash(git push)  Allow? (y/n)')}
  - wait: { answer: y }
  - hook: { event: PostToolUse, tool: Bash, input: { command: "git push" } }
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "git tag v1" } }
  - ${frame('Bash(git tag v1)  Allow? (y/n)')}
  - wait: { answer: y }
  - hook: { event: PostToolUse, tool: Bash, input: { command: "git tag v1" } }
  - hook: Stop
`,
    { open: false },
  )
  await waitRow(kea, s.id, 'needs you', (r) => r.status === 'needsYou')
  // the post failed to show: main says so once, nothing was recorded as shown, and the flag is up
  await until('main noted the notification that did not show', () => kea.logLines('main').some((l) => l.msg.startsWith('notification not shown')) || undefined)
  expect(await shown()).toBe(0)
  expect((await notifications(kea)).permissionDenied).toBe(true)

  // the page says so, and its link asks main for macOS's pane
  await openPage()
  await expect(note).toBeVisible({ timeout: STEP_MS })
  await expect(note).toContainText('macOS is not showing Kea’s notifications. Allow them in')
  await expect(note).toContainText('The Dock badge works either way.')
  await note.getByRole('button', { name: 'Notification Settings…' }).click()
  await until('main was asked for the Notification Settings pane', () => kea.logLines('main').some((l) => l.msg === 'notification settings not opened (perf)') || undefined)
  await closePage()

  // allowed again: the next question shows, and the page has nothing to say
  await deny(false)
  await fakeAgentTerminal(kea, s.id)
  await kea.waitScreen('the first question', (x) => x.includes('Bash(git push)'))
  await page.locator('.terminal-host.shown').click({ position: { x: 20, y: 200 } })
  await page.keyboard.press('y')
  await kea.waitScreen('the second question', (x) => x.includes('Bash(git tag v1)'))
  await until('the second question’s notification shown', async () => (await shown()) === 1 || undefined)
  expect((await notifications(kea)).permissionDenied).toBe(false)
  await openPage()
  await expect(note, 'the line is gone').toHaveCount(0)
  await closePage()
  await kea.assertUnfocused()
})

/** The platform report main assembles now, read through the test hook: the one core is sent and About shows. */
const platformReport = async (kea: Kea): Promise<PlatformReport> => (await kea.app.evaluate(() => (globalThis as unknown as { __keaTest: { platformReport(): Promise<unknown> } }).__keaTest.platformReport())) as PlatformReport

test('E-SET-6 · Settings › About: Kea’s version, the commit and the day it was built, then the system and every line of the platform report main assembled, in About’s order and as main wrote it; on macOS each line is the full answer, so none has a fix', async ({ launch }) => {
  const kea = await launch()
  await kea.waitScreen('the shell prompt', (s) => s.includes(PROMPT))
  const page = await kea.page()
  const report = await platformReport(kea)
  const version = (JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string }).version

  const sheet = await openSettings(page, 'About')
  await expect(sheet.locator('[data-version]')).toHaveText(`Kea ${version}`)
  // the build's own: `git describe` of the checkout it was built from, and the day (UTC)
  await expect(sheet.locator('[data-commit]')).toHaveText(/^[\w.-]+$/)
  await expect(sheet.locator('[data-build-date]')).toHaveText(/^\d{4}-\d{2}-\d{2}$/)

  // the report: the system, then main's lines in PLATFORM_LINES' order, each as main wrote it
  const lines = sheet.locator('[data-platform-line]')
  await expect(lines).toHaveCount(report.lines.length + 1, { timeout: STEP_MS })
  expect(await lines.evaluateAll((els) => els.map((e) => e.getAttribute('data-platform-line')))).toEqual(['system', ...report.lines.map((l) => l.id)])
  expect(report.lines.map((l) => l.id)).toEqual(PLATFORM_LINES.filter((id) => report.lines.some((l) => l.id === id)))
  await expect(sheet.locator('[data-platform-line="system"] .about-value')).toHaveText(`${report.version} · ${report.arch}`)
  for (const l of report.lines) {
    const row = sheet.locator(`[data-platform-line="${l.id}"]`)
    await expect(row.locator('.settings-label')).toHaveText(l.label)
    await expect(row.locator('.about-text')).toHaveText(l.value)
    await expect(row).toHaveAttribute('data-fix', l.fix === null ? 'none' : 'shown')
  }
  await expect(sheet.locator('[data-platform-fix]')).toHaveCount(report.lines.filter((l) => l.fix !== null).length)
  // macOS: every line is the full answer, so About lists each one with no fix
  if (report.system === 'darwin') {
    expect(report.lines.filter((l) => l.fix !== null)).toEqual([])
    await expect(sheet.locator('.about-dot')).toHaveCount(0)
  }

  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await kea.assertUnfocused()
})
