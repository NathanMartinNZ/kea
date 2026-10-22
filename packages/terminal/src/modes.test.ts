import { afterEach, describe, expect, it } from 'vitest'
import { composeSnapshot } from './modes.ts'
import { internals, newMirror, screenStyles, screenText, type TestMirror } from './test-support.ts'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})

function mirror(cols = 80, rows = 24): TestMirror {
  const m = newMirror(cols, rows)
  cleanup.push(() => m.dispose())
  return m
}

/** DEC private modes worth comparing by asking the terminal itself (DECRQM). */
const DECRQM_MODES = [1, 6, 7, 9, 25, 45, 66, 1000, 1002, 1003, 1004, 1006, 1016, 1049, 2004, 2026]

async function probeModes(m: TestMirror): Promise<string[]> {
  m.replies.length = 0
  await m.write(DECRQM_MODES.map((n) => `\x1b[?${n}$p`).join('') + '\x1b[4$p\x1b[20$p\x1b[?u\x1bP$qr\x1b\\\x1b[6n')
  const out = [...m.replies]
  m.replies.length = 0
  return out
}

/** Source state → snapshot → fresh mirror; returns both after asserting they match everywhere the test can see. */
async function roundTrip(input: string, opts: { cols?: number; rows?: number; after?: string } = {}) {
  const src = mirror(opts.cols, opts.rows)
  await src.write(input)
  expect(src.kit.atGround).toBe(true)
  src.replies.length = 0
  const snap = src.snapshot()
  const dst = mirror(opts.cols, opts.rows)
  await dst.write(snap)
  expect(dst.replies, 'a snapshot never contains a query').toEqual([])

  const a = internals(src.term)
  const b = internals(dst.term)
  // both saved flag slots, including the active screen's stale one: xterm.js swaps them on every 47/1047/1049, so a
  // leave without an enter reads it back
  expect(b.kitty).toEqual(a.kitty)
  expect(b.mouseEncoding).toBe(a.mouseEncoding)
  expect(b.mouseProtocol).toBe(a.mouseProtocol)
  expect(b.scrollRegion).toEqual(a.scrollRegion)
  expect(b.cursorStyle).toBe(a.cursorStyle)
  expect(b.cursorBlink).toBe(a.cursorBlink)
  expect(b.glevel).toBe(a.glevel)
  expect(b.charsets).toEqual(a.charsets)
  expect(b.title).toBe(a.title)
  expect(b.saved, 'saved cursors (DECSC, 1049): position, attributes, origin and wrap').toEqual(a.saved)
  expect(b.savedCharsets, 'charsets saved with them').toEqual(a.savedCharsets)
  expect(src.kit.modes.state().saved, 'the tracker agrees with xterm.js').toEqual(a.saved)
  expect(src.kit.modes.state().attrs, 'the tracker follows the attributes as xterm.js does').toEqual(a.attrs)
  for (const k of ['normal', 'alt'] as const) {
    const t = src.kit.charsets.saved(k)
    expect({ set: t.charsets.map((f) => f !== undefined), glevel: t.glevel }, `the charset tracker's ${k} slot`).toEqual({ set: a.savedCharsets[k].charsets.map((c) => c !== undefined && c !== null), glevel: a.savedCharsets[k].glevel })
  }
  expect(b.attrs, 'current attributes').toEqual(a.attrs)
  expect(b.tabs, 'tab stops of both screens').toEqual(a.tabs)
  expect(src.kit.modes.state().tabs, 'the tracker follows the tab stops as xterm.js does').toEqual(a.tabs)
  expect(dst.term.options.convertEol, 'LNM').toBe(src.term.options.convertEol)
  expect(dst.term.modes).toEqual(src.term.modes)
  expect(dst.term.buffer.active.type).toBe(src.term.buffer.active.type)
  expect([dst.term.buffer.active.cursorX, dst.term.buffer.active.cursorY]).toEqual([src.term.buffer.active.cursorX, src.term.buffer.active.cursorY])
  expect(screenText(dst.term)).toEqual(screenText(src.term))
  expect(screenStyles(dst.term)).toEqual(screenStyles(src.term))
  // the trackers agree too, so a mirror rebuilt from this snapshot can checkpoint again correctly
  expect(dst.kit.modes.state()).toEqual(src.kit.modes.state())
  expect(dst.kit.charsets.snapshot()).toEqual(src.kit.charsets.snapshot())
  expect(dst.kit.colors.trailer()).toBe(src.kit.colors.trailer())
  // and the terminal answers mode queries identically
  expect(await probeModes(dst)).toEqual(await probeModes(src))

  // output after the boundary lands identically (cursor, charsets, wrap, region, insert mode)
  const after = opts.after ?? 'after\r\n\x1b[2Bq x\r\nmore text'
  await src.write(after)
  await dst.write(after)
  expect(screenText(dst.term)).toEqual(screenText(src.term))
  expect(screenStyles(dst.term), 'and in the same attributes').toEqual(screenStyles(src.term))
  expect(internals(dst.term).kitty.flags).toBe(internals(src.term).kitty.flags)
  expect(internals(dst.term).attrs).toEqual(internals(src.term).attrs)
  return { src, dst, snap }
}

