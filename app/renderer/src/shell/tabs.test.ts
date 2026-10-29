import { describe, expect, it } from 'vitest'
import { L, type PtyKind } from '@kea/protocol'
import { EMPTY_VIEW, type TabViewState } from '../features/viewer/tab.ts'
import { afterClose, afterGone, closeFileTab, fileTabId, fileTabTitle, homeTab, isFileTabId, NO_FILE_TABS, openFileTab, parseTabMemory, pickActive, pickActiveTab, pinFileTab, rememberTab, sameTabMemory, savedTabs, saveFileTabView, startTab, stripOrder, tabToColumn, tabToSplit, viewFileTab, workTabs, type FileTabs } from './tabs.ts'

/** Open paths one after another (as file views unless said), keeping the tabs. */
function opened(paths: readonly string[], o: { pin?: boolean; from?: FileTabs } = {}): FileTabs {
  let s = o.from ?? NO_FILE_TABS
  for (const path of paths) s = openFileTab(s, { path, mode: 'file', ...(o.pin ? { pin: true } : {}) }).tabs
  return s
}
const shape = (s: FileTabs) => s.tabs.map((t) => `${t.path}${t.mode === 'diff' ? ' Δ' : ''}${t.pinned ? '' : ' (preview)'}`)

describe('active tab', () => {
  it('U-TERM-26 · a new shell becomes active when the list shows it, whether the list or the reply comes first', () => {
    // reply first: the list does not have it yet, the current tab stays
    let s = pickActive(['a', 'b'], { active: 'b', wanted: 'c' })
    expect(s).toEqual({ active: 'b', wanted: 'c' })
    s = pickActive(['a', 'b', 'c'], s)
    expect(s).toEqual({ active: 'c', wanted: null })
    // list first: the reply finds it at once
    expect(pickActive(['a', 'b', 'c'], { active: 'b', wanted: 'c' })).toEqual({ active: 'c', wanted: null })
    // later list changes leave the choice alone
    expect(pickActive(['a', 'b', 'c', 'd'], { active: 'b', wanted: null })).toEqual({ active: 'b', wanted: null })
  })

  it('U-TERM-26 · a closed active tab falls back to the last tab; no tabs, no active', () => {
    expect(pickActive(['a', 'b'], { active: 'x', wanted: null })).toEqual({ active: 'b', wanted: null })
    expect(pickActive([], { active: 'x', wanted: null })).toEqual({ active: null, wanted: null })
    expect(pickActive(['a'], { active: null, wanted: null })).toEqual({ active: 'a', wanted: null })
  })

  it('U-TERM-50 · a session the window has not shown before starts on the tab it remembers when that tab still exists, else on its Agent terminal, never on whichever tab is last; what it remembers names a Server or Setup tab by its kind and a shell by its PTY, and nothing for the Agent terminal or a file tab', () => {
    const kinds: Record<string, PtyKind> = { agent1: 'agent', setup1: 'script', server1: 'server', server2: 'server', shell1: 'shell', shell2: 'shell' }
    const kindOf = (id: string) => kinds[id]
    const terminals = ['agent1', 'server1', 'shell1', 'shell2']
    const nothingYet = { active: null, wanted: null }

    // the window was closed and reopened (or reloaded, or Kea relaunched): it remembers no tab of the session. With
    // nothing remembered the session shows its Agent terminal, not its Server tab or its last shell
    expect(pickActiveTab(terminals, [], nothingYet, 'agent1')).toEqual({ active: 'agent1', wanted: null })
    expect(pickActiveTab(['agent1', 'server1'], [], nothingYet, 'agent1')).toEqual({ active: 'agent1', wanted: null })
    // the tab it remembers, while it exists: a shell by its PTY, the Server and Setup tabs by their kind (a re-run
    // replaces the Server tab's PTY)
    expect(startTab(terminals, kindOf, { kind: 'shell', ptyId: 'shell1' }, 'agent1')).toBe('shell1')
    expect(startTab(terminals, kindOf, { kind: 'server' }, 'agent1')).toBe('server1')
    expect(startTab(['agent1', 'server2', 'shell1'], kindOf, { kind: 'server' }, 'agent1')).toBe('server2')
    expect(startTab(['agent1', 'setup1'], kindOf, { kind: 'script' }, 'agent1')).toBe('setup1')
    expect(pickActiveTab(terminals, [], nothingYet, 'agent1', startTab(terminals, kindOf, { kind: 'shell', ptyId: 'shell1' }, 'agent1'))).toEqual({ active: 'shell1', wanted: null })
    // a remembered tab that is gone (the shell was closed, the server never ran again): the Agent terminal
    expect(startTab(['agent1', 'shell2'], kindOf, { kind: 'shell', ptyId: 'shell1' }, 'agent1')).toBe('agent1')
    expect(startTab(['agent1', 'shell2'], kindOf, { kind: 'server' }, 'agent1')).toBe('agent1')
    expect(startTab(terminals, kindOf, null, 'agent1')).toBe('agent1')
    expect(startTab([], kindOf, { kind: 'server' }, null)).toBeNull()
    // a PTY of another kind under a remembered shell's id is not that shell
    expect(startTab(terminals, kindOf, { kind: 'shell', ptyId: 'server1' }, 'agent1')).toBe('agent1')

    // a tab that goes while it is shown still hands over to the last terminal (U-TERM-26), and a shell just opened
    // still wins over where the pane starts
    expect(pickActiveTab(['agent1', 'server1'], [], { active: 'shell1', wanted: null }, 'agent1')).toEqual({ active: 'server1', wanted: null })
    expect(pickActiveTab(terminals, [], { active: null, wanted: 'shell2' }, 'agent1')).toEqual({ active: 'shell2', wanted: null })
    // no start named (the plain shells have no Agent terminal and remember nothing): the last tab, as before
    expect(pickActiveTab(['shell1', 'shell2'], [], nothingYet, 'shell1', null)).toEqual({ active: 'shell2', wanted: null })

    // what a session remembers of the tab on screen
    expect(rememberTab('server1', kindOf)).toEqual({ kind: 'server' })
    expect(rememberTab('setup1', kindOf)).toEqual({ kind: 'script' })
    expect(rememberTab('shell2', kindOf)).toEqual({ kind: 'shell', ptyId: 'shell2' })
    // the Agent terminal is where a session starts anyway, and a file tab is the window's: nothing kept
    expect(rememberTab('agent1', kindOf)).toBeNull()
    expect(rememberTab(fileTabId('src/a.ts'), kindOf)).toBeNull()
    expect(rememberTab(null, kindOf)).toBeNull()
    expect(rememberTab('gone', kindOf)).toBeNull()
    expect(sameTabMemory({ kind: 'shell', ptyId: 'shell1' }, { kind: 'shell', ptyId: 'shell1' })).toBe(true)
    expect(sameTabMemory({ kind: 'shell', ptyId: 'shell1' }, { kind: 'shell', ptyId: 'shell2' })).toBe(false)
    expect(sameTabMemory({ kind: 'server' }, { kind: 'server' })).toBe(true)
    expect(sameTabMemory({ kind: 'server' }, { kind: 'script' })).toBe(false)
    expect(sameTabMemory({ kind: 'server' }, null)).toBe(false)
    expect(sameTabMemory(null, null)).toBe(true)

    // as saved (`sessions.setUi`, the `tabs` key) and read back: anything else reads as nothing remembered
    for (const m of [{ kind: 'server' }, { kind: 'script' }, { kind: 'shell', ptyId: 'shell1' }] as const) expect(parseTabMemory(savedTabs(m))).toEqual(m)
    expect(savedTabs(null)).toBeNull()
    for (const junk of [undefined, null, 'agent', 7, [], {}, { active: null }, { active: 'server' }, { active: { kind: 'agent' } }, { active: { kind: 'shell' } }, { active: { kind: 'shell', ptyId: 7 } }, { active: { kind: 'file', ptyId: 'x' } }])
      expect(parseTabMemory(junk), JSON.stringify(junk)).toBeNull()
    // a saved copy carries only what is remembered
    expect(parseTabMemory({ active: { kind: 'server', ptyId: 'x', extra: 1 } })).toEqual({ kind: 'server' })
  })
})

