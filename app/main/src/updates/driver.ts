// The macOS updater as main sees it: a driver over the updater library and Squirrel.Mac, which lives in its own bundle
// (`updater.cjs`, built from `os/squirrel.ts`) that only the Mac app ships and main loads only when it makes one.
// Types only, so importing this file brings none of the updater's code into main's bundle.

/** What the driver tells main, in the order an update goes through them. */
export interface UpdaterEvents {
  checking(): void
  /** The feed's version is not newer (or is a prerelease). */
  current(version: string): void
  /** A newer version is out; main decides whether to download it. */
  available(version: string): void
  /** Download progress in whole percents; 100 while Squirrel fetches and checks the zip. */
  progress(version: string, percent: number): void
  /** Squirrel has the update and has checked its signature: Restart to Update can run. */
  ready(version: string): void
  /** A step failed; `squirrel` when Squirrel itself refused, so main falls back to the command. */
  failed(reason: string, step: 'check' | 'download' | 'squirrel'): void
  /** The updater does not run in this build (not packaged, no test feed): nothing will answer. */
  inactive(): void
}

export interface UpdaterLog {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export interface UpdaterInput {
  /** The generic feed's base, `releases/latest/download/`. */
  url: string
  /** Whether a request may go to this URL: Kea's repository's releases on GitHub and its release-asset hosts. */
  allowed(url: string): boolean
  /** The headers every request carries (no identifier). */
  headers: Readonly<Record<string, string>>
  fetchTimeoutMs: number
  stallMs: number
  log: UpdaterLog
  on: UpdaterEvents
  /** Test hooks only: an `app-update.yml` with the stand-in feed, for an unpackaged dev build. */
  testConfigPath?: string
}

export interface UpdaterDriver {
  /** Ask the feed. Answers through `on`; one check at a time. */
  check(): void
  /** Download the version `available` named. */
  download(): void
  /** Quit and install: Squirrel swaps the bundle after Kea quits and opens the new one. */
  install(): void
  dispose(): void
}

/** What `updater.cjs` exports. */
export type MakeUpdater = (input: UpdaterInput) => UpdaterDriver
