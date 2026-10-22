import { systemOf, unavailable } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { darwin } from './darwin.ts'
import { coreOs } from './index.ts'
import { linux } from './linux.ts'

describe("core's OS layer", () => {
  it("U-PLT-11 · core's layer: chosen once for this system; macOS has every capability; each one Linux lacks says why in one sentence", () => {
    expect(coreOs).toBe(systemOf(process.platform) === 'linux' ? linux : darwin) // os-ok: the layer of the system this runs on (both run this suite)
    expect(unavailable(darwin)).toEqual([])
    expect(unavailable(linux).length).toBeGreaterThan(0)
    for (const u of unavailable(linux)) expect(u.reason, u.capability).toMatch(/^[A-Z][^\n]*\.$/)
  })
})