describe('file and diff tabs', () => {
  it('U-FV-11 · a click opens the preview tab and the next click reuses it in place; a path has one tab; pinning keeps a tab', () => {
    expect(isFileTabId(fileTabId('src/a.ts'))).toBe(true)
    expect(isFileTabId('k3j2h1g0f9'), 'a ptyId is never a file tab').toBe(false)
    expect(isFileTabId(null)).toBe(false)
    expect(fileTabTitle('src/auth/login.ts')).toBe('login.ts')
    expect(fileTabTitle('README.md')).toBe('README.md')

    // one preview tab, replaced by the next open
    let s = opened(['a.ts'])
    expect(shape(s)).toEqual(['a.ts (preview)'])
    const b = openFileTab(s, { path: 'src/b.ts', mode: 'file' })
    expect(b.id).toBe(fileTabId('src/b.ts'))
    expect(shape(b.tabs)).toEqual(['src/b.ts (preview)'])
    // pinned (double-click, ↵): it stays, and the next open gets a new preview tab after it
    s = pinFileTab(b.tabs, b.id)
    expect(pinFileTab(s, b.id), 'pinning a pinned tab changes nothing').toBe(s)
    s = opened(['c.ts'], { from: s })
    expect(shape(s)).toEqual(['src/b.ts', 'c.ts (preview)'])
    // the preview is replaced where it stands, between pinned tabs
    s = opened(['d.ts'], { from: s, pin: true })
    s = opened(['e.ts'], { from: s })
    expect(shape(s)).toEqual(['src/b.ts', 'e.ts (preview)', 'd.ts'])
    // a path that has a tab shows that tab: no second tab; a pinned one stays pinned, the preview stays the preview
    const again = openFileTab(s, { path: 'src/b.ts', mode: 'file' })
    expect(again.id).toBe(b.id)
    expect(shape(again.tabs)).toEqual(shape(s))
    expect(shape(openFileTab(s, { path: 'e.ts', mode: 'file' }).tabs)).toEqual(shape(s))
    // an open that asks for a pinned tab pins the path's tab
    expect(shape(openFileTab(s, { path: 'e.ts', mode: 'file', pin: true }).tabs)).toEqual(['src/b.ts', 'e.ts', 'd.ts'])
    // closing takes the tab out; an unknown id changes nothing
    expect(shape(closeFileTab(s, b.id))).toEqual(['e.ts (preview)', 'd.ts'])
    expect(closeFileTab(s, fileTabId('nope'))).toBe(s)
    expect(pinFileTab(s, fileTabId('nope'))).toBe(s)
  })

  it('U-FV-11 · at most L.viewerPinnedTabsMax pinned tabs: pinning one more closes the least recently viewed pinned tab, never the preview or the one just pinned', () => {
    const max = L.viewerPinnedTabsMax
    const paths = Array.from({ length: max }, (_, i) => `f${i}.ts`)
    let s = opened(paths, { pin: true })
    s = opened(['preview.ts'], { from: s })
    expect(s.tabs).toHaveLength(max + 1)
    // f0 is looked at again: f1 is now the least recently viewed
    s = viewFileTab(s, fileTabId('f0.ts'))
    const ninth = openFileTab(s, { path: 'ninth.ts', mode: 'file', pin: true })
    expect(ninth.tabs.tabs.filter((t) => t.pinned)).toHaveLength(max)
    expect(shape(ninth.tabs)).not.toContain('f1.ts')
    expect(shape(ninth.tabs)).toEqual(expect.arrayContaining(['f0.ts', 'ninth.ts', 'preview.ts (preview)']))
    // the same when the preview is pinned instead
    const pinned = pinFileTab(s, fileTabId('preview.ts'))
    expect(pinned.tabs.filter((t) => t.pinned)).toHaveLength(max)
    expect(shape(pinned)).not.toContain('f1.ts')
    expect(shape(pinned)).toContain('preview.ts')
    // a smaller cap closes as many as it takes, oldest first
    expect(shape(openFileTab(opened(['a', 'b', 'c'], { pin: true }), { path: 'd', mode: 'file', pin: true }, 2).tabs)).toEqual(['c', 'd'])
  })

  it('U-FV-11 · a tab keeps its view while hidden (scroll, selection, at most L.viewerTabFoldsMax folds); a line to land on lasts until the view is saved; the other mode starts the view afresh in the same tab', () => {
    const view: TabViewState = { scroll: { line: 120, offset: 6, left: 0 }, selection: { anchor: { line: 121, col: 3 }, head: { line: 124, col: 1 } }, folds: [{ from: 10, to: 40 }] }
    const o = openFileTab(NO_FILE_TABS, { path: 'src/a.ts', mode: 'file', line: 42, col: 7 })
    expect(o.tabs.tabs[0]).toMatchObject({ path: 'src/a.ts', mode: 'file', pinned: false, view: EMPTY_VIEW, goto: { line: 42, col: 7 } })
    expect(openFileTab(NO_FILE_TABS, { path: 'x', mode: 'file', line: 5 }).tabs.tabs[0]?.goto, 'no column: the line’s start').toEqual({ line: 5, col: 1 })
    // the viewer went there and saved: the position is used up, the view is kept
    let s = saveFileTabView(o.tabs, o.id, view)
    expect(s.tabs[0]).toMatchObject({ view, goto: null })
    expect(saveFileTabView(s, fileTabId('nope'), view)).toBe(s)
    // the same path opened again later: the view it kept is still there
    s = openFileTab(s, { path: 'src/a.ts', mode: 'file' }).tabs
    expect(s.tabs[0]).toMatchObject({ view, goto: null })
    // opened again at a line: that wins over the kept scroll until the next save
    s = openFileTab(s, { path: 'src/a.ts', mode: 'file', line: 9 }).tabs
    expect(s.tabs[0]).toMatchObject({ view, goto: { line: 9, col: 1 } })
    // File · Diff: the same tab in the other mode, its view afresh, landing on the line kept
    const flipped = openFileTab(s, { path: 'src/a.ts', mode: 'diff', line: 121 })
    expect(flipped.id).toBe(o.id)
    expect(flipped.tabs.tabs).toHaveLength(1)
    expect(flipped.tabs.tabs[0]).toMatchObject({ mode: 'diff', view: EMPTY_VIEW, goto: { line: 121, col: 1 } })
    expect(openFileTab(s, { path: 'src/a.ts', mode: 'diff' }).tabs.tabs[0]?.goto, 'a flip with no line lands nowhere in particular').toBeNull()
    // the folds are capped: the newest are kept
    const many = Array.from({ length: L.viewerTabFoldsMax + 5 }, (_, i) => ({ from: i * 10, to: i * 10 + 5 }))
    const capped = saveFileTabView(s, o.id, { ...view, folds: many }).tabs[0]?.view.folds
    expect(capped).toHaveLength(L.viewerTabFoldsMax)
    expect(capped?.at(-1)).toEqual(many.at(-1))
  })
})

