import { describe, expect, it } from 'vitest'
import { VisibleSet, type VisibleChange } from './visible.ts'

describe('the visible set', () => {
  it('U-VIS-1 · each window shows one session; a session is visible while any window shows it, and listeners are told, before the call returns, which sessions came into and left the set', () => {
    const v = new VisibleSet()
    const seen: VisibleChange[] = []
    const off = v.onChange((c) => seen.push(c))
    const a = {}
    const b = {}
    expect({ sessions: v.sessions(), size: v.size, has: v.has('s1'), of: v.of(a) }).toEqual({ sessions: [], size: 0, has: false, of: null })

    v.set(a, 's1')
    expect(seen).toEqual([{ scope: a, sessionId: 's1', shown: ['s1'], hidden: [] }])
    expect({ sessions: v.sessions(), has: v.has('s1'), of: v.of(a) }).toEqual({ sessions: ['s1'], has: true, of: 's1' })
    // told again the same: nothing changes, nobody is told
    v.set(a, 's1')
    expect(seen).toHaveLength(1)

    // a second window on the same session: it is one visible session; the window's own change is still reported
    v.set(b, 's1')
    expect(seen.at(-1)).toEqual({ scope: b, sessionId: 's1', shown: [], hidden: [] })
    expect({ sessions: v.sessions(), size: v.size }).toEqual({ sessions: ['s1'], size: 2 })

    // the first window moves on: s2 comes in, s1 stays (the other window shows it)
    v.set(a, 's2')
    expect(seen.at(-1)).toEqual({ scope: a, sessionId: 's2', shown: ['s2'], hidden: [] })
    expect(v.sessions().sort()).toEqual(['s1', 's2'])

    // a window that shows no session (the composer); then the other window goes: nothing is visible
    v.set(a, null)
    expect(seen.at(-1)).toEqual({ scope: a, sessionId: null, shown: [], hidden: ['s2'] })
    v.drop(b)
    expect(seen.at(-1)).toEqual({ scope: b, sessionId: null, shown: [], hidden: ['s1'] })
    expect({ sessions: v.sessions(), size: v.size, has: v.has('s1') }).toEqual({ sessions: [], size: 0, has: false })
    // a window that never showed a session goes: nothing to tell
    const told = seen.length
    v.drop({})
    expect(seen).toHaveLength(told)

    off.dispose()
    v.set(a, 's3')
    expect(seen).toHaveLength(told)
  })

  it('U-VIS-1 · a listener sees the set already changed (a producer registers the session’s stores there), and one that throws does not keep the others from hearing', () => {
    const v = new VisibleSet()
    const order: string[] = []
    v.onChange(() => {
      throw new Error('boom')
    })
    v.onChange((c) => order.push(`${c.shown.join()}:${v.has('s1')}`))
    v.set({}, 's1')
    order.push('returned')
    expect(order).toEqual(['s1:true', 'returned'])
  })
})
