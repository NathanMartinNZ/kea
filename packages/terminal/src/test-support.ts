// Test-only helpers: real `@xterm/headless` terminals built from `createTerminalOptions()`, as ptyhost builds its
// mirrors. Internal fields are read only to *verify* state in tests (`internals`), never by the package itself.

import headless from '@xterm/headless'
import serializeAddon from '@xterm/addon-serialize'
import { MirrorKit, type MirrorTerminal } from './mirror.ts'
import { createTerminalOptions } from './options.ts'
import { colorThemeOf } from './themes.ts'

const { Terminal } = headless
const { SerializeAddon } = serializeAddon
export type HeadlessTerminal = InstanceType<typeof Terminal>

export function newTerminal(side: 'mirror' | 'renderer', cols = 80, rows = 24, scrollback = 1000): HeadlessTerminal {
  return new Terminal(createTerminalOptions({ side, cols, rows, scrollback }))
}

export function write(term: HeadlessTerminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

const enc = new TextEncoder()

export interface TestMirror {
  term: HeadlessTerminal
  kit: MirrorKit
  replies: string[]
  /** Write like ptyhost does: parse, then feed the parsed bytes to the kit in the write callback. */
  write(data: string | Uint8Array): Promise<void>
  serialize(): string
  snapshot(): string
  dispose(): void
}

export function newMirror(cols = 80, rows = 24, theme = 'kea-dark'): TestMirror {
  const term = newTerminal('mirror', cols, rows)
  const replies: string[] = []
  // xterm.js types its options as optional though it reports every one, defaults included (OptionsApi); ptyhost casts
  // the same way (`app/ptyhost/src/mirror/mirror.ts`).
  const kit = new MirrorKit(term as unknown as MirrorTerminal, { colors: colorThemeOf(theme), reply: (d) => replies.push(d) })
  /** Load the serialize addon for one call and dispose it afterwards, as ptyhost does. */
  const withSerializer = <T,>(fn: (s: InstanceType<typeof SerializeAddon>) => T): T => {
    const addon = new SerializeAddon()
    term.loadAddon(addon)
    try {
      return fn(addon)
    } finally {
      addon.dispose()
    }
  }
  const serialize = () => withSerializer((a) => a.serialize())
  return {
    term,
    kit,
    replies,
    write: (data) =>
      new Promise((resolve) => {
        const bytes = typeof data === 'string' ? enc.encode(data) : data
        term.write(bytes, () => {
          kit.parsed(bytes)
          resolve()
        })
      }),
    serialize,
    snapshot: () => withSerializer((a) => kit.snapshot(a)),
    dispose: () => {
      kit.dispose()
      term.dispose()
    },
  }
}

/** Internal state read straight from xterm.js, to check the tracker and the restore against the real thing. */
export function internals(term: HeadlessTerminal) {
  const core = (term as any)._core
  const ih = core._inputHandler
  const buf = core._bufferService.buffer
  const kk = core.coreService.kittyKeyboard
  const dm = core.coreService.decPrivateModes
  return {
    parserState: ih._parser.currentState as number,
    utf8Pending: (ih._utf8Decoder.interim[0] as number) !== 0,
    kitty: { flags: kk.flags, mainFlags: kk.mainFlags, altFlags: kk.altFlags, mainStack: [...kk.mainStack], altStack: [...kk.altStack] },
    mouseEncoding: core.mouseStateService.activeEncoding as string,
    mouseProtocol: core.mouseStateService.activeProtocol as string,
    scrollRegion: [buf.scrollTop, buf.scrollBottom] as [number, number],
    cursorStyle: dm.cursorStyle as string | undefined,
    cursorBlink: dm.cursorBlink as boolean | undefined,
    glevel: core._charsetService.glevel as number,
    charsets: [0, 1, 2, 3].map((g) => core._charsetService.charsets[g]),
    title: ih._windowTitle as string,
    x: buf.x as number,
    y: buf.y as number,
    /**
     * Each screen's saved cursor as DECRC would restore it now (xterm.js clamps the row at the viewport top), with the
     * attributes' fg / bg words and the origin and auto-wrap flags saved with it.
     */
    saved: Object.fromEntries(
      (['normal', 'alt'] as const).map((k) => {
        const b = core._bufferService.buffers[k]
        const at = { x: Math.min(b.savedX || 0, core.cols - 1), y: Math.min(Math.max(b.savedY - b.ybase, 0), core.rows - 1) }
        return [k, { ...at, fg: b.savedCurAttrData.fg as number, bg: b.savedCurAttrData.bg as number, origin: b.savedOriginMode as boolean, wrap: b.savedWraparoundMode as boolean }]
      }),
    ) as Record<'normal' | 'alt', { x: number; y: number; fg: number; bg: number; origin: boolean; wrap: boolean }>,
    /** Each screen's saved character set table (holes read as undefined, as DECRC reads them) and GL level. */
    savedCharsets: Object.fromEntries(
      (['normal', 'alt'] as const).map((k) => {
        const b = core._bufferService.buffers[k]
        return [k, { charsets: Array.from(b.savedCharsets as unknown[]), glevel: b.savedGlevel as number }]
      }),
    ) as Record<'normal' | 'alt', { charsets: unknown[]; glevel: number }>,
    /** The current attributes: fg / bg words and the extended fields SGR sets. */
    attrs: { fg: ih._curAttrData.fg as number, bg: ih._curAttrData.bg as number, ulStyle: ih._curAttrData.extended.underlineStyle as number, ulColor: ih._curAttrData.extended.underlineColor as number },
    /** The live charset table, exact length (holes read as undefined). */
    charsetTable: Array.from(core._charsetService.charsets as unknown[]),
    /** Each screen's tab stops left of the right margin, ascending. */
    tabs: Object.fromEntries(
      (['normal', 'alt'] as const).map((k) => {
        const tabs = core._bufferService.buffers[k].tabs as Record<string, boolean | undefined>
        const stops = Object.keys(tabs)
          .filter((x) => tabs[x])
          .map(Number)
          .filter((x) => x < core.cols)
          .sort((a, b) => a - b)
        return [k, stops]
      }),
    ) as Record<'normal' | 'alt', number[]>,
  }
}

type Cell = NonNullable<ReturnType<NonNullable<ReturnType<HeadlessTerminal['buffer']['active']['getLine']>>['getCell']>>

/**
 * What a cell looks like: for a cell with text, its colours, intensity, underline style and colour, and the other SGR
 * flags; for an empty cell, its background (what an erase leaves). The underline is compared by style, which is how
 * SGR set it: `isUnderline()` is also true inside an OSC 8 link, and links come back as plain text.
 */
export function cellStyle(c: Cell): string {
  if (!c.getChars()) return `bg ${c.getBgColorMode()}:${c.getBgColor()}`
  const ul = c.getUnderlineStyle()
  const flags = [c.isBold(), c.isDim(), c.isItalic(), c.isBlink(), c.isInverse(), c.isInvisible(), c.isStrikethrough(), c.isOverline()].map((f) => (f ? 1 : 0)).join('')
  return `fg ${c.getFgColorMode()}:${c.getFgColor()} bg ${c.getBgColorMode()}:${c.getBgColor()} ${flags} ul ${ul}${ul ? ` ${c.getUnderlineColorMode()}:${c.getUnderlineColor()}` : ''}`
}

/** Every cell's style, row by row (active buffer, scrollback included); a wide character's second cell is skipped. */
export function screenStyles(term: HeadlessTerminal): string[] {
  const b = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y)!
    const cells: string[] = []
    for (let x = 0; x < term.cols; x++) {
      const c = line.getCell(x)!
      if (c.getWidth() === 0 && x > 0 && line.getCell(x - 1)!.getWidth() === 2) continue
      cells.push(cellStyle(c))
    }
    out.push(cells.join('|'))
  }
  return out
}

/** Active buffer, viewport and scrollback, as text lines. */
export function screenText(term: HeadlessTerminal): string[] {
  const b = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
  return out
}
