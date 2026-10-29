// The entry of `updater.cjs`, the macOS updater's bundle: electron-updater's MacUpdater, Electron's Squirrel.Mac and
// electron-updater's own session, handed to the driver (`squirrelDriver.ts`). Only the Mac app ships the bundle; main
// loads it only when it makes the updater (`os/darwin.ts`), so none of this code runs on Linux or in a build that
// does not update itself. It imports only types from Kea's packages: main hands in its log and everything else.

import { autoUpdater, session } from 'electron'
import { MacUpdater } from 'electron-updater/out/MacUpdater.js'
import type { MakeUpdater } from '../updates/driver.ts'
import { driveUpdater, type MacUpdaterLike } from './squirrelDriver.ts'

/** electron-updater's session (its `getNetSession`), made here first with the same options, so the filters are Kea's. */
const PARTITION = 'electron-updater'

export const makeUpdater: MakeUpdater = (input) =>
  driveUpdater({ make: (url) => new MacUpdater({ provider: 'generic', url }) as unknown as MacUpdaterLike, native: autoUpdater, ses: session.fromPartition(PARTITION, { cache: false }), home: process.env.HOME ?? '' }, input)
