// The window's copy of core's `settings` and `settings.status` stores: every setting's effective value by full dotted
// key, and the file's state for the banner that says it does not parse. Until core answers, values are the
// schema's defaults. The terminal's preferences come from here (applied live), and so does the terminal theme: a
// bundled palette by its id, or, for "Match Ghostty config", the colours and the font core read from the user's Ghostty
// config (`settings.ghostty`), resolved by the same `resolveTheme` core uses for the mirror's colours, so what a
// terminal shows and what its program is told agree.

import { GHOSTTY_THEME, parseSettings, SETTINGS_GHOSTTY_KEY, SETTINGS_GHOSTTY_STORE, SETTINGS_STATUS_KEY, SETTINGS_STATUS_STORE, SETTINGS_STORE, type GhosttyConfig, type SettingsStatus, type SettingsValues } from '@kea/protocol'
import { DEFAULT_THEME, ghosttyFont, resolveTheme, themeOf, type TerminalTheme } from '@kea/terminal'
import { subscribe } from '../../lib/rpc.ts'
import { prefs, staticPrefsSource, terminalPrefs, type TerminalPrefs } from '../terminal/prefs.ts'

const DEFAULTS = parseSettings({}, []).values

/** Effective values: core's, falling back to the schema's defaults for keys it has not sent. */
function valuesOf(data: ReadonlyMap<string, unknown>): SettingsValues {
  return {
    flat: Object.fromEntries(data),
    get<T>(key: string): T {
      return (data.has(key) ? data.get(key) : DEFAULTS.get(key)) as T
    },
    agent: (id) => DEFAULTS.agent(id),
  }
}

/**
 * The terminal's preferences for these settings and this reading of the Ghostty config. With the `ghostty` theme the
 * colours are the file's over Kea Dark and the font is the file's where it states one; `colors` is the same
 * object for as long as the file's colours are (`themes`), so nothing is re-applied without a change.
 */
export function resolvedPrefs(values: SettingsValues, ghostty: GhosttyConfig | null, themes: ThemeMemo = new ThemeMemo()): TerminalPrefs {
  const p = terminalPrefs(values)
  if (p.theme !== GHOSTTY_THEME) return p
  const font = ghosttyFont(p.theme, ghostty)
  return { ...p, fontFamily: font.fontFamily ?? p.fontFamily, fontSize: font.fontSize ?? p.fontSize, colors: themes.of(ghostty) }
}

/** The Ghostty theme last resolved, kept while the config it came from says the same. */
export class ThemeMemo {
  private key = ''
  private theme: TerminalTheme = themeOf(DEFAULT_THEME)

  of(ghostty: GhosttyConfig | null): TerminalTheme {
    const key = JSON.stringify(ghostty)
    if (key !== this.key) {
      this.key = key
      this.theme = resolveTheme(GHOSTTY_THEME, ghostty)
    }
    return this.theme
  }
}

type Listener = () => void

class SettingsMirror {
  private current: SettingsValues = DEFAULTS
  private fileStatus: SettingsStatus | null = null
  private ghosttyConfig: GhosttyConfig | null = null
  private readonly listeners = new Set<Listener>() // bounded: the window's few settings readers
  private readonly prefsSource = staticPrefsSource(terminalPrefs(DEFAULTS))
  private readonly themes = new ThemeMemo()
  private installed = false

  install(): void {
    if (this.installed) return
    this.installed = true
    prefs.setSource(this.prefsSource)
    subscribe<unknown>(SETTINGS_STORE, (data) => {
      // a copy: the RPC client keeps changing its own map
      this.current = valuesOf(new Map(data))
      this.applyPrefs()
      this.changed()
    })
    subscribe<SettingsStatus>(SETTINGS_STATUS_STORE, (data) => {
      this.fileStatus = data.get(SETTINGS_STATUS_KEY) ?? null
      this.changed()
    })
    subscribe<GhosttyConfig>(SETTINGS_GHOSTTY_STORE, (data) => {
      this.ghosttyConfig = data.get(SETTINGS_GHOSTTY_KEY) ?? null
      this.applyPrefs()
      this.changed()
    })
  }

  get values(): SettingsValues {
    return this.current
  }

  get<T>(key: string): T {
    return this.current.get<T>(key)
  }

  /** `settings.status`'s one entry, null until core sends it. */
  get status(): SettingsStatus | null {
    return this.fileStatus
  }

  /** What core read of the Ghostty config; null until core sends it. */
  get ghostty(): GhosttyConfig | null {
    return this.ghosttyConfig
  }

  /** The colours of the terminal theme in force (the Terminal page's preview). */
  get theme(): TerminalTheme {
    return this.prefsSource.get().colors ?? themeOf(this.prefsSource.get().theme)
  }

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** The terminals' preferences follow the settings and the Ghostty config (live, every open terminal). */
  private applyPrefs(): void {
    const next = resolvedPrefs(this.current, this.ghosttyConfig, this.themes)
    const cur = this.prefsSource.get()
    if (next.colors === cur.colors && JSON.stringify({ ...next, colors: null }) === JSON.stringify({ ...cur, colors: null })) return
    this.prefsSource.set(next)
    // the padding around a terminal is its theme's background (styles.css `.terminal-frame`); Kea Dark's is the token
    const theme = next.colors ?? themeOf(next.theme)
    if (theme === themeOf(DEFAULT_THEME)) document.documentElement.style.removeProperty('--terminal-canvas')
    else document.documentElement.style.setProperty('--terminal-canvas', theme.background)
  }

  private changed(): void {
    for (const l of [...this.listeners]) l()
  }
}

export const settings = new SettingsMirror()
