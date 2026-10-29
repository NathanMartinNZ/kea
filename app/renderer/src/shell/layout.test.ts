import { describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { SIZE_PX } from '@kea/ui/tokens'
import { SPACE_PX } from '@kea/ui/tokens'
import { cycleRegion, DEFAULT_LAYOUT, dragAgent, dragTo, drawn, LAYOUT_KEY, loadLayout, mainWidth, paneCols, paneWidth, parseLayout, RANGE, resetAgentWidth, resetWidth, saveLayout, setAgentBeside, setCellWidth, setTreeHidden, sidebarCompactAt, splitMode, splitNeed, splitOn, splitWidths, STEP, stepAgent, stepWidth, toggleSidebar, type KeyValue } from './layout.ts'

const WIDE = SIZE_PX['window-default-width']

function memory(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

describe('three-column layout', () => {
  it('U-LAYOUT-1 · columns open at their token widths and resize only within their ranges; double-click resets; arrows move one grid step', () => {
    expect(drawn(DEFAULT_LAYOUT, WIDE)).toEqual({ sidebar: SIZE_PX.sidebar, tree: SIZE_PX.tree, treeAuto: false })
    // drag: clamped to [min, max]
    let l = dragTo(DEFAULT_LAYOUT, 'sidebar', SIZE_PX.sidebar, 1000, WIDE)
    expect(l.sidebarWidth).toBe(SIZE_PX['sidebar-max'])
    l = dragTo(l, 'sidebar', SIZE_PX['sidebar-max'], -1000, WIDE)
    expect(l.sidebarWidth).toBe(SIZE_PX['sidebar-min'])
    l = dragTo(l, 'tree', SIZE_PX.tree, 37, WIDE)
    expect(l.treeWidth).toBe(SIZE_PX.tree + 37)
    l = dragTo(l, 'tree', SIZE_PX.tree, 10_000, 2 * WIDE)
    expect(l.treeWidth).toBe(SIZE_PX['tree-max'])
    // double-click: back to the token width
    expect(resetWidth(l, 'tree').treeWidth).toBe(SIZE_PX.tree)
    expect(resetWidth(l, 'sidebar').sidebarWidth).toBe(SIZE_PX.sidebar)
    // keyboard: one grid step each way, still clamped
    expect(stepWidth(DEFAULT_LAYOUT, 'sidebar', 1, WIDE).sidebarWidth).toBe(SIZE_PX.sidebar + STEP)
    expect(stepWidth(DEFAULT_LAYOUT, 'tree', -1, WIDE).treeWidth).toBe(SIZE_PX.tree - STEP)
    expect(stepWidth({ ...DEFAULT_LAYOUT, sidebarWidth: RANGE.sidebar.min }, 'sidebar', -1, WIDE).sidebarWidth).toBe(RANGE.sidebar.min)
    // a drag never pushes the main column below its minimum
    const tight = SIZE_PX['tree-autocollapse'] + 20
    const t = dragTo(DEFAULT_LAYOUT, 'tree', SIZE_PX.tree, 1000, tight)
    const d = drawn(t, tight)
    expect(d.sidebar + d.tree + SIZE_PX['main-min']).toBeLessThanOrEqual(tight)
  })

  it('U-LAYOUT-1 · ⌘B hides the sidebar and brings it back at its width; the file panel collapses below tree-autocollapse and returns when widened; main keeps main-min', () => {
    const l = { ...DEFAULT_LAYOUT, sidebarWidth: 300 }
    const hidden = toggleSidebar(l)
    expect(drawn(hidden, WIDE).sidebar).toBe(0)
    expect(drawn(toggleSidebar(hidden), WIDE).sidebar).toBe(300)
    // both hidden: the window is a terminal with a header
    expect(drawn(setTreeHidden(hidden, true), WIDE)).toEqual({ sidebar: 0, tree: 0, treeAuto: false })
    // narrow: the panel goes by itself, and is back when widened — the person's choice is untouched
    const narrow = SIZE_PX['tree-autocollapse'] - 1
    expect(drawn(l, narrow)).toEqual({ sidebar: 300, tree: 0, treeAuto: true })
    expect(drawn(l, WIDE)).toEqual({ sidebar: 300, tree: SIZE_PX.tree, treeAuto: false })
    expect(drawn(l, SIZE_PX['tree-autocollapse']).treeAuto).toBe(false)
    expect(l.treeHidden).toBe(false)
    // at the window's minimum width the main column still has its minimum, the sidebar giving way down to its own
    const min = SIZE_PX['window-min-width']
    const big = { ...DEFAULT_LAYOUT, sidebarWidth: SIZE_PX['sidebar-max'] }
    const dm = drawn(big, min)
    expect(min - dm.sidebar - dm.tree).toBeGreaterThanOrEqual(SIZE_PX['main-min'])
    expect(dm.sidebar).toBeGreaterThanOrEqual(SIZE_PX['sidebar-min'])
    // between: the file panel gives way first
    const mid = SIZE_PX['tree-autocollapse'] + 40
    const wide = { ...DEFAULT_LAYOUT, treeWidth: SIZE_PX['tree-max'] }
    const dw = drawn(wide, mid)
    expect(dw.sidebar).toBe(SIZE_PX.sidebar)
    expect(dw.tree).toBe(mid - SIZE_PX.sidebar - SIZE_PX['main-min'])
  })

  it('U-LAYOUT-1 · widths, hidden columns and the panel mode persist; a stored value that is missing, wrong or out of range takes its default', () => {
    const kv = memory()
    expect(loadLayout(kv)).toEqual(DEFAULT_LAYOUT)
    const l = { ...DEFAULT_LAYOUT, sidebarWidth: 300, treeWidth: 400, sidebarHidden: true, treeHidden: false, panelMode: 'changes' as const }
    saveLayout(kv, l)
    expect(JSON.parse(kv.data.get(LAYOUT_KEY)!)).toEqual(l)
    expect(loadLayout(kv)).toEqual(l)
    kv.data.set(LAYOUT_KEY, '{not json')
    expect(loadLayout(kv)).toEqual(DEFAULT_LAYOUT)
    expect(parseLayout({ sidebarWidth: 9999, treeWidth: -5, sidebarHidden: 'yes', panelMode: 'other' })).toEqual({ ...DEFAULT_LAYOUT, sidebarWidth: SIZE_PX['sidebar-max'], treeWidth: SIZE_PX['tree-min'] })
    expect(parseLayout({ sidebarWidth: Number.NaN })).toEqual(DEFAULT_LAYOUT)
    // storage that throws (private mode, full): defaults, and saving does not throw
    const broken: KeyValue = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('full')
      },
    }
    expect(loadLayout(broken)).toEqual(DEFAULT_LAYOUT)
    expect(() => saveLayout(broken, l)).not.toThrow()
  })
})

