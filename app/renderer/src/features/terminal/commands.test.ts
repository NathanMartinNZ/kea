import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PANE_TOO_NARROW, agentPaneToggle, DEFAULT_LAYOUT, splitNeed } from '../../shell/layout.ts'

// the terminal on screen with the keyboard, or the active pane's: what `activeView` gives the commands
const onScreen: { view: { ptyId: string; focus: () => void } | undefined } = { view: undefined }
vi.mock('./views.ts', () => ({ activeView: () => onScreen.view, viewFor: () => undefined, clearAllAtlases: () => undefined }))
vi.mock('../../lib/rpc.ts', () => ({ call: () => Promise.resolve() }))
vi.mock('../../lib/reactive.svelte.ts', () => ({ watch: () => () => undefined }))

const { commands } = await import('../commands/registry.ts')
const { registerPaneCommands, registerTerminalCommands } = await import('./commands.ts')

const offs: { dispose(): void }[] = []
afterEach(() => {
  for (const d of offs.splice(0)) d.dispose()
  onScreen.view = undefined
})

/** The split's commands: the work pane's strip, the agent pane beside it. */
function split(o: { pane: 'work' | 'agent'; active: string | null; lastTerminal?: string | null }) {
  const did: string[] = []
  const strip = ['server1', 'shell1', 'file:a.ts']
  offs.push(
    registerTerminalCommands({
      tabs: () => strip,
      active: () => o.active,
      terminal: () => onScreen.view?.ptyId ?? null,
      lastTerminal: () => o.lastTerminal ?? null,
      openShell: () => did.push('openShell'),
      canClose: (id) => id.startsWith('file:') || id.startsWith('shell'),
      closing: () => (o.pane === 'agent' ? 'agent1' : o.active),
      closeTab: (id) => did.push(`close ${id}`),
      focusAgent: () => did.push('focusAgent'),
      agentThere: () => true,
      select: (id) => did.push(`select ${id}`),
      openFind: () => did.push('find'),
    }),
  )
  return did
}

describe('the commands of the split', () => {
  it('U-KB-20 · Next and Previous Tab step through the work pane’s strip, also from the agent pane, and never move the keyboard; ⌘W acts on the active pane and is unavailable in the agent pane', () => {
    const fromAgent = split({ pane: 'agent', active: 'shell1' })
    expect(commands.run('terminal.nextTab')).toBe(true)
    expect(commands.run('terminal.previousTab')).toBe(true)
    // the work pane's tabs change; nothing is focused, so what is typed next still reaches the agent
    expect(fromAgent).toEqual(['select file:a.ts', 'select server1'])
    // ⌘W with the agent pane active: the agent's terminal is not closable
    expect(commands.available('terminal.closeTab')).toBe(false)
    expect(commands.reason('terminal.closeTab')).toBe('This tab cannot be closed')
    expect(commands.run('terminal.closeTab')).toBe(false)
    expect(fromAgent).not.toContain('close agent1')
    for (const d of offs.splice(0)) d.dispose()

    // the work pane active: ⌘W closes the tab it shows, a file tab or a shell
    const fromWork = split({ pane: 'work', active: 'file:a.ts' })
    expect(commands.run('terminal.closeTab')).toBe(true)
    expect(fromWork).toEqual(['close file:a.ts'])
    for (const d of offs.splice(0)) d.dispose()
    split({ pane: 'work', active: 'server1' })
    expect(commands.available('terminal.closeTab'), 'the Server tab is not closable').toBe(false)
  })

  it('U-KB-20 · ⌃` gives the keyboard to the active pane’s terminal; with a file on screen and no terminal to go back to, to the agent', () => {
    const focused: string[] = []
    onScreen.view = { ptyId: 'agent1', focus: () => focused.push('agent1') }
    split({ pane: 'agent', active: 'file:a.ts' })
    expect(commands.run('terminal.focus')).toBe(true)
    expect(focused).toEqual(['agent1'])
    for (const d of offs.splice(0)) d.dispose()

    // the viewer has the keyboard, no terminal is shown in the work pane and none was before the file: the agent
    onScreen.view = undefined
    const did = split({ pane: 'work', active: 'file:a.ts', lastTerminal: null })
    expect(commands.run('terminal.focus')).toBe(true)
    expect(did).toEqual(['focusAgent'])
    for (const d of offs.splice(0)) d.dispose()
    // a terminal shown before the file comes back, as in one column
    const back = split({ pane: 'work', active: 'file:a.ts', lastTerminal: 'shell1' })
    expect(commands.run('terminal.focus')).toBe(true)
    expect(back).toEqual(['select shell1'])
  })

  it('U-KB-20 · Focus Agent and Focus Work Pane run in the split; Focus Work Pane is unavailable in one column and Focus Agent before the agent starts, each with its reason', () => {
    const did: string[] = []
    const s = { split: true, agent: true }
    offs.push(registerPaneCommands({ split: () => s.split, agentThere: () => s.agent, focusAgent: () => did.push('agent'), focusWork: () => did.push('work') }))
    expect(commands.run('view.focusAgent')).toBe(true)
    expect(commands.run('view.focusWork')).toBe(true)
    expect(did).toEqual(['agent', 'work'])
    s.split = false
    expect(commands.reason('view.focusWork')).toBe('The agent is shown as a tab')
    expect(commands.available('view.focusAgent'), 'one column: the Agent tab').toBe(true)
    s.agent = false
    expect(commands.reason('view.focusAgent')).toBe('The agent is not running')
    expect(commands.run('view.focusAgent')).toBe(false)
    expect(did).toEqual(['agent', 'work'])
  })

  it('U-KB-20 · View ▸ Show Agent Beside Terminals / Show Agent as a Tab follows the choice and is unavailable while the main column cannot hold the split', () => {
    const cell = 8
    const room = { ...DEFAULT_LAYOUT, sidebarHidden: true, treeHidden: true }
    const need = splitNeed(cell).total
    expect(agentPaneToggle({ ...room, agentBeside: false }, need, cell)).toEqual({ title: 'Show Agent Beside Terminals', fits: true })
    expect(agentPaneToggle({ ...room, agentBeside: true }, need, cell)).toEqual({ title: 'Show Agent as a Tab', fits: true })
    expect(agentPaneToggle({ ...room, agentBeside: true }, need - 1, cell).fits).toBe(false)
    expect(AGENT_PANE_TOO_NARROW).toBe('The window is too narrow to show the agent beside terminals')
  })
})
