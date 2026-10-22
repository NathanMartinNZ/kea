import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryLogger } from '@kea/kit'
import { L, noGhosttyConfig } from '@kea/protocol'
import { colorThemeOf, ghosttyFont, isDarkTheme, resolveTheme, THEMES } from '@kea/terminal'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StubWatchService } from '../platform/watch/stub.ts'
import { GhosttyFile, ghosttyColour, parseGhosttyConfig } from './ghostty.ts'

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
  vi.useRealTimers()
})

/** A temp folder standing in for `~/.config/ghostty`: no test reads the real one (the path is always given). */
function configDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-ghostty-test-'))
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function open(file: string | null, watcher?: StubWatchService): GhosttyFile {
  const g = new GhosttyFile({ path: file, log: createMemoryLogger({ process: 'core' }), ...(watcher ? { watcher } : {}) })
  cleanup.push(() => g.dispose())
  return g
}

const CONFIG = `# my Ghostty
font-family = "Berkeley Mono"
font-family = Symbols Nerd Font
font-size = 14.5
theme = something-not-read
background = 1d1f21
foreground = #C5C8C6
cursor-color = #fa0
palette = 0=#1d1f21
palette = 1 = cc6666
palette = 15=#ffffff
palette = 16=#000000
palette = 2=tomato
window-padding-x = 8
`

