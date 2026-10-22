import { describe, expect, it } from 'vitest'
import { systemOf, unavailable } from '../../../../packages/protocol/src/platform.ts'
import { darwin } from './darwin.ts'
import { packOs } from './index.ts'
import { linux } from './linux.ts'

describe("tools/pack's OS layer", () => {
  it("U-PLT-11 · tools/pack's layer: chosen once for this system; macOS has every capability; each one Linux lacks says why in one sentence", () => {
    expect(packOs).toBe(systemOf(process.platform) === 'linux' ? linux : darwin) // os-ok: the layer of the system this runs on (both run this suite)
    expect(unavailable(darwin)).toEqual([])
    expect(unavailable(linux).length).toBeGreaterThan(0)
    for (const u of unavailable(linux)) expect(u.reason, u.capability).toMatch(/^[A-Z][^\n]*\.$/)
  })
})
