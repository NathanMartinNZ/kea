import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMainToChild, L, type MenuBarState } from '@kea/protocol'
import { BackgroundTray, DockIcon, isQuitChoice, lastWindowAction, markQuitSheetSeen, MenuBarItemRemoval, QuitSheetAnswer, quitAction, quitSheetSeen, rememberedOnQuit, trayTemplate, trayTitle } from './menuBar.ts'

const state = (o: Partial<MenuBarState> = {}): MenuBarState => ({ live: 2, onQuit: 'menuBar', count: 0, sessions: [], badge: true, ...o })
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('⌘Q and the menu-bar item', () => {
  it('U-SES-6 · ⌘Q: with nothing kept running Kea quits; otherwise "On quit" decides, and the first time it would stay in the menu bar the sheet asks, once, when a window can show it', () => {
    expect(quitAction({ state: null, sheetSeen: false, canAsk: true }), 'nothing known from core yet').toBe('quit')
    expect(quitAction({ state: state({ live: 0 }), sheetSeen: false, canAsk: true })).toBe('quit')
    expect(quitAction({ state: state(), sheetSeen: false, canAsk: true })).toBe('sheet')
    expect(quitAction({ state: state(), sheetSeen: true, canAsk: true })).toBe('menuBar')
    expect(quitAction({ state: state(), sheetSeen: false, canAsk: false }), 'no window to show the sheet in').toBe('menuBar')
    expect(quitAction({ state: state({ onQuit: 'quit' }), sheetSeen: false, canAsk: true })).toBe('quit')
    expect(quitAction({ state: state({ onQuit: 'stopAll' }), sheetSeen: false, canAsk: true })).toBe('stopAll')
    expect(['menuBar', 'quit', 'stopAll'].every(isQuitChoice)).toBe(true)
    expect([undefined, 'sheet', 'Quit', 1].some(isQuitChoice)).toBe(false)
    // answered once, kept beside the window state
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-menubar-'))
    dirs.push(dir)
    expect(quitSheetSeen(dir)).toBe(false)
    markQuitSheetSeen(dir)
    expect(quitSheetSeen(dir)).toBe(true)
    fs.writeFileSync(path.join(dir, 'menu-bar.json'), '{not json')
    expect(quitSheetSeen(dir), 'an unreadable mark shows the sheet again').toBe(false)
  })

  it('U-SES-6 · the menu-bar item: the needs-you count as its title (nothing at zero, nothing with the badge switched off); its menu lists those sessions with their glyphs, then Open Kea and Quit Kea Completely, each doing what it says', () => {
    const act = { openKea: vi.fn(), showSession: vi.fn(), quit: vi.fn() }
    expect(trayTitle(null)).toBe('')
    expect(trayTitle(state())).toBe('')
    const s = state({
      count: 3,
      sessions: [
        { id: 's1', title: 'Fix auth', reason: 'permission', glyph: 'needsYou' },
        { id: 's2', title: 'Docs', reason: 'lost', glyph: 'failed' },
        { id: 's3', title: 'Claude Code', reason: 'limited', glyph: 'limited' },
      ],
    })
    expect(trayTitle(s)).toBe('3')
    expect(trayTitle({ ...s, badge: false }), 'notifications.dockBadge off').toBe('')
    const t = trayTemplate(s, act)
    expect(t.map((m) => m.id ?? m.type)).toEqual(['session:s1', 'session:s2', 'session:s3', 'separator', 'app.openKea', 'app.quit'])
    expect(t.map((m) => m.label)).toEqual(['◉ Fix auth — permission', '⊘ Docs — lost', '⊘ Claude Code — limited', undefined, 'Open Kea', 'Quit Kea Completely'])
    const click = (m: MenuItemConstructorOptions | undefined) => (m?.click as () => void)()
    click(t[1])
    expect(act.showSession).toHaveBeenCalledWith('s2')
    click(t[4])
    expect(act.openKea).toHaveBeenCalled()
    click(t[5])
    expect(act.quit).toHaveBeenCalled()
    expect(trayTemplate(state(), act).map((m) => m.id), 'nobody needs you: no list, no separator').toEqual(['app.openKea', 'app.quit'])
  })

  it('U-SES-9 · the first-quit sheet’s answer becomes "On quit" when it is non-destructive: Keep in Menu Bar → menuBar, Quit Completely → quit, so the next ⌘Q does what was chosen; Stop All and Quit applies once and leaves the setting as it was', () => {
    expect(rememberedOnQuit('menuBar')).toBe('menuBar')
    expect(rememberedOnQuit('quit')).toBe('quit')
    expect(rememberedOnQuit('stopAll'), 'one click never makes every later ⌘Q stop every agent').toBeNull()
    // what main tells core (core writes settings.json; its menu-bar state then carries the new setting)
    expect(isMainToChild({ k: 'onQuit', onQuit: 'quit' })).toBe(true)
    expect(isMainToChild({ k: 'onQuit', onQuit: 'menuBar' })).toBe(true)
    expect([{ k: 'onQuit', onQuit: 'stopAll' }, { k: 'onQuit' }, { k: 'onQuit', onQuit: 'Quit' }].some(isMainToChild), 'Stop All is never remembered from the sheet').toBe(false)
    // the next ⌘Q: the sheet is not shown again, and the remembered setting decides
    expect(quitAction({ state: state({ onQuit: 'quit' }), sheetSeen: true, canAsk: true })).toBe('quit')
    expect(quitAction({ state: state({ onQuit: 'menuBar' }), sheetSeen: true, canAsk: true })).toBe('menuBar')
  })

  it('U-SES-11 · a first-quit answer given while core is away is handed to core once it is ready, and the sheet counts as seen only then; Stop All and Quit has nothing to save and counts at once', () => {
    let coreUp = false
    const posted: string[] = []
    let seen = 0
    const answer = new QuitSheetAnswer({ post: (onQuit) => (coreUp ? (posted.push(onQuit), true) : false), markSeen: () => seen++ })
    answer.answer('quit')
    expect({ posted, seen }, 'core away: nothing saved, so not seen yet (a quit now asks again next time)').toEqual({ posted: [], seen: 0 })
    coreUp = true
    answer.coreReady()
    expect({ posted, seen }, 'core back: the choice is handed over, then the sheet counts as seen').toEqual({ posted: ['quit'], seen: 1 })
    answer.coreReady()
    expect({ posted, seen }, 'once').toEqual({ posted: ['quit'], seen: 1 })
    // with core ready: at once
    answer.answer('menuBar')
    expect({ posted, seen }).toEqual({ posted: ['quit', 'menuBar'], seen: 2 })
    // Stop All and Quit is never remembered: seen at once, even with core away
    coreUp = false
    answer.answer('stopAll')
    expect({ posted, seen }).toEqual({ posted: ['quit', 'menuBar'], seen: 3 })
  })

  it('U-SES-10 · the Dock icon after a quick second ⌘Q: Electron ignores a hide within a second of a show, so a hide sooner than L.dockRehideAfterShowMs after the last show is made again once that has passed, unless Kea was reopened meanwhile; a later hide needs nothing more', () => {
    vi.useFakeTimers()
    try {
      // Electron's Dock: a hide within its own second of the last show does nothing (shell/browser/browser_mac.mm)
      const ELECTRON_HIDE_IGNORED_MS = 1000
      let visible = true
      let shownAt = -Infinity
      const calls: string[] = []
      const dock = {
        show: () => {
          calls.push('show')
          visible = true
          shownAt = Date.now()
        },
        hide: () => {
          calls.push('hide')
          if (Date.now() - shownAt >= ELECTRON_HIDE_IGNORED_MS) visible = false
        },
      }
      const icon = new DockIcon({ dock, now: () => Date.now(), waitMs: L.dockRehideAfterShowMs })
      expect(L.dockRehideAfterShowMs, 'longer than Electron’s own second').toBeGreaterThan(ELECTRON_HIDE_IGNORED_MS)

      // reopened from the menu bar, then ⌘Q at once: the first hide is ignored, the second one, later, works
      icon.show()
      vi.advanceTimersByTime(100)
      icon.hide()
      expect(visible, 'Electron ignored the hide').toBe(true)
      vi.advanceTimersByTime(L.dockRehideAfterShowMs - 100 - 1)
      expect(visible).toBe(true)
      vi.advanceTimersByTime(1)
      expect(visible, 'hidden again once the wait has passed since the show').toBe(false)
      expect(calls).toEqual(['show', 'hide', 'hide'])

      // reopened again before the wait is over: the pending hide is dropped, the icon stays
      calls.length = 0
      icon.show()
      icon.hide()
      icon.show()
      vi.advanceTimersByTime(L.dockRehideAfterShowMs * 2)
      expect(visible, 'Kea was reopened: the Dock icon stays').toBe(true)
      expect(calls).toEqual(['show', 'hide', 'show'])

      // a hide long after the show works at once and schedules nothing
      calls.length = 0
      vi.advanceTimersByTime(L.dockRehideAfterShowMs)
      icon.hide()
      expect(visible).toBe(false)
      expect(vi.getTimerCount(), 'nothing pending').toBe(0)

      // disposed (full quit) with a hide pending: nothing fires afterwards
      icon.show()
      icon.hide()
      expect(vi.getTimerCount()).toBe(1)
      icon.dispose()
      expect(vi.getTimerCount()).toBe(0)
      // no Dock (not macOS): nothing to do
      const none = new DockIcon({ dock: undefined, now: () => Date.now(), waitMs: L.dockRehideAfterShowMs })
      none.show()
      none.hide()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('U-SES-13 · leaving the menu bar: an item that shows a title (the needs-you count) has it cleared first and is removed L.menuBarItemRemoveMs later, once the menu bar has drawn it without one; an item with no title goes at once; one item waits at most, and a full quit removes it at once', () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const item = (name: string, title: string) => ({
        getTitle: () => title,
        setTitle: (t: string) => {
          calls.push(`${name} title '${t}'`)
          title = t
        },
        destroy: () => calls.push(`${name} removed`),
      })
      const removal = new MenuBarItemRemoval({ waitMs: L.menuBarItemRemoveMs })

      // the count on show: cleared now, the item removed only once the wait has passed
      removal.remove(item('a', '3'))
      expect(calls, 'the title cleared before anything else').toEqual([`a title ''`])
      expect(removal.waiting).toBe(1)
      vi.advanceTimersByTime(L.menuBarItemRemoveMs - 1)
      expect(calls, 'still there: the menu bar has not drawn it without its title yet').toEqual([`a title ''`])
      vi.advanceTimersByTime(1)
      expect(calls).toEqual([`a title ''`, 'a removed'])
      expect(removal.waiting).toBe(0)
      expect(vi.getTimerCount(), 'nothing pending').toBe(0)

      // no title: nothing is left behind, so it goes at once and nothing waits
      calls.length = 0
      removal.remove(item('b', ''))
      expect(calls).toEqual(['b removed'])
      expect(removal.waiting).toBe(0)
      expect(vi.getTimerCount()).toBe(0)

      // a second removal while one waits (⌘Q and Open Kea again within the wait): the first goes at once
      calls.length = 0
      removal.remove(item('c', '1'))
      removal.remove(item('d', '2'))
      expect(calls).toEqual([`c title ''`, 'c removed', `d title ''`])
      expect(removal.waiting).toBe(1)
      expect(vi.getTimerCount()).toBe(1)

      // a full quit: the waiting item goes now and nothing fires afterwards
      removal.dispose()
      expect(calls).toEqual([`c title ''`, 'c removed', `d title ''`, 'd removed'])
      expect(removal.waiting).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(L.menuBarItemRemoveMs * 2)
      expect(calls.filter((c) => c === 'd removed')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the tray on Linux', () => {
  // With a tray host, menu-bar mode works as on macOS. Without one "keep running" quits (the first-quit sheet still
  // asks once, without its Keep option: QuitSheet.svelte) and closing the last window quits. A tray made before a host
  // comes never shows, so the tray is made when one comes, destroying the one made before. Nothing waits on the tray's
  // `click`: its menu is the way in, and main never listens for the click.
  it('U-PLT-9 · the tray rule: a host → menu-bar mode; none → quit, last window quits; a host that comes later gets the tray then; no click', () => {
    // ⌘Q (Ctrl+Shift+Q): with a host as on macOS; without one the sheet once, then quit
    expect(quitAction({ state: state(), sheetSeen: true, canAsk: true, background: true })).toBe('menuBar')
    expect(quitAction({ state: state(), sheetSeen: true, canAsk: true, background: false })).toBe('quit')
    expect(quitAction({ state: state(), sheetSeen: false, canAsk: true, background: false })).toBe('sheet')
    expect(quitAction({ state: state(), sheetSeen: false, canAsk: false, background: false })).toBe('quit')
    expect(quitAction({ state: state({ onQuit: 'stopAll' }), sheetSeen: true, canAsk: true, background: false })).toBe('stopAll')
    // the last window: macOS stays; Linux goes to the background with a host and live sessions, and quits otherwise
    expect(lastWindowAction({ lastWindow: 'stay', background: false, live: 3 })).toBe('stay')
    expect(lastWindowAction({ lastWindow: 'backgroundOrQuit', background: true, live: 3 })).toBe('background')
    expect(lastWindowAction({ lastWindow: 'backgroundOrQuit', background: false, live: 3 })).toBe('quit')
    expect(lastWindowAction({ lastWindow: 'backgroundOrQuit', background: true, live: 0 })).toBe('quit')

    // the tray: made when Kea is in the background with a host there, or when a host comes; one made before goes
    const made: { n: number; destroyed: boolean; destroy(): void }[] = []
    const shown: number[] = []
    const t = new BackgroundTray({
      make: () => {
        const item = { n: made.length + 1, destroyed: false, destroy: () => void (item.destroyed = true) }
        made.push(item)
        return item
      },
      made: (item) => shown.push(item.n),
    })
    t.host(null)
    t.enter()
    expect([t.background, t.tray, t.canRunInBackground], 'no answer from the bus yet: no tray').toEqual([true, null, false])
    t.host(true)
    expect([t.tray?.n, shown]).toEqual([1, [1]])
    t.host(false) // the shell locked: a tray made with a host comes back by itself
    expect([t.tray?.n, made[0]!.destroyed]).toEqual([1, false])
    t.host(true) // the host is back: a new tray, the old one destroyed
    expect([t.tray?.n, made[0]!.destroyed, shown]).toEqual([2, true, [1, 2]])
    t.host(true)
    expect(made.length, 'the same answer again makes nothing').toBe(2)
    const gone = t.leave()
    expect([gone?.n, t.tray, t.background]).toEqual([2, null, false])
    t.host(false)
    t.host(true)
    expect(made.length, 'a host that comes while Kea has a window makes no tray').toBe(2)
    t.enter()
    expect(t.tray?.n).toBe(3)
    t.dispose()
    expect([made[2]!.destroyed, t.tray]).toEqual([true, null])

    // the menu says the count, which a Linux tray shows as no title
    const s = state({ count: 2, sessions: [{ id: 'a', title: 'Fix login', reason: 'Needs approval', glyph: 'needsYou' }] })
    const act = { openKea: () => undefined, showSession: () => undefined, quit: () => undefined }
    expect(trayTemplate(s, act, { countLine: true })[0]).toMatchObject({ id: 'count', label: '2 sessions need you', enabled: false })
    expect(trayTemplate(s, act)[0]!.id, 'macOS: the title has the count').toBe('session:a')
    expect(trayTemplate(state({ count: 0 }), act, { countLine: true }).map((m) => m.id)).toEqual(['app.openKea', 'app.quit'])
    // nothing listens for the tray's click
    const main = fs.readFileSync(path.join(import.meta.dirname, 'main.ts'), 'utf8')
    expect(main).not.toMatch(/\.on\(\s*['"](click|double-click|right-click)['"]/)
  })

  it('U-DST-39 · while an update waits for a restart the tray’s menu offers it above Open Kea, and its click restarts; otherwise it has none', () => {
    const restart = vi.fn()
    const act = { openKea: vi.fn(), showSession: vi.fn(), quit: vi.fn(), restart }
    expect(trayTemplate(null, act).map((i) => i.id)).toEqual(['app.openKea', 'app.quit'])
    const t = trayTemplate(null, act, { restart: 'Restart to Update' })
    expect(t.map((i) => i.id)).toEqual(['app.checkUpdates', 'app.openKea', 'app.quit'])
    expect(t[0]!.label).toBe('Restart to Update')
    ;(t[0]!.click as () => void)()
    expect(restart).toHaveBeenCalledTimes(1)
  })
})
