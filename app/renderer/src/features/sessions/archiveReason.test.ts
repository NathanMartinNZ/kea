import { describe, expect, it } from 'vitest'
import { archiveReason } from './archiveReason.ts'

describe('the archive sheet’s reasons', () => {
  // archiving also asks when it could not be learned whether a shell tab runs a program; the sheet must not then say
  // "A shell tab is running a program"
  it('U-SES-12 · the archive sheet says what is true of a shell tab: a program known to run is named; when it could not be learned whether one runs, the sheet says it may be and that Kea could not tell, in the close-tab sheet’s words; the other reasons read as before', () => {
    // known to be busy: the program, named as data
    expect(archiveReason({ kind: 'shellBusy', detail: 'cat' })).toBe('A shell tab is running a program: cat')
    expect(archiveReason({ kind: 'shellBusy', detail: '' })).toBe('A shell tab is running a program')
    // not known (core's `known: false`): never "is running"
    const unknown = archiveReason({ kind: 'shellUnknown', detail: '' })
    expect(unknown).toBe('A shell tab may be running a program: Kea could not tell whether one is still running in it')
    expect(unknown).not.toContain('is running a program')
    expect(archiveReason({ kind: 'shellUnknown', detail: 'ignored' })).toBe(unknown)
    // a program's name is its own word: control characters never reach the sheet
    expect(archiveReason({ kind: 'shellBusy', detail: 'ev\x1b[31mil' })).toBe('A shell tab is running a program: ev [31mil')
    // the others
    expect(archiveReason({ kind: 'midTurn', detail: 'the agent is working' })).toBe('The agent is in the middle of a turn: the agent is working')
    expect(archiveReason({ kind: 'server', detail: '' })).toBe('A dev server is running')
    expect(archiveReason({ kind: 'somethingNew', detail: '' })).toBe('somethingNew')
  })
})
