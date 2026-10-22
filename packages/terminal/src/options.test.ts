import fs from 'node:fs'
import path from 'node:path'
import headless from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { protocolOs, SETTINGS } from '@kea/protocol'
import { darwin as protocolDarwin } from '@kea/protocol/os/darwin'
import { linux as protocolLinux } from '@kea/protocol/os/linux'
import { applyAppearance, appearanceOptions, createTerminalOptions, MIRROR_WINDOW_OPTIONS, RENDERER_BEHAVIOUR, TERMINAL_FONT_FALLBACKS, terminalFontStack, WINDOW_OPTIONS_OFF, type Appearance } from './options.ts'
import { colorThemeOf, themeOf } from './themes.ts'
import { THEMES } from './generated/themes.ts'
import { screenText, write } from './test-support.ts'

describe('createTerminalOptions', () => {
  it('U-PTY-5 · mirror and renderer share parser options; only the mirror allows the three geometry reports', () => {
    const m = createTerminalOptions({ side: 'mirror', cols: 80, rows: 24, scrollback: 500 })
    const r = createTerminalOptions({ side: 'renderer', cols: 80, rows: 24, scrollback: 500 })
    expect({ ...m, windowOptions: null }).toEqual({ ...r, windowOptions: null })
    expect(r.vtExtensions).toEqual({ kittyKeyboard: true, colorSchemeQuery: false })
    expect(Object.values(r.windowOptions).every((v) => v === false)).toBe(true)
    const allowed = Object.entries(m.windowOptions).filter(([, v]) => v).map(([k]) => k).sort()
    expect(allowed).toEqual(['getCellSizePixels', 'getWinSizeChars', 'getWinSizePixels'])
    expect(Object.keys(MIRROR_WINDOW_OPTIONS).sort()).toEqual(Object.keys(WINDOW_OPTIONS_OFF).sort())
  })

  it('U-TERM-9 · appearance maps the terminal settings onto xterm options; unknown themes fall back to the default', () => {
    const a = appearanceOptions({ fontFamily: 'Berkeley Mono', fontSize: 14, lineHeight: 1.3, theme: 'nope', cursorStyle: 'bar', cursorBlink: true, optionIsMeta: false })
    expect(a).toEqual({ fontFamily: terminalFontStack('Berkeley Mono'), fontSize: 14, lineHeight: 1.3, cursorStyle: 'bar', cursorBlink: true, macOptionIsMeta: false, theme: THEMES['kea-dark'] })
    // the font stack always ends in the system's fallbacks, without repeating the user's choice (macOS's here; Linux's
    // are checked below)
    const mac = protocolDarwin.window.terminalFontFallbacks
    expect(terminalFontStack('Berkeley Mono', mac)).toBe('"Berkeley Mono", "SF Mono", ui-monospace, Menlo, monospace')
    expect(terminalFontStack('SF Mono', mac)).toBe('"SF Mono", ui-monospace, Menlo, monospace')
    expect(terminalFontStack(' "JetBrains Mono" ', mac)).toBe('"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace')
    expect(terminalFontStack('ui-monospace', mac)).toBe('ui-monospace, "SF Mono", Menlo, monospace')
    expect(themeOf('kea-dark')).toBe(THEMES['kea-dark'])
    const c = colorThemeOf('kea-dark')
    expect(c.palette).toHaveLength(16)
    expect(c.palette[1]).toBe(THEMES['kea-dark'].red)
    expect(c.background).toBe(THEMES['kea-dark'].background)
  })

  it('U-TERM-16 · appearance applies live to an open terminal without recreating it; only changed options are set', async () => {
    const a: Appearance = { fontFamily: 'SF Mono', fontSize: 13, lineHeight: 1.2, theme: 'kea-dark', cursorStyle: 'block', cursorBlink: false, optionIsMeta: true }
    const term = new headless.Terminal({ ...createTerminalOptions({ side: 'renderer', cols: 40, rows: 5, scrollback: 100 }), ...RENDERER_BEHAVIOUR, ...appearanceOptions(a) })
    await write(term, 'still here\r\n')
    expect(applyAppearance(term, a)).toEqual({ changed: [], fontChanged: false })
    expect(applyAppearance(term, { ...a, cursorStyle: 'bar', cursorBlink: true })).toEqual({ changed: ['cursorStyle', 'cursorBlink'], fontChanged: false })
    expect(applyAppearance(term, { ...a, cursorStyle: 'bar', cursorBlink: true, fontSize: 15 })).toEqual({ changed: ['fontSize'], fontChanged: true })
    const opts = term.options as Record<string, unknown>
    expect(opts.fontSize).toBe(15)
    expect(opts.cursorStyle).toBe('bar')
    expect(screenText(term)[0]).toBe('still here')
    term.dispose()
  })

  it('U-TERM-16 · scroll lock: output never moves a scrolled-up viewport; typing jumps to the bottom', async () => {
    const term = new headless.Terminal({ ...createTerminalOptions({ side: 'renderer', cols: 20, rows: 5, scrollback: 100 }), ...RENDERER_BEHAVIOUR })
    for (let i = 0; i < 30; i++) await write(term, `line ${i}\r\n`)
    const b = term.buffer.active
    term.scrollLines(-10)
    const viewport = b.viewportY
    expect(viewport).toBeLessThan(b.baseY)
    for (let i = 0; i < 5; i++) await write(term, `more ${i}\r\n`)
    expect(b.viewportY).toBe(viewport)
    expect(b.baseY).toBeGreaterThan(viewport)
    const typed: string[] = []
    term.onData((d) => typed.push(d))
    term.input('x', true)
    expect(typed).toEqual(['x'])
    expect(b.viewportY).toBe(b.baseY)
    term.dispose()
  })
})

describe('fonts on each system', () => {
  it("U-PLT-39 · the terminal font: JetBrains Mono, then DejaVu Sans Mono and Noto Sans Mono, on Linux; SF Mono on macOS; the setting's default and the stack are this system's; the UI font is the desktop's where SF is missing", () => {
    const l = protocolLinux.window
    const m = protocolDarwin.window
    expect([l.terminalFont, m.terminalFont]).toEqual(['JetBrains Mono', 'SF Mono'])
    expect(terminalFontStack(l.terminalFont, l.terminalFontFallbacks)).toBe('"JetBrains Mono", "DejaVu Sans Mono", "Noto Sans Mono", monospace')
    expect(terminalFontStack('Fira Code', l.terminalFontFallbacks)).toBe('"Fira Code", "JetBrains Mono", "DejaVu Sans Mono", "Noto Sans Mono", monospace')
    expect(terminalFontStack(m.terminalFont, m.terminalFontFallbacks)).toBe('"SF Mono", ui-monospace, Menlo, monospace')
    // this system's: the schema's default and the stack every terminal, preview and viewer draws with
    expect(SETTINGS.find((d) => d.key === 'terminal.fontFamily')!.default).toBe(protocolOs.window.terminalFont)
    expect(TERMINAL_FONT_FALLBACKS).toEqual(protocolOs.window.terminalFontFallbacks)
    // the UI font: SF where it is (macOS), else system-ui, the desktop's own (Cantarell, Noto Sans, …), before the generic family
    const tokens = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'constants', 'tokens.json'), 'utf8')) as { font: { ui: { $value: string } } }
    const ui = tokens.font.ui.$value.split(',').map((f) => f.trim())
    expect(ui.indexOf('system-ui')).toBeGreaterThan(-1)
    expect(ui.indexOf('system-ui')).toBeLessThan(ui.indexOf('sans-serif'))
  })
})
