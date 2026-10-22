// Test hook for core and ptyhost. A dev main run with `--kea-perf` loads it into both utility processes before their
// own code, through NODE_OPTIONS (app/main/src/testHooks.ts); nothing else loads it. It changes nothing until asked: it
// answers `{ k: 'kea-test', id, op, arg }` on parentPort with `{ k: 'kea-test', id, ok, value | error }`, which main
// relays to the harness (`__keaTest.debug`) and the child's own handler ignores (`isMainToChild` is false for them).
//
// Ops:
//   gc        forced full GC, twice (`--expose-gc` set at runtime, `gc` taken from a fresh context)
//   heap      v8.getHeapStatistics() + process.memoryUsage()
//   handles   process.getActiveResourcesInfo(), counted by type (sockets, timers, …)
//   kit       kit's resource report, read from the bundle's registry at Symbol.for('kea.kit.resources')
//   ports     live MessagePortMain objects (v8.queryObjects, which collects garbage first); null until main sends its
//             first port (the control port), whose constructor it counts
//   snapshot  v8.writeHeapSnapshot(arg): a heap snapshot for a failure report
//   streams   the StreamToRenderer `snapshot` and `data` messages posted since the last `streams reset`, with their
//             sizes, counted by wrapping MessagePortMain's postMessage (a renderer far behind gets a snapshot)
//   fault     on the next turn of the event loop, `throw` an uncaught exception or `reject` a promise nothing handles
//             (core's guard logs it and exits 1)
//   hold      `<point>|<file>`: the next time core passes that fault point (`create:<step>`, `delete:<stage>`,
//             `restore:<step>`; app/core/src/main.ts reads Symbol.for('kea.test.faults')), the session's id is written
//             to <file> and the operation waits for good, so the harness can kill the app at exactly that point
//   status    core only, through the status engine core hands this hook (app/core/src/status/seam.ts).
//             `{ deltas, chunk, everyMs, title }`: a storm of `deltas` inputs across every live session, `chunk` every
//             `everyMs`, applied as the hook intake does. Each session gets whole turns (a tool, a permission prompt
//             raised and answered), a `meta` context reading, then the title `title`, so every storm leaves each
//             session in the same state but its title; `deltas / sessions − 2` must be a multiple of 6. Answers when
//             done, with the engine's resource counts. `{ ingest: { sessionId, source, events } }`: one input as an
//             adapter's intake applies it, for a state the fake agent cannot reach (`at` defaults to now);
//             `{ statusFile: { sessionId, reading } }`: one reading of the agent's status file. Both answer
//             `{ applied, phase }` at once
//   lateReplies  `<ms>`: every later RPC reply (`{ k: 'res' }`) leaves `ms` late, in order, while store deltas and the
//             rest go at once; in core, the window then hears of a change before the reply to the call that made it
//             (as from a restarted core whose first reconciliation lists a shell being spawned). `0` turns it off
//   timers    `start` / `stop`: a watch over this process's timers (timer-watch.cjs) for the idle budget's
//             `max_timer_hz` (P-CPU-2); `stop` answers `{ seconds, timers: [{ delayMs, repeat, fired }], callbacks }`
//             since `start`. `plant:<ms>` arms an interval that does nothing, the stray the watch must see, and
//             `unplant` clears it; `wander:<ms>` arms a timeout that re-arms itself 1 ms later each time, so no two
//             fires share a delay
//   alloc     `<bytes>`: real allocations past the watchdog's hard limit, in buffers with every page written, outside
//             V8's heap so its cap does not end the process first; a later `alloc` replaces them, `0` frees them
//   scan      `[[code, …], …]` (each marker as its character codes): every live ArrayBuffer and typed array's buffer
//             searched for the markers (buffer-scan.cjs), found through an in-process inspector session
//             (`Runtime.queryObjects`, which collects garbage first). `{ needles, plant: [code, …] }` adds the control:
//             this hook holds `plant` while it searches, so a search that sees this process's buffers reports it
//   children  the children this process started through `child_process.spawn` (kit's runProcess), which this hook
//             wraps before the bundle loads, since the bundle calls it through the module object: `{ now, live,
//             ended }`, each `{ pid, argv, startedAt, exitedAt, closedAt }` (Date.now(); null until then). `live` are
//             not closed yet; `ended` the last CHILDREN_ENDED to close, newest last. It names what `kit.children`
//             counted
'use strict'

