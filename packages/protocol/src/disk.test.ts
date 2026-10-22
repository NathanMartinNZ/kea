import { describe, expect, it } from 'vitest'
import { formatBytes, isStale, zDiskUsage } from './disk.ts'
import { L } from './generated/limits.ts'

const DAY = 86_400_000

describe('the Disk view’s shared rules', () => {
  it('U-WT-13 · stale: not on screen now and not shown for L.diskStaleDays days, counted from creation when never shown', () => {
    const now = 1_800_000_000_000
    const created = { createdAt: now - 30 * DAY }
    const row = (viewedAt: number | null, visible = false) => ({ visible, viewedAt })
    const edge = now - L.diskStaleDays * DAY

    expect(isStale(now, created, row(edge))).toBe(true)
    expect(isStale(now, created, row(edge + 1))).toBe(false)
    expect(isStale(now, created, row(now - 20 * DAY))).toBe(true)
    // on screen now: never stale, however old the last note
    expect(isStale(now, created, row(now - 20 * DAY, true))).toBe(false)
    // never shown since Kea began to note it: its age decides
    expect(isStale(now, created, row(null))).toBe(true)
    expect(isStale(now, { createdAt: edge + 1 }, row(null))).toBe(false)
    expect(isStale(now, { createdAt: edge }, row(null))).toBe(true)
    // no row yet (the store has not arrived): the same rule
    expect(isStale(now, created, undefined)).toBe(true)
    expect(isStale(now, { createdAt: now }, undefined)).toBe(false)
  })

  it('U-WT-14 · sizes are written in decimal units, one decimal below 10 of a unit; a row holds whole byte counts only', () => {
    expect(formatBytes(0)).toBe('0 bytes')
    expect(formatBytes(1)).toBe('1 byte')
    expect(formatBytes(999)).toBe('999 bytes')
    expect(formatBytes(1000)).toBe('1.0 KB')
    expect(formatBytes(4_200_000)).toBe('4.2 MB')
    expect(formatBytes(9_940_000)).toBe('9.9 MB')
    expect(formatBytes(9_960_000)).toBe('10 MB')
    expect(formatBytes(13_400_000_000)).toBe('13 GB')
    expect(formatBytes(999_600_000)).toBe('1000 MB')
    expect(formatBytes(2_500_000_000_000)).toBe('2.5 TB')
    expect(formatBytes(5e15)).toBe('5000 TB')
    for (const bad of [-1, Number.NaN, Infinity]) expect(formatBytes(bad)).toBe('—')

    const ok = { bytes: 4096, rebuildableBytes: 0, capped: false, at: 1, measuring: false, visible: true, viewedAt: null }
    expect(zDiskUsage.safeParse(ok).success).toBe(true)
    expect(zDiskUsage.safeParse({ ...ok, bytes: null, rebuildableBytes: null, at: null }).success).toBe(true)
    for (const bad of [{ bytes: -1 }, { bytes: 1.5 }, { rebuildableBytes: -1 }, { capped: 1 }]) expect(zDiskUsage.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false)
  })
})
