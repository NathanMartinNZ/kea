// Snapshots through Kea's patched `@xterm/addon-serialize` (patches/): the cases the published build gets wrong come
// back exactly, through its allocation-free output path.

import headless from '@xterm/headless'
import serializeAddon from '@xterm/addon-serialize'
import { DEFAULT_TERMINAL_SETTINGS } from '@kea/protocol'
import { colorThemeOf, createTerminalOptions } from '@kea/terminal'
import { afterEach, describe, expect, it } from 'vitest'
import { Mirror } from './mirror.ts'

type Terminal = InstanceType<typeof headless.Terminal>

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})

const write = (t: Terminal, data: string) => new Promise<void>((r) => t.write(data, r))

/** A mirror fed `input`, its snapshot, and a renderer-side terminal restored from it. */
async function restore(input: string, cols = 20, rows = 4): Promise<{ mirror: Terminal; renderer: Terminal; data: string }> {
  const m = new Mirror({ cols, rows, scrollback: 100, colors: colorThemeOf(DEFAULT_TERMINAL_SETTINGS.theme), startSeq: 0, reply: () => {}, parsed: () => {}, now: () => 0 })
  cleanup.push(() => m.dispose())
  m.write(0, new TextEncoder().encode(input))
  await write(m.terminal as never, '')
  const s = m.snapshot()
  const r = new headless.Terminal(createTerminalOptions({ side: 'renderer', cols, rows, scrollback: 100 }))
  cleanup.push(() => r.dispose())
  await write(r, s.data)
  return { mirror: m.terminal as never, renderer: r, data: s.data }
}

/** Each row: wrap flag, then every cell's text, width and the attributes compared here. */
function cells(t: Terminal): string[] {
  const b = t.buffer.active
  const out: string[] = []
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y)!
    let row = line.isWrapped ? 'W' : ' '
    for (let x = 0; x < t.cols; x++) {
      const c = line.getCell(x)!
      row += `|${c.getChars() || '·'}${c.getWidth()}${c.isBold() ? 'B' : ''}${c.isDim() ? 'D' : ''}${c.getBgColorMode() ? `/${c.getBgColor()}` : ''}`
    }
    out.push(row)
  }
  return out
}

