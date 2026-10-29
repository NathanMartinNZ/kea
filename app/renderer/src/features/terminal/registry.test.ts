import { describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { TerminalRegistry, type ManagedView, type RegistryPolicy } from './registry.ts'
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

/** The renderer's idle time, run by the test. */
function manualIdle() {
  const queue: (() => void)[] = []
  return {
    schedule: (fn: () => void) => {
      queue.push(fn)
      return () => {
        const i = queue.indexOf(fn)
        if (i >= 0) queue.splice(i, 1)
      }
    },
    run: () => {
      for (const fn of queue.splice(0)) fn()
    },
    get pending() {
      return queue.length
    },
  }
}

function setup(policy: Partial<RegistryPolicy> = {}) {
  const log: string[] = []
  const created: FakeView[] = []
  const idle = manualIdle()
  const reg = new TerminalRegistry(
    (id) => {
      const v = new FakeView(id, log)
      created.push(v)
      return v
    },
    { warm: L.warmTerminals, glMax: L.webglContextsMax, idle: idle.schedule, ...policy },
  )
  const contexts = () => created.filter((v) => !v.disposed && v.gl).length
  const alive = () => new Set(created.filter((v) => !v.disposed).map((v) => v.ptyId))
  const gl = () => new Set(created.filter((v) => !v.disposed && v.gl).map((v) => v.ptyId))
  return { reg, log, created, contexts, idle, alive, gl }
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
    const r = retention({ visible: ['v'], mru: ['v', 'w1', 'p', 'w2', 'w3', 'w4'], exists: () => true, alive: () => true, pinned: ['p'], warm: L.warmTerminals, glMax: L.webglContextsMax })
    expect(r.keep).toEqual(['v', 'p', 'w1', 'w2', 'w3'])
    expect(r.webgl).toEqual(['v', 'w1', 'w2', 'w3'])
    expect(retention({ visible: ['v'], mru: ['a', 'b', 'c', 'd'], exists: () => true, alive: () => true, warm: 9, glMax: L.webglContextsMax }).webgl).toHaveLength(L.webglContextsMax)
    // a warm terminal is never created ahead of time: only live views qualify
    expect(retention({ visible: ['v'], mru: ['v', 'x'], exists: () => true, alive: (id) => id !== 'x', warm: L.warmTerminals, glMax: L.webglContextsMax }).keep).toEqual(['v'])
    const { reg, log } = setup()
    const tabs = ['a', 'b', 'c', 'd', 'e']
    for (const id of tabs) reg.activate(id, tabs)
    log.length = 0
    reg.activate('a', tabs) // a recreated; b evicted (its context goes with it) before a's loads
    expect(log).toEqual(['create a', 'dispose b', 'gl+ a'])
  })

  it('U-TERM-34 · sessions: the active session’s other tabs stay alive without WebGL; the warm ones are the Agent terminals of the most recently viewed other sessions (L.warmTerminals); a cold switch keeps the terminal on screen, with WebGL, until it is shown; never more contexts than the cap', () => {
    const { reg, created, contexts, idle } = setup()
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
      idle.run() // a warm terminal that gave its context up for the switch gets it back
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
    idle.run()
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
    idle.run()
    visited(next)
    expect(alive().has(shell(cold)), 'let go once it is shown').toBe(false)
    expect(gl()).toEqual(new Set([agent(next), ...warmFor(next)]))
  })
})