// Nothing the child starts (the login-shell probe, holders, shells) may inherit the hook.
delete process.env.NODE_OPTIONS

const asyncHooks = require('node:async_hooks')
const fs = require('node:fs')
const v8 = require('node:v8')
const vm = require('node:vm')
const { scanBuffers, BUFFERS, VIEWS } = require('./buffer-scan.cjs')
const { createTimerWatch } = require('./timer-watch.cjs')

// Under the harness, editors, `open` and `gh` are looked for only under the run's own HOME (an empty folder of the
// harness's: tools/perf/src/launch.ts refuses the real one), so no test starts the user's editor, browser or terminal
// app. Core's main.ts reads this at start (app/core/src/editor/host.ts `sandboxEditorHost`).
globalThis[Symbol.for('kea.test.editor')] = process.env.HOME || '/var/empty'

// Every child this process starts, by argv (the `children` op). Wrapped before the bundle loads, so kit's runProcess
// (`(0, import_node_child_process.spawn)(…)` in the CommonJS bundle) calls the wrapper.
const CHILDREN_ENDED = 32
const liveChildren = new Set() // bounded: the children alive now (runProcess's pools and held children)
const endedChildren = [] // bounded: CHILDREN_ENDED, the oldest dropped first
const childProcess = require('node:child_process')
const spawn = childProcess.spawn
childProcess.spawn = function (file, args, ...rest) {
  const child = spawn.call(this, file, args, ...rest)
  const entry = { pid: child.pid ?? null, argv: [String(file), ...(Array.isArray(args) ? args.map(String) : [])], startedAt: Date.now(), exitedAt: null, closedAt: null }
  liveChildren.add(entry)
  child.once('exit', () => {
    entry.exitedAt = Date.now()
  })
  // a child that never spawned emits `error` and `close`; one that did, `exit` then `close` once its pipes are shut
  child.once('close', () => {
    entry.closedAt = Date.now()
    liveChildren.delete(entry)
    endedChildren.push(entry)
    if (endedChildren.length > CHILDREN_ENDED) endedChildren.shift()
  })
  return child
}

// core hands its status engine over at start (app/core/src/status/seam.ts), before `install` runs: set it now
let statusEngine = null
globalThis[Symbol.for('kea.test.status')] = (engine) => {
  statusEngine = engine
}
const TURN = [
  { t: 'turn.started' },
  { t: 'tool.started', name: 'Bash', summary: 'npm test' },
  { t: 'attention.permission', key: 'Bash: npm test', tool: 'Bash', summary: 'npm test' },
  { t: 'attention.cleared', key: 'Bash: npm test' },
  { t: 'tool.finished', name: 'Bash', summary: 'npm test', ok: true },
  { t: 'turn.finished', backgroundWork: false, lastMessage: 'done' },
]

// `process.parentPort` is set up after preloaded modules run and before the entry's first tick.
process.nextTick(install)