describe('mode trailer', () => {
  it('U-PTY-3 · kitty keyboard flags: push/set/OR stack on the main screen survives', async () => {
    const { src, dst } = await roundTrip('hello\x1b[>1u\x1b[>3u\x1b[=4;2u', { after: '\x1b[<u' })
    expect(internals(src.term).kitty.flags).toBe(1)
    expect(internals(dst.term).kitty.mainStack).toEqual(internals(src.term).kitty.mainStack)
  })

  it('U-PTY-3 · kitty keyboard flags: separate stacks for the alternate screen (alt active)', async () => {
    await roundTrip('main\x1b[>5u\x1b[?1049h\x1b[>9u\x1b[>11u alt screen', { after: '\x1b[<u\x1b[?1049l\x1b[<u' })
  })

  it('U-PTY-3 · kitty keyboard flags: alternate-screen stack kept while the main screen is active', async () => {
    const { src, dst } = await roundTrip('\x1b[?1049h\x1b[>2u\x1b[>6u\x1b[?1049l\x1b[>1u back on main', { after: '\x1b[?1049h\x1b[<u\x1b[?1049l' })
    expect(internals(dst.term).kitty.altStack).toEqual(internals(src.term).kitty.altStack)
    expect(internals(dst.term).kitty.altFlags).toBe(internals(src.term).kitty.altFlags)
  })

  it.each([
    ['main active', '\x1b[>1u\x1b[?1049h\x1b[?1049l', '\x1b[?1049l\x1b[<u'],
    ['alt active', '\x1b[?1049h\x1b[>3u\x1b[?1049l\x1b[?1049h', '\x1b[?1049l\x1b[?1049l\x1b[<u'],
    ['alt active, main flags set without a stack', '\x1b[=5;1u\x1b[?1049h\x1b[=2;1u', '\x1b[?1049l\x1b[?1049l'],
  ])('U-PTY-3 · kitty keyboard flags: the active screen\'s stale slot survives (a leave without an enter reads it), %s', async (_name, input, after) => {
    const { src, dst } = await roundTrip(input, { after })
    expect(internals(dst.term).kitty).toEqual(internals(src.term).kitty)
  })

  it.each([
    ['any-event mouse with SGR encoding', '\x1b[?1003h\x1b[?1006h'],
    ['button-event mouse with SGR-pixels encoding', '\x1b[?1002h\x1b[?1016h'],
    ['X10 mouse, default encoding', '\x1b[?9h'],
    ['focus reporting and bracketed paste', '\x1b[?1004h\x1b[?2004h'],
    ['DECCKM and keypad application mode', '\x1b[?1h\x1b='],
    ['auto-wrap off and insert mode', '\x1b[?7l\x1b[4h'],
    ['hidden cursor and reverse wrap-around', '\x1b[?25l\x1b[?45h'],
  ])('U-PTY-3 · DEC modes survive: %s', async (_name, seq) => {
    await roundTrip(`prompt$ ${seq}typed`)
  })

  it('U-PTY-3 · saved cursor on the main screen (DECSC / SCOSC): DECRC after the restore lands where it would have', async () => {
    await roundTrip('one\r\ntwo\x1b[5;10H\x1b7\x1b[20;1Hbelow', { after: '\x1b8X' })
    await roundTrip('one\x1b[7;3H\x1b[s\x1b[12;40Hsome text', { after: '\x1b[uY' })
    // saved, then scrolled: the row follows the content up (xterm.js keeps an absolute row)
    await roundTrip('\x1b[3;5H\x1b7' + '\r\nline'.repeat(30), { after: '\x1b8Z' })
  })

  it('U-PTY-3 · saved cursors around the alternate screen: 1049 restores the main cursor on leaving; alt keeps its own', async () => {
    // alt active: leaving it restores where 1049h saved
    await roundTrip('main text\x1b[3;7H\x1b[?1049h\x1b[10;10Halt screen', { after: '\x1b[?1049lZ' })
    // alt active with a main scroll region, and DECSC inside the alternate screen
    await roundTrip('main\x1b[2;20r\x1b[6;2H\x1b[?1049h\x1b[4;4H\x1b7\x1b[9;9Hx', { after: '\x1b8Y\x1b[?1049lW' })
    // back on main: the alternate screen's saved cursor survives for the next visit
    await roundTrip('\x1b[?1049h\x1b[5;6H\x1b7\x1b[?1049lmain again', { after: '\x1b[?1049h\x1b8V' })
  })

  it('U-PTY-3 · a saved cursor brings back the attributes and character sets saved with it, on either screen', async () => {
    // DECSC with bold red and DEC graphics in G0; DECRC after the restore draws a bold red line
    await roundTrip('\x1b[1;31m\x1b(0\x1b7\x1b[0m\x1b(Babc', { after: '\x1b8qqX\x1b[0m' })
    // SCOSC / SCORC, G1 shifted in, a 256-colour background and a curly underline (the underline style is not saved)
    await roundTrip('\x1b[48;5;123;4:3m\x1b)0\x0e\x1b[s\x1b[0m\x0fplain', { after: '\x1b[uqx' })
    // 1048 saves without switching screens
    await roundTrip('\x1b[32;7m\x1b[?1048h\x1b[0mtext', { after: '\x1b[?1048lG' })
    // the main screen's slot while the alternate screen is active: leaving restores it
    await roundTrip('\x1b[4;35m\x1b)0\x0e\x1b[?1049h\x1b[0m\x0f\x1b(Bfull screen', { after: '\x1b[?1049lqZ' })
    // the alternate screen's slot while the main screen is active: built before the main content
    await roundTrip('\x1b[?1049h\x1b[3;3H\x1b[7;38;2;1;2;3m\x1b(0\x1b7\x1b[?1049l\x1b[0;2mmain', { after: '\x1b[?1049h\x1b8qV' })
    // DECSC inside the alternate screen while it is active
    await roundTrip('\x1b[?1049h\x1b[9;9H\x1b[3;53m\x1b7\x1b[0m\x1b[1;1Halt', { after: '\x1b8W' })
  })

  it('U-PTY-3 · a saved cursor brings back origin mode and auto-wrap; a slot saved in origin mode is placed absolutely', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n')
    // saved in origin mode inside a region, then origin mode and the region dropped: DECRC turns origin mode back on
    await roundTrip(`${lines}\x1b[5;20r\x1b[?6h\x1b[3;7H\x1b7\x1b[?6l\x1b[r\x1b[1;1Hx`, { after: '\x1b8Y\x1b[1;1HZ' })
    // origin mode still on at the snapshot: the slot is placed with CUP relative to the whole screen, not the region
    await roundTrip(`${lines}\x1b[5;20r\x1b[?6h\x1b[3;7H\x1b7\x1b[8;1Hhere`, { after: '\x1b8X' })
    // saved with auto-wrap off, restored while it is on: DECRC turns it off again
    await roundTrip('\x1b[?7l\x1b[2;70H\x1b7\x1b[?7h\x1b[5;1Hwrapping on', { after: `\x1b8${'w'.repeat(20)}` })
    // the alternate screen's slot with auto-wrap off and origin mode, built in the prefix
    await roundTrip('\x1b[?1049h\x1b[3;10r\x1b[?6h\x1b[?7l\x1b[2;75H\x1b7\x1b[?6l\x1b[?7h\x1b[r\x1b[?1049lmain', { after: `\x1b[?1049h\x1b8${'v'.repeat(12)}` })
  })

  it('U-PTY-3 · DECSTR resets the saved position and attributes but keeps the saved modes and charsets; DECSCA survives', async () => {
    await roundTrip('\x1b[1;34m\x1b(0\x1b[?7l\x1b7\x1b[!p after soft reset', { after: '\x1b8q' })
    await roundTrip('\x1b[1"qprotected\x1b[2"q\x1b[1"q', { after: 'more' })
  })

  it('U-PTY-3 · current attributes the cells do not show come back: an underline colour set before the underline', async () => {
    await roundTrip('text\x1b[58:5:3m', { after: '\x1b[4munderlined' })
    await roundTrip('text\x1b[58:2::10:20:30;9m\x1b[59m', { after: '\x1b[4:3mcurly' })
    // also after a reprinted pending-wrap row, whose serializer restores only what shows
    await roundTrip(`\x1b[58:5:3m${'x'.repeat(80)}`, { after: '\x1b[4my' })
    await roundTrip('\x1b[58:5:3m\x1b[?1049hon the alternate screen', { after: '\x1b[4my' })
  })

  it('U-PTY-3 · alternate screen with non-default current attributes: its content is not drawn in them', async () => {
    await roundTrip('main\x1b[?1049h\x1b[Halt\x1b[2;1H\x1b[31;44m', { after: 'red on blue' })
    await roundTrip('main\x1b[44m\x1b[?1049h\x1b[3;1Hx\x1b[2;1H', { after: 'y' })
  })

  it('U-PTY-3 · scroll region and origin mode, with the cursor inside the region', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n')
    const { dst } = await roundTrip(`${lines}\x1b[5;20r\x1b[?6h\x1b[3;7Hhere`, { after: '\r\n\r\nX\x1b[20;1H\r\n\r\nscrolled' })
    expect(internals(dst.term).scrollRegion).toEqual([4, 19])
  })

  it('U-PTY-3 · scroll region of the alternate screen; the main screen’s is kept underneath', async () => {
    await roundTrip('\x1b[3;10r\x1b[?1049h\x1b[2;8r\x1b[5;1Hx', { after: '\r\n\r\n\r\n\r\ny\x1b[?1049lz' })
  })

  it('U-PTY-3 · character sets: G0–G3 designations and SO/SI and locking shifts', async () => {
    await roundTrip('\x1b(0\x1b)A\x1b*0\x1b+A\x0eqqq', { after: 'q\x0fq\x1bnq\x1boq' })
    await roundTrip('\x1b)0\x0eqq', { after: 'lqk\x0fx' })
    await roundTrip('\x1b(0\x1b%G', { after: 'q' }) // ESC % G selects the default set again
  })

  it.each([
    ['steady bar', '\x1b[6 q'],
    ['blinking underline', '\x1b[3 q'],
    ['blink flag without a shape (DECSCUSR 7)', '\x1b[7 q'],
    ['reset to the option', '\x1b[2 q\x1b[0 q'],
  ])('U-PTY-3 · cursor style: %s', async (_name, seq) => {
    await roundTrip(seq)
  })

  it('U-PTY-3 · tab stops set and cleared on the active screen come back, and the main screen\'s while the alternate screen is active', async () => {
    const tabs = '\r\tA\tB\tC\tD'
    // HTS at two columns, TBC 0 clearing a default one
    await roundTrip('\x1b[5G\x1bH\x1b[21G\x1bH\x1b[9G\x1b[g\x1b[1Gtext', { after: tabs })
    // TBC 3, then a few stops
    await roundTrip('\x1b[3g\x1b[3G\x1bH\x1b[40G\x1bH\r\nx', { after: tabs })
    // all stops cleared: a tab goes to the last column
    await roundTrip('\x1b[3gnone', { after: tabs })
    // on the alternate screen, which is active
    await roundTrip('\x1b[?1049h\x1b[3g\x1b[11G\x1bH\x1b[2;1Halt', { after: `${tabs}\x1b[?1049l${tabs}` })
    // the main screen's, set before entering the alternate screen (built in the prefix)
    await roundTrip('\x1b[3g\x1b[7G\x1bH\x1b[?1049h\x1b[3g\x1b[30G\x1bH\x1b[1;1Halt', { after: `${tabs}\x1b[?1049l${tabs}` })
    // leaving the alternate screen resets its stops; RIS resets both screens'
    await roundTrip('\x1b[?1049h\x1b[3g\x1b[?1049lmain', { after: `\x1b[?1049h${tabs}` })
    await roundTrip('\x1b[3g\x1b[?1049h\x1b[3g\x1bc', { after: tabs })
    // a stop set in the pending-wrap column is past the right margin: nothing to restore at this width
    await roundTrip(`${'x'.repeat(80)}\x1bH`, { after: tabs })
  })

  it('U-PTY-3 · a tab stop set by the 8-bit C1 HTS (U+0088) does not come back (known loss, documented): no parser hook sees it', async () => {
    const src = mirror()
    await src.write('\x1b[5G\u0088')
    expect(internals(src.term).tabs.normal).toContain(4)
    expect(src.kit.modes.state().tabs.normal).not.toContain(4)
    const dst = mirror()
    await dst.write(src.snapshot())
    expect(internals(dst.term).tabs.normal).not.toContain(4)
  })

  it('U-PTY-3 · tab stops after a resize: new stops are laid from the last one left of the new width, as in xterm.js', async () => {
    const src = mirror(60, 10)
    await src.write('\x1b[3g\x1b[13G\x1bH\x1b[?1049h\x1b[3g\x1b[5G\x1bH')
    src.term.resize(100, 10)
    await src.write('\x1b[?1049l')
    src.term.resize(90, 12)
    const a = internals(src.term)
    expect(src.kit.modes.state().tabs).toEqual(a.tabs)
    expect(a.tabs.normal.slice(0, 3)).toEqual([12, 20, 28])
    const dst = mirror(90, 12)
    await dst.write(src.snapshot())
    expect(internals(dst.term).tabs).toEqual(a.tabs)
    expect(dst.kit.modes.state().tabs).toEqual(src.kit.modes.state().tabs)
  })

  it('U-PTY-3 · LNM comes back, and a snapshot turns it off in a reused terminal that still has it (RIS and reset() keep it)', async () => {
    await roundTrip('\x1b[20hline', { after: 'a\nb\nc' })
    await roundTrip('\x1b[20h\x1b[20lline', { after: 'a\nb' })
    const src = mirror()
    await src.write('text')
    const reused = newMirror()
    cleanup.push(() => reused.dispose())
    await reused.write('\x1b[20h\x1bc')
    expect(reused.term.options.convertEol, 'RIS keeps LNM').toBe(true)
    reused.term.reset()
    expect(reused.term.options.convertEol, 'reset() keeps it too').toBe(true)
    await reused.write(src.snapshot())
    expect(reused.term.options.convertEol).toBe(false)
  })

  it('U-PTY-3 · current title', async () => {
    const { dst } = await roundTrip('\x1b]0;first\x07\x1b]2;✳ Claude Code\x1b\\')
    expect(internals(dst.term).title).toBe('✳ Claude Code')
    expect(dst.kit.title).toBe('✳ Claude Code')
  })

  it('U-PTY-3 · colour overrides survive, so colour queries after a restore get the same answer', async () => {
    const { src, dst } = await roundTrip('\x1b]4;1;#123456\x07\x1b]11;rgb:20/20/20\x07\x1b]10;#eeeeee\x07')
    src.replies.length = 0
    dst.replies.length = 0
    const q = '\x1b]4;1;?\x07\x1b]11;?\x07\x1b]10;?\x07\x1b[?996n'
    await src.write(q)
    await dst.write(q)
    expect(dst.replies).toEqual(src.replies)
    expect(dst.replies[0]).toBe('\x1b]4;1;rgb:1212/3434/5656\x1b\\')
  })

  it('U-PTY-3 · alternate screen with content, cursor and modes', async () => {
    await roundTrip('shell output\r\n$ vim\x1b[?1049h\x1b[H\x1b[2Jfile contents\r\n~\r\n~\x1b[?1h\x1b=\x1b[?2004h\x1b[10;5H')
  })

  it('U-PTY-3 · cursor position: explicit CUP, also after a line filled to the last column', async () => {
    await roundTrip('abc\x1b[12;40Hmid')
    await roundTrip('x'.repeat(79) + 'Y', { after: 'Z continues' })
    await roundTrip('wide 日本語\x1b[5;79H日', { after: 'next' })
  })

  it('U-PTY-3 · pending wrap away from the end of the content, where the serializer alone loses it (#6165)', async () => {
    const src = mirror()
    await src.write('\x1b[10;1Hbelow\x1b[5;79HXY')
    const dst = mirror()
    await dst.write(src.serialize())
    await src.write('Z')
    await dst.write('Z')
    expect(screenText(dst.term)).not.toEqual(screenText(src.term)) // the serializer alone overwrites instead of wrapping
    await roundTrip('\x1b[10;1Hbelow\x1b[5;79HXY', { after: 'Z wraps' })
    await roundTrip('\x1b[4h\x1b[3;1Habc\x1b[3;79H\x1b[1;31mXY\x1b[0;4m', { after: 'Z wraps, underlined' })
  })

  it.each([
    ['on the alternate screen', '\x1b[?1049h\x1b[3;79HXY'],
    ['in origin mode', '\x1b[5;20r\x1b[?6h\x1b[2;79HXY'],
  ])('U-PTY-3 · pending wrap %s comes back as the last column (known loss, documented)', async (_name, seq) => {
    const src = mirror()
    await src.write(seq)
    const dst = mirror()
    await dst.write(src.snapshot())
    expect(src.term.buffer.active.cursorX).toBe(80)
    expect([dst.term.buffer.active.cursorX, dst.term.buffer.active.cursorY]).toEqual([79, src.term.buffer.active.cursorY])
  })

  it('U-PTY-3 · DECSTR and RIS reset what they reset in xterm.js, and the trailer agrees', async () => {
    await roundTrip('\x1b[>3u\x1b[5 q\x1b[3;9r\x1b(0\x1b[!p after soft reset')
    await roundTrip('\x1b[>3u\x1b[?1006h\x1b[5 q\x1b]2;t\x07\x1bc after full reset')
  })

  it('U-PTY-3 · a resize resets the scroll regions, as in xterm.js', async () => {
    const src = mirror()
    await src.write('\x1b[3;9r')
    src.term.resize(100, 30)
    expect(src.kit.modes.state().region).toEqual({ normal: null, alt: null })
    expect(internals(src.term).scrollRegion).toEqual([0, 29])
  })

  it('U-PTY-3 · the trailer ends DECSTBM → DECOM → CUP, and a snapshot is prefix + serialized + suffix', async () => {
    const m = mirror()
    await m.write('\x1b[>1u\x1b[4;12r\x1b[?6h\x1b[2;3H')
    const t = m.kit.trailer()
    expect(t.suffix.endsWith('\x1b[4;12r\x1b[?6h\x1b[2;3H')).toBe(true)
    expect(composeSnapshot('BODY', t)).toBe(`${t.prefix}BODY${t.suffix}`)
    expect(t.prefix).toBe('\x1b[=0;1u\x1b[>1u')
  })
})

