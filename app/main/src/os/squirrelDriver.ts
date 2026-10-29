// The macOS updater's logic, with electron-updater's MacUpdater, Squirrel.Mac's events and the session handed in, so
// tests drive it with fakes. Bundled into `updater.cjs` by its entry, `squirrel.ts`; main never imports it.
//
// · Every request goes through electron-updater's own session, in memory, whose filters let through only Kea's
//   releases on GitHub and their asset hosts and set the headers (no identifier: Kea's patch also removes the one
//   electron-updater would send).
// · A check with no answer, or a download that stops making progress, is ended by closing that session's connections,
//   which fails the request and frees electron-updater's pending promise for the next check.
// · `ready` waits for Squirrel's own "update-downloaded" (it has fetched the zip from electron-updater's local proxy
//   and checked it), not electron-updater's, which fires when the proxy starts; the proxy is closed then.

import type { UpdaterDriver, UpdaterInput, UpdaterLog } from '../updates/driver.ts'
import { installUpdateFilters, type FilterSession } from '../updates/net.ts'

type Listener = (...args: never[]) => void

/** The parts of electron-updater's MacUpdater the driver uses. */
export interface MacUpdaterLike {
  logger: unknown
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  allowPrerelease: boolean
  forceDevUpdateConfig: boolean
  updateConfigPath: string | null
  readonly currentVersion: { version: string }
  on(event: string, listener: Listener): unknown
  removeListener(event: string, listener: Listener): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  closeServerIfExists(): void
}

/** Squirrel.Mac's events (Electron's native updater). */
export interface NativeUpdaterLike {
  on(event: 'update-downloaded', listener: () => void): unknown
  removeListener(event: 'update-downloaded', listener: () => void): unknown
}

/** The parts of an Electron session the driver uses. */
export interface SessionLike extends FilterSession {
  closeAllConnections(): Promise<void>
}

/** One line of what electron-updater logs: no query strings, no headers or bodies after it, the home folder as `~`. */
export function cleanLine(text: string, home: string): string {
  const first = text.split('\n')[0] ?? ''
  const noQuery = first.replace(/(https?:\/\/[^\s?#"']+)\?[^\s"']*/g, '$1')
  const noHome = home ? noQuery.split(home).join('~') : noQuery
  return noHome.slice(0, 300)
}

function wrapLog(log: UpdaterLog, home: string): UpdaterLog & { debug(msg: string): void } {
  const text = (m: unknown) => cleanLine(m instanceof Error ? m.message : String(m), home)
  return { info: (m) => log.info(text(m)), warn: (m) => log.warn(text(m)), error: (m) => log.error(text(m)), debug: () => {} }
}

const prerelease = (v: string) => v.includes('-')

/**
 * The driver over `make`'s MacUpdater (made with the generic feed at `url`), Squirrel's `native` events and the
 * updater's `ses`. `home` is replaced by `~` in what it logs.
 */
export function driveUpdater(deps: { make(url: string): MacUpdaterLike; native: NativeUpdaterLike; ses: SessionLike; home: string }, input: UpdaterInput): UpdaterDriver {
  const { native: nativeUpdater, ses, home } = deps
  const log = wrapLog(input.log, home)
  const removeFilters = installUpdateFilters(ses, input.allowed, input.headers, (url) => log.warn(`update request refused: ${url}`))

  const updater = deps.make(input.url)
  updater.logger = log
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = true
  updater.allowDowngrade = false
  updater.allowPrerelease = false
  if (input.testConfigPath) {
    // the test hooks' feed: an unpackaged build reads this file (provider, the stand-in's url, the cache folder's name)
    updater.forceDevUpdateConfig = true
    updater.updateConfigPath = input.testConfigPath
  }

  let step: 'idle' | 'check' | 'download' | 'squirrel' | 'ready' = 'idle'
  let version: string | null = null
  let percent = -1
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  /** End what is in flight when nothing has moved for `ms`: its request fails and the error below reports it. */
  const watch = (ms: number) => {
    clear()
    timer = setTimeout(() => {
      timer = null
      log.warn(`update ${step} made no progress: ending it`)
      void ses.closeAllConnections()
    }, ms)
  }

  const onChecking = () => input.on.checking()
  const onNone = (info: { version: string }) => {
    clear()
    step = 'idle'
    input.on.current(info.version)
  }
  const onAvailable = (info: { version: string }) => {
    clear()
    step = 'idle'
    if (prerelease(info.version)) return input.on.current(updater.currentVersion.version)
    version = info.version
    input.on.available(info.version)
  }
  const onProgress = (p: { percent: number }) => {
    if (step !== 'download' || !version) return
    watch(input.stallMs)
    const whole = Math.min(99, Math.max(0, Math.floor(p.percent)))
    if (whole === percent) return
    percent = whole
    input.on.progress(version, whole)
  }
  // electron-updater's: the zip is downloaded and checked; Squirrel fetches it from the proxy next
  const onDownloaded = () => {
    if (!version) return
    step = 'squirrel'
    watch(input.stallMs)
    input.on.progress(version, 100)
  }
  // Squirrel's: it has the update and its signature satisfies the running app's requirement
  const onSquirrelReady = () => {
    clear()
    if (!version) return
    step = 'ready'
    updater.closeServerIfExists()
    input.on.ready(version)
  }
  const onError = (e: unknown) => {
    clear()
    const was = step
    step = 'idle'
    const reason = cleanLine(e instanceof Error ? e.message : String(e), home)
    input.on.failed(reason, was === 'squirrel' || was === 'ready' ? 'squirrel' : was === 'download' ? 'download' : 'check')
  }
  // proxy authentication is answered with nothing, so the request fails at once instead of waiting for ever
  const onLogin = (_info: unknown, callback: () => void) => callback()

  const on = (event: string, l: (...a: never[]) => void) => updater.on(event, l)
  on('checking-for-update', onChecking)
  on('update-not-available', onNone)
  on('update-available', onAvailable)
  on('download-progress', onProgress)
  on('update-downloaded', onDownloaded)
  on('error', onError)
  on('login', onLogin)
  nativeUpdater.on('update-downloaded', onSquirrelReady)

  return {
    check() {
      if (step === 'check' || step === 'download' || step === 'squirrel' || step === 'ready') return
      step = 'check'
      watch(input.fetchTimeoutMs)
      updater.checkForUpdates().then(
        (r) => {
          if (r === null) {
            clear()
            step = 'idle'
            input.on.inactive()
          }
        },
        // the failure was reported through `error`
        () => {},
      )
    },
    download() {
      if (step !== 'idle' || !version) return
      step = 'download'
      percent = -1
      watch(input.stallMs)
      updater.downloadUpdate().catch(() => {})
    },
    install() {
      if (step !== 'ready') return
      updater.quitAndInstall()
    },
    dispose() {
      clear()
      updater.removeListener('checking-for-update', onChecking)
      updater.removeListener('update-not-available', onNone)
      updater.removeListener('update-available', onAvailable)
      updater.removeListener('download-progress', onProgress)
      updater.removeListener('update-downloaded', onDownloaded)
      updater.removeListener('error', onError)
      updater.removeListener('login', onLogin)
      nativeUpdater.removeListener('update-downloaded', onSquirrelReady)
      removeFilters()
      updater.closeServerIfExists()
    },
  }
}
