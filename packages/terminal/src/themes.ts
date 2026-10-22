// Terminal themes as data. The bundled ones are generated from `constants/tokens.json` (`generated/themes.ts`:
// Kea Dark, Kea Light); "Match Ghostty config" is Kea Dark with what the user's Ghostty config states laid over it. One
// resolver serves both sides, so the renderer's xterm and ptyhost's mirror (which answers OSC 4/10/11/12 and
// `CSI ? 996 n` from these colours) can never show and report different themes.

import { GHOSTTY_THEME, L, type GhosttyConfig } from '@kea/protocol'
import { luminance, parseXColor, type ColorTheme } from './colors.ts'
import { THEMES, type ThemeId } from './generated/themes.ts'

/** An xterm.js `ITheme` with every colour Kea sets. `selectionForeground` only where a theme states one. */
export type TerminalTheme = { readonly [K in keyof (typeof THEMES)[ThemeId]]: string } & { readonly selectionForeground?: string }

export const DEFAULT_THEME: ThemeId = 'kea-dark'

export const ANSI_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const

export function isThemeId(id: string): id is ThemeId {
  return Object.hasOwn(THEMES, id)
}

/** The bundled theme with this id; an unknown id (and `ghostty`, which has no palette of its own) is the default theme. */
export function themeOf(id: string): TerminalTheme {
  return THEMES[isThemeId(id) ? id : DEFAULT_THEME]
}

/**
 * "Match Ghostty config": Kea Dark, with every colour the file states in its place. A file that states a
 * background or a foreground but no selection or cursor colours gets Ghostty's own defaults for those (the selection
 * is the two swapped, the cursor is the foreground, its text the background), so a light Ghostty palette is not given
 * Kea Dark's dark selection. Nothing read (no file, a broken one): Kea Dark itself, the same object.
 */
export function ghosttyTheme(g: GhosttyConfig | null | undefined): TerminalTheme {
  const base = THEMES[DEFAULT_THEME]
  if (!g || !g.found) return base
  const own = g.background !== null || g.foreground !== null
  const background = g.background ?? base.background
  const foreground = g.foreground ?? base.foreground
  const selectionBackground = g.selectionBackground ?? (own ? foreground : base.selectionBackground)
  const t: { -readonly [K in keyof TerminalTheme]: TerminalTheme[K] } = {
    ...base,
    background,
    foreground,
    cursor: g.cursor ?? (own ? foreground : base.cursor),
    cursorAccent: g.cursorText ?? (own ? background : base.cursorAccent),
    selectionBackground,
    selectionInactiveBackground: g.selectionBackground !== null || own ? selectionBackground : base.selectionInactiveBackground,
  }
  const selectionForeground = g.selectionForeground ?? (own && g.selectionBackground === null ? background : null)
  if (selectionForeground !== null) t.selectionForeground = selectionForeground
  for (const [i, key] of ANSI_KEYS.entries()) t[key] = g.palette[i] ?? base[key]
  return t
}

/** The colours `terminal.theme` means now: a bundled palette, or the Ghostty config's (`ghostty`: what core read of it). */
export function resolveTheme(id: string, ghostty?: GhosttyConfig | null): TerminalTheme {
  return id === GHOSTTY_THEME ? ghosttyTheme(ghostty) : themeOf(id)
}

/**
 * The font "Match Ghostty config" takes from the file: its first `font-family` and its `font-size`, the size
 * kept inside `terminal.fontSize`'s range. Null for what the file does not state, and for every other theme: the
 * `terminal.*` setting then applies.
 */
export function ghosttyFont(id: string, g: GhosttyConfig | null | undefined): { fontFamily: string | null; fontSize: number | null } {
  if (id !== GHOSTTY_THEME || !g || !g.found) return { fontFamily: null, fontSize: null }
  const size = g.fontSize
  return { fontFamily: g.fontFamily, fontSize: size === null ? null : Math.min(L.settingsFontSizeMax, Math.max(L.settingsFontSizeMin, size)) }
}

/** Dark or light, as xterm.js and the mirror decide it (`CSI ? 996 n`): dark when the background is darker than the foreground. */
export function isDarkTheme(t: { background: string; foreground: string }): boolean {
  const bg = parseXColor(t.background)
  const fg = parseXColor(t.foreground)
  if (!bg || !fg) return true
  return luminance(bg) < luminance(fg)
}

/** The colours the mirror answers OSC 4/10/11/12 with (`zMirrorConfig`). */
export function colorThemeOf(id: string, ghostty?: GhosttyConfig | null): ColorTheme {
  const t = resolveTheme(id, ghostty)
  return { foreground: t.foreground, background: t.background, cursor: t.cursor, palette: ANSI_KEYS.map((k) => t[k]) }
}
