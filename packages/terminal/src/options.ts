// `createTerminalOptions()` — the one place xterm.js options are decided. The ptyhost mirror and the renderer's
// terminal are created from the same core options, so their parsers, buffers and query behaviour match; the renderer
// adds appearance on top.

import { protocolOs } from '@kea/protocol'
import { themeOf, type TerminalTheme } from './themes.ts'

/** Every window manipulation and report off. */
export const WINDOW_OPTIONS_OFF = Object.freeze({
  restoreWin: false,
  minimizeWin: false,
  setWinPosition: false,
  setWinSizePixels: false,
  raiseWin: false,
  lowerWin: false,
  refreshWin: false,
  setWinSizeChars: false,
  maximizeWin: false,
  fullscreenWin: false,
  getWinState: false,
  getWinPosition: false,
  getWinSizePixels: false,
  getScreenSizePixels: false,
  getCellSizePixels: false,
  getWinSizeChars: false,
  getScreenSizeChars: false,
  getIconTitle: false,
  getWinTitle: false,
  pushTitle: false,
  popTitle: false,
  setWinLines: false,
})

/**
 * The mirror allows exactly the three geometry reports that Kea's responders answer. xterm.js hands a custom `CSI Ps t`
 * handler only the ops its `windowOptions` allow (everything else is swallowed before any hook runs), so Kea's own
 * responders for `CSI 14/16/18 t` see those three and nothing else; title, icon, position and screen reports stay off.
 */
export const MIRROR_WINDOW_OPTIONS = Object.freeze({ ...WINDOW_OPTIONS_OFF, getWinSizePixels: true, getCellSizePixels: true, getWinSizeChars: true })

export type TerminalSide = 'mirror' | 'renderer'

export interface CoreTerminalOptions {
  cols: number
  rows: number
  scrollback: number
  allowProposedApi: boolean
  convertEol: false
  logLevel: 'warn'
  windowOptions: { readonly [K in keyof typeof WINDOW_OPTIONS_OFF]: boolean }
  /** kitty keyboard on; colour-scheme query off — its unsolicited `CSI ? 997 n` bypasses parser hooks */
  vtExtensions: { kittyKeyboard: true; colorSchemeQuery: false }
}

/** The same parser, buffer and VT extensions on both sides; only the window-report permissions differ. */
export function createTerminalOptions(o: { side: TerminalSide; cols: number; rows: number; scrollback: number }): CoreTerminalOptions {
  return {
    cols: o.cols,
    rows: o.rows,
    scrollback: o.scrollback,
    allowProposedApi: true,
    convertEol: false,
    logLevel: 'warn',
    windowOptions: o.side === 'mirror' ? MIRROR_WINDOW_OPTIONS : WINDOW_OPTIONS_OFF,
    vtExtensions: { kittyKeyboard: true, colorSchemeQuery: false },
  }
}

export interface Appearance {
  fontFamily: string
  fontSize: number
  lineHeight: number
  theme: string
  /**
   * The colours of `theme` when they are not a bundled palette's ("Match Ghostty config", `resolveTheme`). The
   * same object for as long as the colours are the same: a new one is a theme change (a new glyph atlas).
   */
  colors?: TerminalTheme
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  optionIsMeta: boolean
}

/**
 * Renderer-only behaviour. Typing scrolls to the bottom, while output never moves a viewport the user scrolled up
 * (xterm.js's own rule). `⌥`-drag selects text while an app captures the mouse.
 */
export const RENDERER_BEHAVIOUR = Object.freeze({ scrollOnUserInput: true, macOptionClickForcesSelection: true })

/** Renderer options: the core options plus behaviour and appearance. Changing appearance never recreates the terminal. */
export function rendererTerminalOptions(core: CoreTerminalOptions, a: Appearance) {
  return {
    ...core,
    ...RENDERER_BEHAVIOUR,
    ...appearanceOptions(a),
  }
}

const FONT_KEYS = new Set(['fontFamily', 'fontSize', 'lineHeight'])

/**
 * Apply appearance to an open terminal in place: only the options that differ are set, so nothing is re-laid out
 * needlessly, and the terminal (its buffer, its PTY) is never recreated. `fontChanged` tells the caller to refit the
 * grid and clear the glyph atlas.
 */
export function applyAppearance(term: { options: object }, a: Appearance): { changed: string[]; fontChanged: boolean } {
  const opts = term.options as Record<string, unknown>
  const changed: string[] = []
  for (const [k, v] of Object.entries(appearanceOptions(a))) {
    if (opts[k] === v) continue
    opts[k] = v
    changed.push(k)
  }
  return { changed, fontChanged: changed.some((k) => FONT_KEYS.has(k)) }
}

/**
 * The terminal font stack: the user's font, then this system's. macOS: `"SF Mono", ui-monospace, Menlo, monospace`;
 * SF Mono is not an installed font that Chromium can find by name, and macOS exposes it as `ui-monospace`, hence the
 * fallbacks. Linux: `"JetBrains Mono"` (shipped in Kea's packages), then `"DejaVu Sans Mono", "Noto Sans Mono",
 * monospace`.
 */
export const TERMINAL_FONT_FALLBACKS: readonly string[] = protocolOs.window.terminalFontFallbacks

/** `family`, then `fallbacks` (this system's unless given) without repeating it. */
export function terminalFontStack(family: string, fallbacks: readonly string[] = TERMINAL_FONT_FALLBACKS): string {
  const user = family.trim()
  const bare = user.replace(/^["']|["']$/g, '')
  const head = /^(ui-monospace|monospace)$/.test(bare) ? bare : `"${bare.replace(/"/g, '')}"`
  return [head, ...fallbacks.filter((f) => f.replace(/"/g, '') !== bare)].join(', ')
}

/** The options that follow the `terminal.*` settings; applied live with `term.options = …` (U-TERM-9). */
export function appearanceOptions(a: Appearance) {
  return {
    fontFamily: terminalFontStack(a.fontFamily),
    fontSize: a.fontSize,
    lineHeight: a.lineHeight,
    cursorStyle: a.cursorStyle,
    cursorBlink: a.cursorBlink,
    macOptionIsMeta: a.optionIsMeta,
    theme: a.colors ?? themeOf(a.theme),
  }
}
