import { describe, expect, it } from 'vitest'
import { L, parseSettings } from '@kea/protocol'
import { Prefs, staticPrefsSource, terminalPrefs } from './prefs.ts'

describe('terminal preferences', () => {
  it('U-TERM-24 · ⌘+ / ⌘− step the font size within the setting’s range; ⌘0 returns to the setting; settings changes reach listeners', () => {
    const src = staticPrefsSource(terminalPrefs(parseSettings({ terminal: { fontSize: 14, clipboardWrite: 'never' } }, []).values))
    const p = new Prefs(src)
    let changes = 0
    p.subscribe(() => changes++)
    expect(p.get().clipboardWrite).toBe('never')
    expect(p.get().confirmMultilinePaste).toBe(true)
    p.zoomBy(1)
    p.zoomBy(1)
    expect(p.appearance().fontSize).toBe(14 + 2 * L.terminalFontStep)
    p.zoomBy(-1)
    expect(p.appearance().fontSize).toBe(14 + L.terminalFontStep)
    p.zoomBy(0)
    expect(p.appearance().fontSize).toBe(14)
    expect(changes).toBe(4)
    p.zoomBy(0) // already at the setting: no change
    expect(changes).toBe(4)
    // never past the range
    for (let i = 0; i < L.settingsFontSizeMax; i++) p.zoomBy(1)
    expect(p.appearance().fontSize).toBe(L.settingsFontSizeMax)
    for (let i = 0; i < 2 * L.settingsFontSizeMax; i++) p.zoomBy(-1)
    expect(p.appearance().fontSize).toBe(L.settingsFontSizeMin)
    p.zoomBy(0)
    // a settings change is seen at once (live apply)
    const before = changes
    src.set(terminalPrefs(parseSettings({ terminal: { fontSize: 16, cursorStyle: 'bar' } }, []).values))
    expect(changes).toBe(before + 1)
    expect(p.appearance()).toMatchObject({ fontSize: 16, cursorStyle: 'bar' })
    // the settings store swaps in its own source (`Prefs.setSource`)
    p.setSource(staticPrefsSource(terminalPrefs(parseSettings({ terminal: { theme: 'kea-dark', fontSize: 12 } }, []).values)))
    expect(p.appearance().fontSize).toBe(12)
  })
})
