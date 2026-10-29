// Leak cycle of the agent beside the work pane (the split) against the real app (tests/support/app.ts), measured with
// tests/support/app-leak.ts: sessions switched, the split toggled, the window narrowed past the split's need and widened
// again, files opened and closed. Every per-session memory of the window (both tab memories, the active pane, the file
// tabs) and every view, context and listener comes back to where it was.
import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { KeaRun, PROMPT, STEP_MS, until, type Kea } from '../support/app.ts'
import { expectBytesFlat, expectCountsFlat, RendererProbe, runCycles, type LeakRun } from '../support/app-leak.ts'
import { addProject, agentTerminal, demoRepo, selectSession, startSession, waitLive } from '../support/app-sessions.ts'
import { fileTabs, openFile, viewerShown } from '../support/app-tabs.ts'

const runs: KeaRun[] = []
const probes: RendererProbe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

const HEAPS = ['renderer.heap', 'core.heap', 'ptyhost.heap', 'main.heap']
/** Exact counts: all of them but the atlas sizes the views report, which follow what was drawn. */
const COUNTS = (key: string) => !/\.atlas(?:Bytes|Pages)$/.test(key)
/** A window that holds the split with both side columns open, and one that does not. */
const WIDE = { width: 1440, height: 880 }
const NARROW = { width: 1280, height: 820 }
/** The sessions a cycle goes through. */
const SESSIONS = 2

function seriesOf(run: LeakRun, key: string): number[] {
  return run.points.map((p) => p.counts[key] ?? 0)
}

async function splitDrawn(kea: Kea, on: boolean): Promise<void> {
  await until(on ? 'the split drawn' : 'one column', async () => ((await kea.layout()).split !== null) === on || undefined)
}

describe('the split (app)', () => {
  it('L-TERM-13 · 50 rounds of switching sessions, toggling the split, crossing its width and opening and closing a file in each session: views, WebGL contexts, listeners, DOM nodes and the per-session memories at every checkpoint as at the first; heaps within budget', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    await addProject(kea, demoRepo(run).root)
    await kea.setLayout({ agentBeside: true })
    await kea.resize(WIDE.width, WIDE.height)
    await splitDrawn(kea, true)
    const ids: string[] = []
    for (let i = 0; i < SESSIONS; i++) ids.push(await startSession(kea, `split ${i + 1}`, { background: true, open: i === 0 }))
    for (const id of ids) await waitLive(kea, id)
    // each session: its agent beside one shell
    const agents = new Map<string, string>()
    for (const id of ids) {
      agents.set(id, await agentTerminal(kea, id))
      const shell = await kea.newTab()
      await until('the shell’s prompt', async () => (await kea.terminalText(shell)).includes(PROMPT) || undefined)
    }
    const renderer = await RendererProbe.open(kea, { classes: ['Terminal', 'EditorView'] })
    probes.push(renderer)
    const onAgent = (id: string) => until(`the agent of ${id} beside its work pane`, async () => ((await kea.shown('agent')) === agents.get(id) ? true : undefined), STEP_MS)

    const leak = await runCycles({
      kea,
      renderer,
      warmup: 2,
      batch: 5,
      cycle: async () => {
        for (const id of ids) {
          await selectSession(kea, id)
          await onAgent(id)
          await openFile(kea, { sessionId: id, path: 'README.md', mode: 'file' })
          await until('the file on screen', async () => (await viewerShown(kea)) ?? undefined)
          await kea.press('Escape')
          await until('the file closed', async () => ((await fileTabs(kea)).length === 0 ? true : undefined))
        }
        await kea.setLayout({ agentBeside: false })
        await splitDrawn(kea, false)
        await kea.setLayout({ agentBeside: true })
        await splitDrawn(kea, true)
        await kea.resize(NARROW.width, NARROW.height)
        await splitDrawn(kea, false)
        await kea.resize(WIDE.width, WIDE.height)
        await splitDrawn(kea, true)
        await onAgent(ids.at(-1)!)
      },
    })
    expect(leak.cycles.at(-1)).toBe(50)
    const live = seriesOf(leak, 'renderer.liveTerminal')
    expect(new Set(live).size, `live Terminal instances at every checkpoint: ${live}`).toBe(1)
    for (const key of ['renderer.liveWebgl2Contexts', 'renderer.webglContexts']) {
      const sr = seriesOf(leak, key)
      expect(sr.every((n) => n <= L.webglContextsMax), `${key} within L.webglContextsMax: ${sr}`).toBe(true)
    }
    expect(new Set(seriesOf(leak, 'renderer.tabMemory')).size, 'the per-session tab memories').toBe(1)
    expectCountsFlat(leak, COUNTS)
    await expectBytesFlat(kea, renderer, leak, HEAPS, 'L-TERM-13')
  })
})
