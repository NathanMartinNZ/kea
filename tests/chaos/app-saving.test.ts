// Saving from the file view and quitting with unsaved files, under faults, against the real app (tests/support/app.ts).
// C-KILL-27 kills core at each step of a save, where the child hook's hold op stops it at `save:<step>`
// (tests/support/app-child-hooks.cjs). C-KILL-28 sends main SIGTERM twice in a row, with nothing unsaved and while an
// unsaved file's warning asks: Kea quits once, after the review, never by the signal's default action (Electron's own
// handler puts that back after the first signal; main's own handler replaces Electron's).

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KeaRun, PROMPT, STEP_MS, until, type Kea } from '../support/app.ts'
import { holdersUnharmed } from '../support/app-chaos.ts'
import { addProject, demoRepo, startSession, waitLive } from '../support/app-sessions.ts'
import { openFile } from '../support/app-tabs.ts'
import { sampleSource, sessionWorktree, viewerText, waitViewer, writeFiles } from '../support/app-viewer.ts'
import { sysKey, textKey } from '../support/keys.ts'

const runs: KeaRun[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose()
})

/** A session of a demo repository with `file` (`text`) open in the viewer, editable, the keyboard in it. */
async function editing(kea: Kea, run: KeaRun, file: string, text: string): Promise<{ id: string; abs: string }> {
  await kea.oneColumn()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'saving')
  await waitLive(kea, id)
  const worktree = sessionWorktree(repo.root)
  writeFiles(worktree, { [file]: text })
  expect(await openFile(kea, { sessionId: id, path: file, mode: 'file' }), `viewer.open ${file}`).toBe(true)
  await waitViewer(kea, `${file} shown and editable`, (v) => v.ui.path === file && v.ui.body.kind === 'text' && v.ui.editable && !v.ui.unsaved)
  return { id, abs: path.join(fs.realpathSync(worktree), file) }
}

/** The first line of the document on screen typed again as `line`, key by key; resolves with the document's text. */
async function retype(kea: Kea, line: string, rest: string): Promise<string> {
  const page = await kea.page()
  await page.locator('.viewer .cm-content').focus()
  await page.keyboard.press(textKey('Meta+ArrowUp'))
  await page.keyboard.press('Shift+End')
  await page.keyboard.type(line)
  const text = `${line}\n${rest}`
  await until(`“${line}” typed`, async () => (await viewerText(kea)) === text || undefined)
  return text
}

/** The steps of a save at which core is killed, in the order a save passes them. */
const STEPS = ['save:journal', 'save:temp', 'save:write', 'save:rename', 'save:renamed'] as const
type Step = (typeof STEPS)[number]

