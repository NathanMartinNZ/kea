// ptyhost entry: an Electron utilityProcess, the only process that talks to the terminal holders. It takes
// `<KEA_HOME>/run/ptyhost.lock` (one ptyhost per home), answers main's heartbeat, serves `ptyhostApi` to core on the
// control port and attaches renderer streams.

import fs from 'node:fs'
import path from 'node:path'
import { createLogger, registerSingletonGauge, resources, tryLock } from '@kea/kit'
import { buildMismatch, fromElectronPort, isMainToChild, L, parseChildArgv, ptyhostApi, RpcPeer, type ChildToMain, type PtyhostNote } from '@kea/protocol'
import { installExceptionGuard } from './guard.ts'
import { PtyManager } from './manager.ts'

/** The build this bundle belongs to (tools/build.ts defines it); absent when the code runs unbundled. */
declare const __KEA_BUILD_ID__: string | undefined

/** The slice of Electron's `process.parentPort` used here (this package does not depend on electron). */
interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown; ports: unknown[] }) => void): void
  postMessage(message: unknown): void
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort
if (!parentPort) throw new Error('ptyhost must run as an Electron utilityProcess')

const args = parseChildArgv(process.argv)
const send = (m: ChildToMain) => parentPort.postMessage(m)

fs.mkdirSync(path.join(args.home, 'run'), { recursive: true, mode: 0o700 })
fs.mkdirSync(path.join(args.home, 'logs'), { recursive: true, mode: 0o700 })
// A ptyhost from another build than main's (a package manager replaced Kea's files under a running Kea) stops here,
// before it takes the lock or opens anything, with the exit code main reads as "Kea's files changed"
const ownBuild = typeof __KEA_BUILD_ID__ === 'string' ? __KEA_BUILD_ID__ : undefined
if (buildMismatch(ownBuild, args.build)) {
  createLogger({ dir: path.join(args.home, 'logs'), process: 'ptyhost', level: 'info' }).warn('started from another build than main: exiting', { build: ownBuild, main: args.build })
  process.exit(L.childBuildMismatchExit)
}
const lockPath = path.join(args.home, 'run', 'ptyhost.lock')
let lock: ReturnType<typeof tryLock>
try {
  lock = tryLock(lockPath)
} catch (err) {
  // the lock could not be tried at all (Linux: a run directory that is not the user's alone, no `flock`, a file system
  // without locks): said in this process's own log before it exits, as nothing else would show it
  createLogger({ dir: path.join(args.home, 'logs'), process: 'ptyhost', level: 'info' }).error('instance lock not taken', { lock: lockPath, error: String(err) })
  throw err
}
if (!lock) {
  send({ k: 'locked', path: lockPath })
  process.exit(3)
}

const log = createLogger({ dir: path.join(args.home, 'logs'), process: 'ptyhost', level: args.dev ? 'debug' : 'info' })
let control: RpcPeer | null = null
const notes: PtyhostNote[] = [] // bounded: L.ptyhostNotesMax (notifications queued for core), raised while core is away
const notify = (n: PtyhostNote) => {
  if (control && !control.isDisposed) control.notify(n.m, n.a)
  else if (notes.length < L.ptyhostNotesMax) notes.push(n)
}
// tier 3's activity notes are only worth something live: dropped while core is away, never queued
const notifyLive = (n: PtyhostNote) => {
  if (control && !control.isDisposed) control.notify(n.m, n.a)
}
// the resource-report rows held here: core's control connection, and the notes queued while core is away
registerSingletonGauge('ptyhost.control', () => (control && !control.isDisposed ? 1 : 0))
registerSingletonGauge('ptyhost.notesQueued', () => notes.length)

const manager = new PtyManager(
  // The client requirement is always derived from this process's own executable (on macOS its code signature), never
  // from the environment.
  { home: args.home, helperSource: args.helper ?? '', keaVersion: args.version, dev: args.dev },
  { log, notify, notifyLive },
)

// An exception from inside a mirror rebuilds that mirror; any other one ends ptyhost
installExceptionGuard(process, manager, log, (code) => process.exit(code))

parentPort.on('message', (e) => {
  const m = e.data
  if (!isMainToChild(m)) return
  switch (m.k) {
    case 'ping':
      send({ k: 'pong', n: m.n })
      return
    case 'control': {
      const port = e.ports[0]
      if (!port) return
      control?.dispose()
      control = new RpcPeer(fromElectronPort(port as never), { name: 'ptyhost', api: ptyhostApi, handlers: manager.handlers(), onError: (err) => log.warn('control port error', { error: String(err) }) })
      for (const n of notes.splice(0)) control.notify(n.m, n.a)
      return
    }
    case 'stream': {
      const port = e.ports[0]
      if (port) manager.attachStream(m.ptyId, fromElectronPort(port as never), m.connId)
      return
    }
    case 'disconnect':
      // The window went away (reload, crash, close); its stream ports are closed on this end too
      manager.disconnect(m.connId)
      return
    case 'report':
      // main's collection (the hourly resources.ndjson line, watchdog triggers)
      send({ k: 'report', id: m.id, report: resources.report() })
      return
    case 'shutdown':
      manager.shutdown()
      control?.dispose()
      log.info('shutdown')
      lock.dispose()
      process.exit(0)
      return
    case 'rpc':
      return
  }
})

log.info('started', { pid: process.pid, home: args.home, version: args.version })

// perf harness only (main passes it only under --kea-perf): a stand-in for a snapshot serialisation stall
if (args.perfBusy) {
  const { ms, everyMs } = args.perfBusy
  log.warn('perf: injecting event-loop stalls', { ms, everyMs })
  setInterval(() => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      // busy on purpose
    }
  }, everyMs).unref()
}
void manager.adoptAll().then((r) => {
  if (r.adopted.length || r.failed.length) log.info('holders adopted', { adopted: r.adopted.length, failed: r.failed.length })
})
send({ k: 'ready' })
