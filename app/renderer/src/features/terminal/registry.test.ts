import { describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { TerminalRegistry, type ManagedView } from './registry.ts'
import { retention } from './warm.ts'

class FakeView implements ManagedView {
  readonly ptyId: string
  gl = false
  disposed = false
  isAttached = false
  readonly log: string[]
  constructor(ptyId: string, log: string[]) {
    this.ptyId = ptyId
    this.log = log
    log.push(`create ${ptyId}`)
  }
  setWebgl(on: boolean): void {
    if (this.disposed) throw new Error(`setWebgl on disposed ${this.ptyId}`)
    if (on !== this.gl) this.log.push(`${on ? 'gl+' : 'gl-'} ${this.ptyId}`)
    this.gl = on
  }
  dispose(): void {
    this.log.push(`dispose ${this.ptyId}`)
    this.gl = false
    this.disposed = true
  }
}

function setup() {
  const log: string[] = []
  const created: FakeView[] = []
  const reg = new TerminalRegistry((id) => {
    const v = new FakeView(id, log)
    created.push(v)
    return v
  })
  const contexts = () => created.filter((v) => !v.disposed && v.gl).length
  return { reg, log, created, contexts }
}

describe('terminal instance policy', () => {
  it('U-TERM-17 · visiting many tabs keeps the visible one plus the most recently viewed others warm; WebGL never above the cap', () => {
    const { reg, created, contexts } = setup()
    const tabs = ['a', 'b', 'c', 'd', 'e', 'f']
    for (const id of tabs) {
      reg.activate(id, tabs)
      expect(reg.size).toBeLessThanOrEqual(1 + L.warmTerminals)
      expect(contexts()).toBeLessThanOrEqual(L.webglContextsMax)
      expect(reg.get(id)?.gl).toBe(true)
    }
    // f visible; e, d, c warm (most recent first); a and b were evicted after `L.warmTerminals` newer views
    expect(reg.liveIds()).toEqual(['f', 'e', 'd', 'c'])
    expect(created.filter((v) => v.disposed).map((v) => v.ptyId)).toEqual(['a', 'b'])
    // switching to a warm terminal creates nothing
    reg.activate('d', tabs)
    expect(created).toHaveLength(6)
    expect(reg.liveIds()).toEqual(['d', 'f', 'e', 'c'])
    // switching to an evicted one recreates it (from a snapshot) and evicts the least recent
    reg.activate('a', tabs)
    expect(created).toHaveLength(7)
    expect(reg.liveIds()).toEqual(['a', 'd', 'f', 'e'])
    expect(created.find((v) => v.ptyId === 'c')?.disposed).toBe(true)
    // round-robin under load never leaks views or contexts
    for (let i = 0; i < 500; i++) {
      reg.activate(tabs[i % tabs.length] as string, tabs)
      expect(reg.size).toBeLessThanOrEqual(1 + L.warmTerminals)
      expect(contexts()).toBeLessThanOrEqual(L.webglContextsMax)
    }
    expect(created.filter((v) => !v.disposed)).toHaveLength(reg.size)
  })

  it('U-TERM-17 · closing a tab disposes its view at once; tabs that disappear are evicted on the next change', () => {
    const { reg, log } = setup()
    reg.activate('a', ['a', 'b'])
    reg.activate('b', ['a', 'b'])
    reg.close('a')
    expect(log.at(-1)).toBe('dispose a')
    expect(reg.liveIds()).toEqual(['b'])
    reg.activate('c', ['b', 'c'])
    reg.activate('c', ['c'])
    expect(log.at(-1)).toBe('dispose b')
    reg.activate(null, [])
    expect(reg.size).toBe(0)
    expect(reg.visible()).toBeUndefined()
  })

  it('U-TERM-35 · two hundred tabs opened, visited and closed, one at a time and in groups: no view and no id left in the most-recently-viewed order', () => {
    const { reg, created } = setup()
    const open: string[] = []
    for (let i = 0; i < 200; i++) {
      const id = `t${i}`
      open.push(id)
      reg.activate(id, open)
      // every fourth step a tab is closed (⌘W), every tenth the older half goes at once (a session switch)
      if (i % 4 === 3) {
        const gone = open.shift()!
        reg.close(gone)
      }
      if (i % 10 === 9) open.splice(0, Math.floor(open.length / 2))
    }
    for (const id of [...open]) {
      reg.close(id)
      open.splice(open.indexOf(id), 1)
      reg.activate(open.at(-1) ?? null, open)
    }
    expect({ views: reg.size, mru: reg.mruSize, alive: created.filter((v) => !v.disposed).length }).toEqual({ views: 0, mru: 0, alive: 0 })
  })

  it('U-TERM-17 · pinned tabs (the active session’s) stay alive without a WebGL context; contexts are released before others load', () => {
    const r = retention({ visible: 'v', mru: ['v', 'w1', 'p', 'w2', 'w3', 'w4'], exists: () => true, alive: () => true, pinned: ['p'], warm: L.warmTerminals, glMax: L.webglContextsMax })
    expect(r.keep).toEqual(['v', 'p', 'w1', 'w2', 'w3'])
    expect(r.webgl).toEqual(['v', 'w1', 'w2', 'w3'])
    expect(retention({ visible: 'v', mru: ['a', 'b', 'c', 'd'], exists: () => true, alive: () => true, warm: 9, glMax: L.webglContextsMax }).webgl).toHaveLength(L.webglContextsMax)
    // a warm terminal is never created ahead of time: only live views qualify
    expect(retention({ visible: 'v', mru: ['v', 'x'], exists: () => true, alive: (id) => id !== 'x', warm: L.warmTerminals, glMax: L.webglContextsMax }).keep).toEqual(['v'])
    const { reg, log } = setup()
    const tabs = ['a', 'b', 'c', 'd', 'e']
    for (const id of tabs) reg.activate(id, tabs)
    log.length = 0
    reg.activate('a', tabs) // a recreated; b evicted (its context goes with it) before a's loads
    expect(log).toEqual(['create a', 'dispose b', 'gl+ a'])
  })

  it('U-TERM-34 · sessions: the active session’s other tabs stay alive without WebGL; the warm ones are the Agent terminals of the most recently viewed other sessions (L.warmTerminals); a cold switch keeps the terminal on screen, with WebGL, until it is shown; never more contexts than the cap', () => {
    const { reg, created, contexts } = setup()
    // L.warmTerminals + 3 sessions, each an Agent tab and a shell tab: always more than stay warm
    const S = Array.from({ length: L.warmTerminals + 3 }, (_, i) => `s${i + 1}`)
    const agent = (s: string) => `${s}-agent`
    const shell = (s: string) => `${s}-shell`
    const all = new Set(S.flatMap((s) => [agent(s), shell(s)]))
    // the sessions in the order last viewed, most recent first; the warm ones are the first L.warmTerminals others
    const mru: string[] = []
    const visited = (s: string) => mru.splice(0, mru.length, s, ...mru.filter((x) => x !== s))
    const warmFor = (active: string) => mru.filter((x) => x !== active).slice(0, L.warmTerminals).map(agent)
    const opts = (s: string, tab: string) => ({ pinned: [agent(s), shell(s)].filter((t) => t !== tab), exists: (id: string) => all.has(id), warmable: (id: string) => id.endsWith('-agent'), representative: agent(s) })
    const view = (s: string, tab: string) => {
      const v = reg.activate(tab, [agent(s), shell(s)], opts(s, tab))!
      v.isAttached = true // its snapshot paints
      reg.setShown(tab)
      visited(s)
      expect(contexts(), `contexts after viewing ${tab}`).toBeLessThanOrEqual(L.webglContextsMax)
      return v
    }
    const alive = () => new Set(created.filter((v) => !v.disposed).map((v) => v.ptyId))
    const gl = () => new Set(created.filter((v) => !v.disposed && v.gl).map((v) => v.ptyId))
    for (const s of S) {
      view(s, agent(s))
      view(s, shell(s)) // each session's shell tab viewed last: the session is viewed, its Agent terminal stands for it
    }
    // the last session active: both its tabs alive, the shell on screen with WebGL, its Agent tab without; the warm ones
    const last = S.at(-1)!
    expect(alive()).toEqual(new Set([shell(last), agent(last), ...warmFor(last)]))
    expect(gl()).toEqual(new Set([shell(last), ...warmFor(last)]))
    expect(reg.size, 'tabs of the active session + the warm ones').toBe(2 + L.warmTerminals)
    // back to the oldest warm one: shown at once; the last session's Agent terminal now warm, its shell let go
    const warm = mru.filter((x) => x !== last)[L.warmTerminals - 1]!
    const before = created.length
    reg.activate(agent(warm), [agent(warm), shell(warm)], opts(warm, agent(warm)))
    expect(created.length, 'a warm switch creates nothing for the Agent tab').toBe(before)
    reg.setShown(agent(warm))
    visited(warm)
    expect(alive()).toEqual(new Set([agent(warm), ...warmFor(warm)]))
    // a cold switch (the first session, evicted long ago) from that Agent tab: it stays on screen, with WebGL, until the new one is shown
    const cold = S[0]!
    expect(warmFor(warm)).not.toContain(agent(cold))
    const v = reg.activate(agent(cold), [agent(cold), shell(cold)], opts(cold, agent(cold)))!
    expect(v.isAttached).toBe(false)
    expect(gl().has(agent(warm)), 'the terminal on screen keeps WebGL while the new one paints').toBe(true)
    expect(contexts()).toBeLessThanOrEqual(L.webglContextsMax)
    v.isAttached = true
    reg.setShown(agent(cold))
    visited(cold)
    expect(alive()).toEqual(new Set([agent(cold), ...warmFor(cold)]))
    expect(gl()).toEqual(alive())
    // leaving a shell tab for another cold session: the shell stays on screen until shown, then goes (it is not an Agent terminal)
    view(cold, shell(cold))
    const next = S[1]!
    expect(warmFor(cold)).not.toContain(agent(next))
    const w = reg.activate(agent(next), [agent(next), shell(next)], opts(next, agent(next)))!
    expect(alive().has(shell(cold)), 'the shell tab on screen is kept while the next one paints').toBe(true)
    expect(gl().has(shell(cold)), 'with its WebGL').toBe(true)
    expect(contexts()).toBeLessThanOrEqual(L.webglContextsMax)
    w.isAttached = true
    reg.setShown(agent(next))
    visited(next)
    expect(alive().has(shell(cold)), 'let go once it is shown').toBe(false)
    expect(gl()).toEqual(new Set([agent(next), ...warmFor(next)]))
  })
})