describe('the strip with every kind of tab', () => {
  const kinds: Record<string, 'agent' | 'server' | 'shell'> = { agent1: 'agent', server1: 'server', shell1: 'shell', shell2: 'shell' }
  const kindOf = (id: string) => kinds[id]

  it('U-TERM-36 · the strip is the terminals then the file tabs; an active file tab stays while it exists and hands over to the Agent terminal when it closes; a closed terminal never falls back to a file tab', () => {
    const terminals = ['agent1', 'server1', 'shell1']
    const files = opened(['a.ts', 'b.ts'], { pin: true })
    const ids = files.tabs.map((t) => t.id)
    expect(stripOrder(terminals, files)).toEqual(['agent1', 'server1', 'shell1', fileTabId('a.ts'), fileTabId('b.ts')])
    expect(stripOrder(terminals, NO_FILE_TABS)).toEqual(terminals)
    expect(homeTab(terminals, kindOf)).toBe('agent1')
    expect(homeTab(['shell1', 'shell2'], kindOf), 'no Agent terminal: the first tab').toBe('shell1')
    expect(homeTab([], kindOf)).toBeNull()

    const on = { active: ids[0]!, wanted: null }
    // terminals come and go under an active file tab: it stays
    expect(pickActiveTab(terminals, ids, on, 'agent1')).toBe(on)
    expect(pickActiveTab(['agent1'], ids, on, 'agent1')).toBe(on)
    // it closes (Esc, ⌘W, the pin cap): back to the Agent terminal, not to its neighbour or the last tab
    expect(pickActiveTab(terminals, [ids[1]!], on, 'agent1')).toEqual({ active: 'agent1', wanted: null })
    expect(pickActiveTab([], [], on, null)).toEqual({ active: null, wanted: null })
    // a terminal tab is active: the terminals' rule (U-TERM-26), and a closed shell falls back to the last terminal
    expect(pickActiveTab(terminals, ids, { active: 'server1', wanted: null }, 'agent1')).toEqual({ active: 'server1', wanted: null })
    expect(pickActiveTab(['agent1', 'server1'], ids, { active: 'shell1', wanted: null }, 'agent1')).toEqual({ active: 'server1', wanted: null })
    expect(pickActiveTab(['agent1', 'server1'], ids, { active: 'shell1', wanted: null }, 'agent1')).toEqual(pickActive(['agent1', 'server1'], { active: 'shell1', wanted: null }))
    // a pane that has shown no tab yet starts on the Agent terminal, not on the last one (U-TERM-50)
    expect(pickActiveTab(terminals, [], { active: null, wanted: null }, 'agent1')).toEqual({ active: 'agent1', wanted: null })
  })

  it('U-TERM-36 · a shell opened from a file tab takes the active tab once it is listed, whether the list or the reply comes first', () => {
    const ids = opened(['a.ts']).tabs.map((t) => t.id)
    // reply first: the file tab stays until the list shows the shell
    let s = pickActiveTab(['agent1'], ids, { active: ids[0]!, wanted: 'shell1' }, 'agent1')
    expect(s).toEqual({ active: ids[0], wanted: 'shell1' })
    s = pickActiveTab(['agent1', 'shell1'], ids, s, 'agent1')
    expect(s).toEqual({ active: 'shell1', wanted: null })
    // list first: the reply finds it at once
    expect(pickActiveTab(['agent1', 'shell1'], ids, { active: ids[0]!, wanted: 'shell1' }, 'agent1')).toEqual({ active: 'shell1', wanted: null })
    // the file tab closes while the shell is still awaited: the Agent terminal meanwhile, then the shell
    s = pickActiveTab(['agent1'], [], { active: ids[0]!, wanted: 'shell1' }, 'agent1')
    expect(s).toEqual({ active: 'agent1', wanted: 'shell1' })
    expect(pickActiveTab(['agent1', 'shell1'], [], s, 'agent1')).toEqual({ active: 'shell1', wanted: null })
  })
})

