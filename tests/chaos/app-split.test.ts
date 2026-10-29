// The agent beside the work pane (the split) through a reload of the window and a restart of core, against the real app
// (tests/support/app.ts): both panes come back as they were, the agent beside the terminal the session's work pane was
// left on, and every holder outlives both.
import { afterEach, describe, expect, it } from 'vitest'
import { KeaRun, PROMPT, STEP_MS, until, type Kea } from '../support/app.ts'
import { holdersUnharmed } from '../support/app-chaos.ts'
import { addProject, agentTerminal, demoRepo, startSession, waitLive } from '../support/app-sessions.ts'

const runs: KeaRun[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose()
})

const WIDE = { width: 1440, height: 880 }

async function bothPanes(kea: Kea, agent: string, work: string, what: string): Promise<void> {
  await until(what, async () => ((await kea.shown('agent')) === agent && (await kea.shown('work')) === work ? true : undefined), STEP_MS)
}

describe('the split through failures (app)', () => {
  it('C-RACE-8 · the window reloaded and core restarted with the split drawn: the agent pane shows the agent again and the work pane the terminal it was left on, the keyboard with the agent; no holder is harmed', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    await addProject(kea, demoRepo(run).root)
    await kea.setLayout({ agentBeside: true })
    await kea.resize(WIDE.width, WIDE.height)
    await until('the split drawn', async () => (await kea.layout()).split ?? undefined)
    const id = await startSession(kea, 'split race')
    await waitLive(kea, id)
    const agent = await agentTerminal(kea, id)
    const t1 = await kea.newTab()
    const t2 = await kea.newTab()
    for (const t of [t1, t2]) await until('the shell’s prompt', async () => (await kea.terminalText(t)).includes(PROMPT) || undefined)
    // the work pane left on its first shell, not its last
    await kea.clickTab(t1)
    await bothPanes(kea, agent, t1, 'the agent beside Terminal 1')
    const holders = run.holders()

    await kea.reloadWindow()
    await bothPanes(kea, agent, t1, 'after the reload: the agent beside Terminal 1 again')
    expect((await kea.layout()).split, 'the split is still drawn').not.toBeNull()

    const old = await kea.pid('core')
    await kea.signal('core', 'SIGKILL')
    await kea.restarted('core', old)
    await bothPanes(kea, agent, t1, 'after core’s restart: the agent beside Terminal 1 again')
    await kea.echo('c-race-8')
    expect(await kea.terminalText(agent), 'what was typed after both went to the agent').toContain('c-race-8-42')
    holdersUnharmed(run, holders)
  })
})
