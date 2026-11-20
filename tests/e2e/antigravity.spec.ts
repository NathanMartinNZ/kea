// Antigravity CLI end to end in the Electron window: Settings › Agents card detection and toggles, composer model-family
// grouping and per-family reasoning-effort options, permission-mode gating for --dangerously-skip-permissions, live
// status-line feed transitions through real kea-helper feed, ⌘J jump to a tool-confirmation prompt, "Why this status?",
// Stop and Resume with --conversation, the top-right quota usage meter, and missing-CLI detection.

import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { clockTime, L } from '@kea/protocol'
import { groupModels, parseModels } from '../../packages/adapters/src/antigravity/detect.ts'
import { SPACE_PX } from '../../packages/ui/src/generated/tokens.ts'
import { STEP_MS, until, type Kea, type KeaRun } from '../support/app.ts'
import {
  AGENT_MARK,
  agentEvents,
  claudeByDefault,
  fakeAgentTerminal,
  fakeAntigravity,
  fakeCommandCode,
  gate,
} from '../support/app-fake-agent.ts'
import { focusIn, openPalette, palette, tooltip, waitPalette } from '../support/app-palette.ts'
import { clipboard, recordClipboard } from '../support/app-server.ts'
import {
  addProject,
  demoRepo,
  paneSession,
  promptBox,
  rowState,
  selectSession,
  sessionRow,
  startSession,
  tabOf,
  waitLive,
  waitRow,
} from '../support/app-sessions.ts'
import { expect, test } from './fixtures.ts'
import { sysKey } from '../support/keys.ts'

const MODELS_TXT = path.resolve(import.meta.dirname, '../../fixtures/cli/antigravity/1.5.13/models.txt')
const INSTALL_CMD = 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
const WIDE = { width: 1440, height: 880 }
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const STATUS_ROW = '.agent-pane .status-row'
const STRIP = '.terminal-pane .tabstrip'
const FINISHED = ['idle', 'unread']

/** A fake agent's screen: its mark, the prompt, then `lines` (YAML flow sequence). */
const frame = (...lines: string[]) => `frame: ${JSON.stringify([AGENT_MARK, '', '> {{prompt}}', '', ...lines])}`

/** The `start` records of the agents that logged to `log` (their argv, conversation id and folder), once there are `n`. */
function agentStarts(log: string, n: number): Promise<{ argv: string[]; sessionId: string; cwd: string }[]> {
  return until(`${n} fake agent start(s) in ${path.basename(log)}`, () => {
    const starts = agentEvents(log).filter((r) => r.t === 'start') as unknown as {
      argv: string[]
      sessionId: string
      cwd: string
    }[]
    return starts.length >= n ? starts : undefined
  })
}

const composer = (page: Page): Locator => page.getByRole('region', { name: 'New session' })
const selectors = (page: Page): Locator => composer(page).getByRole('group', { name: 'Agent options' })
const promptFocused = (page: Page) =>
  until(
    'the prompt holding the keyboard',
    () => promptBox(page).evaluate((e) => e === document.activeElement).catch(() => false) || undefined,
  )
const inTerminal = (kea: Kea): Promise<boolean> => focusIn(kea, '.terminal-host.shown')
const labels = (menu: Locator): Promise<string[]> => menu.locator('.kea-menu-label').allTextContents()

/** `⌘<digit>` from the prompt opens a selector's menu; resolves with the open menu. */
async function openSelector(page: Page, digit: 1 | 2 | 3 | 4, name: string): Promise<Locator> {
  await promptFocused(page)
  await page.keyboard.press(sysKey(`Meta+${digit}`))
  const menu = page.getByRole('menu', { name, exact: true })
  await expect(menu).toBeVisible({ timeout: STEP_MS })
  return menu
}

/** Choose in a selector's menu with the keyboard (`keys`: arrows, Home, End or type-ahead letters), then `↵`. */
async function choose(page: Page, digit: 1 | 2 | 3 | 4, name: string, keys: readonly string[]): Promise<void> {
  const menu = await openSelector(page, digit, name)
  for (const k of keys) await page.keyboard.press(k)
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await promptFocused(page)
}

/** The composer's selector row as it reads: each button's accessible name (`Agent: …`, `Model: …`, …). */
async function shown(page: Page): Promise<string[]> {
  return selectors(page)
    .getByRole('button')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
}

/** The composer's Permission mode menu as it lists now (⌘4, read, Esc). */
async function modesListed(page: Page): Promise<string[]> {
  const menu = await openSelector(page, 4, 'Permission mode')
  const listed = await labels(menu)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  return listed
}

/** The Settings sheet, opened with ⌘, on `section`. */
async function openSettings(page: Page, section: string): Promise<Locator> {
  await page.keyboard.press(sysKey('Meta+,'))
  const sheet = page.getByRole('dialog', { name: /^Settings: / })
  await expect(sheet).toBeVisible({ timeout: STEP_MS })
  await sheet.getByRole('tab', { name: section, exact: true }).click()
  await expect(page.getByRole('dialog', { name: `Settings: ${section}`, exact: true })).toBeVisible()
  return sheet
}

