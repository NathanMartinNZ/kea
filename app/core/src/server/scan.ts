// Listening-port detection: what `kea-helper ports` printed, what `lsof` printed about one port's holder, and when the
// scans run.
//
//   every L.portScanFastMs until the first listening port is found, then every L.portScanSlowMs
//   one extra scan L.portScanExtraMs after output that announces a URL or "listening" / "ready" / "started"
//   one scan when the Server tab or the port menu is opened
//   none once the server has stopped
//
// A scan every L.portScanFastMs for the life of a server would break the idle-CPU budget (P-CPU-1), so the cadence is
// exactly this: scans never overlap (one asked for while another runs follows it, once), and every timer is cleared by
// `stop`.

import type { Clock, TimerHandle } from '@kea/kit'
import { L } from '@kea/protocol'

const MAX_PORT = 0xffff

export interface PortsOutput {
  /** Every listening port, lowest first, each once. */
  ports: number[]
  /** The pids that hold each port. */
  holders: Map<number, number[]>
  /** Pids the helper could not read (gone, or not permitted). */
  errors: number
}

/** `kea-helper ports` output: `<pid> tcp4|tcp6 <local address> <port>` or `<pid> error <reason>` per line. */
export function parsePorts(out: string): PortsOutput {
  const holders = new Map<number, number[]>() // bounded: the ports of one scan's output (L.portScanMaxBytes)
  let errors = 0
  for (const line of out.split('\n')) {
    const w = line.trim().split(/\s+/)
    if (w.length < 2 || !/^\d+$/.test(w[0] as string)) continue
    if (w[1] === 'error') {
      errors++
      continue
    }
    if ((w[1] !== 'tcp4' && w[1] !== 'tcp6') || w.length !== 4 || !/^\d+$/.test(w[3] as string)) continue
    const pid = Number(w[0])
    const port = Number(w[3])
    if (port < 1 || port > MAX_PORT) continue
    const pids = holders.get(port) ?? []
    if (!pids.includes(pid)) pids.push(pid)
    holders.set(port, pids)
  }
  return { ports: [...holders.keys()].sort((a, b) => a - b), holders, errors }
}

/** `lsof -nP -iTCP:<port> -sTCP:LISTEN`, its fields one per line (`-F pc`: `p<pid>`, `c<command>`), names not cut short. */
export function lsofArgs(port: number): string[] {
  return ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '+c', '0', '-F', 'pc']
}

/** The first process `lsof -F pc` lists, or null when it lists none. */
export function parseLsofHolder(out: string): { pid: number; name: string } | null {
  let pid: number | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('p') && /^p\d+$/.test(line)) pid = Number(line.slice(1))
    else if (line.startsWith('c') && pid !== null) return { pid, name: line.slice(1) }
  }
  return pid !== null ? { pid, name: '' } : null
}

export interface ScanScheduleOptions {
  clock: Clock
  /** One scan. Resolves true when a listening port is known after it. Never rejects. */
  scan(): Promise<boolean>
}

/** The scan cadence above, for one running server. */
export class ScanSchedule {
  private readonly o: ScanScheduleOptions
  private periodic: TimerHandle | null = null
  private extra: TimerHandle | null = null
  private found = false
  private scanning = false
  private again = false
  private stopped = true

  constructor(o: ScanScheduleOptions) {
    this.o = o
  }

  /** The server is alive: scan at the fast interval until a port is found. `now`: and once at once (a restarted core). */
  start(o: { now?: boolean } = {}): void {
    this.stop()
    this.stopped = false
    this.found = false
    this.arm()
    if (o.now) void this.run()
  }

  /** Output announced a URL or that it is listening: one extra scan, a little later (one pending at a time). */
  output(): void {
    if (this.stopped || this.extra !== null) return
    this.extra = this.o.clock.setTimeout(() => {
      this.extra = null
      void this.run()
    }, L.portScanExtraMs)
  }

  /** The Server tab or the port menu was opened: one scan now. */
  opened(): void {
    if (!this.stopped) void this.run()
  }

  /** The server stopped: no scan runs after this (one in flight finishes, and its result is the caller's to ignore). */
  stop(): void {
    this.stopped = true
    this.again = false
    if (this.periodic !== null) this.o.clock.clearTimeout(this.periodic)
    if (this.extra !== null) this.o.clock.clearTimeout(this.extra)
    this.periodic = null
    this.extra = null
  }

  get active(): boolean {
    return !this.stopped
  }

  /** Timers armed now (counted in the resource report): at most two, none once stopped. */
  get timers(): number {
    return (this.periodic !== null ? 1 : 0) + (this.extra !== null ? 1 : 0)
  }

  private arm(): void {
    if (this.periodic !== null) this.o.clock.clearTimeout(this.periodic)
    this.periodic = this.o.clock.setTimeout(
      () => {
        this.periodic = null
        this.arm()
        void this.run()
      },
      this.found ? L.portScanSlowMs : L.portScanFastMs,
    )
  }

  private async run(): Promise<void> {
    if (this.stopped) return
    if (this.scanning) {
      this.again = true
      return
    }
    this.scanning = true
    let found = false
    try {
      found = await this.o.scan()
    } catch {
      found = false
    } finally {
      this.scanning = false
    }
    if (this.stopped) return
    if (found && !this.found) {
      // the first port: from here on the slow interval, counted from this scan
      this.found = true
      this.arm()
    }
    if (this.again) {
      this.again = false
      void this.run()
    }
  }
}