describe('Match Ghostty config', () => {
  it('U-SET-4 · the parser reads font-family, font-size, palette, background, foreground and cursor colour, and nothing it cannot use', () => {
    const c = parseGhosttyConfig(CONFIG)
    expect(c.fontFamily, 'the first font-family is the font; the rest are fallbacks').toBe('Berkeley Mono')
    expect(c.fontSize).toBe(14.5)
    expect(c.background).toBe('#1d1f21')
    expect(c.foreground).toBe('#c5c8c6')
    expect(c.cursor, '#rgb is widened').toBe('#ffaa00')
    expect(c.palette[0]).toBe('#1d1f21')
    expect(c.palette[1], 'spaces around the inner = and no #').toBe('#cc6666')
    expect(c.palette[15]).toBe('#ffffff')
    expect(c.palette[2], 'a named colour is not a colour Kea can use').toBeNull()
    expect(c.palette, '0…15 only: entry 16 is not kept').toHaveLength(16)
    expect(c.selectionBackground).toBeNull()
    // a later line wins; an empty value puts the key back to its default; comments, blank lines and CRLF are skipped
    const later = parseGhosttyConfig('background = #000000\r\n\r\n# background = #111111\r\nbackground = #222222\r\nfont-size = 12\r\nfont-size =\r\nfont-family = A\r\nfont-family =\r\nfont-family = B\r\n')
    expect(later.background).toBe('#222222')
    expect(later.fontSize).toBeNull()
    expect(later.fontFamily).toBe('B')
    // nothing usable: every value null
    const none = parseGhosttyConfig('no equals sign\n= value\nfont-size = big\nfont-size = -3\nbackground = rgb(1,2,3)\npalette = red\npalette = 300=#fff\n\0\0')
    expect(none).toEqual({ ...noGhosttyConfig(''), path: undefined, found: undefined })
    expect(ghosttyColour('#ABCDEF')).toBe('#abcdef')
    expect(ghosttyColour('abcdefg')).toBeNull()
    expect(parseGhosttyConfig(`font-family = ${'x'.repeat(L.settingsFontFamilyMaxChars + 1)}`).fontFamily, 'a font name longer than terminal.fontFamily allows').toBeNull()
  })

  it('U-SET-4 · the theme is Kea Dark with what the file states laid over it; unstated selection and cursor follow Ghostty’s own defaults; the font is the file’s, the size inside terminal.fontSize’s range', () => {
    const dir = configDir()
    const file = path.join(dir, 'config')
    fs.writeFileSync(file, CONFIG)
    const g = open(file)
    g.follow(true)
    const t = resolveTheme('ghostty', g.config)
    const dark = THEMES['kea-dark']
    expect(t.background).toBe('#1d1f21')
    expect(t.foreground).toBe('#c5c8c6')
    expect(t.cursor).toBe('#ffaa00')
    expect(t.black).toBe('#1d1f21')
    expect(t.red).toBe('#cc6666')
    expect(t.green, 'a palette entry the file does not state is Kea Dark’s').toBe(dark.green)
    expect(t.brightWhite).toBe('#ffffff')
    expect([t.selectionBackground, t.selectionForeground], 'Ghostty’s default selection: foreground and background swapped').toEqual(['#c5c8c6', '#1d1f21'])
    expect(t.cursorAccent).toBe('#1d1f21')
    expect(ghosttyFont('ghostty', g.config)).toEqual({ fontFamily: 'Berkeley Mono', fontSize: 14.5 })
    expect(ghosttyFont('kea-dark', g.config), 'another theme takes nothing from the file').toEqual({ fontFamily: null, fontSize: null })
    expect(ghosttyFont('ghostty', { ...g.config, fontSize: 400 }).fontSize).toBe(L.settingsFontSizeMax)
    expect(ghosttyFont('ghostty', { ...g.config, fontSize: 1 }).fontSize).toBe(L.settingsFontSizeMin)
    // the mirror's colours are the same theme's, and its scheme follows the file's colours
    expect(colorThemeOf('ghostty', g.config)).toMatchObject({ background: '#1d1f21', foreground: '#c5c8c6', cursor: '#ffaa00' })
    expect(isDarkTheme(t)).toBe(true)
    fs.writeFileSync(file, 'background = #fafafa\nforeground = #101010\n')
    g.reload()
    expect(isDarkTheme(resolveTheme('ghostty', g.config)), 'a light Ghostty palette is a light scheme').toBe(false)
    // a file that states colours only: the bundled themes are untouched by it
    expect(resolveTheme('kea-light', g.config)).toBe(THEMES['kea-light'])
    expect(resolveTheme('no-such-theme', g.config), 'an unknown id is the default theme').toBe(dark)
  })

  it('U-SET-4 · a missing, unreadable, oversized or emptied file falls back to Kea Dark silently; the file is read only while the theme follows it', () => {
    const dir = configDir()
    const file = path.join(dir, 'config')
    const log = createMemoryLogger({ process: 'core' })
    const g = new GhosttyFile({ path: file, log })
    cleanup.push(() => g.dispose())
    let changes = 0
    g.onChange(() => changes++)
    fs.writeFileSync(file, 'background = #101010\n')
    expect(g.config, 'not followed: nothing read, though the file is there').toEqual(noGhosttyConfig(file))
    g.reload()
    expect(g.config.found, 'a reload while not followed reads nothing').toBe(false)
    g.follow(true)
    expect(g.config).toMatchObject({ found: true, background: '#101010' })
    expect(changes).toBe(1)
    // missing
    fs.rmSync(file)
    g.reload()
    expect(g.config).toEqual(noGhosttyConfig(file))
    expect(resolveTheme('ghostty', g.config), 'Kea Dark itself').toBe(THEMES['kea-dark'])
    // a folder in its place, then a file over the cap: no config either
    fs.mkdirSync(file)
    g.reload()
    expect(g.config.found).toBe(false)
    fs.rmdirSync(file)
    fs.writeFileSync(file, `background = #101010\n${'#'.repeat(L.ghosttyConfigMaxBytes)}`)
    g.reload()
    expect(g.config.found).toBe(false)
    // an empty file is a config that states nothing: Kea Dark, colour for colour
    fs.writeFileSync(file, '')
    g.reload()
    expect(g.config.found).toBe(true)
    expect(resolveTheme('ghostty', g.config)).toEqual(THEMES['kea-dark'])
    // silently: nothing above the debug level was logged (no banner has a source)
    expect(log.entries.filter((e) => e.level !== 'debug')).toEqual([])
    // another theme chosen: let go, nothing kept
    g.follow(false)
    expect(g.config).toEqual(noGhosttyConfig(file))
    // no path given (every test's default): nothing is ever read
    const none = open(null)
    none.follow(true)
    expect(none.config.found).toBe(false)
  })

  it('U-SET-4 · the file is re-read when it changes, once per batching window; one watch while followed, none after', () => {
    vi.useFakeTimers()
    const dir = configDir()
    const file = path.join(dir, 'config')
    const watcher = new StubWatchService()
    const g = open(file, watcher)
    let changes = 0
    g.onChange(() => changes++)
    expect(watcher.watched(), 'nothing is watched until the theme follows the file').toEqual([])
    g.follow(true)
    expect(watcher.watched()).toEqual([{ kind: 'file', path: file }])
    expect(g.config.found, 'no file yet').toBe(false)
    // the file appears; an editor's save is several events: one read, after the collection window
    fs.writeFileSync(file, 'foreground = #eeeeee\n')
    watcher.fire(file)
    watcher.fire(file)
    watcher.fire(file)
    expect(g.resourceCounts).toEqual({ watchers: 1, timers: 1, listeners: 1 })
    expect(g.config.found).toBe(false)
    vi.advanceTimersByTime(L.watchBatchMs)
    expect(g.config).toMatchObject({ found: true, foreground: '#eeeeee' })
    expect(changes).toBe(1)
    // a save that changes nothing Kea reads tells nobody
    fs.writeFileSync(file, 'foreground = #eeeeee\nwindow-padding-x = 4\n')
    watcher.fire(file)
    vi.advanceTimersByTime(L.watchBatchMs)
    expect(changes).toBe(1)
    // follow and let go, 50 times: back to nothing each time (the watch, its timer)
    for (let i = 0; i < 50; i++) {
      g.follow(false)
      expect(watcher.watched()).toEqual([])
      g.follow(true)
      watcher.fire(file)
      expect(g.resourceCounts).toEqual({ watchers: 1, timers: 1, listeners: 1 })
    }
    g.follow(false)
    expect(g.resourceCounts).toEqual({ watchers: 0, timers: 0, listeners: 1 })
    expect(vi.getTimerCount()).toBe(0)
    g.dispose()
    expect(g.resourceCounts).toEqual({ watchers: 0, timers: 0, listeners: 0 })
  })
})