function install() {
  const parent = process.parentPort
  if (!parent) return
  let gc = null
  let Port = null
  const timerWatch = createTimerWatch(asyncHooks)
  const streams = { snapshots: 0, snapshotChars: 0, data: 0, dataBytes: 0 }
  // `alloc`'s buffers: outside V8's heap (its old space is capped at the watchdog's hard limit), so they reach the
  // footprint the watchdog reads without V8 ending the process first
  const held = [] // bounded: one `alloc` request's buffers, replaced by the next
  const ALLOC_CHUNK = 64 * 1024 * 1024
  let lateMs = 0
  const delayReplies = (P) => {
    const post = P.prototype.postMessage
    P.prototype.postMessage = function (m, ...rest) {
      if (lateMs > 0 && m && m.k === 'res') {
        setTimeout(() => post.call(this, m, ...rest), lateMs)
        return undefined
      }
      return post.call(this, m, ...rest)
    }
  }
  const countStreams = (P) => {
    const post = P.prototype.postMessage
    P.prototype.postMessage = function (m, ...rest) {
      if (m && m.k === 'snapshot' && typeof m.data === 'string') {
        streams.snapshots++
        streams.snapshotChars += m.data.length
      } else if (m && m.k === 'data' && m.b instanceof Uint8Array) {
        streams.data++
        streams.dataBytes += m.b.byteLength
      }
      return post.call(this, m, ...rest)
    }
  }

  const ops = {
    gc() {
      if (!gc) {
        v8.setFlagsFromString('--expose-gc')
        gc = vm.runInNewContext('gc')
      }
      const t0 = performance.now()
      gc()
      gc()
      return { ms: performance.now() - t0 }
    },
    heap() {
      return { ...v8.getHeapStatistics(), ...process.memoryUsage() }
    },
    handles() {
      const out = {}
      for (const r of process.getActiveResourcesInfo()) out[r] = (out[r] || 0) + 1
      return out
    },
    kit() {
      const reg = globalThis[Symbol.for('kea.kit.resources')]
      return reg && typeof reg.report === 'function' ? reg.report() : null
    },
    ports() {
      return Port ? v8.queryObjects(Port, { format: 'count' }) : null
    },
    children() {
      return { now: Date.now(), live: [...liveChildren], ended: [...endedChildren] }
    },
    streams(arg) {
      const out = { ...streams }
      if (arg === 'reset') for (const k of Object.keys(streams)) streams[k] = 0
      return out
    },
    fault(kind) {
      if (kind !== 'throw' && kind !== 'reject') throw new Error('fault needs throw or reject')
      setImmediate(() => {
        if (kind === 'throw') throw new Error('kea-test: uncaught exception')
        void Promise.reject(new Error('kea-test: unhandled rejection'))
      })
      return kind
    },
    hold(arg) {
      const [point, file] = String(arg).split('|')
      if (!point || !file) throw new Error('hold needs <point>|<file>')
      const key = Symbol.for('kea.test.faults')
      globalThis[key] = (p, id) => {
        if (p !== point) return undefined
        delete globalThis[key]
        fs.writeFileSync(file, id)
        return new Promise(() => {})
      }
      return point
    },
    status(arg) {
      if (!statusEngine) throw new Error('no status engine here (core only)')
      const a = typeof arg === 'string' ? JSON.parse(arg) : arg || {}
      const phaseOf = (id) => (statusEngine.state(id) || {}).phase || null
      if (a.ingest) return { applied: statusEngine.ingest({ ...a.ingest, at: a.ingest.at || Date.now() }), phase: phaseOf(a.ingest.sessionId) }
      if (a.statusFile) return { applied: statusEngine.statusFile(a.statusFile.sessionId, a.statusFile.reading), phase: phaseOf(a.statusFile.sessionId) }
      const { deltas, chunk, everyMs, title } = a
      const ids = [...statusEngine.store.values()].map((x) => x.sessionId)
      const steps = deltas / ids.length
      if (!ids.length || !Number.isInteger(steps) || (steps - 2) % TURN.length !== 0) throw new Error(`status: ${deltas} deltas do not split into whole turns across ${ids.length} sessions`)
      const eventOf = (step) => (step === steps - 1 ? { t: 'meta', title, titleSource: 'agent' } : step === steps - 2 ? { t: 'meta', contextUsedPct: (deltas + step) % 100 } : TURN[step % TURN.length])
      let k = 0
      return new Promise((resolve, reject) => {
        const tick = () => {
          try {
            for (let n = 0; n < chunk && k < deltas; n++, k++) statusEngine.ingest({ sessionId: ids[k % ids.length], source: 'hook', events: [eventOf(Math.floor(k / ids.length))] })
          } catch (err) {
            reject(err)
            return
          }
          if (k < deltas) setTimeout(tick, everyMs)
          else resolve({ sessions: ids.length, ...statusEngine.resourceCounts })
        }
        tick()
      })
    },
    lateReplies(arg) {
      const ms = Number(arg)
      if (!Number.isFinite(ms) || ms < 0) throw new Error('lateReplies needs a delay in ms (0: off)')
      if (!Port) throw new Error('lateReplies: no port seen yet')
      lateMs = ms
      return ms
    },
    snapshot(file) {
      if (typeof file !== 'string' || !file.endsWith('.heapsnapshot')) throw new Error('snapshot needs a .heapsnapshot path')
      return v8.writeHeapSnapshot(file)
    },
    timers(arg) {
      const a = String(arg)
      if (a === 'start') return timerWatch.start()
      if (a === 'stop') return timerWatch.stop()
      if (a === 'unplant') return timerWatch.unplant()
      if (a.startsWith('plant:')) return timerWatch.plant(Number(a.slice('plant:'.length)))
      if (a.startsWith('wander:')) return timerWatch.plant(Number(a.slice('wander:'.length)), true)
      throw new Error('timers needs start, stop, plant:<ms>, wander:<ms> or unplant')
    },
    alloc(arg) {
      const bytes = Number(arg)
      if (!Number.isInteger(bytes) || bytes < 0) throw new Error('alloc needs a number of bytes (0: let go)')
      held.length = 0
      // every page written, so the footprint counts it (an untouched page of a fresh allocation is not resident)
      for (let left = bytes; left > 0; left -= ALLOC_CHUNK) held.push(Buffer.alloc(Math.min(ALLOC_CHUNK, left), 0x6b))
      return { held: held.reduce((n, b) => n + b.length, 0), heapUsed: process.memoryUsage().heapUsed }
    },
    scan(arg) {
      const asked = JSON.parse(String(arg))
      const needles = Array.isArray(asked) ? asked : asked && asked.needles
      if (!Array.isArray(needles) || needles.length === 0 || needles.some((n) => !Array.isArray(n) || n.length < 8 || n.some((c) => !Number.isInteger(c))))
        throw new Error('scan needs markers of 8 characters or more, each as an array of character codes')
      // the control's plant: alive from here to the answer
      const planted = !Array.isArray(asked) && Array.isArray(asked.plant) ? Uint8Array.from(asked.plant) : null
      const session = new (require('node:inspector').Session)()
      session.connect()
      try {
        // a session on its own thread answers before `post` returns
        const post = (method, params) => {
          let answer
          session.post(method, params, (err, r) => {
            answer = err ? { err } : { r }
          })
          if (!answer) throw new Error(`scan: ${method} did not answer at once`)
          if (answer.err) throw new Error(`scan: ${method}: ${answer.err.message || JSON.stringify(answer.err)}`)
          return answer.r
        }
        const every = (prototype) => {
          const proto = post('Runtime.evaluate', { expression: prototype, objectGroup: 'kea-scan' }).result.objectId
          return post('Runtime.queryObjects', { prototypeObjectId: proto, objectGroup: 'kea-scan' }).objects.objectId
        }
        const out = post('Runtime.callFunctionOn', {
          objectId: every(BUFFERS),
          functionDeclaration: scanBuffers.toString(),
          arguments: [{ objectId: every(VIEWS) }, { value: needles }],
          returnByValue: true,
        })
        if (out.exceptionDetails) throw new Error(`scan: ${out.exceptionDetails.exception?.description || out.exceptionDetails.text}`)
        post('Runtime.releaseObjectGroup', { objectGroup: 'kea-scan' })
        return planted ? { ...out.result.value, planted: planted.length } : out.result.value
      } finally {
        session.disconnect()
      }
    },
  }

  parent.on('message', (e) => {
    if (!Port && e.ports && e.ports[0]) {
      Port = e.ports[0].constructor
      countStreams(Port)
      delayReplies(Port)
    }
    const m = e.data
    if (!m || m.k !== 'kea-test' || typeof m.id !== 'number') return
    try {
      const op = Object.prototype.hasOwnProperty.call(ops, m.op) ? ops[m.op] : null
      if (!op) throw new Error(`unknown op ${String(m.op)}`)
      const value = op(m.arg)
      // an op that takes time (status) answers when it is done
      if (value && typeof value.then === 'function') {
        value.then(
          (v) => parent.postMessage({ k: 'kea-test', id: m.id, ok: true, value: v }),
          (err) => parent.postMessage({ k: 'kea-test', id: m.id, ok: false, error: String((err && err.message) || err) }),
        )
        return
      }
      parent.postMessage({ k: 'kea-test', id: m.id, ok: true, value })
    } catch (err) {
      parent.postMessage({ k: 'kea-test', id: m.id, ok: false, error: String((err && err.message) || err) })
    }
  })
}
