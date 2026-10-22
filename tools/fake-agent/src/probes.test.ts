import { describe, expect, it } from 'vitest'
import { parseKeys } from './keys.ts'
import { classifyReply, ProbeBatch, probeQuery, tokenize } from './probes.ts'

describe('fake-agent probes and keys', () => {
  it('U-FAKE-7 · the tokenizer splits CSI/OSC/DCS/SS3 sequences from text and holds an incomplete one for the next chunk', () => {
    const { tokens, rest } = tokenize('ab\x1b[?1;2cxy\x1b]11;rgb:0/0/0\x07\x1bP>|xterm\x1b\\\x1bOA\x1b]11;rgb:1')
    expect(tokens).toEqual([
      { type: 'text', seq: 'ab' },
      { type: 'csi', seq: '\x1b[?1;2c' },
      { type: 'text', seq: 'xy' },
      { type: 'osc', seq: '\x1b]11;rgb:0/0/0\x07' },
      { type: 'dcs', seq: '\x1bP>|xterm\x1b\\' },
      { type: 'ss3', seq: '\x1bOA' },
    ])
    expect(rest).toBe('\x1b]11;rgb:1')
    // a split ST, then completion
    expect(tokenize('\x1b]11;x\x1b').rest).toBe('\x1b]11;x\x1b')
    expect(tokenize('\x1b]11;x\x1b\\').tokens).toEqual([{ type: 'osc', seq: '\x1b]11;x\x1b\\' }])
    // keyboard input: a lone ESC at the end is the Esc key
    expect(tokenize('\x1b', true).tokens).toEqual([{ type: 'esc', seq: '\x1b' }])
    expect(tokenize('\x1b').rest).toBe('\x1b')
  })

  it('U-FAKE-8 · a probe batch sends its queries then the DA1 sentinel, takes replies out of the input in any chunking, and passes keys through', () => {
    const b = new ProbeBatch(['decrqm-2026', 'kitty', 'osc11', 'cpr'])
    expect(b.start(100)).toBe('\x1b[?2026$p' + '\x1b[?u' + '\x1b]11;?\x1b\\' + '\x1b[6n' + '\x1b[c')
    const replies = '\x1b[?2026;2$y' + 'y' + '\x1b[?5u' + '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\' + '\x1b[A' + '\x1b[?1;2c' + 'after'
    // feed one byte at a time: replies split anywhere still parse
    let keys = ''
    for (let i = 0; i < replies.length; i++) keys += b.feed(replies[i] as string, 100 + i)
    expect(b.done).toBe(true)
    expect(keys).toBe('y\x1b[Aafter') // typed keys survive, in order; bytes after the sentinel are keys
    const { results } = b.finish()
    expect(results).toEqual([
      { id: 'decrqm-2026', reply: '\x1b[?2026;2$y', value: '2', ms: 10 },
      { id: 'kitty', reply: '\x1b[?5u', value: '5', ms: 16 },
      { id: 'osc11', reply: '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\', value: 'rgb:1e1e/1e1e/1e1e', ms: 41 },
      { id: 'cpr', reply: null, value: null, ms: null }, // unanswered before the sentinel
    ])
    // an explicit da1 query: the first DA1 reply answers it, the second is the sentinel
    const d = new ProbeBatch(['da1'])
    expect(d.start(0)).toBe('\x1b[c\x1b[c')
    d.feed('\x1b[?62;4c', 3)
    expect(d.done).toBe(false)
    d.feed('\x1b[?62;4c', 4)
    expect(d.done).toBe(true)
    expect(d.finish().results).toEqual([{ id: 'da1', reply: '\x1b[?62;4c', value: '62;4', ms: 3 }])
    expect(probeQuery('decrqm-1049')).toBe('\x1b[?1049$p')
    expect(classifyReply('\x1b[>0;276;0c')).toMatchObject({ id: 'da2' })
    expect(classifyReply('\x1bP>|xterm.js(6.1.0)\x1b\\')).toMatchObject({ id: 'xtversion', value: 'xterm.js(6.1.0)' })
    expect(classifyReply('\x1b[A')).toBeNull()
  })

  it('U-FAKE-9 · keystrokes become key names (controls, arrows, Esc, kitty-encoded keys)', () => {
    expect(parseKeys('y\r\x7f\x03\x04\t ')).toEqual(['y', 'enter', 'backspace', 'ctrl-c', 'ctrl-d', 'tab', ' '])
    expect(parseKeys('\x1b[A\x1b[B\x1bOC\x1b[Z')).toEqual(['up', 'down', 'right', 'shift-tab'])
    expect(parseKeys('\x1b')).toEqual(['esc'])
    expect(parseKeys('\x1bx')).toEqual(['alt-x'])
    expect(parseKeys('\x1b[121u\x1b[13;2u\x1b[27u\x1b[99;5u')).toEqual(['y', 'shift-enter', 'esc', 'ctrl-c'])
    expect(parseKeys('\x1b[200~hi\x1b[201~')).toEqual(['paste-start', 'h', 'i', 'paste-end'])
    expect(parseKeys('é')).toEqual(['é'])
    expect(parseKeys('\x1b[99~')).toEqual(['seq:\\u001b[99~'])
  })
})
