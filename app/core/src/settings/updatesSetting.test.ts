import { describe, expect, it } from 'vitest'
import { watchUpdatesSetting } from './updatesSetting.ts'

describe('watchUpdatesSetting', () => {
  it('U-DST-50 · sends the switch at once, then only when it changes', () => {
    let value = true
    let changed: (() => void) | null = null
    const sent: boolean[] = []
    const off = watchUpdatesSetting({
      check: () => value,
      onSettings: (cb) => {
        changed = cb
        return () => {
          changed = null
        }
      },
      send: (v) => sent.push(v),
    })
    expect(sent).toEqual([true])
    changed!()
    expect(sent).toEqual([true])
    value = false
    changed!()
    changed!()
    expect(sent).toEqual([true, false])
    value = true
    changed!()
    expect(sent).toEqual([true, false, true])
    off()
    expect(changed).toBeNull()
  })
})
