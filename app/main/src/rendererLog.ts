// The window's log (every process keeps one structured log in `<KEA_HOME>/logs/`). The renderer is sandboxed and writes
// no file, so main writes `renderer.log` for it: what a window's console says at warning or error level (uncaught
// errors, rejected promises, Chromium's own complaints such as a refused resource, and the window's own `console.warn`
// / `console.error`), one line each, rotated like every log. "Copy diagnostics" reads its newest lines with the other
// processes' (core's `resources/diagnostics.ts`).
//
// What a line holds: the message, cut at L.rendererLogMessageMaxChars; the script it came from, as its path inside the
// app's own bundle (a script that is not the app's is named `other`); the line number; the window. The window's code
// never writes terminal content or file contents to its console: that rule is the code's, this file cannot check it.
//
// A line that repeats the one before it (same window, level, message and place) is counted, not written; the count is
// written when another line follows, or when that window goes. One line is remembered for that, whatever the number of
// windows. No Electron here: main.ts passes what the `console-message` event gave it, so this file is unit-tested in
// Node.

import type { Logger } from '@kea/kit'
import { L } from '@kea/protocol'

/** The fields of Electron's `console-message` event that are used. */
export interface ConsoleMessage {
  level: string
  message: string
  lineNumber: number
  sourceId: string
}

const APP_ORIGIN = 'kea://app/'

/** A script of the app as its path in the bundle (`assets/index-1a2b.js`); anything else is not named. */
export function sourceName(sourceId: string): string {
  if (!sourceId) return ''
  if (!sourceId.startsWith(APP_ORIGIN)) return 'other'
  const rel = sourceId.slice(APP_ORIGIN.length)
  const end = rel.search(/[?#]/)
  return end < 0 ? rel : rel.slice(0, end)
}

type Last = { window: number; key: string; repeats: number; level: 'warn' | 'error'; fields: Record<string, string | number> }

export class RendererLog {
  private readonly log: Logger
  /** The line written last and how often it has repeated since: one value, not one per window. */
  private last: Last | null = null

  constructor(log: Logger) {
    this.log = log
  }

  /** One console message of window `window`: written when it is a warning or an error and does not repeat the last line. */
  message(window: number, m: ConsoleMessage): void {
    const level = m.level === 'error' ? 'error' : m.level === 'warning' ? 'warn' : null
    if (level === null) return
    const message = m.message.length > L.rendererLogMessageMaxChars ? `${m.message.slice(0, L.rendererLogMessageMaxChars)}…` : m.message
    const source = sourceName(m.sourceId)
    const fields: Record<string, string | number> = { window, ...(source ? { source, line: m.lineNumber } : {}) }
    const key = `${level}\0${message}\0${source}\0${m.lineNumber}`
    if (this.last && this.last.window === window && this.last.key === key) {
      this.last.repeats++
      return
    }
    this.flush()
    this.last = { window, key, repeats: 0, level, fields }
    this.log[level](message, fields)
  }

  /** The window is gone (closed): what was counted for it is written, and nothing of it is kept. */
  closed(window: number): void {
    if (this.last?.window !== window) return
    this.flush()
    this.last = null
  }

  private flush(): void {
    const last = this.last
    if (!last || last.repeats === 0) return
    this.log[last.level](`the line before repeated ${last.repeats} more ${last.repeats === 1 ? 'time' : 'times'}`, last.fields)
    last.repeats = 0
  }
}
