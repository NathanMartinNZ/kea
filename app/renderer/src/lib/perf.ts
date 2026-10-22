// Perf probes for tools/perf, installed only when the app runs with `--kea-perf`: `window.__keaPerf`.
//
// Echo latency (P-TERM-1): arm with the character about to be typed; the capture-phase keydown records the event's
// timestamp; the first xterm render after which that character sits just before the cursor ends the measurement.
// Frames (P-TERM-4, P-UI-7): a requestAnimationFrame counter with the longest gap and the most flushes of the sessions
// store in one frame. The sidebar (P-START-2, P-UI-4): when session rows are first drawn, and when a new one is.
// Statuses (P-START-4): when core's `status` store first held a number of statuses, every one confirmed.

import { STATUS_STORE, type SessionStatus } from '@kea/protocol'
import { primaryDown } from '../features/commands/keys.ts'
import { rendererResources } from '../features/resources/report.ts'
import { sessions } from '../features/sessions/state.svelte.ts'
import { activeView, terminals } from '../features/terminal/views.ts'
import { subscribe } from './rpc.ts'

/** A session's row in the sidebar, found by role and data attribute as the tests find it. */
const SESSION_ROW = '[role=treeitem][data-session-id]'

type Echo = { ch: string; down: number | null; done: Promise<number>; resolve(ms: number): void }

function term() {
  const v = activeView()
  if (!v) throw new Error('no active terminal')
  return v.xterm
}

/** The character just before the cursor (the one most recently echoed). */
function charBeforeCursor(): string {
  const t = term()
  const b = t.buffer.active
  let x = b.cursorX - 1
  let y = b.baseY + b.cursorY
  if (x < 0) {
    y -= 1
    x = t.cols - 1
  }
  return b.getLine(y)?.getCell(x)?.getChars() ?? ''
}

