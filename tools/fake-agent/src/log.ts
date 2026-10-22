// The event log tests read (`--log <file>` / FAKE_AGENT_LOG): one JSON object per line, appended synchronously so the
// order on disk is the order things happened, even if the process is killed right after. `t` names the event, `ms`
// is the time since start.

import { appendFileSync } from 'node:fs'

export type LogEvent = { t: string; ms: number } & Record<string, unknown>

export class EventLog {
  private readonly target: string | ((e: LogEvent) => void) | null
  private readonly now: () => number

  /** `target`: a file to append to, a function (tests), or null for no log. */
  constructor(target: string | ((e: LogEvent) => void) | null, now: () => number) {
    this.target = target
    this.now = now
  }

  event(t: string, data: Record<string, unknown> = {}): void {
    if (this.target === null) return
    const e: LogEvent = { t, ms: Math.round(this.now() * 10) / 10, ...data }
    if (typeof this.target === 'function') return this.target(e)
    try {
      appendFileSync(this.target, `${JSON.stringify(e)}\n`)
    } catch {
      // a log that cannot be written must not change the agent's behaviour
    }
  }
}
