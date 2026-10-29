import { describe, expect, it } from 'vitest'
import { viewed, type ViewedInput } from './viewed.ts'

const base: ViewedInput = { pane: { kind: 'session', id: 's1' }, focused: true, agentPane: null, shown: null, live: () => true }
const v = (o: Partial<ViewedInput>) => viewed({ ...base, ...o })

describe('the session being viewed', () => {
  it('U-ST-24 · in the split the session is viewed while its agent pane is drawn, whatever the work pane shows; one column needs the Agent tab; a detached session with no Agent tab counts while shown', () => {
    // the split: the agent pane is drawn beside a shell, a file, a diff or nothing
    for (const kind of ['shell', 'server', 'file', 'diff', null] as const) expect(v({ agentPane: 's1', shown: { context: 's1', kind } }), String(kind)).toBe('s1')
    expect(v({ agentPane: 's1' }), 'the work pane has reported nothing yet').toBe('s1')
    // but never unfocused, nor another session's agent pane
    expect(v({ agentPane: 's1', focused: false })).toBeNull()
    expect(v({ agentPane: 's2' })).toBeNull()
    expect(v({ agentPane: 's1', pane: { kind: 'composer' } })).toBeNull()
    // one column: the Agent tab, and nothing else
    expect(v({ shown: { context: 's1', kind: 'agent' } })).toBe('s1')
    for (const kind of ['shell', 'server', 'script', 'file', 'diff'] as const) expect(v({ shown: { context: 's1', kind } }), kind).toBeNull()
    expect(v({ shown: { context: 's2', kind: 'agent' } }), 'another session’s pane').toBeNull()
    expect(v({ shown: { context: 's1', kind: 'agent' }, focused: false })).toBeNull()
    // detached, no Agent tab left: shown counts; a live session showing no tab does not
    expect(v({ shown: { context: 's1', kind: null }, live: () => false })).toBe('s1')
    expect(v({ shown: { context: 's1', kind: null } })).toBeNull()
    expect(v({ pane: { kind: 'shells' }, shown: { context: 'shells', kind: 'shell' } })).toBeNull()
  })
})