/** What an agent's card in Settings › Agents says it detected: its state, path, lines and copyable command. */
async function cardSays(
  card: Locator,
): Promise<{ state: string | null; path: string | null; lines: string[]; command: string | null }> {
  const row = card.locator('[data-agent-state]')
  return {
    state: await row.getAttribute('data-agent-state'),
    path: (await row.locator('.path-mid').count()) ? await row.locator('.path-mid').getAttribute('data-tip') : null,
    lines: await row.locator('.agent-detected > span:not(.agent-command)').allTextContents(),
    command: (await row.locator('.agent-command code').count())
      ? await row.locator('.agent-command code').textContent()
      : null,
  }
}

/** Run a command from the palette with keys alone: `⌘⇧P`, `>` and a few words of its title, `↵` on the row that leads. */
async function runFromPalette(kea: Kea, words: string, id: string): Promise<void> {
  const page = await kea.page()
  await openPalette(kea)
  await page.keyboard.type(`>${words}`)
  const rows = await waitPalette(kea, `${id} leads`, (r) => r[0]?.id === id)
  expect(rows[0], `${id} can run`).toMatchObject({ disabled: false, current: true })
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
}

/** The session popover ("Why this status?"), opened from the palette; resolves with the dialog. */
async function openWhy(kea: Kea): Promise<Locator> {
  await runFromPalette(kea, 'why this status', 'session.whyStatus')
  const dialog = (await kea.page()).getByRole('dialog', { name: 'Session details' })
  await expect(dialog).toBeVisible({ timeout: STEP_MS })
  return dialog
}
const whyEntries = (dialog: Locator): Locator => dialog.getByRole('list', { name: 'Why this status?' }).locator('li')
const configValue = (dialog: Locator, label: string): Promise<string> =>
  dialog.locator('dl.popover-config').evaluate((dl, want) => {
    const dt = [...dl.querySelectorAll('dt')].find((e) => e.textContent === want)
    return dt?.nextElementSibling?.querySelector('.popover-value')?.textContent ?? ''
  }, label)

/** The session's journal from core's `status.why`, oldest first: `source · event`. */
async function whyLines(kea: Kea, id: string): Promise<string[]> {
  const why = (await (await kea.page()).evaluate(
    (sid) =>
      (window as unknown as { __keaProbe: { call(m: string, a: unknown): Promise<unknown> } }).__keaProbe.call(
        'status.why',
        { id: sid },
      ),
    id,
  )) as { entries: { source: string; event: string }[] }
  return why.entries.map((e) => `${e.source} · ${e.event}`)
}

/** Choose the split layout and size the window for it; resolves once it is drawn. */
async function drawSplit(kea: Kea): Promise<void> {
  await kea.setLayout({ agentBeside: true })
  await kea.resize(WIDE.width, WIDE.height)
  await until('the split drawn', async () => (await kea.layout()).split ?? undefined)
}

