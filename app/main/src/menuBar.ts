// Menu-bar mode: what `⌘Q` does, the menu-bar item's title and menu, and the mark that the first-quit sheet was
// answered. Pure (Electron's template objects, plain files), so it is unit-tested without Electron; main.ts owns the
// Tray, the Dock icon and the windows.
//
// `⌘Q` (`app.closeToMenuBar`): with no session kept running Kea quits as any app does; otherwise "On quit"
// (`general.onQuit`) decides: stay in the menu bar (the default), quit completely (holders run on) or stop all
// sessions and quit. The first time it would go to the menu bar, and a window is there to show it in, the sheet asks
// instead (Keep in Menu Bar, Quit Completely, Stop All and Quit); once answered it is not shown again, and a
// non-destructive answer becomes the setting.

import fs from 'node:fs'
import path from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import { atomicWriteSync } from '@kea/kit'
import { commandById, ON_QUIT, type MenuBarState, type SessionGlyph } from '@kea/protocol'

/** What `⌘Q` leads to: one of the "On quit" choices, or the first-quit sheet. */
export type QuitAction = (typeof ON_QUIT)[number] | 'sheet'

/** A choice the first-quit sheet answers with (its three buttons). */
export type QuitChoice = (typeof ON_QUIT)[number]

export function isQuitChoice(v: unknown): v is QuitChoice {
  return (ON_QUIT as readonly unknown[]).includes(v)
}

/**
 * The first-quit sheet's answer becomes the "On quit" setting when it is non-destructive (Keep in Menu Bar, Quit
 * Completely), so the next `⌘Q` does what was chosen; Stop All and Quit applies once (null: the setting stays).
 */
export function rememberedOnQuit(c: QuitChoice): 'menuBar' | 'quit' | null {
  return c === 'stopAll' ? null : c
}

/**
 * The first-quit sheet's answer. A non-destructive answer becomes "On quit", which core writes: `post` hands it to core
 * (false when core is not ready, e.g. restarting), and an answer core could not take waits, the latest only, until core
 * is ready again (`coreReady`). The sheet counts as seen (`markSeen`) once nothing of the answer is left to save: at
 * once for Stop All and Quit (never remembered), otherwise when core has the choice. A quit before that leaves the
 * sheet unseen, so the next `⌘Q` asks again instead of doing what was not chosen.
 */
export class QuitSheetAnswer {
  private readonly o: { post: (onQuit: 'menuBar' | 'quit') => boolean; markSeen: () => void }
  /** A remembered choice core has not taken yet. */
  private pending: 'menuBar' | 'quit' | null = null

  constructor(o: { post: (onQuit: 'menuBar' | 'quit') => boolean; markSeen: () => void }) {
    this.o = o
  }

  answer(choice: QuitChoice): void {
    const remembered = rememberedOnQuit(choice)
    if (!remembered) {
      this.o.markSeen()
      return
    }
    this.pending = remembered
    this.handOver()
  }

  /** Core became ready (main's onChildReady): a choice waiting for it goes now. */
  coreReady(): void {
    this.handOver()
  }

  private handOver(): void {
    if (!this.pending || !this.o.post(this.pending)) return
    this.pending = null
    this.o.markSeen()
  }
}

/**
 * What `⌘Q` does. `state`: core's last menu-bar state (null before core has sent one: nothing is known to run, so Kea
 * quits; holders run on either way). `canAsk`: a window whose renderer can show the sheet. `background`: Kea can run
 * with no window and be opened again (on Linux only while a tray host is there); without it "keep running" quits, as
 * the setting's default then does, and the sheet offers only the other two.
 */
export function quitAction(o: { state: MenuBarState | null; sheetSeen: boolean; canAsk: boolean; background?: boolean }): QuitAction {
  const s = o.state
  if (!s || s.live === 0) return 'quit'
  if (s.onQuit !== 'menuBar') return s.onQuit
  if (!o.sheetSeen && o.canAsk) return 'sheet'
  return o.background === false ? 'quit' : 'menuBar'
}

/**
 * The menu-bar item's title: the needs-you count in the menu bar's own font, nothing at zero or with the badge switched
 * off (`notifications.dockBadge`).
 */
export function trayTitle(s: MenuBarState | null): string {
  return s && s.badge && s.count > 0 ? String(s.count) : ''
}

