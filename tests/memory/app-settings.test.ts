// Leak cycles of the Settings sheet against the real app (tests/support/app.ts), measured with
// tests/support/app-leak.ts. One project with one session (its worktree is the Disk page's row), its Agent terminal on
// screen. A cycle takes the same path every time: each section is left only once what it asked core for is drawn. The
// second set closes the sheet with a section's question to core unanswered, core held with SIGSTOP meanwhile.

import { afterEach, describe, expect, it } from 'vitest'
import type { Locator, Page } from '@playwright/test'
import { signalKnown } from '../../tools/perf/src/launch.ts'
import { KeaRun, STEP_MS, until, type Kea } from '../support/app.ts'
import { expectBytesFlat, expectCountsFlat, RendererProbe, runCycles } from '../support/app-leak.ts'
import { keyboardRows } from '../support/app-palette.ts'
import { addProject, agentTerminal, demoRepo, startSession, waitLive, waitRow } from '../support/app-sessions.ts'
import { sysKey } from '../support/keys.ts'

const runs: KeaRun[] = []
const probes: RendererProbe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

const HEAPS = ['renderer.heap', 'core.heap', 'ptyhost.heap', 'main.heap']
/** The Settings sections, in the sheet's order (About aside). */
const SECTIONS = ['General', 'Terminal', 'Agents', 'Notifications', 'Files', 'Keyboard', 'Projects', 'Disk', 'Advanced'] as const
type Section = (typeof SECTIONS)[number]
/** The sections that ask core something each time they open (the Agents page's description is asked once per window). */
const ASKING: readonly Section[] = ['Projects', 'Disk', 'Advanced']
/** The setting changed and reset in each cycle: a switch, written to settings.json and back. */
const SWITCH = { key: 'notifications.sound', label: 'Sound for needs-you', section: 'Notifications' as Section }

type Probe = { rpcPending(): number }
const pending = (page: Page): Promise<number> => page.evaluate(() => (globalThis as unknown as { __keaProbe: Probe }).__keaProbe.rpcPending())
const atRest = (page: Page) => until('no call of the window waiting on core', async () => (await pending(page)) === 0 || undefined)

const sheet = (page: Page): Locator => page.getByRole('dialog', { name: /^Settings: / })
const named = (page: Page, section: string): Locator => page.getByRole('dialog', { name: `Settings: ${section}`, exact: true })

