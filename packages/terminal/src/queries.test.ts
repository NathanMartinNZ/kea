import { afterEach, describe, expect, it } from 'vitest'
import { installRendererSwallow, QUERY_TABLE, type QueryEntry } from './queries.ts'
import { newMirror, newTerminal, write, type HeadlessTerminal, type TestMirror } from './test-support.ts'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})

/** A renderer stand-in: same options and hooks as the renderer's xterm (same InputHandler at the pinned commit). */
function renderer() {
  const term = newTerminal('renderer')
  const replies: string[] = []
  term.onData((d) => replies.push(d))
  cleanup.push(() => term.dispose())
  return { term, replies }
}

/** Counts sequences that get past the swallow hooks (registered before them, so it runs after them). */
function probe(term: HeadlessTerminal, e: QueryEntry): { calls: number } {
  const c = { calls: 0 }
  const hit = () => {
    c.calls++
    return false
  }
  if (e.kind === 'csi') term.parser.registerCsiHandler(e.ident, hit)
  else if (e.kind === 'dcs') term.parser.registerDcsHandler(e.ident, hit)
  else term.parser.registerOscHandler(e.ident, hit)
  return c
}

function mirror(): TestMirror {
  const m = newMirror()
  cleanup.push(() => m.dispose())
  return m
}

const entry = (id: string) => QUERY_TABLE.find((e) => e.id === id) as QueryEntry

