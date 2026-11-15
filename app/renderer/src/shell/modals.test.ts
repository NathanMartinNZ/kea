// The modal registry against a stand-in page: what is covered and when, where the keyboard goes back, holds across a
// sequence's steps, cancelling everything, and Esc that nothing else handled.
import { describe, expect, it } from 'vitest'
import { MODAL_OPEN_CLASS, Modals, type FocusTarget, type ModalLayer, type ModalPage } from './modals.ts'

/** A stand-in page: the root's classes, the window's key listeners, the keyboard's place and what happened, in order. */
function page() {
  const classes = new Set<string>()
  const listeners = new Set<(e: KeyboardEvent) => void>()
  const log: string[] = []
  const at: { now: FocusTarget | null } = { now: null }
  const p: ModalPage = {
    root: { classList: { toggle: (c, on) => void (on ? classes.add(c) : classes.delete(c)) } },
    keys: { addEventListener: (_t, l) => void listeners.add(l), removeEventListener: (_t, l) => void listeners.delete(l) },
    active: () => at.now,
    opening: () => log.push('opening'),
    shown: (open) => log.push(open ? 'shown' : 'hidden'),
    changed: () => log.push('changed'),
  }
  /** An Esc keydown reaching the window. */
  const esc = (o: { composing?: boolean; handled?: boolean } = {}) => {
    const e = { key: 'Escape', isComposing: !!o.composing, defaultPrevented: !!o.handled, preventDefault() { this.defaultPrevented = true } }
    for (const l of [...listeners]) l(e as unknown as KeyboardEvent)
    return e.defaultPrevented
  }
  return { p, classes, listeners, log, at, esc }
}

/** A focusable element; `covered` says what was inert when it took the keyboard. */
function target(name: string, ctx: ReturnType<typeof page>, parts: { inert: boolean }[] = []) {
  const t = { name, isConnected: true, coveredWhenFocused: null as boolean | null, focus: () => {
    t.coveredWhenFocused = parts.some((x) => x.inert)
    ctx.at.now = t
    ctx.log.push(`focus ${name}`)
  } }
  return t
}

/** A modal's layer holding `inside` (its default control first). */
function layer(inside: FocusTarget[] = []): ModalLayer & { inert: boolean } {
  return { inert: false, contains: (n) => inside.includes(n as FocusTarget), querySelector: (s) => (s === '[data-default]' ? (inside[0] ?? null) : null) }
}

function setup() {
  const ctx = page()
  const m = new Modals()
  m.install(ctx.p)
  const sidebar = { inert: false }
  const main = { inert: false }
  m.cover(sidebar)
  m.cover(main)
  return { ctx, m, sidebar, main }
}

