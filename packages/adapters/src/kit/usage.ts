// Shared usage-limit setting and window helpers for adapters that report `account.usage`: the setting key and toggle
// definition (`agents.<id>.usageLimits`, on by default), percentage clamping, and deterministic window ordering and
// capping.

import { z } from 'zod'
import { compareUsageWindows, L, type SettingDef, type UsageWindow } from '@kea/protocol'
import type { AgentSettingsLike } from '../types.ts'

/** The per-agent setting key (`agents.<id>.usageLimits`) that turns usage-limit reporting on. */
export const USAGE_LIMITS_KEY = 'usageLimits'

/** Whether `agents.<id>.usageLimits` is on: true unless explicitly set to `false`. */
export function usageLimitsOn(settings: Pick<AgentSettingsLike, string>): boolean {
  return settings[USAGE_LIMITS_KEY] !== false
}

/** Build the `Show usage limits` toggle definition for an adapter's `AgentSettingsExtension.keys`. */
export function usageLimitsSetting(help: string): SettingDef {
  return {
    key: USAGE_LIMITS_KEY,
    schema: z.boolean(),
    default: true,
    label: 'Show usage limits',
    help,
    section: 'Agents',
    control: 'toggle',
  }
}

/** Clamp a usage percentage to `[0, 100]`. */
export function clampUsagePct(pct: number): number {
  return Math.min(100, Math.max(0, pct))
}

/**
 * Copy, sort (`priority ?? 50` ascending, then `id` lexicographically) and cap `windows` at `max`
 * (`L.usageWindowsMax` by default).
 */
export function sortUsageWindows<T extends Pick<UsageWindow, 'id' | 'priority'>>(windows: readonly T[], max: number = L.usageWindowsMax): T[] {
  return [...windows].sort(compareUsageWindows).slice(0, Math.max(0, max))
}
