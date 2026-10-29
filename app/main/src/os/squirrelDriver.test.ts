// The macOS updater's driver against a stand-in MacUpdater, Squirrel and session, by electron-updater's own event names:
// ready only on Squirrel's event, the local server closed then, stalls ended by closing the session's connections, a
// prerelease taken as current, an inactive updater said so, each failure with its step, the log kept to one clean line.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdaterEvents, UpdaterInput } from '../updates/driver.ts'
import { cleanLine, driveUpdater, type MacUpdaterLike, type SessionLike } from './squirrelDriver.ts'

class FakeUpdater extends EventEmitter {
  logger: unknown = null
  autoDownload = true
  autoInstallOnAppQuit = false
  allowDowngrade = true
  allowPrerelease = true
  forceDevUpdateConfig = false
  updateConfigPath: string | null = null
  readonly currentVersion = { version: '1.0.2' }
  check = Promise.resolve<unknown>({})
  checkForUpdates = vi.fn(() => this.check)
  downloadUpdate = vi.fn(() => Promise.resolve([]))
  quitAndInstall = vi.fn()
  closeServerIfExists = vi.fn()
}

function setup(o: Partial<UpdaterInput> = {}) {
  const updater = new FakeUpdater()
  const native = new EventEmitter()
  const filters: { req: unknown; headers: unknown } = { req: null, headers: null }
  const ses = {
    webRequest: { onBeforeRequest: (l: unknown) => void (filters.req = l), onBeforeSendHeaders: (l: unknown) => void (filters.headers = l) },
    closeAllConnections: vi.fn(() => Promise.resolve()),
  } as unknown as SessionLike & { closeAllConnections: ReturnType<typeof vi.fn> }
  const events: string[] = []
  const on: UpdaterEvents = {
    checking: () => events.push('checking'),
    current: (v) => events.push(`current ${v}`),
    available: (v) => events.push(`available ${v}`),
    progress: (v, p) => events.push(`progress ${v} ${p}`),
    ready: (v) => events.push(`ready ${v}`),
    failed: (r, step) => events.push(`failed ${step}: ${r}`),
    inactive: () => events.push('inactive'),
  }
  const logged: string[] = []
  const madeWith: string[] = []
  const driver = driveUpdater(
    { make: (url) => (madeWith.push(url), updater as unknown as MacUpdaterLike), native: native as never, ses, home: '/Users/someone' },
    { url: 'https://github.com/o/n/releases/latest/download/', allowed: () => true, headers: { 'User-Agent': 'Kea' }, fetchTimeoutMs: 1000, stallMs: 5000, log: { info: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) }, on, ...o },
  )
  return { updater, native, ses, filters, events, logged, driver, madeWith }
}

const flush = () => new Promise((r) => setImmediate(r))

