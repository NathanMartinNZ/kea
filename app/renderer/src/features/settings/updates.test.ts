// What the window shows of main's update state: About's line and its one action for every state, the footer's line
// (✕ only where running on is harmless), the command's title, how often Kea checks in words, and About drawn with it.
import { render } from 'svelte/server'
import { describe, expect, it, vi } from 'vitest'
import { NO_UPDATE_STATE, type UpdateState } from '@kea/protocol'

let push: ((s: UpdateState) => void) | null = null
vi.mock('../../lib/bridge.ts', () => ({ onUpdateState: (cb: (s: UpdateState) => void) => ((push = cb), () => undefined) }))

const { aboutUpdate, checkInterval, footerUpdate, lastCheckedText, releaseNotesUrl, updates, updateTitle } = await import('./updates.ts')
const { default: AboutView } = await import('./AboutView.svelte')

const SH = 'curl -fsSL https://github.com/NathanMartinNZ/kea/releases/latest/download/install.sh | sh'
const at = (o: Partial<UpdateState>): UpdateState => ({ ...NO_UPDATE_STATE, mode: 'command', auto: true, command: SH, ...o })
const none = { dismissed: () => false, notice: false }

describe('the update state in the window', () => {
  it('U-DST-44 · About’s line and action for each state, by how this Kea is updated', () => {
    expect(aboutUpdate(at({ phase: { k: 'checking' } }))).toMatchObject({ line: 'Checking for updates…', action: null })
    expect(aboutUpdate(at({ phase: { k: 'current', version: '1.0.2' } }))).toMatchObject({ line: 'Kea 1.0.2 is the newest version.', action: 'check', notes: null })
    expect(aboutUpdate(at({ mode: 'updater', phase: { k: 'downloading', version: '1.0.3', percent: 40 } }))).toMatchObject({ line: 'Downloading Kea 1.0.3… 40 %', action: null, notes: '1.0.3' })
    expect(aboutUpdate(at({ mode: 'updater', phase: { k: 'ready', version: '1.0.3' } }))).toMatchObject({ line: 'Kea 1.0.3 is ready. Kea restarts; sessions keep running.', action: 'restartUpdate' })
    expect(aboutUpdate(at({ phase: { k: 'available', version: '1.0.3' } }))).toEqual({ line: `Kea 1.0.3 is out. Quit Kea completely (sessions keep running), then run \`${SH}\`.`, action: 'copy', notes: '1.0.3', command: SH })
    expect(aboutUpdate(at({ mode: 'packageManager', auto: false, command: 'sudo apt update && sudo apt install --only-upgrade kea-app', phase: { k: 'available', version: '1.0.3' } })).line).toBe('Kea 1.0.3 is out. Your system’s updates install it, or run `sudo apt update && sudo apt install --only-upgrade kea-app`.')
    expect(aboutUpdate(at({ command: `${SH} -s -- --no-repo`, phase: { k: 'available', version: '1.0.3' } })).line).toBe(`Kea 1.0.3 is out. Run \`${SH} -s -- --no-repo\`.`)
    expect(aboutUpdate(at({ phase: { k: 'upgraded', version: '1.0.3' } }))).toMatchObject({ line: 'Kea was updated to 1.0.3. Restart Kea to use it; sessions keep running.', action: 'restartKea' })
    expect(aboutUpdate(at({ phase: { k: 'upgraded', version: null } })).line).toBe('Kea was updated. Restart Kea to use it; sessions keep running.')
    expect(aboutUpdate(at({ phase: { k: 'didNotInstall', version: '1.0.3' } }))).toMatchObject({ line: 'Kea 1.0.3 did not install. Install it with the command instead.', action: 'copy' })
    expect(aboutUpdate(at({ phase: { k: 'failed', reason: 'GitHub answered 503' } }))).toMatchObject({ line: 'Couldn’t check for updates: GitHub answered 503. Kea tries again at the next check.', action: 'retry' })
    expect(aboutUpdate(at({ phase: { k: 'removed' } })).action).toBeNull()
    expect(aboutUpdate(NO_UPDATE_STATE)).toMatchObject({ line: 'This build was not installed from a release, so it does not check for updates.', action: null })
    expect(releaseNotesUrl('1.0.3')).toBe('https://github.com/NathanMartinNZ/kea/releases/tag/v1.0.3')
  })

  it('U-DST-45 · the footer: "is out" with ✕ until dismissed for that version, ready and updated without ✕ (a click restarts), the one-time line saying how often Kea checks', () => {
    expect(footerUpdate(at({ phase: { k: 'available', version: '1.0.3' } }), none)).toEqual({ kind: 'out', text: 'Kea 1.0.3 is out', click: 'about', close: true, version: '1.0.3', action: null })
    expect(footerUpdate(at({ phase: { k: 'available', version: '1.0.3' } }), { dismissed: (v) => v === '1.0.3', notice: false })).toBeNull()
    expect(footerUpdate(at({ phase: { k: 'ready', version: '1.0.3' } }), none)).toMatchObject({ text: 'Kea 1.0.3 is ready — Restart to Update', click: 'restart', close: false, action: 'Restart to Update' })
    expect(footerUpdate(at({ phase: { k: 'upgraded', version: '1.0.3' } }), none)).toMatchObject({ text: 'Kea was updated — Restart Kea', click: 'restart', close: false, action: 'Restart Kea' })
    expect(footerUpdate(at({}), { dismissed: () => false, notice: true })).toMatchObject({ kind: 'notice', text: 'Kea checks GitHub once a day for a newer version · Settings', close: true, action: 'Settings' })
    expect(footerUpdate(at({ phase: { k: 'current', version: '1.0.2' } }), none)).toBeNull()
    // a line's action is the end of its text, which the footer keeps whole on one line
    for (const phase of [{ k: 'ready', version: '1.0.3' }, { k: 'upgraded', version: null }] as const) {
      const line = footerUpdate(at({ phase }), none)!
      expect(line.text.endsWith(` ${line.action}`), line.text).toBe(true)
    }
    expect(checkInterval(86_400_000)).toBe('once a day')
    expect(checkInterval(43_200_000)).toBe('every 12 hours')
    expect(checkInterval(172_800_000)).toBe('every 2 days')
  })

  it('U-DST-46 · the command’s title follows the state; the store keeps the one-time line in this window after main stops saying it is due, until ✕', () => {
    expect(updateTitle(at({ phase: { k: 'ready', version: '1.0.3' } }))).toBe('Restart to Update')
    expect(updateTitle(at({ phase: { k: 'upgraded', version: null } }))).toBe('Restart Kea')
    expect(updateTitle(at({ phase: { k: 'available', version: '1.0.3' } }))).toBe('Check for Updates…')
    const seen = vi.fn()
    const off = updates.subscribe(seen)
    push!(at({ notice: true }))
    expect(updates.notice).toBe(true)
    push!(at({ notice: false }))
    expect(updates.notice, 'still shown here').toBe(true)
    updates.closeNotice()
    expect(updates.notice).toBe(false)
    updates.dismiss('1.0.3')
    expect(updates.dismissed('1.0.3')).toBe(true)
    expect(seen).toHaveBeenCalledTimes(4)
    off()
    expect(lastCheckedText(null)).toBeNull()
    expect(lastCheckedText(Date.UTC(2026, 9, 29, 14, 5), Date.UTC(2026, 9, 29, 18, 0))).toMatch(/^Last checked /)
  })

  it('U-DST-47 · About draws Updates between Built and This system: the line with its command as code, the action, Release notes, Last checked, why the updater is not used', () => {
    const build = { version: '1.0.2', arch: 'arm64', commit: null, date: null }
    const u = { about: aboutUpdate(at({ phase: { k: 'available', version: '1.0.3' } })), last: 'Last checked 14:05', why: 'Kea cannot change the folder it is in, so it does not update itself.', notesUrl: releaseNotesUrl('1.0.3') }
    const page = render(AboutView, { props: { build, report: null, updates: u } }).body
    expect(page.indexOf('data-build-date')).toBeLessThan(page.indexOf('id="updates-heading"'))
    expect(page.indexOf('id="updates-heading"')).toBeLessThan(page.indexOf('id="platform-heading"'))
    expect(page).toContain(`<code>${SH}</code>`)
    expect(page).toMatch(/data-update-action="copy"[^>]*>Copy Command</)
    expect(page).toMatch(/data-update-notes[^>]*>Release notes</)
    expect(page).toMatch(/data-update-last[^>]*>Last checked 14:05</)
    expect(page).toMatch(/data-update-why[^>]*>Kea cannot change the folder/)
    expect(render(AboutView, { props: { build, report: null } }).body, 'no block without a state').not.toContain('updates-heading')
  })
})
