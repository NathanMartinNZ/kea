import { describe, expect, it, vi } from 'vitest'
import { ClearOnCopy, CopyHint, isUserSelection, selectionKey } from './ctrlCopy.ts'

const at = (y1: number, x1: number, y2: number, x2: number) => ({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 } })

describe('plain Ctrl+C in a terminal', () => {
  it('U-PLT-58 · the find bar’s match is not the person’s selection; one they made elsewhere, or over it again after another, is', () => {
    const match = selectionKey(at(3, 4, 3, 9))
    expect(selectionKey(undefined)).toBeNull()
    expect(isUserSelection(true, selectionKey(at(5, 0, 6, 2)), match)).toBe(true)
    expect(isUserSelection(true, match, match)).toBe(false) // left by the find bar, after it closed too
    expect(isUserSelection(false, null, match)).toBe(false)
    expect(isUserSelection(true, selectionKey(at(5, 0, 6, 2)), null)).toBe(true) // no search made
    expect(selectionKey(at(3, 4, 3, 9))).not.toBe(selectionKey(at(3, 4, 3, 10)))
  })

  it('U-PLT-58 · a copy made by plain Ctrl+C clears the selection only from the terminal’s own copy event, once; a selection changed first keeps it', () => {
    const c = new ClearOnCopy()
    expect(c.copied()).toBe(false) // Ctrl+Shift+C's copy keeps the selection
    c.arm()
    expect(c.isArmed).toBe(true)
    expect(c.copied()).toBe(true)
    expect(c.copied()).toBe(false) // spent
    c.arm()
    c.selectionChanged() // another drag before the copy ran
    expect(c.copied()).toBe(false)
  })

  it('U-TERM-55 · the hint asks core once a window, and shows only when core says it is the first time in this KEA_HOME', async () => {
    const shown: string[] = []
    const ask = vi.fn(async () => true)
    const hint = new CopyHint(ask, () => shown.push('hint'))
    await Promise.all([hint.due(), hint.due()])
    expect(shown).toEqual(['hint'])
    expect(ask).toHaveBeenCalledTimes(1)
    // a KEA_HOME that has seen it: never shown
    const again = new CopyHint(async () => false, () => shown.push('again'))
    await again.due()
    expect(shown).toEqual(['hint'])
    // core not answering shows nothing and throws nothing
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await new CopyHint(async () => Promise.reject(new Error('gone')), () => shown.push('failed')).due()
    expect(shown).toEqual(['hint'])
    warn.mockRestore()
  })
})