describe('query table', () => {
  it('U-PTY-5 · every entry is well formed: a known answerer, a reply pattern exactly when someone answers', () => {
    const ids = new Set<string>()
    for (const e of QUERY_TABLE) {
      expect(ids.has(e.id), e.id).toBe(false)
      ids.add(e.id)
      expect(['xterm', 'kea', 'nobody']).toContain(e.answeredBy)
      expect(e.reply === null, e.id).toBe(e.answeredBy === 'nobody')
    }
    // every query the mirror must answer has an entry
    for (const id of ['DA1', 'DA2', 'DSR', 'DECXCPR', 'DECRQM', 'DECRQM_DEC', 'KITTY_KBD', 'XTVERSION', 'DECRQSS', 'OSC4', 'OSC10', 'OSC11', 'OSC12', 'COLOR_SCHEME', 'WIN_PX', 'CELL_PX', 'WIN_CHARS']) {
      expect(ids.has(id), id).toBe(true)
    }
  })

  for (const e of QUERY_TABLE) {
    it(`U-PTY-5 · ${e.id}: the renderer swallows it; the mirror answers ${e.answeredBy === 'nobody' ? 'never' : 'exactly once'}`, async () => {
      const r = renderer()
      const seen = probe(r.term, e)
      cleanup.push(installRendererSwallow(r.term).dispose)
      await write(r.term, e.example)
      expect(r.replies).toEqual([])
      expect(seen.calls).toBe(0)

      const m = mirror()
      await m.write(e.example)
      if (e.reply === null) expect(m.replies).toEqual([])
      else {
        expect(m.replies).toHaveLength(1)
        expect(m.replies[0]).toMatch(e.reply)
      }
    })
  }

  it.each([
    ['kitty push', '\x1b[>1u', 'KITTY_KBD'],
    ['palette set', '\x1b]4;1;#ff0000\x07', 'OSC4'],
    ['background set', '\x1b]11;#101010\x07', 'OSC11'],
    ['clipboard write', '\x1b]52;c;aGVsbG8=\x07', 'OSC52_READ'],
    ['DSR with another code', '\x1b[3n', 'DSR'],
    ['DA1 with a parameter', '\x1b[1c', 'DA1'],
  ])('U-PTY-5 · set and push forms still reach the renderer’s xterm: %s', async (_name, seq, id) => {
    const r = renderer()
    const e = entry(id)
    const seen = probe(r.term, e)
    cleanup.push(installRendererSwallow(r.term).dispose)
    await write(r.term, seq)
    if (e.id !== 'KITTY_KBD') expect(seen.calls).toBe(1) // kitty push has its own identifier, untouched by the table
    expect(r.replies).toEqual([])
  })

  it('U-PTY-5 · a colour OSC mixing a query and a set: renderer swallows the query and still applies the set', async () => {
    const r = renderer()
    const sets: string[] = []
    r.term.parser.registerOscHandler(4, (d) => {
      sets.push(d)
      return false
    })
    cleanup.push(installRendererSwallow(r.term).dispose)
    await write(r.term, '\x1b]4;1;?;2;#00ff00\x07')
    await write(r.term, '') // the re-applied set is queued behind the current chunk
    expect(r.replies).toEqual([])
    expect(sets).toEqual(['2;#00ff00'])

    const m = mirror()
    await m.write('\x1b]4;1;?;2;#00ff00\x07\x1b]4;2;?\x07')
    expect(m.replies).toEqual(['\x1b]4;1;rgb:ecec/6a6a/5757\x1b\\', '\x1b]4;2;rgb:0000/ffff/0000\x1b\\'])
  })

  it('U-PTY-53 · mirror colours come from the theme, follow program overrides and restores', async () => {
    const m = mirror()
    await m.write('\x1b]11;?\x07\x1b]10;?\x1b\\\x1b]12;?\x07\x1b]4;1;?\x07\x1b]4;196;?\x07\x1b]4;244;?\x07')
    expect(m.replies).toEqual([
      '\x1b]11;rgb:0c0c/0d0d/0b0b\x1b\\', // kea-dark background #0C0D0B
      '\x1b]10;rgb:dada/dddd/d3d3\x1b\\', // foreground #DADDD3
      '\x1b]12;rgb:f5f5/7979/3a3a\x1b\\', // cursor #F5793A
      '\x1b]4;1;rgb:ecec/6a6a/5757\x1b\\', // red #EC6A57
      '\x1b]4;196;rgb:ffff/0000/0000\x1b\\', // 6×6×6 cube
      '\x1b]4;244;rgb:8080/8080/8080\x1b\\', // grey ramp
    ])
    m.replies.length = 0
    await m.write('\x1b]11;rgb:ff/ff/ff\x07\x1b]11;?\x07\x1b[?996n\x1b]111\x07\x1b]11;?\x07\x1b[?996n')
    expect(m.replies).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\', '\x1b[?997;2n', '\x1b]11;rgb:0c0c/0d0d/0b0b\x1b\\', '\x1b[?997;1n'])
    m.replies.length = 0
    // one OSC 10 with two slots asks for foreground and background
    await m.write('\x1b]10;?;?\x07')
    expect(m.replies).toEqual(['\x1b]10;rgb:dada/dddd/d3d3\x1b\\', '\x1b]11;rgb:0c0c/0d0d/0b0b\x1b\\'])
    m.replies.length = 0
    await m.write('\x1b]4;3;#010203\x07\x1b]104;3\x07\x1b]4;3;?\x07\x1b]4;5;#010203\x07\x1b]104\x07\x1b]4;5;?\x07')
    expect(m.replies).toEqual(['\x1b]4;3;rgb:d9d9/b4b4/5b5b\x1b\\', '\x1b]4;5;rgb:b5b5/8a8a/d6d6\x1b\\'])
  })

  it('U-PTY-5 · CSI 14/16/18 t answer from the last renderer pixel size and the grid', async () => {
    const m = mirror()
    await m.write('\x1b[14t\x1b[16t')
    expect(m.replies).toEqual(['\x1b[4;0;0t', '\x1b[6;0;0t']) // no renderer has reported a size yet
    m.replies.length = 0
    m.kit.setPixelSize(800, 480)
    await m.write('\x1b[14t\x1b[16t\x1b[18t\x1b[14;2t')
    expect(m.replies).toEqual(['\x1b[4;480;800t', '\x1b[6;20;10t', '\x1b[8;24;80t', '\x1b[4;480;800t'])
  })

  it('U-PTY-5 · replies are dropped while the mirror rebuilds from the ring, and resume afterwards', async () => {
    const m = mirror()
    m.kit.setReplying(false)
    await m.write('\x1b[c\x1b]11;?\x07\x1b[6n\x1b[?996n')
    expect(m.replies).toEqual([])
    expect(m.kit.droppedReplies).toBe(4)
    m.kit.setReplying(true)
    await m.write('\x1b[c')
    expect(m.replies).toEqual(['\x1b[?1;2c'])
  })

  it('U-PTY-5 · replies keep the order of the queries, mixing xterm’s and Kea’s answerers', async () => {
    const m = mirror()
    await m.write('\x1b]11;?\x07\x1b[c\x1b[?996n\x1b[6n\x1b[18t')
    expect(m.replies).toEqual(['\x1b]11;rgb:0c0c/0d0d/0b0b\x1b\\', '\x1b[?1;2c', '\x1b[?997;1n', '\x1b[1;1R', '\x1b[8;24;80t'])
  })
})

describe('untrusted output', () => {
  it('U-TERM-14 · window reports (CSI 11/13/15/19/20/21 t) and title push/pop produce no reply from the mirror or the renderer', async () => {
    const seq = '\x1b]2;rm -rf ~\x07' + [11, 13, 15, 19, 20, 21, 22, 23].map((n) => `\x1b[${n}t`).join('')
    const r = renderer()
    cleanup.push(installRendererSwallow(r.term).dispose)
    await write(r.term, seq)
    expect(r.replies).toEqual([])
    const m = mirror()
    await m.write(seq)
    expect(m.replies).toEqual([])
  })

  it('U-TERM-14 · a clipboard read (OSC 52 ?) is never answered', async () => {
    const r = renderer()
    cleanup.push(installRendererSwallow(r.term).dispose)
    await write(r.term, '\x1b]52;c;?\x07')
    expect(r.replies).toEqual([])
    const m = mirror()
    await m.write('\x1b]52;c;?\x07\x1b]52;p;?\x1b\\')
    expect(m.replies).toEqual([])
  })
})