/** A reset as the usage meter formats it: the clock time on the same day, else the weekday and the time. */
function resetWords(ms: number): string {
  const d = new Date(ms)
  return d.toDateString() === new Date().toDateString()
    ? clockTime(ms)
    : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${clockTime(ms)}`
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface MeterShown {
  text: string
  levels: string[]
  rightGap: number
  words: { left: number; width: number } | null
}

/** The usage meter in `row` as a person sees it; null when none is drawn. */
function meterIn(page: Page, row: string): Promise<MeterShown | null> {
  return page.evaluate((sel) => {
    const r = document.querySelector(sel)
    const m = r?.querySelector('.usage-meter')
    if (!r || !m) return null
    const token = (t: string): string => {
      const probe = document.createElement('span')
      probe.style.color = `var(${t})`
      document.body.append(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    }
    const names = new Map([
      [token('--text-3'), 'plain'],
      [token('--warn'), 'warn'],
      [token('--danger'), 'danger'],
    ])
    const bottom = m.getBoundingClientRect().bottom
    const shownParts = [...m.querySelectorAll('.usage-part')].filter((p) => p.getBoundingClientRect().top < bottom - 1)
    const last = shownParts.at(-1)
    const words = r.querySelector('.status-text')?.getBoundingClientRect()
    return {
      text: shownParts.map((p) => p.textContent ?? '').join(''),
      levels: shownParts.map((p) => names.get(getComputedStyle(p.querySelector('.usage-value')!).color) ?? 'other'),
      rightGap: last ? Math.round(r.getBoundingClientRect().right - last.getBoundingClientRect().right) : -1,
      words: words ? { left: words.left, width: words.width } : null,
    }
  }, row)
}

/** Wait until the meter in `row` shows `text`; resolves with what it shows. */
function waitMeter(page: Page, row: string, text: string): Promise<MeterShown> {
  return until(`the meter showing "${text}"`, async () => {
    const m = await meterIn(page, row)
    return m?.text === text ? m : undefined
  }).catch(async (e: Error) => {
    throw new Error(`${e.message}: ${JSON.stringify(await meterIn(page, row))}`)
  })
}

/** Narrow the agent pane's status row so its meter has `room` px beside the words (null restores its own width). */
async function narrowRow(page: Page, room: number | null): Promise<MeterShown | null> {
  await page.evaluate(
    ([sel, px]) => {
      const r = document.querySelector<HTMLElement>(sel)!
      if (px === null) return void r.style.removeProperty('width')
      const s = getComputedStyle(r)
      const pads = s.boxSizing === 'border-box' ? parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) : 0
      const words = r.querySelector('.status-text')!.getBoundingClientRect().width
      r.style.width = `${px + parseFloat(s.columnGap) + words + pads}px`
    },
    [STATUS_ROW, room] as const,
  )
  return meterIn(page, STATUS_ROW)
}

/** Write Antigravity quota buckets to `file` so the next status-line feed snapshot reports them. */
function writeQuotaFile(
  file: string,
  fiveHourUsedPct: number,
  weeklyUsedPct: number,
  resets: { fiveHour: number; weekly: number },
): void {
  const quota = {
    'gemini-5h': {
      remaining_fraction: (100 - fiveHourUsedPct) / 100,
      reset_time: new Date(resets.fiveHour).toISOString(),
    },
    'gemini-weekly': {
      remaining_fraction: (100 - weeklyUsedPct) / 100,
      reset_time: new Date(resets.weekly).toISOString(),
    },
    '3p-5h': {
      remaining_fraction: 0.5,
      reset_time: new Date(resets.fiveHour).toISOString(),
      disabled: true,
    },
  }
  fs.writeFileSync(file, JSON.stringify(quota))
}

/** Extract the parsed JSON object from `--settings=<json>` in an Antigravity CLI argv. */
function parsedSettingsArg(argv: readonly string[]): Record<string, unknown> {
  const token = argv.find((a) => a.startsWith('--settings='))
  expect(token, `--settings=<json> in ${JSON.stringify(argv)}`).toBeDefined()
  return JSON.parse(token!.slice('--settings='.length)) as Record<string, unknown>
}

const AG_MODES = ['Ask before edits', 'Accept edits', 'Plan', 'Auto']
const CLAUDE_MODES = [
  'Ask before edits',
  'Accept edits',
  'Plan',
  'Auto',
  "Don't ask (deny anything not pre-approved)",
]
const YOLO = 'Bypass permissions (yolo)'

test('E-AGT-5 · Antigravity CLI end to end in Electron: Settings › Agents card shows installed path, version 1.5.13, default toggles and no false Signed out badge; composer lists Antigravity CLI, grouped model families with per-family efforts and ungrouped models without effort, and modes; enabling Allow bypass-permission modes unlocks yolo (--dangerously-skip-permissions) across launch and resume; standard-mode session drives working → tool confirmation (⌘J jump and answer) → unread ready and title update through real kea-helper feed, with exact source in "Why this status?" and resume via --conversation; top-right quota usage meter renders normal/warn/danger/100%, tooltip, accessible role="img", narrow-row drop order, cross-session sharing and immediate hide when Show usage limits is turned off while status feed keeps working; removing agy and clicking Look again shows Not installed with copyable install command', async ({
  run,
  launch,
}) => {
  test.setTimeout(180_000)
  claudeByDefault(run)
  const quotaFile = path.join(run.home, 'agy-quota.json')
  fakeCommandCode(
    run,
    'e-agt-5-cmd',
    `steps:\n  - ${frame('cmd ready')}\n  - wait: { answer: z }\n`,
  )
  const agy = fakeAntigravity(
    run,
    'e-agt-5-agy-yolo',
    `steps:\n  - ${frame('agy yolo {{sessionId}}')}\n  - wait: { answer: z }\n`,
  )

  const kea = await launch()
  await kea.pretendFocused(true)
  const page = await kea.page()
  await recordClipboard(page)
  await addProject(kea, demoRepo(run).root, 'demo')
  await promptFocused(page)

  // ── 2. Settings › Agents card: installed path, version 1.5.13, default toggles, and no false "Signed out" badge ──
  let sheet = await openSettings(page, 'Agents')
  const claudeCard = sheet.getByRole('region', { name: 'Claude Code', exact: true })
  const agCard = sheet.getByRole('region', { name: 'Antigravity CLI', exact: true })
  await until('Antigravity CLI detected', async () => (await cardSays(agCard)).state === 'installed' || undefined)
  expect(await cardSays(agCard)).toEqual({
    state: 'installed',
    path: path.join(run.agentBin, 'agy'),
    lines: ['Version 1.5.13'],
    command: null,
  })
  await expect(agCard.getByRole('switch', { name: 'Show usage limits' })).toBeChecked()
  await expect(agCard.getByRole('switch', { name: 'Auto-trust Kea worktrees' })).toBeChecked()
  await expect(agCard.getByRole('switch', { name: 'Allow bypass-permission modes' })).not.toBeChecked()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await promptFocused(page)

  // ── 3 & 4. Composer selectors: Agent, grouped Model families, per-model Effort levels, Permission modes ──
  let menu = await openSelector(page, 1, 'Agent')
  await expect(menu.locator('.kea-menu-label')).toHaveText(
    ['Claude Code', 'Command Code', 'Antigravity CLI', 'Shell'],
    { timeout: STEP_MS },
  )
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await promptFocused(page)
  expect(await shown(page)).toEqual([
    'Agent: Antigravity CLI',
    'Model: default',
    'Effort: model default',
    'Permission mode: Ask before edits',
  ])

  const grouped = groupModels(parseModels(fs.readFileSync(MODELS_TXT, 'utf8')))
  expect(grouped.map((m) => m.label)).toEqual(
    expect.arrayContaining(['Gemini 4 Neon', 'Gemini 4 Argon', 'Gemini 3.8 Flash', 'Orchestrator (Neon)']),
  )
  menu = await openSelector(page, 2, 'Model')
  expect(await labels(menu)).toEqual([
    "Default (Antigravity's own)",
    ...grouped.map((m) => m.label),
    'Custom model…',
  ])
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // Default model offers all five canonical effort levels.
  menu = await openSelector(page, 3, 'Effort')
  expect(await labels(menu)).toEqual(['Model default', 'low', 'medium', 'high', 'xhigh', 'max'])
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // Switching to an ungrouped model (`Orchestrator (Neon)`) hides the Effort selector (`efforts: []`).
  await choose(page, 2, 'Model', ['o'])
  expect(await shown(page)).toEqual([
    'Agent: Antigravity CLI',
    'Model: gemini-pro-orchestrator-neon',
    'Permission mode: Ask before edits',
  ])

  // Switching to `Gemini 4 Argon` restores the Effort selector with Argon's exact supported efforts (`low`, `medium`, `high`).
  await choose(page, 2, 'Model', ['ArrowDown', 'ArrowDown'])
  expect(await shown(page)).toEqual([
    'Agent: Antigravity CLI',
    'Model: gemini-4-argon',
    'Effort: model default',
    'Permission mode: Ask before edits',
  ])
  menu = await openSelector(page, 3, 'Effort')
  expect(await labels(menu)).toEqual(['Model default', 'low', 'medium', 'high'])
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // Switching to `Gemini 4 Neon` offers `low`, `medium`, `high`, `xhigh`; choose `high`.
  await choose(page, 2, 'Model', ['ArrowDown'])
  menu = await openSelector(page, 3, 'Effort')
  expect(await labels(menu)).toEqual(['Model default', 'low', 'medium', 'high', 'xhigh'])
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await choose(page, 3, 'Effort', ['h'])
  expect(await shown(page)).toEqual([
    'Agent: Antigravity CLI',
    'Model: gemini-4-neon',
    'Effort: high',
    'Permission mode: Ask before edits',
  ])

  // Permission mode selector lists the four safe modes while `allowDangerousModes` is off.
  expect(await modesListed(page)).toEqual(AG_MODES)

  // ── 5. Yolo flow (`--dangerously-skip-permissions`): Settings toggle, launch argv, Stop + Resume ──
  sheet = await openSettings(page, 'Agents')
  const agBypass = agCard.getByRole('switch', { name: 'Allow bypass-permission modes' })
  await agBypass.focus()
  await page.keyboard.press('Space')
  await expect(agBypass).toBeChecked({ timeout: STEP_MS })
  await expect(
    agCard.locator('[data-setting="agents.antigravity.allowDangerousModes"]').getByRole('status'),
  ).toContainText('it can run any command and change any file your account can')
  await expect(
    claudeCard.getByRole('switch', { name: 'Allow bypass-permission modes' }),
    'Claude Code’s card stays unchecked',
  ).not.toBeChecked()
  const written = JSON.parse(fs.readFileSync(path.join(run.home, 'settings.json'), 'utf8')) as {
    agents?: Record<string, unknown>
  }
  expect(written.agents).toEqual({ antigravity: { allowDangerousModes: true } })
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await promptFocused(page)

  // Yolo is now offered for Antigravity CLI (and still not for Claude Code).
  expect(await modesListed(page)).toEqual([...AG_MODES, YOLO])
  await choose(page, 1, 'Agent', ['Home'])
  expect(await modesListed(page), 'Claude Code still lists no dangerous mode').toEqual(CLAUDE_MODES)
  await choose(page, 1, 'Agent', ['ArrowDown', 'ArrowDown'])
  await choose(page, 4, 'Permission mode', ['End'])
  expect(await shown(page)).toEqual([
    'Agent: Antigravity CLI',
    'Model: gemini-4-neon',
    'Effort: high',
    `Permission mode: ${YOLO}`,
  ])

  const yoloId = await startSession(kea, 'yolo task', { open: false })
  await waitLive(kea, yoloId)
  const [yoloStart] = await agentStarts(agy.log, 1)
  expect(yoloStart!.argv).toContain('--model=gemini-4-neon')
  expect(yoloStart!.argv).toContain('--effort=high')
  expect(yoloStart!.argv).toContain('--dangerously-skip-permissions')
  expect(yoloStart!.argv.some((a) => a === '--mode' || a.startsWith('--mode='))).toBe(false)
  expect(yoloStart!.argv.at(-1)).toBe('--prompt-interactive=yolo task')
  const yoloSettings = parsedSettingsArg(yoloStart!.argv)
  expect(yoloSettings.clearScrollbackOnResize).toBe(false)
  expect(yoloSettings.trustedWorkspaces).toEqual([yoloStart!.cwd])
  expect(yoloSettings.statusLine).toMatchObject({ type: 'command', stack_with_default: true })

  // Wait for the startup status-line feed event to record the conversation id before stopping and resuming.
  await until(
    'the yolo session’s startup feed event in the journal',
    async () => (await whyLines(kea, yoloId)).includes('hook · session.started') || undefined,
  )
  await runFromPalette(kea, 'stop agent', 'session.stop')
  await waitRow(kea, yoloId, 'detached after Stop', (r) => r.lifecycle === 'detached')
  const overlay = page.getByRole('status', { name: 'Session ended' })
  await expect(overlay).toContainText('Session stopped', { timeout: STEP_MS })
  await until('the keyboard in the ended terminal’s area', () => focusIn(kea, '.terminal-area, .terminal-host'))
  await page.keyboard.press('Enter')
  await waitRow(kea, yoloId, 'live after Resume', (r) => r.lifecycle === 'live')
  const [, yoloResumed] = await agentStarts(agy.log, 2)
  expect(yoloResumed!.argv[0]).toBe(`--conversation=${yoloStart!.sessionId}`)
  expect(yoloResumed!.argv).toContain('--model=gemini-4-neon')
  expect(yoloResumed!.argv).toContain('--effort=high')
  expect(yoloResumed!.argv).toContain('--dangerously-skip-permissions')
  expect(yoloResumed!.argv.some((a) => a === '--mode' || a.startsWith('--mode='))).toBe(false)
  expect(yoloResumed!.argv.some((a) => a.startsWith('--prompt-interactive'))).toBe(false)
  expect(parsedSettingsArg(yoloResumed!.argv).statusLine).toMatchObject({ type: 'command', stack_with_default: true })
  await kea.waitScreen('the resumed yolo session', (x) => x.includes(`agy yolo ${yoloStart!.sessionId}`))

  // ── 6. Standard-mode live feed + ⌘J + "Why this status?" + Stop & Resume ──
  const gWorking = gate(run, 'e-agt-5-working')
  const gConfirm = gate(run, 'e-agt-5-confirm')
  const gFinish = gate(run, 'e-agt-5-finish')
  fakeAntigravity(
    run,
    'e-agt-5-agy-std',
    `steps:
  - ${frame('Starting…')}
  - ${gWorking.step}
  - hook: working
  - ${frame('✶ Working…')}
  - ${gConfirm.step}
  - hook: tool_confirmation
  - ${frame('run_command(npm test)  Allow? (y/n)')}
  - wait: { answer: y }
  - hook: tool_confirmation_clear
  - ${frame('✶ Running npm test…')}
  - ${gFinish.step}
  - hook: { event: idle, fields: { conversation_title: "Run the tests" } }
  - ${frame('⏺ All tests pass.')}
`,
    { quota: quotaFile },
  )

  await page.keyboard.press(sysKey('Meta+n'))
  await promptFocused(page)
  await choose(page, 2, 'Model', ['Home'])
  await choose(page, 3, 'Effort', ['Home'])
  await choose(page, 4, 'Permission mode', ['Home'])
  expect(await shown(page)).toEqual([
    'Agent: Antigravity CLI',
    'Model: default',
    'Effort: model default',
    'Permission mode: Ask before edits',
  ])
  const stdId = await startSession(kea, 'run the tests', { open: false })
  await waitLive(kea, stdId)
  const stdLog = path.join(run.home, 'e-agt-5-agy-std.log')
  const [stdStart] = await agentStarts(stdLog, 1)
  expect(stdStart!.argv).not.toContain('--dangerously-skip-permissions')
  expect(stdStart!.argv.some((a) => a === '--mode' || a.startsWith('--mode='))).toBe(false)
  expect(stdStart!.argv).toContain('--prompt-interactive=run the tests')
  expect(parsedSettingsArg(stdStart!.argv).statusLine).toMatchObject({ type: 'command', stack_with_default: true })

  // Gate 1 (`working`) → sidebar row shows `working`.
  await gWorking.open()
  await waitRow(kea, stdId, 'working from the status-line feed', (r) => r.status === 'working')

  // Switch to the first session so ⌘J can jump to `stdId` when `tool_confirmation` blocks it.
  await page.keyboard.press('Control+Tab')
  await until('⌃Tab showed the yolo session', async () => (await paneSession(page)) === yoloId || undefined)

  // Gate 2 (`tool_confirmation`) → sidebar row shows `needs you` (`blocked`) with the `permission` label.
  await gConfirm.open()
  const asking = await waitRow(kea, stdId, 'needs you on tool confirmation', (r) => r.status === 'needsYou')
  expect(asking.selected, 'it is not the session on screen').toBe(false)
  expect(await sessionRow(page, stdId).locator('.sb-label').textContent()).toBe('permission')

  // Jump via ⌘J and answer in the terminal → confirmation clears and the session returns to `working`.
  await page.keyboard.press(sysKey('Meta+j'))
  await until('⌘J showed the standard Antigravity session', async () => (await paneSession(page)) === stdId || undefined)
  await kea.waitScreen('the confirmation prompt', (x) => x.includes('Allow? (y/n)'))
  await until('the keyboard in its terminal', () => inTerminal(kea))
  await page.keyboard.press('y')
  await waitRow(kea, stdId, 'working again once confirmation is answered', (r) => r.status === 'working')
  expect(await sessionRow(page, stdId).locator('.sb-label').count(), 'permission label cleared').toBe(0)

  // Switch away before gate 3 finishes the turn so the row lands on unread `ready` with the updated title.
  await page.keyboard.press('Control+Tab')
  await until('⌃Tab showed the yolo session again', async () => (await paneSession(page)) === yoloId || undefined)
  await gFinish.open()
  await waitRow(
    kea,
    stdId,
    'unread ready and titled by the agent',
    (r) => r.status === 'unread' && r.title === 'Run the tests',
  )

  // Jump back via ⌘J (unread ready is in attention order) and inspect "Why this status?".
  await page.keyboard.press(sysKey('Meta+j'))
  await until('⌘J showed the finished session', async () => (await paneSession(page)) === stdId || undefined)
  await kea.waitScreen('the finished turn on screen', (x) => x.includes('All tests pass.'))

  const why = await openWhy(kea)
  await expect(whyEntries(why).last()).toHaveText(/^\d\d:\d\d:\d\d hook · turn finished → ready$/, {
    timeout: STEP_MS,
  })
  const lines = (await whyEntries(why).allTextContents()).map((t) => t.replace(/^\d\d:\d\d:\d\d /, ''))
  const from = lines.indexOf('hook · turn started → working')
  expect(from, `the turn’s start in ${JSON.stringify(lines)}`).toBeGreaterThanOrEqual(0)
  expect(lines.slice(from)).toEqual([
    'hook · turn started → working',
    'hook · permission asked → blocked',
    expect.stringMatching(/^hook · answered → working/),
    'hook · turn finished → ready',
  ])
  expect(lines.filter((l) => l.startsWith('heuristic · ')), 'none of it estimated from terminal activity').toEqual([])
  await expect(why.getByText('Status is estimated from terminal activity.')).toHaveCount(0)
  await expect(why.getByRole('list', { name: 'Waiting on you' })).toHaveCount(0)
  expect(await configValue(why, 'Agent')).toBe('Antigravity CLI 1.5.13')
  expect(await configValue(why, 'Agent session')).toBe(stdStart!.sessionId)
  await page.keyboard.press('Escape')
  await expect(why).toHaveCount(0)
  await until('the keyboard back in the terminal', () => inTerminal(kea))

  // Stop Agent, then Resume → relaunches with `--conversation=<learnedId>` and `--settings=<json>`.
  fakeAntigravity(
    run,
    'e-agt-5-agy-std',
    `steps:
  - ${frame('RESUMED {{sessionId}}')}
onLine:
  - hook: working
  - print: "GOT {{line}}\\r\\n"
  - wait: { answer: k }
  - hook: { event: idle, fields: { conversation_title: "Run the tests" } }
`,
    { quota: quotaFile },
  )
  await runFromPalette(kea, 'stop agent', 'session.stop')
  await waitRow(kea, stdId, 'detached after Stop', (r) => r.lifecycle === 'detached')
  await expect(overlay).toContainText('Session stopped', { timeout: STEP_MS })
  await until('the keyboard in the ended terminal’s area', () => focusIn(kea, '.terminal-area, .terminal-host'))
  await page.keyboard.press('Enter')
  await waitRow(kea, stdId, 'live after Resume', (r) => r.lifecycle === 'live')
  const [, stdResumed] = await agentStarts(stdLog, 2)
  expect(stdResumed!.argv[0]).toBe(`--conversation=${stdStart!.sessionId}`)
  expect(stdResumed!.argv).not.toContain('--dangerously-skip-permissions')
  expect(stdResumed!.argv.some((a) => a.startsWith('--prompt-interactive'))).toBe(false)
  expect(parsedSettingsArg(stdResumed!.argv).statusLine).toMatchObject({ type: 'command', stack_with_default: true })
  expect(stdResumed!.sessionId).toBe(stdStart!.sessionId)
  await kea.waitScreen('the resumed standard session', (x) => x.includes(`RESUMED ${stdStart!.sessionId}`))
  await until('the keyboard in the resumed terminal', () => inTerminal(kea))
  await kea.enter('follow up')
  await kea.waitScreen('the line at the resumed agent', (x) => x.includes('GOT follow up'))
  await waitRow(kea, stdId, 'working on follow-up turn', (r) => r.status === 'working')
  await page.keyboard.press('k')
  await waitRow(kea, stdId, 'finished follow-up turn', (r) => FINISHED.includes(r.status))

  // ── 7. Top-right usage meter on Antigravity: normal → warn → danger → 100%, tooltip, a11y, narrow row, sharing, toggle off ──
  await drawSplit(kea)
  const stdAgentPty = await fakeAgentTerminal(kea, stdId)
  expect(await meterIn(page, STATUS_ROW), 'no quota file written yet: no meter').toBeNull()

  const now = Date.now()
  const resets = { fiveHour: now + HOUR_MS, weekly: now + 3 * DAY_MS }
  const warn = Math.round(L.usageWarnRatio * 100)
  const danger = Math.round(L.usageDangerRatio * 100)

  const focusAgentTerminal = async (): Promise<void> => {
    if ((await paneSession(page)) !== stdId) await selectSession(kea, stdId)
    if (!(await inTerminal(kea))) await page.keyboard.press(sysKey('Meta+BracketRight'))
    await until('the keyboard in the terminal', () => inTerminal(kea))
  }

  const reportQuota = async (fiveHourPct: number, weeklyPct: number): Promise<void> => {
    writeQuotaFile(quotaFile, fiveHourPct, weeklyPct, resets)
    await focusAgentTerminal()
    await kea.enter(`quota-${fiveHourPct}-${weeklyPct}`)
    await waitRow(kea, stdId, 'working while reporting quota', (r) => r.status === 'working')
    await page.keyboard.press('k')
    await waitRow(kea, stdId, 'finished after reporting quota', (r) => FINISHED.includes(r.status))
  }

  // Normal reading: both non-disabled windows at the row's right end, in `--text-3` (`plain`).
  await reportQuota(25, 50)
  let m = await waitMeter(page, STATUS_ROW, 'Gem 5h 25% · Gem 7d 50%')
  expect(m.levels).toEqual(['plain', 'plain'])
  expect(m.rightGap, 'at the row’s right end').toBe(SPACE_PX[2])

  // Warning ratio (`--warn`) and danger ratio (`--danger`).
  await reportQuota(warn, 50)
  m = await waitMeter(page, STATUS_ROW, `Gem 5h ${warn}% · Gem 7d 50%`)
  expect(m.levels).toEqual(['warn', 'plain'])
  await reportQuota(danger, warn)
  m = await waitMeter(page, STATUS_ROW, `Gem 5h ${danger}% · Gem 7d ${warn}%`)
  expect(m.levels).toEqual(['danger', 'warn'])

  // Tooltip and accessible `role="img"` name and description.
  await page.locator(`${STATUS_ROW} .usage-part[data-window="gemini-5h"]`).hover()
  const tipPrefix = `Gemini 5-hour: ${danger}% used, resets ${resetWords(resets.fiveHour)} · Gemini weekly: ${warn}% used, resets ${resetWords(resets.weekly)} · as of `
  await expect(tooltip(page).locator('span')).toHaveText(new RegExp(`^${escapeRe(tipPrefix)}\\d\\d:\\d\\d$`), {
    timeout: STEP_MS,
  })
  await page.mouse.move(1, 1)
  await expect(tooltip(page)).toHaveCount(0)

  const agentRegion = page.getByRole('region', { name: 'Agent' })
  const meterImg = agentRegion.getByRole('img', {
    name: `Usage: Gemini 5-hour ${danger}%, Gemini weekly ${warn}%`,
    exact: true,
  })
  await expect(meterImg).toBeVisible({ timeout: STEP_MS })
  await expect(meterImg).toHaveAccessibleDescription(new RegExp(`^${escapeRe(tipPrefix)}\\d\\d:\\d\\d$`))

  // At 100 %: `Gem 5h limit · <reset>` and accessible name with `limit reached until <reset>`.
  await reportQuota(100, 50)
  m = await waitMeter(page, STATUS_ROW, `Gem 5h limit · ${resetWords(resets.fiveHour)} · Gem 7d 50%`)
  expect(m.levels).toEqual(['danger', 'plain'])
  await expect(
    agentRegion.getByRole('img', {
      name: `Usage: Gemini 5-hour limit reached until ${resetWords(resets.fiveHour)}, Gemini weekly 50%`,
      exact: true,
    }),
  ).toBeVisible({ timeout: STEP_MS })

  // Narrow row drops the lower-priority bucket (`Gem 7d`) first, then the meter, without shifting left-side status text.
  await reportQuota(25, 50)
  m = await waitMeter(page, STATUS_ROW, 'Gem 5h 25% · Gem 7d 50%')
  const widths = await page.evaluate(
    (sel) =>
      Object.fromEntries(
        [...document.querySelectorAll(`${sel} .usage-part`)].map((p) => [
          p.getAttribute('data-window') ?? '',
          p.getBoundingClientRect().width,
        ]),
      ),
    STATUS_ROW,
  )
  expect(await narrowRow(page, widths['gemini-5h']! + widths['gemini-weekly']! - 1)).toMatchObject({
    text: 'Gem 5h 25%',
    words: m.words,
  })
  expect(await narrowRow(page, widths['gemini-5h']! - 1)).toMatchObject({
    text: '',
    words: m.words,
  })
  await narrowRow(page, null)
  await waitMeter(page, STATUS_ROW, 'Gem 5h 25% · Gem 7d 50%')

  // The second Antigravity session (`yoloId`) shares the account's reading; a Command Code session shows none.
  await selectSession(kea, yoloId)
  await fakeAgentTerminal(kea, yoloId)
  await waitMeter(page, STATUS_ROW, 'Gem 5h 25% · Gem 7d 50%')

  const cmdId = await startSession(kea, 'command code session', {
    beforeStart: async () => {
      await choose(page, 1, 'Agent', ['ArrowDown'])
      expect((await shown(page))[0]).toBe('Agent: Command Code')
    },
  })
  await waitLive(kea, cmdId)
  await fakeAgentTerminal(kea, cmdId)
  expect(await meterIn(page, STATUS_ROW), 'no meter for Command Code').toBeNull()

  await selectSession(kea, stdId)
  await fakeAgentTerminal(kea, stdId)
  await waitMeter(page, STATUS_ROW, 'Gem 5h 25% · Gem 7d 50%')

  // One-column mode renders the meter at the tab strip's right end while the Agent tab is shown.
  await kea.oneColumn()
  await kea.clickTab(stdAgentPty)
  m = await waitMeter(page, STRIP, 'Gem 5h 25% · Gem 7d 50%')
  expect(m.rightGap, 'at the strip’s right end').toBe(SPACE_PX[2])
  await drawSplit(kea)
  await fakeAgentTerminal(kea, stdId)
  await waitMeter(page, STATUS_ROW, 'Gem 5h 25% · Gem 7d 50%')

  // Toggle "Show usage limits" OFF in Settings › Agents for Antigravity → meter disappears immediately while a new
  // feed turn still moves the sidebar row `working → ready` (proving `statusLine` stays injected).
  sheet = await openSettings(page, 'Agents')
  const agUsage = agCard.getByRole('switch', { name: 'Show usage limits' })
  await agUsage.focus()
  await page.keyboard.press('Space')
  await expect(agUsage).not.toBeChecked({ timeout: STEP_MS })
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)

  await until('no meter with Show usage limits off', async () =>
    (await meterIn(page, STATUS_ROW)) === null ? true : undefined,
  )
  await focusAgentTerminal()
  await kea.enter('turn with meter off')
  await waitRow(kea, stdId, 'working with Show usage limits off', (r) => r.status === 'working')
  await page.keyboard.press('k')
  await waitRow(kea, stdId, 'finished with Show usage limits off', (r) => FINISHED.includes(r.status))
  expect(await meterIn(page, STATUS_ROW), 'still no meter after a new feed snapshot with quota').toBeNull()

  // ── 8. Missing-CLI card: remove `<agentBin>/agy`, click "Look again" in Settings › Agents ──
  fs.rmSync(path.join(run.agentBin, 'agy'))
  sheet = await openSettings(page, 'Agents')
  const look = sheet.getByRole('button', { name: 'Look again' })
  await look.focus()
  await page.keyboard.press('Enter')
  await until('Antigravity CLI missing', async () => (await cardSays(agCard)).state === 'missing' || undefined)
  expect(await cardSays(agCard)).toEqual({
    state: 'missing',
    path: null,
    lines: ['Not installed'],
    command: INSTALL_CMD,
  })
  await agCard.getByRole('button', { name: 'Copy the install command for Antigravity CLI' }).click()
  await until('the install command copied', async () => (await clipboard(page)).at(-1) === INSTALL_CMD || undefined)
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await kea.assertUnfocused()
})
