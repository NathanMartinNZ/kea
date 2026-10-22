// The Settings sheet's own state. The sheet itself is the window's one sheet (`ui.sheet`, kind `settings`: the page it
// shows and, on Projects, the project picked); what is kept here outlives one opening: the page it showed last, and how
// the last "Reload shell environment" went (Advanced shows it; the palette runs the same call).

import type { SettingsDescription } from '@kea/protocol'
import { call } from '../../lib/rpc.ts'
import { failed, showToast, ui } from '../sessions/state.svelte.ts'

/** The first page (pages.ts gives the order). */
export const FIRST_PAGE = 'general'

/** The page Settings showed last in this window: `⌘,` comes back to it. */
let lastPage = FIRST_PAGE

/** Open Settings (`⌘,`) on `page` (default: the page it showed last); on Projects, with `projectId` picked. */
export function openSettings(page?: string, projectId: string | null = null): void {
  lastPage = page ?? lastPage
  ui.sheet = { kind: 'settings', page: lastPage, projectId }
}

/** Show another page of the open sheet. */
export function showPage(page: string, projectId: string | null = null): void {
  if (ui.sheet?.kind !== 'settings') return
  lastPage = page
  ui.sheet = { kind: 'settings', page, projectId }
}

export function closeSettings(): void {
  if (ui.sheet?.kind === 'settings') ui.sheet = null
}

// ── Reload shell environment ────────────────────────────────────────────────────────────────────────

export type EnvReload = { state: 'idle' } | { state: 'running' } | { state: 'done'; source: 'login-interactive' | 'login' | 'fallback' } | { state: 'failed'; message: string }

class SettingsUi {
  envReload = $state.raw<EnvReload>({ state: 'idle' })
}

export const settingsUi = new SettingsUi()

/** What the last reload found, in words (Advanced's status line). */
export function envReloadText(r: EnvReload): string {
  if (r.state === 'running') return 'Reloading…'
  if (r.state === 'failed') return `Not reloaded: ${r.message}`
  if (r.state === 'done') return r.source === 'fallback' ? 'The login shell gave no environment: Kea is using its fallback PATH.' : `Reloaded from your login shell${r.source === 'login' ? ' (without its interactive files)' : ''}. New terminals and agents get it.`
  return 'New terminals and agents get the environment of your login shell, resolved once per launch.'
}

/** `app.reloadShellEnv`: resolve the login-shell environment again (new PTYs get it; running ones keep theirs). */
export async function reloadShellEnv(): Promise<void> {
  if (settingsUi.envReload.state === 'running') return
  settingsUi.envReload = { state: 'running' }
  try {
    const r = await call('terminal.reloadShellEnv', {})
    settingsUi.envReload = { state: 'done', source: r.source }
    // success is never toasted; a fallback is a failure with no place of its own unless Advanced is open
    if (r.source === 'fallback' && !(ui.sheet?.kind === 'settings' && ui.sheet.page === 'advanced')) showToast({ message: envReloadText(settingsUi.envReload) })
  } catch (e) {
    settingsUi.envReload = { state: 'failed', message: e instanceof Error ? e.message : String(e) }
    if (!(ui.sheet?.kind === 'settings' && ui.sheet.page === 'advanced')) failed("Couldn't reload the shell environment", e)
  }
}

// ── the rows of the Agents section ──────────────────────────────────────────────────────────────────

let described: Promise<SettingsDescription> | null = null
/** Core's answer once it came: a page opened after it draws these rows at once. */
let answered: SettingsDescription | null = null

/**
 * Core's description of the settings: every row as this system offers them (no backup row on Linux, the
 * terminal app offering Automatic and this system's apps), the adapters' own keys included, and the adapters in
 * registry order. The window knows the global rows itself (`settingRows([])`, which leaves out only what this system
 * never has), so a generated page draws those until core answers; an adapter's keys live in core, so Agents waits for
 * it. Asked once per window and kept (the registry does not change while core runs); a failed ask is asked again next
 * time.
 */
export function describeSettings(): Promise<SettingsDescription> {
  described ??= call('settings.describe', {}).then(
    (d) => (answered = d),
    (e: unknown) => {
      described = null
      throw e
    },
  )
  return described
}

/** Core's description if it has answered, else null (`describeSettings`). */
export function describedNow(): SettingsDescription | null {
  return answered
}
