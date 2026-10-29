import { afterEach, describe, expect, it, vi } from 'vitest'
import { L } from '@kea/protocol'
import { osc52Decision, parseOsc52 } from './osc52.ts'
import { terminalUi, uiState } from './ui.svelte.ts'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

describe('OSC 52 write policy', () => {
  it('U-TERM-15 · visible + focused applies the write; hidden or unfocused drops it; `never` drops; `always` applies while hidden', () => {
    const parsed = parseOsc52(`c;${b64('git push --force ✓')}`, L.osc52MaxBytes)
    expect(parsed).toEqual({ kind: 'write', text: 'git push --force ✓', bytes: Buffer.byteLength('git push --force ✓') })
    expect(osc52Decision({ parsed, policy: 'focused', visible: true, windowFocused: true })).toEqual({ apply: true, text: 'git push --force ✓' })
    expect(osc52Decision({ parsed, policy: 'focused', visible: false, windowFocused: true })).toEqual({ apply: false, reason: 'hidden' })
    expect(osc52Decision({ parsed, policy: 'focused', visible: true, windowFocused: false })).toEqual({ apply: false, reason: 'unfocused' })
    expect(osc52Decision({ parsed, policy: 'never', visible: true, windowFocused: true })).toEqual({ apply: false, reason: 'never' })
    expect(osc52Decision({ parsed, policy: 'always', visible: false, windowFocused: false })).toEqual({ apply: true, text: 'git push --force ✓' })
  })

  it('U-TERM-15 · up to the size cap is applied; one byte more is dropped without being decoded; reads and garbage are dropped', () => {
    const atCap = 'x'.repeat(L.osc52MaxBytes)
    const ok = parseOsc52(`;${b64(atCap)}`, L.osc52MaxBytes)
    expect(ok.kind).toBe('write')
    expect(osc52Decision({ parsed: ok, policy: 'always', visible: true, windowFocused: true }).apply).toBe(true)
    const over = parseOsc52(`c;${b64(`${atCap}x`)}`, L.osc52MaxBytes)
    expect(over).toEqual({ kind: 'oversize', bytes: L.osc52MaxBytes + 1 })
    expect(osc52Decision({ parsed: over, policy: 'always', visible: true, windowFocused: true })).toEqual({ apply: false, reason: 'oversize' })
    expect(parseOsc52('c;?', L.osc52MaxBytes)).toEqual({ kind: 'read' })
    expect(osc52Decision({ parsed: { kind: 'read' }, policy: 'always', visible: true, windowFocused: true })).toEqual({ apply: false, reason: 'read' })
    for (const bad of ['', 'c', 'c;', 'c;!!!!', 'c;a', 'p;Zm9v\x1b']) expect(parseOsc52(bad, L.osc52MaxBytes).kind, JSON.stringify(bad)).toBe('invalid')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('U-TERM-15 · an applied write shows “Copied by terminal” for the note’s duration, on the terminal that wrote; another write restarts it', () => {
    vi.useFakeTimers()
    terminalUi.copiedByTerminal('p1')
    expect(uiState.snapshot().copied).toBe('p1')
    vi.advanceTimersByTime(L.osc52NoteMs - 1)
    terminalUi.copiedByTerminal('p2')
    vi.advanceTimersByTime(L.osc52NoteMs - 1)
    expect(uiState.snapshot().copied).toBe('p2')
    vi.advanceTimersByTime(1)
    expect(uiState.snapshot().copied).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
