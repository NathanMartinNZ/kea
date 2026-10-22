import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cssDurationMs, tipOf, tipPlace, TooltipDelay } from './tooltip.ts'

const DELAY = 500

function delay() {
  const shown: string[] = []
  let hides = 0
  let pending = 0
  const d = new TooltipDelay<string>({
    delayMs: () => DELAY,
    show: (t) => shown.push(t),
    hide: () => hides++,
    timers: {
      set: (fn, ms) => {
        pending++
        return setTimeout(() => {
          pending--
          fn()
        }, ms)
      },
      clear: (h) => {
        pending--
        clearTimeout(h as ReturnType<typeof setTimeout>)
      },
    },
  })
  return { d, shown, hides: () => hides, pending: () => pending }
}

describe('tooltips', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('U-KB-12 · a tip shows after the delay, on one timer for the window; leaving or a press hides it and ends the wait', () => {
    const t = delay()
    t.d.enter('new')
    expect(t.d.waiting).toBe(1)
    vi.advanceTimersByTime(DELAY - 1)
    expect(t.shown).toEqual([])
    vi.advanceTimersByTime(1)
    expect(t.shown).toEqual(['new'])
    expect(t.d.showing).toBe(true)
    expect(t.d.waiting).toBe(0)
    // the pointer moving within the same control changes nothing
    t.d.enter('new')
    expect(t.d.waiting).toBe(0)
    expect(t.shown).toEqual(['new'])
    // another control: what showed goes, and the wait starts again
    t.d.enter('find')
    expect(t.hides()).toBe(1)
    expect(t.d.showing).toBe(false)
    expect(t.d.current).toBe('find')
    vi.advanceTimersByTime(DELAY - 1)
    // it left before the delay ran out: nothing shows, nothing waits
    t.d.leave()
    vi.advanceTimersByTime(DELAY * 2)
    expect(t.shown).toEqual(['new'])
    expect(t.d.waiting).toBe(0)
    expect(t.d.current).toBeNull()
    expect(t.hides()).toBe(1)
    // leaving with nothing shown or waiting is nothing
    t.d.leave()
    expect(t.hides()).toBe(1)
  })

  it('U-KB-12 · a thousand controls passed over leave one timer at most, and none once the pointer has left', () => {
    const t = delay()
    for (let i = 0; i < 1000; i++) {
      t.d.enter(`control-${i}`)
      expect(t.pending()).toBe(1)
      if (i % 7 === 0) vi.advanceTimersByTime(DELAY)
      if (i % 5 === 0) t.d.leave()
      expect(t.pending()).toBeLessThanOrEqual(1)
    }
    t.d.leave()
    expect(t.pending()).toBe(0)
    expect(t.d.waiting).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    // only the controls the pointer rested on showed anything
    expect(t.shown.length).toBeLessThan(1000 / 7 + 1)
    expect(t.hides()).toBe(t.shown.length)
  })

  it('U-KB-12 · what a tip says: the control’s text, or its command’s title, with the command’s key now', () => {
    const keys: Record<string, { title: string; shortcut?: string }> = { 'session.new': { title: 'New Session', shortcut: '⌘N' }, 'project.reveal': { title: 'Reveal Project in Finder' } }
    const resolve = (id: string) => keys[id]
    expect(tipOf({ tip: null, command: 'session.new' }, resolve)).toEqual({ text: 'New Session', shortcut: '⌘N' })
    expect(tipOf({ tip: 'New session in kea', command: 'session.new' }, resolve)).toEqual({ text: 'New session in kea', shortcut: '⌘N' })
    expect(tipOf({ tip: null, command: 'project.reveal' }, resolve)).toEqual({ text: 'Reveal Project in Finder' })
    expect(tipOf({ tip: 'Dismiss', command: null }, resolve)).toEqual({ text: 'Dismiss' })
    // the key is the one now: a rebinding shows at the next tip
    keys['session.new'] = { title: 'New Session', shortcut: '⌥⌘N' }
    expect(tipOf({ tip: null, command: 'session.new' }, resolve)?.shortcut).toBe('⌥⌘N')
    // nothing to say
    expect(tipOf({ tip: null, command: null }, resolve)).toBeNull()
    expect(tipOf({ tip: '', command: 'not.a.command' }, resolve)).toBeNull()
    expect(tipOf({ tip: 'Text', command: 'not.a.command' }, resolve)).toEqual({ text: 'Text' })
    // a key no command owns (`data-tip-key`): shown as the chip; a command's key wins over it
    expect(tipOf({ tip: 'Next match', command: null, key: '↵' }, resolve)).toEqual({ text: 'Next match', shortcut: '↵' })
    expect(tipOf({ tip: 'New', command: 'session.new', key: '⌘1' }, resolve)?.shortcut).toBe('⌥⌘N')
    expect(tipOf({ tip: null, command: null, key: '↵' }, resolve)).toBeNull()

    expect(cssDurationMs('500ms')).toBe(500)
    expect(cssDurationMs(' 0.5s ')).toBe(500)
    expect(cssDurationMs('1s')).toBe(1000)
    expect(cssDurationMs('')).toBeNull()
    expect(cssDurationMs('fast')).toBeNull()
  })

  it('U-KB-12 · where a tip goes: centred under its control, above when there is no room, never past the window’s edge', () => {
    const view = { width: 1000, height: 600 }
    const tip = { width: 100, height: 20 }
    expect(tipPlace({ left: 400, top: 100, width: 40, height: 20 }, tip, view, 4)).toEqual({ left: 370, top: 124 })
    // at the left and right edges it is kept inside
    expect(tipPlace({ left: 0, top: 100, width: 20, height: 20 }, tip, view, 4)).toEqual({ left: 4, top: 124 })
    expect(tipPlace({ left: 980, top: 100, width: 20, height: 20 }, tip, view, 4)).toEqual({ left: 896, top: 124 })
    // no room below: above the control
    expect(tipPlace({ left: 400, top: 570, width: 40, height: 20 }, tip, view, 4)).toEqual({ left: 370, top: 546 })
    expect(tipPlace({ left: 400, top: 0, width: 40, height: 600 }, tip, view, 4).top).toBe(4)
  })
})
