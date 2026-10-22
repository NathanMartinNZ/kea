import { describe, expect, it } from 'vitest'
import { onceForHome, SESSION_MODE_SHOWN_KEY, type Kv } from './banners.ts'

describe("the app's banners", () => {
  // The window shows the session-mode banner once per KEA_HOME: the first report records it (with when), and
  // every later one, from this ptyhost, a new one or the next launch of Kea, is not shown.
  it('U-PLT-14 · the session-mode banner is shown once per KEA_HOME: the first time records it, never again after', () => {
    const rows = new Map<string, string>()
    const kv: Kv = { get: (k) => rows.get(k), set: (k, v) => void rows.set(k, v) }
    expect(onceForHome(kv, SESSION_MODE_SHOWN_KEY, 1_000)).toBe(true)
    expect(rows.get(SESSION_MODE_SHOWN_KEY)).toBe('1000')
    expect(onceForHome(kv, SESSION_MODE_SHOWN_KEY, 2_000)).toBe(false)
    expect(rows.get(SESSION_MODE_SHOWN_KEY), 'the first time is kept').toBe('1000')
    const other = new Map<string, string>()
    expect(onceForHome({ get: (k) => other.get(k), set: (k, v) => void other.set(k, v) }, SESSION_MODE_SHOWN_KEY, 3_000), 'another KEA_HOME').toBe(true)
  })
})
