import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@kea/kit'
import { FRONT_LOG, installFrontGuard, stepsBack, type FrontSurfaces, type WakeSource } from './frontGuard.ts'

const SOURCES: readonly WakeSource[] = ['display', 'unlock', 'resume']

/** Electron's side of the guard as a test holds it: the listeners it installed, whether Kea is active, the hides asked. */
function surfaces(): FrontSurfaces & { active: boolean; t: number; hides: number; becomeActive(): void; wake(source: WakeSource): void; listeners: number } {
  const onActive: (() => void)[] = []
  const onWake: ((source: WakeSource) => void)[] = []
  const s = {
    active: false,
    t: 0,
    hides: 0,
    get listeners() {
      return onActive.length + onWake.length
    },
    onActive: (cb: () => void) => void onActive.push(cb),
    onWake: (cb: (source: WakeSource) => void) => void onWake.push(cb),
    isActive: () => s.active,
    // as macOS does it: a hidden app is not the active one
    hide: () => {
      s.hides++
      s.active = false
    },
    now: () => s.t,
    becomeActive: () => {
      s.active = true
      for (const cb of onActive) cb()
    },
    wake: (source: WakeSource) => {
      for (const cb of onWake) cb(source)
    },
  }
  return s
}

describe('a test build never stays the frontmost app', () => {
  it('U-HARN-1 · the decision: a test build steps back whenever it is the active app (it became active, or the display woke, was unlocked or the Mac resumed and found it active) and at no other time; a build that is no test build never does', () => {
    expect(stepsBack(true, { kind: 'active' })).toBe(true)
    for (const source of SOURCES) {
      expect(stepsBack(true, { kind: 'wake', source, active: true }), `${source}, Kea in front`).toBe(true)
      expect(stepsBack(true, { kind: 'wake', source, active: false }), `${source}, another app in front`).toBe(false)
      expect(stepsBack(false, { kind: 'wake', source, active: true }), `${source}, the real app`).toBe(false)
    }
    expect(stepsBack(false, { kind: 'active' }), 'the real app is meant to come to the front').toBe(false)
  })

  it('U-HARN-1 · installed: each time Kea is made the active app it hides at once and writes one error line saying what woke last and how long ago; a display that wakes with another app in front changes nothing; without --kea-perf nothing is installed', () => {
    const log = createMemoryLogger()
    const s = surfaces()
    installFrontGuard(true, s, log)
    expect(s.listeners, 'a fixed set: one for activation, one for the three wakes').toBe(2)
    const lines = () => log.entries.filter((e) => e.msg === FRONT_LOG).map((e) => ({ level: e.level, on: e.on, lastWake: e.lastWake, sinceWakeMs: e.sinceWakeMs }))

    // the display wakes with another app in front, as it nearly always does: nothing
    s.wake('display')
    expect([s.hides, lines()]).toEqual([0, []])

    // … and macOS then gives the front to Kea: back at once, with the cause
    s.t = 1500
    s.becomeActive()
    expect(s.hides).toBe(1)
    expect(lines()).toEqual([{ level: 'error', on: 'active', lastWake: 'display', sinceWakeMs: 1500 }])
    expect(s.active).toBe(false)

    // made active with no wake near it (the app in front quit, a click on the window): the same
    s.t = 900_000
    s.becomeActive()
    expect(s.hides).toBe(2)
    expect(lines().at(-1)).toEqual({ level: 'error', on: 'active', lastWake: 'display', sinceWakeMs: 900_000 })

    // found active at an unlock, without the activation having been heard
    s.t = 1_000_000
    s.active = true
    s.wake('unlock')
    expect(s.hides).toBe(3)
    expect(lines().at(-1)).toEqual({ level: 'error', on: 'wake (unlock)', lastWake: 'unlock', sinceWakeMs: 0 })
    s.wake('resume')
    expect(s.hides, 'hidden already: a resume finds another app in front').toBe(3)

    // the real app: no listener, so nothing can hide it
    const real = surfaces()
    const realLog = createMemoryLogger()
    installFrontGuard(false, real, realLog)
    expect(real.listeners).toBe(0)
    real.becomeActive()
    real.wake('display')
    expect([real.hides, real.active, realLog.entries.length]).toEqual([0, true, 0])
  })

  it('U-HARN-1 · before any wake the line says there was none', () => {
    const log = createMemoryLogger()
    const s = surfaces()
    installFrontGuard(true, s, log)
    s.becomeActive()
    expect(log.entries.map((e) => [e.level, e.msg, e.on, e.lastWake, e.sinceWakeMs])).toEqual([['error', FRONT_LOG, 'active', null, null]])
  })
})
