import { describe, expect, it } from 'vitest'
import { endedText } from './detached.ts'

describe('the detached overlay', () => {
  it('U-SES-7 · "Session ended", refined by why the agent ended: stopped, exited, crashed with its exit code or signal, lost', () => {
    expect(endedText('exited', { code: 0, signal: null })).toBe('Session ended')
    expect(endedText(null, null)).toBe('Session ended')
    expect(endedText('stopped', { code: null, signal: 15 })).toBe('Session stopped')
    expect(endedText('crashed', { code: 3, signal: null })).toBe('Agent crashed (exit 3)')
    expect(endedText('crashed', { code: null, signal: 9 })).toBe('Agent crashed (signal 9)')
    expect(endedText('crashed', null)).toBe('Agent crashed')
    expect(endedText('lost', { code: null, signal: null })).toBe('Agent lost with its terminal')
  })
})