describe('the macOS updater’s driver', () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
  afterEach(() => void vi.useRealTimers())

  it('U-DST-17 · made on the feed with Kea’s options: no automatic download, install at quit, no downgrade or prerelease, filters on its session', () => {
    const { updater, madeWith, filters } = setup()
    expect(madeWith).toEqual(['https://github.com/o/n/releases/latest/download/'])
    expect(updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: true, allowDowngrade: false, allowPrerelease: false, forceDevUpdateConfig: false, updateConfigPath: null })
    expect(typeof filters.req).toBe('function')
    expect(typeof filters.headers).toBe('function')
    const test = setup({ testConfigPath: '/tmp/test-app-update.yml' })
    expect(test.updater).toMatchObject({ forceDevUpdateConfig: true, updateConfigPath: '/tmp/test-app-update.yml' })
  })

  it('U-DST-18 · ready comes only with Squirrel’s own event, after electron-updater’s; the local server is closed then; install quits and installs only once ready', async () => {
    const { updater, native, events, driver } = setup()
    driver.check()
    updater.emit('checking-for-update')
    updater.emit('update-available', { version: '1.0.3' })
    driver.download()
    updater.emit('download-progress', { percent: 41.7 })
    updater.emit('download-progress', { percent: 41.9 })
    driver.install()
    expect(updater.quitAndInstall, 'not before ready').not.toHaveBeenCalled()
    updater.emit('update-downloaded', { version: '1.0.3' })
    expect(events).toEqual(['checking', 'available 1.0.3', 'progress 1.0.3 41', 'progress 1.0.3 100'])
    expect(updater.closeServerIfExists).not.toHaveBeenCalled()
    native.emit('update-downloaded')
    expect(events.at(-1)).toBe('ready 1.0.3')
    expect(updater.closeServerIfExists).toHaveBeenCalledTimes(1)
    driver.install()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
    await flush()
  })

  it('U-DST-19 · a check with no answer in time, or a download with no progress, is ended by closing the session’s connections', () => {
    const { updater, ses, driver } = setup()
    driver.check()
    vi.advanceTimersByTime(999)
    expect(ses.closeAllConnections).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(ses.closeAllConnections).toHaveBeenCalledTimes(1)
    updater.emit('error', new Error('net::ERR_ABORTED'))
    updater.emit('update-available', { version: '1.0.3' })
    driver.download()
    vi.advanceTimersByTime(4000)
    updater.emit('download-progress', { percent: 10 })
    vi.advanceTimersByTime(4000)
    expect(ses.closeAllConnections, 'progress moves the deadline').toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(ses.closeAllConnections).toHaveBeenCalledTimes(2)
  })

  it('U-DST-20 · a prerelease is current, a null check is an inactive updater, and each failure names its step', async () => {
    const pre = setup()
    pre.driver.check()
    pre.updater.emit('update-available', { version: '1.1.0-rc.1' })
    expect(pre.events).toEqual(['current 1.0.2'])

    const off = setup()
    off.updater.check = Promise.resolve(null)
    off.driver.check()
    await flush()
    expect(off.events).toEqual(['inactive'])

    const f = setup()
    f.driver.check()
    f.updater.emit('error', new Error('HttpError: 404\nheaders…'))
    f.updater.emit('update-available', { version: '1.0.3' })
    f.driver.download()
    f.updater.emit('error', new Error('sha512 checksum mismatch'))
    f.updater.emit('update-available', { version: '1.0.3' })
    f.driver.download()
    f.updater.emit('update-downloaded', { version: '1.0.3' })
    f.updater.emit('error', new Error('Code signature at URL … did not pass validation'))
    expect(f.events.filter((e) => e.startsWith('failed'))).toEqual(['failed check: HttpError: 404', 'failed download: sha512 checksum mismatch', 'failed squirrel: Code signature at URL … did not pass validation'])
  })

  it('U-DST-21 · proxy authentication gets no credentials; dispose removes every listener, both filters, and closes the local server', () => {
    const { updater, native, filters, driver } = setup()
    const callback = vi.fn()
    updater.emit('login', {}, callback)
    expect(callback).toHaveBeenCalledWith()
    driver.dispose()
    for (const e of ['checking-for-update', 'update-not-available', 'update-available', 'download-progress', 'update-downloaded', 'error', 'login']) expect(updater.listenerCount(e), e).toBe(0)
    expect(native.listenerCount('update-downloaded')).toBe(0)
    expect(filters).toEqual({ req: null, headers: null })
    expect(updater.closeServerIfExists).toHaveBeenCalled()
  })

  it('U-DST-22 · what electron-updater logs is one line, without query strings, the home folder as ~', () => {
    expect(cleanLine('Downloading https://x.githubusercontent.com/a/b?X-Amz-Signature=secret&y=1 to /Users/someone/Library/Caches/kea-updater\nheaders: {…}', '/Users/someone')).toBe('Downloading https://x.githubusercontent.com/a/b to ~/Library/Caches/kea-updater')
    expect(cleanLine('x'.repeat(400), '')).toHaveLength(300)
  })
})
