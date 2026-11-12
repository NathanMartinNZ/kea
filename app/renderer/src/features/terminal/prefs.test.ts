import { describe, expect, it } from 'vitest'
import { L, parseSettings } from '@kea/protocol'
import { Prefs, staticPrefsSource, terminalPrefs } from './prefs.ts'

describe('terminal preferences', () => {
  it('U-TERM-24 · ⌘+ / ⌘− step the font size within the terminal font range; ⌘0 returns to the saved size; settings changes reach listeners', () => {
    const large = L.terminalFontSize + L.fontSizeStep
    const src = staticPrefsSource(terminalPrefs(parseSettings({ general: { fontSize: 'lg' }, terminal: { clipboardWrite: 'never' } }, []).values))
    const p = new Prefs(src)
    let changes = 0
    p.subscribe(() => changes++)
    expect(p.get().clipboardWrite).toBe('never')
    expect(p.get().confirmMultilinePaste).toBe(true)
    p.zoomBy(1)
    p.zoomBy(1)
    expect(p.appearance().fontSize).toBe(large + 2 * L.terminalFontStep)
    p.zoomBy(-1)
    expect(p.appearance().fontSize).toBe(large + L.terminalFontStep)
    p.zoomBy(0)
    expect(p.appearance().fontSize).toBe(large)
    expect(changes).toBe(4)
    p.zoomBy(0) // already at the setting: no change
    expect(changes).toBe(4)
    // never past the range
    for (let i = 0; i < L.terminalFontSizeMax; i++) p.zoomBy(1)
    expect(p.appearance().fontSize).toBe(L.terminalFontSizeMax)
    for (let i = 0; i < 2 * L.terminalFontSizeMax; i++) p.zoomBy(-1)
    expect(p.appearance().fontSize).toBe(L.terminalFontSizeMin)
    p.zoomBy(0)
    // a settings change is seen at once (live apply)
    const before = changes
    src.set(terminalPrefs(parseSettings({ general: { fontSize: 'xl' }, terminal: { cursorStyle: 'bar' } }, []).values))
    expect(changes).toBe(before + 1)
    expect(p.appearance()).toMatchObject({ fontSize: L.terminalFontSize + 2 * L.fontSizeStep, cursorStyle: 'bar' })
    // the settings store swaps in its own source (`Prefs.setSource`)
    p.setSource(staticPrefsSource(terminalPrefs(parseSettings({ general: { fontSize: 'sm' }, terminal: { theme: 'kea-dark' } }, []).values)))
    expect(p.appearance().fontSize).toBe(L.terminalFontSize - L.fontSizeStep)
  })
})