/**
 * A line's status glyph in the native menu, as text in the menu's own font (Kea's SVG glyphs and tokens do not apply to
 * a native menu): each glyph keeps its own shape, so status is never told by colour.
 */
export const MENU_GLYPHS: Readonly<Record<SessionGlyph, string>> = {
  working: '◐',
  needsYou: '◉',
  unread: '●',
  idle: '○',
  detached: '◌',
  failed: '⊘',
  limited: '⊘',
}

/** The menu-bar item's tooltip. */
export function trayTooltip(s: MenuBarState | null): string {
  const n = s?.count ?? 0
  return n === 0 ? 'Kea' : `Kea · ${n} ${n === 1 ? 'session needs' : 'sessions need'} you`
}

/**
 * The menu-bar item's menu: the sessions that need you (glyph, title and why; an account condition as one line), a
 * separator, Open Kea and Quit Kea Completely (the command table's titles). Native menu styling: Kea's tokens do not
 * apply. `countLine`: a Linux tray shows no title, so its menu says the count first, as the tooltip does.
 */
export function trayTemplate(s: MenuBarState | null, act: { openKea(): void; showSession(id: string): void; quit(): void }, o: { countLine?: boolean } = {}): MenuItemConstructorOptions[] {
  const sessions = s?.sessions ?? []
  const items: MenuItemConstructorOptions[] = []
  if (o.countLine && s && s.count > 0) items.push({ id: 'count', label: trayTooltip(s).replace(/^Kea · /, ''), enabled: false })
  items.push(...sessions.map((x): MenuItemConstructorOptions => ({ id: `session:${x.id}`, label: `${MENU_GLYPHS[x.glyph]} ${x.title} — ${x.reason}`, click: () => act.showSession(x.id) })))
  if (items.length) items.push({ type: 'separator' })
  items.push({ id: 'app.openKea', label: commandById('app.openKea')?.title ?? 'Open Kea', click: () => act.openKea() })
  items.push({ id: 'app.quit', label: commandById('app.quit')?.title ?? 'Quit Kea Completely', click: () => act.quit() })
  return items
}

/**
 * What closing the last window does. macOS keeps Kea as it is (in the Dock, `stay`). Linux has no Dock: Kea goes to the
 * background while sessions run and a tray host is there to open it again from, and quits otherwise; sessions keep
 * running in their holders either way.
 */
export function lastWindowAction(o: { lastWindow: 'stay' | 'backgroundOrQuit'; background: boolean; live: number }): 'stay' | 'background' | 'quit' {
  if (o.lastWindow === 'stay') return 'stay'
  return o.background && o.live > 0 ? 'background' : 'quit'
}

/**
 * The menu-bar item or tray icon while Kea runs in the background. A Linux tray made while no host owns
 * `org.kde.StatusNotifierWatcher` never appears, even after a host comes, so the item is made when Kea goes to the
 * background with a host there, or when a host appears while Kea is there, destroying one made before; one made with a
 * host comes back by itself when that host restarts. On macOS the menu bar is always the host. Nothing here waits on
 * the item's `click`, which a Linux host never sends: its menu is the way in.
 */
export class BackgroundTray<T extends { destroy(): void }> {
  private readonly o: { make: () => T; made: (t: T) => void }
  private item: T | null = null
  private inBackground = false
  private hostPresent: boolean | null = null

  constructor(o: { make: () => T; made: (t: T) => void }) {
    this.o = o
  }

  /** The item, while Kea runs in the background with a host to show it. */
  get tray(): T | null {
    return this.item
  }

  /** Kea runs with no window, until it is opened again. */
  get background(): boolean {
    return this.inBackground
  }

  /** A tray host is there, so Kea can run in the background and be opened again from it. */
  get canRunInBackground(): boolean {
    return this.hostPresent === true
  }

  /** The desktop's answer about a tray host, at start and at each change (null: not known yet). */
  host(present: boolean | null): void {
    const came = present === true && this.hostPresent !== true
    this.hostPresent = present
    if (came && this.inBackground) this.make()
  }

  /** Kea goes to the background: the item is made now if a host is there, else when one comes. */
  enter(): void {
    if (this.inBackground) return
    this.inBackground = true
    if (this.hostPresent === true) this.make()
  }

  /** Kea is opened again: the item to remove (main clears its title first), if one was made. */
  leave(): T | null {
    if (!this.inBackground) return null
    this.inBackground = false
    const t = this.item
    this.item = null
    return t
  }