describe('modals', () => {
  it('U-MODAL-1 · a modal covers the window at once (inert, the root class, the window’s Esc) and gives it back as it closes: inert off before the keyboard returns where it was', () => {
    const { ctx, m, sidebar, main } = setup()
    const terminal = target('terminal', ctx, [sidebar, main])
    const close = m.opened('confirm', layer(), () => {}, terminal)
    expect([sidebar.inert, main.inert, ctx.classes.has(MODAL_OPEN_CLASS), ctx.listeners.size, m.open, m.top, m.count]).toEqual([true, true, true, 1, true, 'confirm', 1])
    expect(ctx.log).toEqual(['opening', 'shown', 'changed'])
    close()
    expect([sidebar.inert, main.inert, ctx.classes.has(MODAL_OPEN_CLASS), ctx.listeners.size, m.open, m.top, m.count]).toEqual([false, false, false, 0, false, null, 0])
    expect(ctx.log.slice(3)).toEqual(['hidden', 'focus terminal', 'changed'])
    expect(terminal.coveredWhenFocused).toBe(false)
    close() // a second close changes nothing
    expect(ctx.log.length).toBe(6)
  })

  it('U-MODAL-1 · a part that comes while a modal is open is covered at once, and uncovered as it goes', () => {
    const { m } = setup()
    m.opened('settings', layer(), () => {}, null)
    const divider = { inert: false }
    const gone = m.cover(divider)
    expect(divider.inert).toBe(true)
    gone()
    expect(divider.inert).toBe(false)
  })

  it('U-MODAL-1 · two stacked: the newer is the top and the only one not inert; closing it gives the keyboard back into the one under it; closing the lower first leaves the top as it is', () => {
    const { ctx, m } = setup()
    const terminal = target('terminal', ctx)
    const settingsDefault = target('settings tab', ctx)
    const settings = layer([settingsDefault])
    const closeSettings = m.opened('settings', settings, () => {}, terminal)
    const trash = layer()
    const closeTrash = m.opened('confirm', trash, () => {}, settingsDefault)
    expect([settings.inert, trash.inert, m.top]).toEqual([true, false, 'confirm'])
    closeTrash()
    expect([settings.inert, m.top, ctx.at.now]).toEqual([false, 'settings', settingsDefault])
    closeSettings()
    expect(ctx.at.now).toBe(terminal)
    // the other order: the lower closes first, the top keeps the keyboard
    const a = m.opened('confirm', layer(), () => {}, terminal)
    const topLayer = layer()
    const closeB = m.opened('settings', topLayer, () => {}, null)
    ctx.log.length = 0
    a()
    expect([m.top, topLayer.inert, ctx.log.some((l) => l.startsWith('focus'))]).toEqual(['settings', false, false])
    closeB()
  })

  it('U-MODAL-1 · the keyboard goes into the modal on top when where it was is outside it (it was behind the backdrop)', () => {
    const { ctx, m } = setup()
    const terminal = target('terminal', ctx)
    const lowerDefault = target('cancel', ctx)
    m.opened('confirm', layer([lowerDefault]), () => {}, terminal)
    const close = m.opened('confirm', layer(), () => {}, terminal)
    close()
    expect(ctx.at.now).toBe(lowerDefault)
  })

  it('U-MODAL-1 · a hold keeps the backdrop through an empty stack: covered, no second showing, no keyboard between steps; its release gives the keyboard back to where it was before the first step', () => {
    const { ctx, m, sidebar } = setup()
    const terminal = target('terminal', ctx, [sidebar])
    const closeDelete = m.opened('confirm', layer(), () => {}, terminal)
    const release = m.hold(() => {})
    ctx.log.length = 0
    closeDelete() // the Delete sheet goes before the review's first question
    expect([sidebar.inert, m.open, m.top, ctx.classes.has(MODAL_OPEN_CLASS)]).toEqual([true, true, null, true])
    const closeWarning = m.opened('confirm', layer(), () => {}, null)
    closeWarning()
    expect(ctx.log).toEqual(['changed', 'opening', 'changed', 'changed']) // never hidden, never shown again, no focus
    release()
    expect(ctx.log.slice(4)).toEqual(['hidden', 'focus terminal', 'changed'])
    expect([sidebar.inert, terminal.coveredWhenFocused, m.count]).toEqual([false, false, 0])
  })

  it('U-MODAL-1 · a hold that ends with a modal open leaves the keyboard in it; that modal, opened under the hold, gives it back to the hold’s place', () => {
    const { ctx, m } = setup()
    const terminal = target('terminal', ctx)
    ctx.at.now = terminal
    const closeSettings = m.opened('settings', layer(), () => {}, terminal)
    const release = m.hold(() => {})
    closeSettings()
    const back = m.opened('settings', layer(), () => {}, null) // Settings shown again on Disk
    ctx.log.length = 0
    release()
    expect(ctx.log).toEqual([])
    back()
    expect(ctx.at.now).toBe(terminal)
  })

  it('U-MODAL-1 · cancelling everything ends the holds first, then each modal from the top down; a released hold lets the backdrop go', () => {
    const { m } = setup()
    const order: string[] = []
    m.opened('confirm', layer(), () => order.push('lower'), null)
    m.opened('confirm', layer(), () => order.push('top'), null)
    m.hold(() => order.push('sequence'))
    m.cancelAll()
    expect(order).toEqual(['sequence', 'top', 'lower'])
    expect(m.count).toBe(2) // the modals go when their owners close them
    const n = new Modals()
    n.hold(() => {})
    n.cancelAll()
    expect(n.open).toBe(false)
  })

  it('U-MODAL-1 · Esc that nothing handled cancels the top modal, wherever the keyboard is; not while an input method composes, nor once handled; between a sequence’s steps it ends the sequence', () => {
    const { ctx, m } = setup()
    const cancels: string[] = []
    m.opened('confirm', layer(), () => cancels.push('lower'), null)
    m.opened('confirm', layer(), () => cancels.push('top'), null)
    expect(ctx.esc({ composing: true })).toBe(false)
    expect(ctx.esc({ handled: true })).toBe(true)
    expect(cancels).toEqual([])
    expect(ctx.esc()).toBe(true)
    expect(cancels).toEqual(['top'])
    const h = setup()
    let ended = false
    h.m.hold(() => (ended = true))
    expect(h.ctx.esc()).toBe(true)
    expect([ended, h.m.open, h.ctx.listeners.size]).toEqual([true, false, 0])
  })
})