describe('saving and unsaved files under faults (app)', () => {
  it('C-KILL-27 · core killed (SIGKILL) at each step of a save from the file view, twice over (before the journal lists the new file, before it is made, half written, whole before the rename, after the rename): the file is its old bytes or its new ones, whole; the restarted core’s sweep leaves no new file and an empty journal; the document is unsaved with “Kea’s core restarted” in its notice, or clean when the file holds what it sent; Try Again saves', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    const FILE = 'notes/saved.txt'
    // a few KB, so a write cut in half leaves part of it
    const rest = sampleSource(4, 300)
    let onDisk = `// save 0000\n${rest}`
    const { abs } = await editing(kea, run, FILE, onDisk)
    const holders = run.holders()
    const page = await kea.page()
    const journal = path.join(run.home, 'save-journal.json')
    /** The new files the journal lists (none while it is not there). */
    const listed = (): string[] => {
      try {
        return (JSON.parse(fs.readFileSync(journal, 'utf8')) as { file: string }[]).map((e) => e.file)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw e
      }
    }
    /** New files of a save beside the file. */
    const newFiles = (): string[] => fs.readdirSync(path.dirname(abs)).filter((f) => f.startsWith('.kea-save-'))
    const swept = () => kea.logLines('core').filter((l) => l.msg === 'save journal swept')
    const seen: Record<string, string> = {}

    for (let round = 0; round < 2; round++) {
      for (const step of STEPS) {
        const n = round * STEPS.length + STEPS.indexOf(step) + 1
        const text = await retype(kea, `// save ${String(n).padStart(4, '0')}`, rest)
        await waitViewer(kea, 'unsaved', (v) => v.ui.unsaved)
        const held = path.join(run.home, 'held-save')
        fs.rmSync(held, { force: true })
        expect(await kea.debug('core', 'hold', `${step}|${held}`)).toBe(step)
        await page.keyboard.press(sysKey('Meta+s'))
        const at = await until(`core held at ${step}`, () => {
          try {
            return JSON.parse(fs.readFileSync(held, 'utf8')) as { point: Step; temp: string | null }
          } catch {
            return undefined
          }
        })
        expect(at.point).toBe(step)

        // where the save stands at the step
        const was = fs.readFileSync(abs, 'utf8')
        const whole = Buffer.byteLength(text)
        const state = { listed: listed(), temp: at.temp === null ? null : fs.existsSync(at.temp) ? fs.statSync(at.temp).size : 'none', file: was === onDisk ? 'old' : was === text ? 'new' : 'neither' }
        const expected: Record<Step, typeof state> = {
          'save:journal': { listed: [], temp: null, file: 'old' },
          'save:temp': { listed: [at.temp as string], temp: 'none', file: 'old' },
          'save:write': { listed: [at.temp as string], temp: state.temp, file: 'old' },
          'save:rename': { listed: [at.temp as string], temp: whole, file: 'old' },
          'save:renamed': { listed: [at.temp as string], temp: 'none', file: 'new' },
        }
        expect(state, `${step}: the journal, the new file (its size) and the file`).toEqual(expected[step])
        if (step === 'save:write') expect(typeof state.temp === 'number' && state.temp > 0 && state.temp < whole, `${step}: the new file is part written (${state.temp} of ${whole} bytes)`).toBe(true)

        // killed there: the file is whole, old or new
        const sweptBefore = swept().length
        const core = await kea.signal('core', 'SIGKILL')
        const after = fs.readFileSync(abs, 'utf8')
        expect(after === onDisk || after === text, `${step}: the file is its old bytes or its new ones, whole`).toBe(true)
        expect(after === text ? 'new' : 'old', `${step}: which`).toBe(step === 'save:renamed' ? 'new' : 'old')

        // the next core sweeps what the save left
        await kea.restarted('core', core)
        await until(`${step}: the journal emptied and no new file left`, () => (listed().length === 0 && newFiles().length === 0) || undefined)
        const sweep = swept().slice(sweptBefore)
        const removed = step === 'save:write' || step === 'save:rename' ? 1 : 0
        expect(
          sweep.map((l) => ({ entries: l.entries, removed: l.removed })),
          `${step}: the sweep's log line`,
        ).toEqual(step === 'save:journal' ? [] : [{ entries: 1, removed }])

        // the document: clean when the file holds what it sent, otherwise unsaved with the reason, and Try Again saves
        if (step === 'save:renamed') {
          await waitViewer(kea, `${step}: clean, the read after the restart found the text it sent`, (v) => v.ui.path === FILE && !v.ui.unsaved && v.ui.editNotice === null)
          seen[step] = 'clean'
        } else {
          const failed = await waitViewer(kea, `${step}: unsaved, the reason in its notice`, (v) => v.ui.path === FILE && v.ui.unsaved && v.ui.editNotice !== null)
          expect(failed.ui.editNotice, `${step}: the notice`).toEqual({ text: 'Not saved · Kea’s core restarted', actions: ['retry'] })
          seen[step] = failed.ui.editNotice?.text ?? ''
          await page.locator('.viewer-edit-notice').getByRole('button', { name: 'Try Again' }).click()
          await waitViewer(kea, `${step}: saved by Try Again`, (v) => v.ui.path === FILE && !v.ui.unsaved && v.ui.editNotice === null && v.resources.viewerSaving === 0)
        }
        expect(fs.readFileSync(abs, 'utf8') === text, `${step}: the file holds the new text`).toBe(true)
        expect({ listed: listed(), newFiles: newFiles() }, `${step}: after the save`).toEqual({ listed: [], newFiles: [] })
        onDisk = text
      }
    }
    console.info(`C-KILL-27 · the document after each kill: ${JSON.stringify(seen)}`)
    // the terminals never noticed
    holdersUnharmed(run, holders)
    await kea.assertUnfocused()
  }, 240_000)

  it('C-KILL-28 · SIGTERM to main twice in a row: with nothing unsaved Kea quits once (exit 0, not the signal); with an unsaved file the first asks (the warning on screen), the second queues a review behind it and does not end Kea; Cancel stops the first quit and the second asks again; Don’t Save quits once, core and ptyhost each shut down once, the file as it was', async () => {
    // nothing unsaved: the two back to back (the system may hand them over as one; the second case sends its second
    // while the first is known to be asking)
    {
      const run = KeaRun.create()
      runs.push(run)
      const kea = await run.launch()
      await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
      expect(await kea.app.evaluate(() => process.listenerCount('SIGTERM')), 'main’s own SIGTERM handler').toBe(1)
      const exit = exited(kea)
      const main = await kea.pid('main')
      run.signalProcess(main, 'SIGTERM')
      run.signalProcess(main, 'SIGTERM')
      expect(await exit, 'nothing unsaved: main’s exit').toEqual({ code: 0, signal: null })
      await kea.gone()
      expect(shutdowns(kea), 'shutdowns logged, nothing unsaved').toEqual({ core: 1, ptyhost: 1 })
    }

    // an unsaved file
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    const FILE = 'notes/unsaved.txt'
    const rest = 'the rest of the file\n'
    const { abs } = await editing(kea, run, FILE, `first line\n${rest}`)
    await retype(kea, 'typed, not saved', rest)
    await waitViewer(kea, 'unsaved', (v) => v.ui.unsaved)
    const page = await kea.page()
    const exit = exited(kea)
    const main = await kea.pid('main')
    const warning = page.getByRole('alertdialog', { name: 'Do you want to save the changes you made to unsaved.txt?' })
    const alive = () => ({ exitCode: kea.app.process().exitCode, signalCode: kea.app.process().signalCode })

    run.signalProcess(main, 'SIGTERM')
    await warning.waitFor({ timeout: STEP_MS })
    expect((await reviews(kea)).requests, 'the first SIGTERM’s quit, asking').toBe(1)
    run.signalProcess(main, 'SIGTERM')
    await until('the second SIGTERM’s quit queued behind the first', async () => (await reviews(kea)).requests === 2 || undefined)
    expect(alive(), 'Kea still running while the warning asks').toEqual({ exitCode: null, signalCode: null })
    expect(await warning.isVisible(), 'the warning still on screen').toBe(true)

    // Cancel: the first quit stops there; the second asks again, as a request of its own
    await warning.getByRole('button', { name: 'Cancel', exact: true }).click()
    await until('the first quit cancelled and the second asking', async () => ((await reviews(kea)).requests === 1 && (await warning.isVisible())) || undefined)
    expect(alive(), 'Kea still running after Cancel').toEqual({ exitCode: null, signalCode: null })

    // Don't Save: Kea quits, once
    await warning.getByRole('button', { name: 'Don’t Save' }).click()
    expect(await exit, 'an unsaved file: main’s exit').toEqual({ code: 0, signal: null })
    await kea.gone()
    expect(shutdowns(kea), 'shutdowns logged, an unsaved file let go').toEqual({ core: 1, ptyhost: 1 })
    expect(fs.readFileSync(abs, 'utf8'), 'the file as it was').toBe(`first line\n${rest}`)
  })
})

/** Main's exit, once it happens. */
function exited(kea: Kea): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const proc = kea.app.process()
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) resolve({ code: proc.exitCode, signal: proc.signalCode })
    else proc.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

/** Main's review queue (its `main.reviews` resource row). */
function reviews(kea: Kea): Promise<{ windows: number; requests: number; tickets: number }> {
  return kea.app.evaluate(() => {
    const reg = (globalThis as unknown as Record<symbol, { report(): Record<string, unknown> }>)[Symbol.for('kea.kit.resources')]
    return reg?.report()['main.reviews'] as { windows: number; requests: number; tickets: number }
  })
}

/** How many times core and ptyhost logged their shutdown. */
function shutdowns(kea: Kea): { core: number; ptyhost: number } {
  const n = (p: 'core' | 'ptyhost') => kea.logLines(p).filter((l) => l.msg === 'shutdown').length
  return { core: n('core'), ptyhost: n('ptyhost') }
}