describe('Settings leaks (app)', () => {
  it('L-MEM-23 · Settings opened with ⌘, and every section shown in turn, each once it has drawn what it asked for (Agents with core’s description, Terminal with its preview, Keyboard with its list, Projects, Disk with the session’s size and branch, Advanced with its holder list read), a switch changed and reset, the sheet closed with Esc, ×30: DOM nodes, listeners, subscriptions and every other count equal, the Disk view’s rows at 0 once closed; heaps within budget. Then Projects, Disk and Advanced each closed while their question to core is unanswered (core held meanwhile), ×10: the same', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea: Kea = await run.launch()
    await addProject(kea, demoRepo(run).root)
    const id = await startSession(kea, 'settings')
    await waitLive(kea, id)
    const agent = await agentTerminal(kea, id)
    const page = await kea.page()
    const renderer = await RendererProbe.open(kea)
    probes.push(renderer)
    const holders = run.holders().length
    expect(holders, 'the first shell and the session’s Agent terminal').toBe(2)

    /** ⌘, and the sheet on General (it opens on the page shown last). */
    const open = async (): Promise<void> => {
      await page.keyboard.press(sysKey('Meta+,'))
      await sheet(page).waitFor({ timeout: STEP_MS })
      await sheet(page).getByRole('tab', { name: 'General', exact: true }).click()
      await named(page, 'General').waitFor({ timeout: STEP_MS })
    }
    const close = async (): Promise<void> => {
      await page.keyboard.press('Escape')
      await sheet(page).waitFor({ state: 'detached', timeout: STEP_MS })
      await until('the keyboard back in the terminal', () => page.evaluate(() => !!document.activeElement?.closest('.terminal-host.shown')) || undefined)
    }
    const show = async (section: Section): Promise<void> => {
      await sheet(page).getByRole('tab', { name: section, exact: true }).click()
      await named(page, section).waitFor({ timeout: STEP_MS })
    }
    /** What each section draws once it has what it asked for. */
    const drawn: Record<Section, () => Promise<unknown>> = {
      General: () => sheet(page).locator('[data-setting="general.branchPrefix"]').waitFor({ timeout: STEP_MS }),
      Terminal: () => sheet(page).getByRole('img', { name: 'Preview' }).waitFor({ timeout: STEP_MS }),
      Agents: () => sheet(page).locator('section.agent-card').first().waitFor({ timeout: STEP_MS }),
      Notifications: () => sheet(page).locator(`[data-setting="${SWITCH.key}"]`).waitFor({ timeout: STEP_MS }),
      Files: () => sheet(page).locator('[data-setting="files.showIgnored"]').waitFor({ timeout: STEP_MS }),
      Keyboard: () => until('the keyboard list drawn', async () => (await keyboardRows(kea)).length > 0 || undefined),
      Projects: () => sheet(page).getByRole('combobox').first().waitFor({ timeout: STEP_MS }),
      Disk: async () => {
        const row = sheet(page).locator(`[data-disk-row="${id}"]`)
        await until('the session’s size measured', async () => /\d/.test((await row.locator('[data-disk-size]').textContent().catch(() => '')) ?? '') || undefined)
        await until('its branch asked of git', async () => !/checking/.test((await row.locator('[data-disk-branch]').textContent().catch(() => 'checking')) ?? 'checking') || undefined)
        await sheet(page).locator('[data-disk-deleted="none"]').waitFor({ timeout: STEP_MS })
      },
      Advanced: () => until('the holder list read', async () => (await sheet(page).locator('[data-holder]').count()) === holders || undefined),
    }
    const toggle = async (): Promise<void> => {
      const row = sheet(page).locator(`[data-setting="${SWITCH.key}"]`)
      const reset = sheet(page).getByRole('button', { name: `Reset ${SWITCH.label} to its default` })
      await row.getByRole('switch').click()
      await reset.waitFor({ timeout: STEP_MS })
      await reset.click()
      await reset.waitFor({ state: 'detached', timeout: STEP_MS })
      expect(await row.getByRole('switch').isChecked(), 'the switch back at its default').toBe(false)
    }
    const diskRows = async (): Promise<Record<string, number>> => {
      const r = await page.evaluate(() => (globalThis as unknown as { __keaPerf: { resources(): Record<string, number> } }).__keaPerf.resources())
      return Object.fromEntries(Object.entries(r).filter(([k]) => /(?:^|\.)(?:disk[A-Z]\w*|diagnosticsAsks)$/.test(k)))
    }
    // the canonical state: the sheet closed, the Agent terminal on screen, core's disk service at rest (its walk thread
    // ends with the walk)
    const quiesce = async (): Promise<void> => {
      expect(await kea.shown()).toBe(agent)
      await atRest(page)
      await until('core’s disk service at rest', async () => {
        const d = (await kea.debug<Record<string, Record<string, number>>>('core', 'kit'))['core.disk']
        return (d?.walking === 0 && d.workers === 0 && d.queued === 0 && d.work === 0) || undefined
      })
    }

    const answered = await runCycles({
      kea,
      renderer,
      batch: 3,
      quiesce,
      cycle: async () => {
        await open()
        await drawn.General()
        await atRest(page)
        for (const section of SECTIONS.slice(1)) {
          await show(section)
          await drawn[section]()
          await atRest(page)
          if (section === SWITCH.section) await toggle()
        }
        await show('General')
        await atRest(page)
        await close()
        expect(Object.values(await diskRows()).every((n) => n === 0), `the Disk view’s rows once closed: ${JSON.stringify(await diskRows())}`).toBe(true)
      },
    })
    expect(answered.cycles.at(-1)).toBe(30)
    await waitRow(kea, id, 'still live', (r) => r.lifecycle === 'live')
    expectCountsFlat(answered, () => true)
    await expectBytesFlat(kea, renderer, answered, HEAPS, 'L-MEM-23')

    // ── closed while a section's question is still unanswered ──
    const core = await kea.pid('core')
    const hold = (sig: 'SIGSTOP' | 'SIGCONT'): void => {
      if (!signalKnown(core, sig)) throw new Error(`core (${core.pid}) is not the process it was`)
    }
    const unanswered = await runCycles({
      kea,
      renderer,
      batch: 1,
      quiesce,
      cycle: async () => {
        for (const section of ASKING) {
          await open()
          await atRest(page)
          hold('SIGSTOP')
          try {
            await show(section)
            await until(`${section}: a question to core waiting`, async () => (await pending(page)) > 0 || undefined)
            await close()
            expect(await pending(page), `${section}: still unanswered once the sheet has closed`).toBeGreaterThan(0)
          } finally {
            hold('SIGCONT')
          }
          // the answers arrive now, for nothing on screen
          await atRest(page)
        }
      },
    })
    expect(unanswered.cycles.at(-1)).toBe(10)
    expect((await kea.pid('core')).pid, 'the same core throughout').toBe(core.pid)
    await waitRow(kea, id, 'still live', (r) => r.lifecycle === 'live')
    expectCountsFlat(unanswered, () => true)
    await expectBytesFlat(kea, renderer, unanswered, HEAPS, 'L-MEM-23 (closed unanswered)')
  })
})