describe('what the serializer restores without the trailer', () => {
  /** Restore with the serializer alone and report which tracked states differ from the source. */
  async function serializerOnly(input: string): Promise<string[]> {
    const src = mirror()
    await src.write(input)
    const dst = mirror()
    await dst.write(src.serialize())
    const a = internals(src.term)
    const b = internals(dst.term)
    const lost: string[] = []
    if (JSON.stringify(a.kitty) !== JSON.stringify(b.kitty)) lost.push('kitty')
    if (a.mouseEncoding !== b.mouseEncoding) lost.push('mouseEncoding')
    if (a.mouseProtocol !== b.mouseProtocol) lost.push('mouseProtocol')
    if (JSON.stringify(a.scrollRegion) !== JSON.stringify(b.scrollRegion)) lost.push('scrollRegion')
    if (a.cursorStyle !== b.cursorStyle || a.cursorBlink !== b.cursorBlink) lost.push('cursorStyle')
    if (a.glevel !== b.glevel || JSON.stringify(a.charsets) !== JSON.stringify(b.charsets)) lost.push('charsets')
    if (a.title !== b.title) lost.push('title')
    if (a.x !== b.x || a.y !== b.y) lost.push('cursor')
    if (JSON.stringify(a.tabs) !== JSON.stringify(b.tabs)) lost.push('tabs')
    if (src.term.options.convertEol !== dst.term.options.convertEol) lost.push('lnm')
    for (const k of Object.keys(src.term.modes) as (keyof typeof src.term.modes)[]) {
      if (src.term.modes[k] !== dst.term.modes[k]) lost.push(k)
    }
    return lost
  }

  it('U-PTY-3 · serializer alone: modes kept, kitty / mouse encoding / charsets / cursor style / title / tab stops / LNM lost', async () => {
    expect(await serializerOnly('\x1b[?1h\x1b=\x1b[?2004h\x1b[4h\x1b[?1004h\x1b[?7l\x1b[?1002h\x1b[?25l\x1b[?45h')).toEqual([])
    expect(await serializerOnly('\x1b[>1u')).toEqual(['kitty'])
    expect(await serializerOnly('\x1b[?1006h')).toEqual(['mouseEncoding'])
    expect(await serializerOnly('\x1b(0')).toEqual(['charsets'])
    expect(await serializerOnly('\x1b[5 q')).toEqual(['cursorStyle'])
    expect(await serializerOnly('\x1b]2;t\x07')).toEqual(['title'])
    expect(await serializerOnly('\x1b[3g\x1b[5G\x1bH\r')).toEqual(['tabs'])
    expect(await serializerOnly('\x1b[20h')).toEqual(['lnm'])
    // scroll region + origin mode: the serializer emits both but homes the cursor afterwards
    expect(await serializerOnly('\x1b[5;20r\x1b[?6h\x1b[3;7H')).toEqual(['cursor'])
  })
})