  /** At quit: the item goes at once. */
  dispose(): void {
    this.item?.destroy()
    this.item = null
  }

  private make(): void {
    this.item?.destroy()
    this.item = this.o.make()
    this.o.made(this.item)
  }
}

/** What DockIcon needs of `app.dock` (absent off macOS). */
export interface DockLike {
  show(): unknown
  hide(): void
}

/**
 * The Dock icon in and out of menu-bar mode. Electron ignores `app.dock.hide()` within a second of `app.dock.show()`
 * (it returns early to avoid a macOS bug that leaves several Dock icons), so `⌘Q` just after Kea was reopened from the
 * menu bar or a notification would leave the icon shown. A hide that comes sooner than `waitMs`
 * (L.dockRehideAfterShowMs) after the last show is therefore made again once that much has passed since the show,
 * unless Kea was shown again meanwhile.
 */
export class DockIcon {
  private readonly dock: DockLike | undefined
  private readonly now: () => number
  private readonly waitMs: number
  private shownAt: number | null = null
  /** The re-hide waiting for the wait to pass: one at most. */
  private pending: ReturnType<typeof setTimeout> | null = null

  constructor(o: { dock: DockLike | undefined; now: () => number; waitMs: number }) {
    this.dock = o.dock
    this.now = o.now
    this.waitMs = o.waitMs
  }

  show(): void {
    this.cancel()
    if (!this.dock) return
    this.shownAt = this.now()
    void this.dock.show()
  }

  hide(): void {
    this.cancel()
    if (!this.dock) return
    this.dock.hide()
    const since = this.shownAt === null ? Infinity : this.now() - this.shownAt
    if (since >= this.waitMs) return
    this.pending = setTimeout(() => {
      this.pending = null
      this.dock?.hide()
    }, this.waitMs - since)
  }

  /** Full quit: nothing fires afterwards. */
  dispose(): void {
    this.cancel()
  }

  private cancel(): void {
    if (this.pending) clearTimeout(this.pending)
    this.pending = null
  }
}

/** What MenuBarItemRemoval needs of Electron's `Tray`. */
export interface TrayLike {
  getTitle(): string
  setTitle(title: string): void
  destroy(): void
}

/**
 * Leaving the menu bar: the item goes. An item removed while its title (the needs-you count) is drawn leaves that
 * title's drawing behind in main, two or three 32 KB blocks of owned memory each time, never given back. So an item
 * that shows a title has it cleared first and is removed `waitMs` (L.menuBarItemRemoveMs) later, once the menu bar has
 * drawn it without one; an item with no title goes at once. One item waits at most: a second removal meanwhile (Kea
 * sent to the menu bar and reopened again within the wait) removes the first at once.
 */
export class MenuBarItemRemoval {
  private readonly waitMs: number
  /** The item waiting to be removed and its timer: one at most. */
  private pending: { item: TrayLike; timer: ReturnType<typeof setTimeout> } | null = null

  constructor(o: { waitMs: number }) {
    this.waitMs = o.waitMs
  }

  remove(item: TrayLike): void {
    this.dispose()
    if (item.getTitle() === '') {
      item.destroy()
      return
    }
    item.setTitle('')
    const timer = setTimeout(() => {
      this.pending = null
      item.destroy()
    }, this.waitMs)
    this.pending = { item, timer }
  }

  /** Items waiting to be removed: 0 or 1. */
  get waiting(): number {
    return this.pending ? 1 : 0
  }

  /** The waiting item, if any, goes now (a second removal; a full quit): nothing fires afterwards. */
  dispose(): void {
    if (!this.pending) return
    clearTimeout(this.pending.timer)
    const { item } = this.pending
    this.pending = null
    item.destroy()
  }
}

const SEEN_FILE = 'menu-bar.json'

/** The first-quit sheet has been answered (first time only); kept in the app's data folder, beside window-state.json. */
export function quitSheetSeen(dir: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, SEEN_FILE), 'utf8')) as { quitSheetSeen?: unknown }).quitSheetSeen === true
  } catch {
    return false
  }
}

export function markQuitSheetSeen(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    atomicWriteSync(path.join(dir, SEEN_FILE), JSON.stringify({ quitSheetSeen: true }), { mode: 0o600 })
  } catch {
    // shown again next time: harmless
  }
}