describe('two panes on screen', () => {
  // sessions with an Agent terminal and a shell each; the warm ones are the Agent terminals of other sessions
  const agent = (s: string) => `${s}-agent`
  const shell = (s: string) => `${s}-shell`
  const tabsOf = (s: string) => [agent(s), shell(s)]
  const optsFor = (all: ReadonlySet<string>, s: string, open = tabsOf(s)) => ({ pinned: open, exists: (id: string) => all.has(id), warmable: (id: string) => id.endsWith('-agent'), representative: agent(s) })

  it('U-TERM-59 · three warm views stay alive through tab flips and switches; contexts go to the arriving, then the leaving, then the warm by recency, within the cap; a warm view gets its context back in idle time after the reveal, never inside it; no view on screen changes renderer during a switch', () => {
    const { reg, log, created, contexts, idle, alive, gl } = setup()
    const S = Array.from({ length: L.warmTerminals + 2 }, (_, i) => `s${i + 1}`)
    const all = new Set(S.flatMap(tabsOf))
    const paint = (id: string) => {
      for (const v of created) if (v.ptyId === id && !v.disposed) v.isAttached = true
    }
    const viewed: string[] = [] // sessions, most recent first
    const warmFor = (s: string) => viewed.filter((x) => x !== s).slice(0, L.warmTerminals).map(agent)
    const capped = () => expect(contexts()).toBeLessThanOrEqual(L.webglContextsMax)
    const split = (s: string) => {
      reg.activate({ work: shell(s), agent: agent(s) }, tabsOf(s), optsFor(all, s))
      capped()
      paint(shell(s))
      paint(agent(s))
      reg.setShown(agent(s), 'agent')
      reg.setShown(shell(s), 'work')
      capped()
      idle.run()
      viewed.splice(0, viewed.length, s, ...viewed.filter((x) => x !== s))
    }
    for (const s of S) split(s)
    const last = S.at(-1)!
    const warm = warmFor(last)
    expect(alive()).toEqual(new Set([...tabsOf(last), ...warm]))
    // two on screen leave the cap less two for the warm ones, the most recent first
    expect(gl()).toEqual(new Set([...tabsOf(last), ...warm.slice(0, L.webglContextsMax - 2)]))

    // a file tab in the work pane: the shell is hidden (pinned, no context); the third warm view gets one in idle time
    reg.activate({ work: null, agent: agent(last) }, tabsOf(last), optsFor(all, last))
    reg.setShown(null, 'work')
    expect(alive(), 'a tab flip keeps every view alive').toEqual(new Set([...tabsOf(last), ...warm]))
    expect(gl().has(warm[2]!), 'not inside the reveal').toBe(false)
    expect(idle.pending).toBeGreaterThan(0)
    idle.run()
    expect(gl()).toEqual(new Set([agent(last), ...warm]))
    // and back: the shell, painted already, is shown at once; the least recent warm view gives its context up first
    log.length = 0
    reg.activate({ work: shell(last), agent: agent(last) }, tabsOf(last), optsFor(all, last))
    reg.setShown(shell(last), 'work')
    expect(log).toEqual([`gl- ${warm[2]}`, `gl+ ${shell(last)}`])
    expect(alive()).toEqual(new Set([...tabsOf(last), ...warm]))

    // a cold switch (the oldest session, evicted): both new views paint while both old ones stay on screen with theirs
    const cold = S[0]!
    expect(warm).not.toContain(agent(cold))
    log.length = 0
    reg.activate({ work: shell(cold), agent: agent(cold) }, tabsOf(cold), optsFor(all, cold))
    capped()
    expect(gl(), 'the two arriving and the two leaving').toEqual(new Set([...tabsOf(cold), ...tabsOf(last)]))
    expect(alive().size - 4, 'the warm set kept, without contexts').toBe(L.warmTerminals - 1)
    // the agent paints first: the old agent is warm now and keeps its context; nothing warm loads inside the reveal
    paint(agent(cold))
    reg.setShown(agent(cold), 'agent')
    capped()
    paint(shell(cold))
    reg.setShown(shell(cold), 'work')
    capped()
    expect(log.filter((l) => l.startsWith('gl-') && (l.endsWith(shell(last)) || l.endsWith(agent(last)) || l.endsWith(shell(cold)) || l.endsWith(agent(cold)))), 'no view on screen changed renderer').toEqual([])
    const regained = warmFor(cold).filter((id) => !gl().has(id))
    expect(regained.length, 'a warm view gave its context up for the switch').toBeGreaterThan(0)
    viewed.splice(0, viewed.length, cold, ...viewed.filter((x) => x !== cold))
    expect(alive()).toEqual(new Set([...tabsOf(cold), ...warmFor(cold)]))
    expect(idle.pending, 'a warm view is owed a context').toBeGreaterThan(0)
    expect(log.some((l) => regained.some((id) => l === `gl+ ${id}`)), 'not inside the reveal').toBe(false)
    idle.run()
    expect(gl()).toEqual(new Set([...tabsOf(cold), ...warmFor(cold).slice(0, L.webglContextsMax - 2)]))

    // round-robin in either paint order: never above the cap, the warm set never shrinks, two on screen plus two warm
    for (let i = 0; i < 200; i++) {
      const s = S[(i * 3) % S.length]!
      reg.activate({ work: shell(s), agent: agent(s) }, tabsOf(s), optsFor(all, s))
      capped()
      const order: ['work' | 'agent', string][] = i % 2 === 0 ? [['work', shell(s)], ['agent', agent(s)]] : [['agent', agent(s)], ['work', shell(s)]]
      for (const [slot, id] of order) {
        paint(id)
        reg.setShown(id, slot)
        capped()
      }
      if (i % 3 === 0) idle.run()
      viewed.splice(0, viewed.length, s, ...viewed.filter((x) => x !== s))
      expect(alive()).toEqual(new Set([...tabsOf(s), ...warmFor(s)]))
    }
    idle.run()
    expect(contexts()).toBe(L.webglContextsMax)
    expect(created.filter((v) => !v.disposed)).toHaveLength(reg.size)
  })

  it('U-TERM-60 · one activation for both panes: a mode switch moves the Agent terminal’s view without disposing it; neither pane’s switch lets go of the other’s terminal; a switch never shrinks the warm set', () => {
    const { reg, created, idle, alive } = setup()
    const others = Array.from({ length: L.warmTerminals }, (_, i) => `o${i + 1}`)
    const shells = Array.from({ length: L.warmTerminals + 3 }, (_, i) => `a-sh${i}`)
    const all = new Set([...others.flatMap(tabsOf), agent('a'), ...shells])
    const open = [agent('a'), ...shells]
    const paint = (id: string) => {
      for (const v of created) if (v.ptyId === id && !v.disposed) v.isAttached = true
    }
    const show = (s: string, work: string | null, agentPane: string | null, tabs: string[]) => {
      reg.activate({ work, agent: agentPane }, tabs, optsFor(all, s, tabs))
      for (const [slot, id] of [['work', work], ['agent', agentPane]] as const) {
        if (id !== null) paint(id)
        reg.setShown(id, slot)
      }
      idle.run()
    }
    const warmAlive = () => [...alive()].filter((id) => id.endsWith('-agent') && !id.startsWith('a-')).length
    for (const s of others) show(s, shell(s), agent(s), tabsOf(s))
    show('a', shells[0]!, agent('a'), open)
    const view = reg.get(agent('a'))!
    expect(warmAlive()).toBe(L.warmTerminals)

    // the work pane flips through every shell: the agent's view stays, with its context, and so does the warm set
    for (const sh of shells) {
      show('a', sh, agent('a'), open)
      expect(reg.get(agent('a'))).toBe(view)
      expect(view.disposed).toBe(false)
      expect(view.gl).toBe(true)
      expect(warmAlive()).toBe(L.warmTerminals)
    }
    expect(new Set(reg.liveIds().slice(0, 2)), 'both panes first').toEqual(new Set([shells.at(-1)!, agent('a')]))

    // to one column: the Agent tab in the work pane is the same view, never disposed and never without its context
    const made = created.length
    reg.activate({ work: agent('a') }, open, optsFor(all, 'a', open))
    expect(reg.visible('work')).toBe(view)
    expect(reg.visible('agent')).toBeUndefined()
    expect(view.gl).toBe(true)
    reg.setShown(agent('a'), 'work')
    expect(reg.shownElsewhere(agent('a'), 'agent'), 'the agent pane’s hand-off leaves what the work pane shows alone').toBe(true)
    reg.setShown(null, 'agent')
    expect(reg.shownElsewhere(agent('a'), 'work')).toBe(false)
    expect(created.length, 'nothing made for the move').toBe(made)
    expect(view.disposed).toBe(false)
    expect(reg.isShown(agent('a'))).toBe(true)
    expect(reg.slotOf(agent('a'))).toBe('work')
    // and back to the split with a shell in the work pane: the shell was kept alive (pinned) all along
    const sh = shells[2]!
    const shellView = reg.get(sh)
    expect(shellView).toBeDefined()
    show('a', sh, agent('a'), open)
    expect(reg.get(sh)).toBe(shellView)
    expect(reg.get(agent('a'))).toBe(view)
    expect(view.gl).toBe(true)
    expect(warmAlive()).toBe(L.warmTerminals)

    // a switch to a warm session in the split and back: the warm set is as large after each
    show(others[0]!, shell(others[0]!), agent(others[0]!), tabsOf(others[0]!))
    expect([...alive()].filter((id) => id.endsWith('-agent') && id !== agent(others[0]!)).length).toBe(L.warmTerminals)
    show('a', sh, agent('a'), open)
    expect(warmAlive()).toBe(L.warmTerminals)
    expect(reg.get(agent('a')), 'a warm view, switched back to').toBe(view)
  })
})
