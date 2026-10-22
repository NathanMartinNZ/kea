// The terminal's settings behind a small source interface, plus the window's font zoom (`⌘+` / `⌘−` / `⌘0`). Views
// read `prefs.get()` and re-apply on change, so changes reach open terminals live.
//
// The source starts from the schema's defaults (`defaultPrefsSource`); the settings store (features/settings/store.ts)
// replaces it through `Prefs.setSource` when it installs, with no change to the views.

import { L, parseSettings, terminalSettings, type CLIPBOARD_WRITE, type SCREEN_READER, type SettingsValues, type TerminalSettings } from '@kea/protocol'
import type { Appearance, TerminalTheme } from '@kea/terminal'

export type TerminalPrefs = TerminalSettings & {
  copyOnSelect: boolean
  confirmMultilinePaste: boolean
  clipboardWrite: (typeof CLIPBOARD_WRITE)[number]
  /**
   * On Linux the screen-reader mode follows this (auto: what main said at start); macOS keeps it at auto.
   */
  screenReader: (typeof SCREEN_READER)[number]
  /**
   * The theme's colours when they are not a bundled palette's: for "Match Ghostty config" the settings store resolves
   * them from core's reading of the Ghostty config, and then `fontFamily` and `fontSize` are the Ghostty config's too.
   */
  colors?: TerminalTheme
}

export function terminalPrefs(v: SettingsValues): TerminalPrefs {
  return {
    ...terminalSettings(v),
    copyOnSelect: v.get('terminal.copyOnSelect'),
    confirmMultilinePaste: v.get('terminal.confirmMultilinePaste'),
    clipboardWrite: v.get('terminal.clipboardWrite'),
    screenReader: v.get('terminal.screenReader'),
  }
}

export interface PrefsSource {
  get(): TerminalPrefs
  /** Called after every change. Returns the unsubscribe function. */
  subscribe(cb: () => void): () => void
}

/** A source holding one value; `set` replaces it (the default source, the settings store's, and tests'). */
export function staticPrefsSource(initial: TerminalPrefs): PrefsSource & { set(p: TerminalPrefs): void } {
  let cur = initial
  const subs = new Set<() => void>() // bounded: the Prefs facade's one subscription
  return {
    get: () => cur,
    set(p) {
      cur = p
      for (const s of [...subs]) s()
    },
    subscribe(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
  }
}

export const defaultPrefsSource = staticPrefsSource(terminalPrefs(parseSettings({}, []).values))

/** The settings plus the window's font zoom; what views read. */
export class Prefs {
  private source: PrefsSource
  private offSource: () => void
  private zoom = 0
  private readonly listeners = new Set<() => void>() // bounded: one per live terminal view plus the UI

  constructor(source: PrefsSource) {
    this.source = source
    this.offSource = source.subscribe(() => this.changed())
  }

  /** Replace the source and tell the listeners; the settings store installs its own source here. */
  setSource(source: PrefsSource): void {
    this.offSource()
    this.source = source
    this.offSource = source.subscribe(() => this.changed())
    this.changed()
  }

  get(): TerminalPrefs {
    return this.source.get()
  }

  /** The appearance views apply: the settings with the zoom on the font size, kept inside the setting's range. */
  appearance(): Appearance {
    const p = this.source.get()
    return {
      fontFamily: p.fontFamily,
      fontSize: clampFont(p.fontSize + this.zoom * L.terminalFontStep),
      lineHeight: p.lineHeight,
      theme: p.theme,
      ...(p.colors ? { colors: p.colors } : {}),
      cursorStyle: p.cursorStyle,
      cursorBlink: p.cursorBlink,
      optionIsMeta: p.optionIsMeta,
    }
  }

  /** `⌘+` (1), `⌘−` (-1), `⌘0` (0, back to the setting). Steps past the range do nothing. */
  zoomBy(step: -1 | 0 | 1): void {
    const next = step === 0 ? 0 : this.zoom + step
    const size = this.source.get().fontSize + next * L.terminalFontStep
    if (step !== 0 && clampFont(size) !== size) return
    if (next === this.zoom) return
    this.zoom = next
    this.changed()
  }

  get zoomSteps(): number {
    return this.zoom
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private changed(): void {
    for (const l of [...this.listeners]) l()
  }
}

function clampFont(px: number): number {
  return Math.min(L.settingsFontSizeMax, Math.max(L.settingsFontSizeMin, px))
}

export const prefs = new Prefs(defaultPrefsSource)
