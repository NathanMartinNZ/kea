// "Match Ghostty config": the six things Kea takes from the user's Ghostty config (font-family, font-size, palette,
// background, foreground, cursor colour), read-only, and read again when the file changes. The file is another
// program's: Kea never writes it, and reads it only while `terminal.theme` is `ghostty`. A missing, unreadable,
// oversized or senseless file is no config at all: the terminal shows Kea Dark, with no banner.
//
// The path is injected (core's main passes `~/.config/ghostty/config`); with none, nothing is ever read, so no test can
// reach the user's own file. What was read is the `settings.ghostty` store's one entry; `packages/terminal`'s
// `resolveTheme` turns it into colours on both sides (the renderer's terminals, ptyhost's mirror).

import fs from 'node:fs'
import type { Disposable, Logger } from '@kea/kit'
import { KeyedStore, L, noGhosttyConfig, SETTINGS_GHOSTTY_KEY, SETTINGS_GHOSTTY_STORE, type GhosttyConfig } from '@kea/protocol'
import type { WatchService } from '../platform/watch/service.ts'

export type GhosttyValues = Omit<GhosttyConfig, 'path' | 'found'>

/** `#rgb`, `#rrggbb` or the same without `#` (Ghostty accepts both) → `#rrggbb`; null for anything else (a named colour). */
export function ghosttyColour(value: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (!m) return null
  const h = m[1]!.toLowerCase()
  return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`
}

/** A config value as Ghostty reads it: trimmed, and without the double quotes it may be wrapped in. */
function unquote(raw: string): string {
  const v = raw.trim()
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v
}

const PALETTE_SIZE = 16

/**
 * Parse a Ghostty config's text. Its syntax: one `key = value` per line, `#` starting a comment line, a value
 * optionally in double quotes, a later line winning over an earlier one, an empty value putting the key back to its
 * default. `font-family` may repeat (the first is the font, the rest fallbacks). `palette = N=colour` sets one of the
 * 256 colours; Kea takes 0…15. Colours are hex with or without `#`; a named colour, and anything else Kea cannot use,
 * leaves that key unset, as if the line were not there. Other keys (`theme`, `config-file` among them) are not read.
 */
export function parseGhosttyConfig(text: string): GhosttyValues {
  const out: GhosttyValues = { fontFamily: null, fontSize: null, background: null, foreground: null, cursor: null, cursorText: null, selectionBackground: null, selectionForeground: null, palette: Array.from({ length: PALETTE_SIZE }, () => null) }
  const colours = { background: 'background', foreground: 'foreground', 'cursor-color': 'cursor', 'cursor-text': 'cursorText', 'selection-background': 'selectionBackground', 'selection-foreground': 'selectionForeground' } as const
  let families: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim()
    if (l === '' || l.startsWith('#')) continue
    const eq = l.indexOf('=')
    if (eq <= 0) continue
    const key = l.slice(0, eq).trim()
    const value = unquote(l.slice(eq + 1))
    if (key === 'font-family') {
      // an empty value clears the list (Ghostty's way to drop the fonts of an earlier line or file)
      if (value === '') families = []
      else if (value.length <= L.settingsFontFamilyMaxChars) families.push(value)
    } else if (key === 'font-size') {
      const n = value === '' ? NaN : Number(value)
      out.fontSize = Number.isFinite(n) && n > 0 ? n : null
    } else if (key === 'palette') {
      const m = /^(\d{1,3})\s*=\s*(.*)$/.exec(value)
      if (!m) continue
      const i = Number(m[1])
      if (i < PALETTE_SIZE) out.palette[i] = ghosttyColour(unquote(m[2]!))
    } else if (Object.hasOwn(colours, key)) {
      out[colours[key as keyof typeof colours]] = ghosttyColour(value)
    }
  }
  out.fontFamily = families[0] ?? null
  return out
}

export interface GhosttyFileOptions {
  /** The config to read (`~/.config/ghostty/config`); null: none, nothing is ever read. */
  path: string | null
  log: Logger
  /** Core's watch service. Without it the file is read when followed and on `reload()` only. */
  watcher?: WatchService
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export class GhosttyFile {
  /** `settings.ghostty`: one entry, what was read. */
  readonly store = new KeyedStore<GhosttyConfig>(SETTINGS_GHOSTTY_STORE)
  private readonly opts: GhosttyFileOptions
  private readonly listeners = new Set<() => void>() // bounded: one per consumer in core (the terminals' mirror config)
  private watch: Disposable | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private active = false
  private disposed = false

  constructor(opts: GhosttyFileOptions) {
    this.opts = opts
    this.store.set(SETTINGS_GHOSTTY_KEY, noGhosttyConfig(opts.path ?? ''))
  }

  /** What was read; `found` false while the file is missing, broken or not followed. */
  get config(): GhosttyConfig {
    return this.store.get(SETTINGS_GHOSTTY_KEY) as GhosttyConfig
  }

  /** Called after what was read changes. Returns the unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Follow the file (the theme is `ghostty`) or let it go (any other theme: nothing is read or watched). */
  follow(on: boolean): void {
    if (this.disposed || on === this.active) return
    this.active = on
    if (!on) {
      this.unwatch()
      this.apply(noGhosttyConfig(this.opts.path ?? ''))
      return
    }
    const file = this.opts.path
    if (file !== null && this.opts.watcher) {
      this.watch = this.opts.watcher.file(file, () => {
        if (this.timer || this.disposed) return
        // changes are collected for one window before the file is read again (an editor's save is several events)
        this.timer = setTimeout(() => {
          this.timer = null
          this.reload()
        }, L.watchBatchMs)
      })
    }
    this.reload()
  }

  /** Read the file again and apply what changed. */
  reload(): void {
    if (this.disposed || !this.active) return
    const file = this.opts.path
    if (file === null) return
    let text: string | null = null
    try {
      const st = fs.statSync(file)
      if (st.isFile() && st.size <= L.ghosttyConfigMaxBytes) text = fs.readFileSync(file, 'utf8')
      else this.opts.log.debug('Ghostty config not read', { file: st.isFile(), size: st.size })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.opts.log.debug('Ghostty config unreadable', { error: (e as Error).message })
    }
    this.apply(text === null ? noGhosttyConfig(file) : { path: file, found: true, ...parseGhosttyConfig(text) })
  }

  /** The `settings.ghostty*` gauges: the watch, its pending re-read, the listeners. */
  get resourceCounts(): { watchers: number; timers: number; listeners: number } {
    return { watchers: this.watch ? 1 : 0, timers: this.timer ? 1 : 0, listeners: this.listeners.size }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unwatch()
    this.listeners.clear()
    this.store.dispose()
  }

  private unwatch(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.watch?.dispose()
    this.watch = null
  }

  private apply(next: GhosttyConfig): void {
    if (equal(this.config, next)) return
    this.store.set(SETTINGS_GHOSTTY_KEY, next)
    for (const l of [...this.listeners]) l()
  }
}