describe('the work pane of the split', () => {
  const kinds: Record<string, PtyKind> = { agent1: 'agent', setup1: 'script', server1: 'server', shell1: 'shell', shell2: 'shell' }
  const kindOf = (id: string) => kinds[id]
  const terminals = ['agent1', 'setup1', 'server1', 'shell1', 'shell2']

  it('U-TERM-61 · its shown terminal leaves: the nearest tab before it that is still there, else the nearest after; none when nothing is left or it was not in the strip', () => {
    const before = ['server1', 'shell1', 'shell2', 'shell3', fileTabId('a.ts'), fileTabId('b.ts')]
    const without = (...gone: string[]) => before.filter((x) => !gone.includes(x))
    // a shell between others: the one before it, not the last
    expect(afterGone(before, 'shell1', without('shell1'))).toBe('server1')
    expect(afterGone(before, 'shell2', without('shell2'))).toBe('shell1')
    // the one before went too: the nearest before it still there
    expect(afterGone(before, 'shell2', without('shell1', 'shell2'))).toBe('server1')
    // the first: the one after it, a file tab when no terminal is left
    expect(afterGone(['shell1', 'shell2'], 'shell1', ['shell2'])).toBe('shell2')
    expect(afterGone(['shell1', fileTabId('a.ts'), fileTabId('b.ts')], 'shell1', [fileTabId('a.ts'), fileTabId('b.ts')])).toBe(fileTabId('a.ts'))
    // nothing left: the empty state; a tab the strip did not have: no answer
    expect(afterGone(['shell1'], 'shell1', [])).toBeNull()
    expect(afterGone(before, 'elsewhere', before)).toBeNull()
  })

  it('U-TERM-58 · the work pane has no Agent tab: Setup, Server and the shells in order, then the file tabs; a closing file tab hands over to the tab before it, else the one after, else none', () => {
    const work = workTabs(terminals, kindOf)
    expect(work).toEqual(['setup1', 'server1', 'shell1', 'shell2'])
    expect(workTabs(['agent1'], kindOf), 'a new session: no tab, only +').toEqual([])
    const files = opened(['a.ts', 'b.ts', 'c.ts'], { pin: true })
    const [a, b, c] = files.tabs.map((t) => t.id) as [string, string, string]
    const strip = stripOrder(work, files)
    expect(strip).toEqual([...work, a, b, c])
    // the tab before it: a file tab, or the last terminal for the first file tab
    expect(afterClose(strip, c)).toBe(b)
    expect(afterClose(strip, b)).toBe(a)
    expect(afterClose(strip, a)).toBe('shell2')
    // no terminal before the first file tab: the one after it; nothing else open: the file view's empty state
    expect(afterClose(stripOrder([], files), a)).toBe(b)
    expect(afterClose(stripOrder([], opened(['a.ts'])), a)).toBeNull()
    expect(afterClose(strip, fileTabId('gone.ts'))).toBeNull()
    // with no terminal and no memory the work pane starts on its last terminal, else (the pick) its last file tab
    expect(pickActiveTab(work, [], { active: null, wanted: null }, null, startTab(work, kindOf, null, null, true))).toEqual({ active: 'shell2', wanted: null })
    expect(pickActiveTab([], [a], { active: null, wanted: null }, null, null)).toEqual({ active: null, wanted: null })
  })

  it('U-TERM-58 · a mode switch: to the split the work pane keeps the one-column tab (a file included) unless it is the Agent, else the tab it showed when last split, else its last terminal; to one column the Agent unless the work pane had the keyboard', () => {
    const work = workTabs(terminals, kindOf)
    const exists = (id: string) => terminals.includes(id) || isFileTabId(id)
    const file = fileTabId('a.ts')
    // one column → split
    expect(tabToSplit('shell1', 'agent1', 'server1', exists, work)).toBe('shell1')
    expect(tabToSplit(file, 'agent1', 'server1', exists, work), 'a file on screen stays on screen').toBe(file)
    expect(tabToSplit('agent1', 'agent1', 'server1', exists, work)).toBe('server1')
    expect(tabToSplit('agent1', 'agent1', 'gone', exists, work), 'the tab it showed is gone').toBe('shell2')
    expect(tabToSplit('agent1', 'agent1', undefined, exists, work)).toBe('shell2')
    expect(tabToSplit('agent1', 'agent1', undefined, exists, []), 'no work tab: its empty state').toBeNull()
    expect(tabToSplit(null, 'agent1', undefined, exists, work)).toBe('shell2')
    // split → one column: the tab of the pane that had the keyboard
    expect(tabToColumn('shell1', 'agent1', true)).toBe('shell1')
    expect(tabToColumn(file, 'agent1', true)).toBe(file)
    expect(tabToColumn('shell1', 'agent1', false), 'the agent pane had it, or nothing did').toBe('agent1')
    expect(tabToColumn(null, 'agent1', false)).toBe('agent1')
    expect(tabToColumn('shell1', null, false), 'no agent yet').toBe('shell1')
  })

  it('U-TERM-58 · the two tab memories: a tab chosen in the split is remembered as such and is not restored in one column, where the session starts on its Agent; one chosen in one column is restored in both', () => {
    const inSplit = rememberTab('shell1', kindOf, true)
    expect(inSplit).toEqual({ kind: 'shell', ptyId: 'shell1', split: true })
    expect(rememberTab('server1', kindOf, true)).toEqual({ kind: 'server', split: true })
    expect(rememberTab('agent1', kindOf, true)).toBeNull()
    expect(sameTabMemory(inSplit, { kind: 'shell', ptyId: 'shell1' }), 'the mode is part of the memory').toBe(false)
    expect(parseTabMemory(savedTabs(inSplit))).toEqual(inSplit)
    expect(parseTabMemory({ active: { kind: 'server', split: 'yes' } }), 'anything but true reads as one column').toEqual({ kind: 'server' })
    // one column does not restore a tab chosen beside the agent: it starts on the Agent
    expect(startTab(terminals, kindOf, inSplit, 'agent1')).toBe('agent1')
    expect(startTab(workTabs(terminals, kindOf), kindOf, inSplit, null, true)).toBe('shell1')
    // a tab chosen in one column comes back in both
    const inColumn = rememberTab('server1', kindOf)
    expect(startTab(terminals, kindOf, inColumn, 'agent1')).toBe('server1')
    expect(startTab(workTabs(terminals, kindOf), kindOf, inColumn, null, true)).toBe('server1')
  })
})