describe('snapshot intensity', () => {
  it('U-PTY-26 · bold and dim survive snapshot → restore in every transition between them; 22 comes before what stays on', async () => {
    // every pair of intensity states, each followed by every other: off, bold, dim, both
    const states = ['22', '22;1', '22;2', '1;2']
    let input = ''
    for (const a of states) for (const b of states) if (a !== b) input += `\x1b[${a}m${'x'}\x1b[${b}m${'y'}`
    const { mirror, renderer, data } = await restore(input, 30, 4)
    expect(cells(renderer)).toEqual(cells(mirror))
    // bold + dim → dim alone: the published build wrote a lone 22 and lost the dim
    const { renderer: r2, data: d2 } = await restore('\x1b[1;2mA\x1b[22;2mB')
    expect(r2.buffer.active.getLine(0)!.getCell(1)!.isDim()).toBeTruthy()
    expect(d2).toContain('\x1b[22;2mB')
    // the published build wrote `1;22` for dim → bold, which a terminal reads as neither
    expect(data).not.toMatch(/\x1b\[(?:[0-9;]*;)?1;(?:[0-9;]*;)?22[;m]/)
  })
})

describe('snapshot rows', () => {
  it('U-PTY-30 · forced wraps: an empty row that wraps, and a wrapped row that starts with an empty cell after a full row', async () => {
    // (a) a full row that wraps, then that row erased: row 0 is empty but row 1 is still its continuation
    const a = await restore(`${'-'.repeat(10)}x\x1b[1;1H\x1b[2K\x1b[2;2Hy`, 10)
    expect(a.data).not.toMatch(/\x1b\[0[CD]/)
    expect(cells(a.renderer)).toEqual(cells(a.mirror))
    expect(a.renderer.buffer.active.getLine(0)!.translateToString(true)).toBe('')
    // (b) the wrapped row's first cell erased: still a wrapped row, its text not pulled into the row above
    const b = await restore(`${'a'.repeat(20)}bc\x1b[2;1H\x1b[X`)
    expect(cells(b.renderer)).toEqual(cells(b.mirror))
    expect(b.renderer.buffer.active.getLine(1)!.isWrapped).toBe(true)
  })

  it('U-PTY-30 · a combining mark printed with nothing to join takes its column back, wherever it is', async () => {
    // (c) at column 0, after a cursor move, right after a character (an SGR came between), on a wrapped row, last column
    for (const input of ['́ab', 'a\x1b[Ćb', 'a\x1b[ḿb', `${'a'.repeat(25)}\x1b[2;1H́`, `${'a'.repeat(19)}\x1b[ḿb`]) {
      const { mirror, renderer } = await restore(input)
      expect(cells(renderer), JSON.stringify(input)).toEqual(cells(mirror))
      expect([renderer.buffer.active.cursorX, renderer.buffer.active.cursorY]).toEqual([mirror.buffer.active.cursorX, mirror.buffer.active.cursorY])
    }
  })

  it('U-PTY-30 · rows of erased cells with a background are kept, not trimmed as trailing empty rows', async () => {
    // (d) a screen cleared in blue, with and without text on its first row
    for (const input of ['abc\x1b[44m\x1b[2J\x1b[H', 'abc\x1b[44m\x1b[2J\x1b[Hx\x1b[0m', 'a\r\n\x1b[44m\x1b[K\r\n\x1b[K\x1b[0m']) {
      const { mirror, renderer } = await restore(input)
      expect(cells(renderer), JSON.stringify(input)).toEqual(cells(mirror))
    }
  })

  it('U-PTY-30 · a default row after a coloured one at the screen\'s height stays default, though the line feed between them scrolls', async () => {
    // (e) the first line feed that scrolls fills the new row in the current background; the row after the coloured one
    // must be written as erased in the default one (a full coloured row, and a coloured row erased to its end)
    for (const input of [`a\r\nb\r\nc\r\n\x1b[44m${'x'.repeat(20)}\x1b[0m\r\n\r\nd`, 'a\r\nb\r\nc\r\n\x1b[44mx\x1b[K\x1b[0m\r\n\r\nd']) {
      const { mirror, renderer } = await restore(input)
      expect(mirror.buffer.active.baseY, 'scrolled').toBeGreaterThan(0)
      expect(cells(renderer), JSON.stringify(input)).toEqual(cells(mirror))
    }
  })
})

describe('snapshot output', () => {
  /** The same terminal serialized twice: with Node's `Buffer` decoding the output, and without it (the portable path). */
  function bothDecodes(t: Terminal): [string, string] {
    const addon = new serializeAddon.SerializeAddon()
    t.loadAddon(addon)
    const g = globalThis as { Buffer?: unknown }
    const buffer = g.Buffer
    try {
      const node = addon.serialize()
      g.Buffer = undefined
      return [node, addon.serialize()]
    } finally {
      g.Buffer = buffer
      addon.dispose()
    }
  }

  it('U-PTY-49 · output written as code units: a screen past the first buffer, beyond Latin-1 and the BMP, comes back exactly, and both decodes write the same text', async () => {
    // a style change every few cells, box drawing (two bytes per unit from the first row), an emoji outside the BMP, a
    // combining sequence and a wide character; thirty rows of it outgrow the buffer sized for the screen
    let input = ''
    for (let i = 0; i < 30; i++) input += `${i ? '\r\n' : ''}\x1b[38;2;${i};2;3m│\x1b[1m\u{1f600}e\u0301日\x1b[22;48;5;${i}m${'x'.repeat(5)}\x1b[0m ok`
    const wide = await restore(input, 20, 4)
    expect(cells(wide.renderer)).toEqual(cells(wide.mirror))
    expect(wide.data).toContain('\u{1f600}e\u0301日')
    const [node, portable] = bothDecodes(wide.mirror)
    expect(portable).toBe(node)
    // Latin-1 only: one byte per unit throughout
    const narrow = await restore(`${'\x1b[31mé\x1b[0m-'.repeat(40)}\r\nplain`, 20, 4)
    expect(cells(narrow.renderer)).toEqual(cells(narrow.mirror))
    const [node1, portable1] = bothDecodes(narrow.mirror)
    expect(portable1).toBe(node1)
  })
})
