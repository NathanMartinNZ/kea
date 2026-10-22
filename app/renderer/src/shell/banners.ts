// What the banner strip says: the settings file's state from `settings.status` and core's `banners` store, as lines.
// Pure, so the wording is tested without a window.

import type { Banner, SettingsStatus } from '@kea/protocol'

export interface BannerLine {
  key: string
  severity: 'warning' | 'error'
  message: string
  /** The fix in words, when the message does not say it. */
  fix: string | null
  /** The line offers "Open settings.json". */
  opensSettings: boolean
}

/** The parse error with its line and column, or the values that fell back to their defaults. */
export function settingsBanner(st: SettingsStatus | null): BannerLine | null {
  if (!st) return null
  if (st.error) {
    return {
      key: 'settings',
      severity: 'error',
      message: `settings.json has an error at line ${st.error.line}, column ${st.error.column}: ${st.error.message}.`,
      fix: 'Kea keeps using the last good settings until it is fixed.',
      opensSettings: true,
    }
  }
  if (st.notices.length) {
    const [first, ...rest] = st.notices
    return { key: 'settings', severity: 'warning', message: rest.length ? `${first!.message} (and ${rest.length} more)` : first!.message, fix: null, opensSettings: true }
  }
  return null
}

/** Every line, settings first, then core's banners: errors before warnings, older before newer. */
export function bannerLines(st: SettingsStatus | null, list: readonly Banner[]): BannerLine[] {
  const s = settingsBanner(st)
  const rest = [...list]
    .sort((a, b) => (a.severity === b.severity ? a.at - b.at : a.severity === 'error' ? -1 : 1))
    .map((b): BannerLine => ({ key: b.kind, severity: b.severity, message: b.message, fix: b.fix, opensSettings: false }))
  return [...(s ? [s] : []), ...rest]
}