export function installPerfProbes(): void {
  let echo: Echo | null = null
  let renderOff: { dispose(): void } | null = null
  const root = document.getElementById('root')

  // P-START-2: the first DOM update that draws session rows (a FrameStore flush, in the frame that paints them), watched
  // from before the window mounts; the observer goes once rows are there
  let firstRows: { rows: number; at: number } | null = null
  if (root) {
    const watch = new MutationObserver(() => {
      const rows = root.querySelectorAll(SESSION_ROW).length
      if (rows === 0) return
      firstRows = { rows, at: performance.now() }
      watch.disconnect()
    })
    watch.observe(root, { childList: true, subtree: true })
  }
  let newRow: Promise<{ drawn: number; painted: number }> | null = null
  // P-START-4: core's `status` store, followed only once a test asks: it is one more store subscription, which the
  // resource report counts (L-MEM tests compare it with the window's own), so never by default
  let watchingStatuses = false
  let confirmed: { rows: number; at: number } | null = null

  window.addEventListener(
    'keydown',
    (e) => {
      if (echo && echo.down === null && e.key === echo.ch) echo.down = e.timeStamp
    },
    true,
  )

  const frames = { running: false, count: 0, maxGap: 0, last: 0, start: 0, flushStart: 0, flushes: 0, maxFlushes: 0 }
  const tick = (t: number) => {
    if (!frames.running) return
    if (frames.last) frames.maxGap = Math.max(frames.maxGap, t - frames.last)
    frames.last = t
    frames.count++
    // the sessions store's flushes since the last frame: at most one is allowed
    frames.maxFlushes = Math.max(frames.maxFlushes, sessions.flushes - frames.flushes)
    frames.flushes = sessions.flushes
    requestAnimationFrame(tick)
  }

  ;(window as unknown as { __keaPerf: unknown }).__keaPerf = {
    ready: () => !!activeView(),
    attached: () => activeView()?.attached ?? Promise.reject(new Error('no active terminal')),
    armEcho(ch: string): void {
      renderOff?.dispose()
      let resolve!: (ms: number) => void
      const done = new Promise<number>((r) => (resolve = r))
      const e: Echo = { ch, down: null, done, resolve }
      echo = e
      renderOff = term().onRender(() => {
        if (e.down === null || charBeforeCursor() !== e.ch) return
        e.resolve(performance.now() - e.down)
        renderOff?.dispose()
        renderOff = null
      })
    },
    awaitEcho(timeoutMs = 2000): Promise<number> {
      const e = echo
      if (!e) return Promise.reject(new Error('not armed'))
      return Promise.race([e.done, new Promise<number>((_, rej) => setTimeout(() => rej(new Error(`no echo of ${e.ch}`)), timeoutMs))])
    },
    /**
     * Resolves once `cat` has written back the line just entered: the two rows above the cursor both read `text` (the
     * terminal's echo, then cat's copy) and the cursor is at column 0. A key typed sooner can echo ahead of cat's copy
     * and end up before it, where the echo probe would never see it before the cursor.
     */
    awaitLineBack(text: string, timeoutMs = 2000): Promise<void> {
      const t = term()
      const back = () => {
        const b = t.buffer.active
        const y = b.baseY + b.cursorY
        const row = (i: number) => b.getLine(i)?.translateToString(true) ?? ''
        return b.cursorX === 0 && row(y - 1) === text && row(y - 2) === text
      }
      return new Promise((resolve, reject) => {
        if (back()) return resolve()
        const timer = setTimeout(() => {
          off.dispose()
          reject(new Error(`line "${text}" not written back`))
        }, timeoutMs)
        const off = t.onRender(() => {
          if (!back()) return
          clearTimeout(timer)
          off.dispose()
          resolve()
        })
      })
    },
    framesStart(): void {
      Object.assign(frames, { running: true, count: 0, maxGap: 0, last: 0, start: performance.now(), flushStart: sessions.flushes, flushes: sessions.flushes, maxFlushes: 0 })
      requestAnimationFrame(tick)
    },
    /** `storeFlushes`: the sessions store's flushes meanwhile; `maxStoreFlushes`: the most between two frames. */
    framesStop(): { fps: number; maxGapMs: number; frames: number; storeFlushes: number; maxStoreFlushes: number } {
      frames.running = false
      const secs = (performance.now() - frames.start) / 1000
      return { fps: frames.count / secs, maxGapMs: frames.maxGap, frames: frames.count, storeFlushes: sessions.flushes - frames.flushStart, maxStoreFlushes: frames.maxFlushes }
    },
    /**
     * P-START-4: follow core's `status` store from now on (once; a snapshot comes first). Read with `statusesConfirmed`.
     */
    watchStatuses(): void {
      if (watchingStatuses) return
      watchingStatuses = true
      subscribe<SessionStatus>(STATUS_STORE, (data) => {
        let all = data.size > 0
        for (const s of data.values()) if (s.unconfirmed) all = false
        if (!all) confirmed = null
        else if (confirmed?.rows !== data.size) confirmed = { rows: data.size, at: performance.now() }
      })
    },
    /**
     * P-START-4: since when the window's copy of the `status` store has held `rows` statuses, none of them unconfirmed
     * (`at`: ms since the window's time origin, when the copy got there); null while any is unconfirmed.
     */
    statusesConfirmed: () => confirmed,
    /** P-START-2: the first session rows drawn (`at`: ms since the window's time origin), null before. */
    firstSessionRows: () => firstRows,
    /**
     * P-UI-4: arm before ⌘↵. Times keydown → the new session's row by the rule of every one-frame budget: `drawn`
     * ends at the frame that draws the row, its paint excluded. The row is added by a FrameStore flush: one run
     * in a frame's animation callbacks is drawn by that frame, so `drawn` is the end of that update; one run between
     * frames (the store's timer when no frame comes) is drawn by the next, so `drawn` is that frame's timestamp.
     * `painted` (information, not asserted) is the start of the frame after the drawing one, by when its paint is done.
     * Read with `awaitNewRow`.
     */
    armNewRow(timeoutMs = 2000): void {
      if (!root) throw new Error('no #root')
      const before = new Set([...root.querySelectorAll(SESSION_ROW)].map((e) => e.getAttribute('data-session-id')))
      newRow = new Promise<{ drawn: number; painted: number }>((resolve, reject) => {
        let down: number | null = null
        let seen = false
        // true from a frame's animation callbacks until its rendering is done: a task queued then runs after the paint
        let inFrame = false
        let ticking = true
        const tick = () => {
          if (!ticking) return
          inFrame = true
          setTimeout(() => {
            inFrame = false
          }, 0)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
        const onKey = (e: KeyboardEvent) => {
          if (down === null && e.key === 'Enter' && primaryDown(e)) down = e.timeStamp
        }
        const watch = new MutationObserver(() => {
          if (down === null || seen) return
          for (const e of root.querySelectorAll(SESSION_ROW)) {
            if (before.has(e.getAttribute('data-session-id'))) continue
            seen = true
            const at = down
            const now = performance.now() - at
            // the frame after the drawing one starts once that paint is done
            const paintedBy = (drawn: number) => requestAnimationFrame((t) => finish(null, { drawn, painted: t - at }))
            if (inFrame) paintedBy(now)
            else requestAnimationFrame((t) => paintedBy(t - at))
            return
          }
        })
        const timer = setTimeout(() => finish(new Error('no new session row')), timeoutMs)
        const finish = (err: Error | null, r?: { drawn: number; painted: number }) => {
          ticking = false
          clearTimeout(timer)
          watch.disconnect()
          window.removeEventListener('keydown', onKey, true)
          if (err) reject(err)
          else resolve(r as { drawn: number; painted: number })
        }
        window.addEventListener('keydown', onKey, true)
        watch.observe(root, { childList: true, subtree: true })
      })
      newRow.catch(() => undefined) // read by awaitNewRow; never an unhandled rejection
    },
    awaitNewRow(): Promise<{ drawn: number; painted: number }> {
      return newRow ?? Promise.reject(new Error('not armed'))
    },
    /** The active terminal's visible text (harness diagnostics). */
    screen(): string {
      const t = term()
      const b = t.buffer.active
      const out: string[] = []
      for (let i = b.viewportY; i < b.viewportY + t.rows; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
      return out.join('\n')
    },
    /** Resolves when `text` appears on the visible screen. */
    waitText(text: string, timeoutMs = 120_000): Promise<number> {
      const t = term()
      const visible = () => {
        const b = t.buffer.active
        for (let i = b.viewportY; i < b.viewportY + t.rows; i++) if (b.getLine(i)?.translateToString(true).includes(text)) return true
        return false
      }
      return new Promise((resolve, reject) => {
        if (visible()) return resolve(performance.now())
        const timer = setTimeout(() => {
          off.dispose()
          reject(new Error(`"${text}" not shown`))
        }, timeoutMs)
        const off = t.onRender(() => {
          if (!visible()) return
          clearTimeout(timer)
          off.dispose()
          resolve(performance.now())
        })
      })
    },
    now: () => performance.now(),
    /** The renderer's resource report: the same rows main collects. */
    resources: () => rendererResources(),
    /**
     * P-TERM-7: arm before a tab-switch shortcut; resolves with keydown → the first frame in which the newly active
     * terminal is laid out and visible. A warm view repaints from its existing canvas, so xterm may not render at all.
     */
    armSwitch(timeoutMs = 2000): Promise<number> {
      const from = activeView()
      return new Promise((resolve, reject) => {
        let down: number | null = null
        let raf = 0
        const onKey = (e: KeyboardEvent) => {
          if (down === null && primaryDown(e)) down = e.timeStamp
        }
        const timer = setTimeout(() => finish(new Error('no switch')), timeoutMs)
        const finish = (err: Error | null, ms?: number) => {
          clearTimeout(timer)
          cancelAnimationFrame(raf)
          window.removeEventListener('keydown', onKey, true)
          if (err) reject(err)
          else resolve(ms as number)
        }
        const frame = (t: number) => {
          const v = activeView()
          // shown (a view still painting its snapshot is laid out but not visible yet)
          if (down !== null && v && v !== from && terminals.isShown(v.ptyId) && v.el.isConnected && v.el.clientWidth > 0) finish(null, t - down)
          else raf = requestAnimationFrame(frame)
        }
        window.addEventListener('keydown', onKey, true)
        raf = requestAnimationFrame(frame)
      })
    },
  }
}
