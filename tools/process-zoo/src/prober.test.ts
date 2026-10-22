import { afterAll, describe, expect, it } from 'vitest'
import { tokenize } from '../../fake-agent/src/probes.ts'
import { QUERY_TABLE } from '../../../packages/terminal/src/queries.ts'
import { UsageError } from './cli.ts'
import { type DoneRecord, ProbeSession, type ProbeRecord, selectQueries, SENTINEL, type StrayRecord } from './prober.ts'
import { killAll, zoo } from './test-support.ts'

afterAll(killAll)

const item = (id: string) => selectQueries([id], [])[0] as ReturnType<typeof selectQueries>[number]
const DA1 = '\x1b[?1;2c'

describe('process zoo: prober', () => {
  it('U-ZOO-5 · each query gets a window closed by the DA1 sentinel; replies are judged against the query table; late input is a stray', () => {
    // every QUERY_TABLE entry by default; ids are case-insensitive; --send sequences unescape
    expect(selectQueries([], []).map((q) => q.id)).toEqual(QUERY_TABLE.map((e) => e.id))
    expect(selectQueries(['osc11'], ['\\e[5n'])).toMatchObject([{ id: 'OSC11', query: '\x1b]11;?\x1b\\', answeredBy: 'kea' }, { id: 'send-1', query: '\x1b[5n', answeredBy: null, reply: null }])
    expect(() => selectQueries(['NOPE'], [])).toThrow(UsageError)

    let now = 0
    const s = new ProbeSession({ sentinel: true, t0: 0 })
    const ask = (id: string, ...chunks: string[]): ProbeRecord => {
      const bytes = s.begin(item(id), now)
      expect(bytes.endsWith(SENTINEL)).toBe(true)
      for (const c of chunks) s.feed(c, (now += 2))
      return s.finish(!s.windowDone)
    }
    // a reply split across chunks, then the sentinel
    expect(ask('DECRQM_DEC', '\x1b[?20', '26;2$y', DA1)).toMatchObject({ id: 'DECRQM_DEC', replies: [{ seq: '\x1b[?2026;2$y', ms: 4 }], sentinelMs: 6, timedOut: false, ok: true })
    // DA1 itself: the first DA1 reply answers it, the second is the sentinel; a third, in the same chunk, is a stray
    expect(ask('DA1', DA1, DA1 + DA1)).toMatchObject({ replies: [{ seq: DA1 }], ok: true })
    expect(s.strays.splice(0)).toEqual([{ t: 'stray', seq: DA1, ms: now, after: 'DA1' }])
    // a deliberately silent entry: ok only when nothing but the sentinel came
    expect(ask('XTGETTCAP', DA1)).toMatchObject({ replies: [], ok: true })
    expect(ask('XTGETTCAP', '\x1bP1+r544e\x1b\\', DA1)).toMatchObject({ ok: false })
    // answered twice, or with the wrong content
    expect(ask('KITTY_KBD', '\x1b[?0u\x1b[?0u', DA1)).toMatchObject({ replies: [{ seq: '\x1b[?0u' }, { seq: '\x1b[?0u' }], ok: false })
    expect(ask('DA2', '\x1b[>1;10;0c', DA1)).toMatchObject({ ok: false })
    // no sentinel reply before the timeout
    expect(ask('OSC11', '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\')).toMatchObject({ replies: [{ seq: '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\' }], timedOut: true, ok: false, sentinelMs: null })
    // input after a window closed: a stray, with the query it followed
    s.feed('\x1b[?0u', (now += 1))
    s.feed('x\x1b[', (now += 1))
    s.flush(now)
    expect(s.strays).toEqual([
      { t: 'stray', seq: '\x1b[?0u', ms: now - 1, after: 'OSC11' },
      { t: 'stray', seq: 'x', ms: now, after: 'OSC11' },
      { t: 'stray', seq: '\x1b[', ms: now, after: 'OSC11' },
    ])

    // without a sentinel the window lasts the whole timeout and collects whatever came
    const n = new ProbeSession({ sentinel: false, t0: 0 })
    expect(n.begin(item('DA1'), 0)).toBe('\x1b[c')
    n.feed(DA1, 1)
    expect(n.windowDone).toBe(false)
    expect(n.finish(true)).toMatchObject({ replies: [{ seq: DA1 }], timedOut: false, ok: true })
  })

  it('U-ZOO-6 · prober on pipes, with the test playing the terminal: one JSON line per query, strays, and a summary', async () => {
    const replies: Record<string, string> = {
      '\x1b[c': DA1,
      '\x1b[?2026$p': '\x1b[?2026;2$y',
      '\x1b[?u': '\x1b[?0u',
      '\x1b]11;?\x1b\\': '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\',
      '\x1b[5n': '\x1b[0n',
    }
    const p = zoo('prober', ['--query', 'DA1', '--query', 'DECRQM_DEC', '--query', 'KITTY_KBD', '--query', 'OSC11', '--query', 'XTGETTCAP', '--send', '\\e[5n', '--timeout-ms', '5000', '--settle-ms', '100'])
    // the terminal: answer each query as it arrives; after the last sentinel, one late duplicate
    let pending = ''
    let sentinels = 0
    p.child.stdout.on('data', (d: string) => {
      const { tokens, rest } = tokenize(pending + d)
      pending = rest
      for (const t of tokens) {
        const r = replies[t.seq]
        if (r === undefined) continue
        p.child.stdin.write(r)
        if (t.seq === '\x1b[c' && ++sentinels === 7) p.child.stdin.write('\x1b[?0u') // DA1's own query + 6 sentinels
      }
    })
    expect(await p.exited).toEqual({ code: 0, signal: null })
    const lines = p
      .out()
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as ProbeRecord | StrayRecord | DoneRecord)
    const byId = Object.fromEntries(lines.filter((l): l is ProbeRecord => l.t === 'reply').map((r) => [r.id, r]))
    expect(Object.keys(byId)).toEqual(['DA1', 'DECRQM_DEC', 'KITTY_KBD', 'OSC11', 'XTGETTCAP', 'send-1'])
    expect(byId.DA1).toMatchObject({ replies: [{ seq: DA1, ms: expect.any(Number) }], ok: true, timedOut: false })
    expect(byId.OSC11).toMatchObject({ answeredBy: 'kea', replies: [{ seq: '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\' }], ok: true })
    expect(byId.XTGETTCAP).toMatchObject({ answeredBy: 'nobody', replies: [], ok: true })
    expect(byId['send-1']).toMatchObject({ replies: [{ seq: '\x1b[0n' }], ok: null })
    expect(lines.filter((l) => l.t === 'stray')).toMatchObject([{ seq: '\x1b[?0u', after: 'send-1' }])
    expect(lines.at(-1)).toMatchObject({ t: 'done', queries: 6, ok: 5, notOk: [], strays: 1 })
  })
})