describe('focus regions', () => {
  it('U-KB-6 · F6 / ⇧F6 cycle sidebar → file panel → header → main (→ the agent pane in the split) and wrap, skipping regions that are hidden or have nothing to focus', () => {
    // one column: no agent pane
    const all = (r: string) => r !== 'agent'
    expect(cycleRegion('sidebar', 1, all)).toBe('files')
    expect(cycleRegion('main', 1, all)).toBe('sidebar')
    expect(cycleRegion('sidebar', -1, all)).toBe('main')
    expect(cycleRegion(null, 1, all)).toBe('sidebar')
    expect(cycleRegion(null, -1, all)).toBe('main')
    // the split: the work pane, then the agent pane, five stops
    const split = () => true
    expect(cycleRegion('main', 1, split)).toBe('agent')
    expect(cycleRegion('agent', 1, split)).toBe('sidebar')
    expect(cycleRegion('sidebar', -1, split)).toBe('agent')
    expect(cycleRegion('agent', -1, split)).toBe('main')
    // the file panel hidden (⌘⇧E) and no header (the composer): sidebar ⇄ main
    const noPanel = (r: string) => r === 'sidebar' || r === 'main'
    expect(cycleRegion('sidebar', 1, noPanel)).toBe('main')
    expect(cycleRegion('main', 1, noPanel)).toBe('sidebar')
    expect(cycleRegion('main', -1, noPanel)).toBe('sidebar')
    // nowhere else to go
    expect(cycleRegion('main', 1, (r) => r === 'main')).toBeNull()
    expect(cycleRegion(null, 1, () => false)).toBeNull()
  })
})

