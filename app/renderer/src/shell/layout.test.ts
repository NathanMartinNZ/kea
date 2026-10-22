import { describe, expect, it } from 'vitest'
import { SIZE_PX } from '@kea/ui/tokens'
import { cycleRegion, DEFAULT_LAYOUT, dragTo, drawn, LAYOUT_KEY, loadLayout, parseLayout, RANGE, resetWidth, saveLayout, setTreeHidden, STEP, stepWidth, toggleSidebar, type KeyValue } from './layout.ts'

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
    const l = { sidebarWidth: 300, treeWidth: 400, sidebarHidden: true, treeHidden: false, panelMode: 'changes' as const }
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
  it('U-KB-6 · F6 / ⇧F6 cycle sidebar → file panel → header → main and wrap, skipping regions that are hidden or have nothing to focus', () => {
    const all = () => true
    expect(cycleRegion('sidebar', 1, all)).toBe('files')
    expect(cycleRegion('main', 1, all)).toBe('sidebar')
    expect(cycleRegion('sidebar', -1, all)).toBe('main')
    expect(cycleRegion(null, 1, all)).toBe('sidebar')
    expect(cycleRegion(null, -1, all)).toBe('main')
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
