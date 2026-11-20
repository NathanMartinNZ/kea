import { L, type UsageWindow } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { clampUsagePct, sortUsageWindows, USAGE_LIMITS_KEY, usageLimitsOn, usageLimitsSetting } from './usage.ts'

const win = (id: string, priority?: number, usedPct = 25): UsageWindow => ({
  id,
  shortLabel: id,
  tipLabel: `Tip ${id}`,
  spokenLabel: id,
  ...(priority !== undefined ? { priority } : {}),
  usedPct,
  resetsAt: 1_794_426_600_000,
})

describe('adapters/kit usage helpers', () => {
  it('U-ST-26 · usageLimitsOn defaults to true and turns off only when usageLimits is false; usageLimitsSetting builds the Agents toggle definition', () => {
    expect(USAGE_LIMITS_KEY).toBe('usageLimits')
    expect(usageLimitsOn({ extraArgs: [], env: {}, allowDangerousModes: false })).toBe(true)
    expect(usageLimitsOn({ extraArgs: [], env: {}, allowDangerousModes: false, usageLimits: undefined })).toBe(true)
    expect(usageLimitsOn({ extraArgs: [], env: {}, allowDangerousModes: false, usageLimits: true })).toBe(true)
    expect(usageLimitsOn({ extraArgs: [], env: {}, allowDangerousModes: false, usageLimits: false })).toBe(false)

    const def = usageLimitsSetting('Shows how much of your quota has been used.')
    expect(def).toMatchObject({
      key: 'usageLimits',
      default: true,
      label: 'Show usage limits',
      help: 'Shows how much of your quota has been used.',
      section: 'Agents',
      control: 'toggle',
    })
    expect(def.schema.safeParse(true).success).toBe(true)
    expect(def.schema.safeParse(false).success).toBe(true)
    expect(def.schema.safeParse('true').success).toBe(false)
  })

  it('U-ST-26 · clampUsagePct clamps percentages to 0..100 and sortUsageWindows orders by priority (default 50) then id and caps at max', () => {
    expect(clampUsagePct(-12)).toBe(0)
    expect(clampUsagePct(0)).toBe(0)
    expect(clampUsagePct(42.75)).toBe(42.75)
    expect(clampUsagePct(100)).toBe(100)
    expect(clampUsagePct(145)).toBe(100)

    const input = [win('zeta'), win('beta', 10), win('alpha', 10), win('gamma', 1), win('delta', 80), win('aardvark')]
    const before = [...input]
    const sorted = sortUsageWindows(input)
    expect(input, 'does not mutate input').toEqual(before)
    expect(sorted.map((w) => w.id)).toEqual(['gamma', 'alpha', 'beta', 'aardvark'].slice(0, L.usageWindowsMax))
    expect(sortUsageWindows(input, 6).map((w) => w.id)).toEqual(['gamma', 'alpha', 'beta', 'aardvark', 'zeta', 'delta'])
    expect(sortUsageWindows(input, 2).map((w) => w.id)).toEqual(['gamma', 'alpha'])
    expect(sortUsageWindows(input, 0)).toEqual([])
  })
})