describe('the split', () => {
  // the cell widths of the saved 13 px fonts: SF Mono on macOS, JetBrains Mono on Linux at DPR 1 and 2
  const MAC = 8
  const LINUX = 7
  const LINUX_2X = 7.5
  // sidebar and file panel at their token widths
  const sides = SIZE_PX.sidebar + SIZE_PX.tree
  const on = { ...DEFAULT_LAYOUT, agentBeside: true }
  const at = (window: number, cell: number, l = on) => {
    const main = mainWidth(l, window)
    return splitOn(l, main, cell, null, false) ? splitWidths(l, main, cell) : null
  }

  it('U-LAYOUT-3 · the widths the split draws at each window, from the cell width of the saved font; one column where the main column cannot hold both minimums', () => {
    expect(splitNeed(MAC)).toEqual({ agent: paneWidth(L.agentMinCols, MAC, SIZE_PX.hairline), work: paneWidth(L.workMinCols, MAC), total: paneWidth(L.agentMinCols, MAC, SIZE_PX.hairline) + paneWidth(L.workMinCols, MAC) })
    // each pane holds its minimum in columns, and no more than that at the need
    const need = splitNeed(MAC)
    expect(paneCols(need.agent, MAC, SIZE_PX.hairline)).toBe(L.agentMinCols)
    expect(paneCols(need.work, MAC)).toBe(L.workMinCols)
    expect(paneCols(need.agent - 1, MAC, SIZE_PX.hairline)).toBe(L.agentMinCols - 1)
    // a wide window: the first share of the main column each
    const wide = at(1728, MAC)!
    expect(wide.agent + wide.work).toBe(1728 - sides)
    expect(wide.agent).toBe(Math.round((1728 - sides) * L.agentFirstShare))
    // narrower: the agent keeps its minimum and the work pane takes the rest, down to its own
    for (const [w, cell] of [[1512, MAC], [1440, MAC], [1366, LINUX], [1440, LINUX_2X]] as const) {
      const s = at(w, cell)
      const n = splitNeed(cell)
      expect(s, `split at ${w}`).not.toBeNull()
      expect(s!.agent + s!.work).toBe(w - sides)
      expect(s!.agent).toBeGreaterThanOrEqual(n.agent)
      expect(s!.work).toBeGreaterThanOrEqual(n.work)
    }
    // below the need, one column: 1366 on macOS, 1280 on both
    expect(at(1366, MAC)).toBeNull()
    expect(at(1280, MAC)).toBeNull()
    expect(at(1280, LINUX)).toBeNull()
    // the sidebar hidden at 1280: the main column holds it again
    expect(at(1280, MAC, { ...on, sidebarHidden: true })).not.toBeNull()
    // chosen off: never
    expect(at(1728, MAC, { ...DEFAULT_LAYOUT, agentBeside: false })).toBeNull()
  })

  it('U-LAYOUT-3 · hysteresis both ways and none on the first frame; no mode change while a divider is dragged', () => {
    const need = splitNeed(MAC).total
    const band = SIZE_PX['split-hysteresis']
    // the first frame: the split wherever it fits
    expect(splitOn(on, need, MAC, null, false)).toBe(true)
    expect(splitOn(on, need - 1, MAC, null, false)).toBe(false)
    // drawn: it stays down to the need
    expect(splitOn(on, need, MAC, true, false)).toBe(true)
    expect(splitOn(on, need - 1, MAC, true, false)).toBe(false)
    // one column: the split only past the band
    expect(splitOn(on, need, MAC, false, false)).toBe(false)
    expect(splitOn(on, need + band - 1, MAC, false, false)).toBe(false)
    expect(splitOn(on, need + band, MAC, false, false)).toBe(true)
    // mid-drag the mode holds, either way; the release decides
    expect(splitOn(on, need - 100, MAC, true, true)).toBe(true)
    expect(splitOn(on, need + band + 100, MAC, false, true)).toBe(false)
    expect(splitOn(on, need + band + 100, MAC, false, false)).toBe(true)
  })

  it('U-LAYOUT-5 · the person’s choice shows the split wherever the column holds the need, inside the band too; a column that changes width still has the band', () => {
    const need = splitNeed(MAC).total
    const band = SIZE_PX['split-hysteresis']
    const off = { ...on, agentBeside: false }
    // chosen off with the column inside the band, then on again: the split at once
    const wasOff = { drew: splitMode(off, need + 1, MAC, { drew: true, chose: true }, false), chose: false }
    expect(wasOff.drew).toBe(false)
    expect(splitMode(on, need + 1, MAC, wasOff, false)).toBe(true)
    // the same choice below the need: one column, and the band from then on
    expect(splitMode(on, need - 1, MAC, wasOff, false)).toBe(false)
    expect(splitMode(on, need + band - 1, MAC, { drew: false, chose: true }, false)).toBe(false)
    expect(splitMode(on, need + band, MAC, { drew: false, chose: true }, false)).toBe(true)
    // drawn, it stays down to the need; the window's first frame has no band
    expect(splitMode(on, need, MAC, { drew: true, chose: true }, false)).toBe(true)
    expect(splitMode(on, need, MAC, null, false)).toBe(true)
  })

  it('U-LAYOUT-3 · the agent divider: drag, reset and step, within both minimums; the stored width kept while a side column toggles', () => {
    const main = 1224
    const need = splitNeed(MAC)
    const first = splitWidths(on, main, MAC).agent
    // dragging left widens the agent; stored in px
    let l = dragAgent(on, first, -100, main, MAC)
    expect(l.agentWidth).toBe(first + 100)
    expect(splitWidths(l, main, MAC)).toEqual({ agent: first + 100, work: main - first - 100 })
    // clamped: the work pane keeps its minimum, the agent its own
    expect(dragAgent(on, first, -10_000, main, MAC).agentWidth).toBe(main - need.work)
    expect(dragAgent(on, first, 10_000, main, MAC).agentWidth).toBe(need.agent)
    // arrows: one grid step, ← wider
    expect(stepAgent(l, -1, main, MAC).agentWidth).toBe(first + 100 + STEP)
    expect(stepAgent(l, 1, main, MAC).agentWidth).toBe(first + 100 - STEP)
    // a side column shown or hidden changes the work pane only
    const wider = main + SIZE_PX.sidebar
    expect(splitWidths(l, wider, MAC).agent).toBe(first + 100)
    // the agent gives way only once the work pane is at its minimum, and its width is kept for later
    const tight = need.total + 10
    expect(splitWidths(l, tight, MAC)).toEqual({ agent: tight - need.work, work: need.work })
    expect(l.agentWidth).toBe(first + 100)
    // double-click forgets it: the first share again
    expect(resetAgentWidth(l).agentWidth).toBeNull()
    expect(splitWidths(resetAgentWidth(l), main, MAC).agent).toBe(first)
  })

  it('U-LAYOUT-3 · the side dividers stop at the split’s need while it is drawn; the need follows the saved font, not the zoom', () => {
    const w = 1440
    const d = drawn(on, w)
    const need = splitNeed(MAC).total
    // widening the file panel as far as it goes leaves the main column at the need
    const l = dragTo(on, 'tree', d.tree, 10_000, w, need)
    expect(mainWidth(l, w)).toBe(need)
    // in one column it stops at main-min, as before
    const one = dragTo(on, 'tree', d.tree, 10_000, w)
    expect(mainWidth(one, w)).toBeGreaterThanOrEqual(SIZE_PX['main-min'])
    expect(mainWidth(one, w)).toBeLessThan(need)
    // a larger font needs more
    expect(splitNeed(MAC * 1.25).total).toBeGreaterThan(need)
  })

  it('U-LAYOUT-3 · a layout stored before the split reads with its defaults; the new fields persist', () => {
    const old = parseLayout({ sidebarWidth: 300, treeWidth: 250, sidebarHidden: false, treeHidden: true, panelMode: 'changes' })
    expect(old).toMatchObject({ sidebarWidth: 300, agentBeside: DEFAULT_LAYOUT.agentBeside, agentWidth: null, cellWidth: null })
    const store = memory()
    const l = setCellWidth(dragAgent(setAgentBeside(DEFAULT_LAYOUT, true), 600, -40, 1224, MAC), MAC)
    saveLayout(store, l)
    expect(loadLayout(store)).toEqual(l)
    // wrong values take their defaults
    expect(parseLayout({ agentBeside: 'yes', agentWidth: -5, cellWidth: 'x' })).toMatchObject({ agentBeside: DEFAULT_LAYOUT.agentBeside, agentWidth: null, cellWidth: null })
  })

  it('U-LAYOUT-6 · the sidebar\'s minimum is the header\'s parts; a drag, a step and a stored width reach it and no lower; wider stored widths stay', () => {
    // the traffic lights less the cluster's own inset, the header's gap, the New Session button with its insets, the border
    const lights = SIZE_PX['traffic-lights'] - SPACE_PX[1]
    const plus = SPACE_PX[1] + SIZE_PX.row + SPACE_PX[1]
    expect(SIZE_PX['sidebar-min']).toBe(lights + SPACE_PX[0] + plus + SIZE_PX.hairline)
    expect(RANGE.sidebar.min).toBe(SIZE_PX['sidebar-min'])
    // the other rules that used the sidebar's minimum keep their own tokens
    expect(SIZE_PX['menu-min']).toBeGreaterThan(SIZE_PX['sidebar-min'])
    expect(SIZE_PX['settings-label']).toBeGreaterThan(SIZE_PX['sidebar-min'])
    const min = RANGE.sidebar.min
    expect(dragTo(DEFAULT_LAYOUT, 'sidebar', SIZE_PX.sidebar, -1000, WIDE).sidebarWidth).toBe(min)
    expect(dragTo(DEFAULT_LAYOUT, 'sidebar', SIZE_PX.sidebar, min - SIZE_PX.sidebar + 3, WIDE).sidebarWidth).toBe(min + 3)
    expect(stepWidth({ ...DEFAULT_LAYOUT, sidebarWidth: min + 1 }, 'sidebar', -1, WIDE).sidebarWidth).toBe(min)
    expect(stepWidth({ ...DEFAULT_LAYOUT, sidebarWidth: min }, 'sidebar', -1, WIDE).sidebarWidth).toBe(min)
    expect(drawn({ ...DEFAULT_LAYOUT, sidebarWidth: min }, WIDE).sidebar).toBe(min)
    // stored widths: below the minimum clamps to it; anything in the range stays as it is
    expect(parseLayout({ sidebarWidth: min - 40 }).sidebarWidth).toBe(min)
    for (const w of [min, 160, 200, SIZE_PX.sidebar, SIZE_PX['sidebar-max']]) expect(parseLayout({ sidebarWidth: w }).sidebarWidth).toBe(w)
    // at the window's minimum width the sidebar still gives way to the main column, down to its own minimum
    const dm = drawn({ ...DEFAULT_LAYOUT, sidebarWidth: SIZE_PX['sidebar-max'] }, SIZE_PX['window-min-width'])
    expect(SIZE_PX['window-min-width'] - dm.sidebar - dm.tree).toBeGreaterThanOrEqual(SIZE_PX['main-min'])
  })

  it('U-LAYOUT-7 · a sidebar drawn narrower than sidebar-compact is compact; at the token and wider, or hidden, it is not', () => {
    expect(sidebarCompactAt(RANGE.sidebar.min)).toBe(true)
    expect(sidebarCompactAt(SIZE_PX['sidebar-compact'] - 1)).toBe(true)
    expect(sidebarCompactAt(SIZE_PX['sidebar-compact'])).toBe(false)
    expect(sidebarCompactAt(SIZE_PX.sidebar)).toBe(false)
    expect(sidebarCompactAt(0)).toBe(false)
    expect(SIZE_PX['sidebar-compact']).toBeGreaterThan(RANGE.sidebar.min)
    expect(SIZE_PX['sidebar-compact']).toBeLessThan(SIZE_PX.sidebar)
  })
})
