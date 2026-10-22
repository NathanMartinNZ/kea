// Resource report registry. Every long-lived resource kind registers a counter or a gauge
// here when it is created, so the report — read by the dev HUD, "Copy diagnostics", the hourly
// resources.ndjson line and the leak tests — cannot miss a row that exists.

import { markAsSingleton, toDisposable } from './disposable.ts'
import type { Disposable } from './disposable.ts'

export interface Counter {
  readonly name: string
  inc(n?: number): void
  dec(n?: number): void
  readonly value: number
}

export type GaugeValue = number | Record<string, number>
export type ResourceReport = Record<string, GaugeValue>

export interface ResourceRegistry {
  /** The counter called `name`, created on first use (the same object on every later call). */
  counter(name: string): Counter
  /** A row computed when the report is taken. Throws if `name` is already registered. */
  gauge(name: string, read: () => GaugeValue): Disposable
  /** Plain-object snapshot of every row, keys sorted. A gauge that throws reports `NaN`. */
  report(): ResourceReport
  /** Names currently registered. */
  names(): string[]
}

class CounterImpl implements Counter {
  readonly name: string
  value = 0
  constructor(name: string) {
    this.name = name
  }
  inc(n = 1): void {
    this.value += n
  }
  dec(n = 1): void {
    this.value -= n
  }
}

export function createResourceRegistry(): ResourceRegistry {
  // bounded: one row per resource kind — names are fixed in code, not per instance
  const counters = new Map<string, CounterImpl>()
  // bounded: one row per registered resource kind; removed when its owner disposes the registration
  const gauges = new Map<string, () => GaugeValue>()

  return {
    counter(name) {
      if (gauges.has(name)) throw new Error(`resources: "${name}" is already a gauge`)
      let c = counters.get(name)
      if (!c) {
        c = new CounterImpl(name)
        counters.set(name, c)
      }
      return c
    },
    gauge(name, read) {
      if (gauges.has(name) || counters.has(name)) throw new Error(`resources: "${name}" is already registered`)
      gauges.set(name, read)
      return toDisposable(() => {
        if (gauges.get(name) === read) gauges.delete(name)
      })
    },
    report() {
      const out: ResourceReport = {}
      const names = [...counters.keys(), ...gauges.keys()].sort()
      for (const name of names) {
        const c = counters.get(name)
        if (c) {
          out[name] = c.value
          continue
        }
        const read = gauges.get(name)
        if (!read) continue
        try {
          const v = read()
          out[name] = typeof v === 'number' ? v : { ...v }
        } catch {
          out[name] = Number.NaN
        }
      }
      return out
    },
    names() {
      return [...counters.keys(), ...gauges.keys()].sort()
    },
  }
}

/** The process-global registry. Kit's own rows: `kit.children`, `kit.timers`, `kit.listeners`, … */
export const resources: ResourceRegistry = createResourceRegistry()
// Also reachable by name, so the leak suite's hook (tests/support/app-child-hooks.cjs, loaded beside a bundled process in
// test runs only) reads this bundle's copy of the report.
;(globalThis as Record<symbol, unknown>)[Symbol.for('kea.kit.resources')] = resources

/** Register a process-lifetime gauge on the global registry (exempt from leak reports). */
export function registerSingletonGauge(name: string, read: () => GaugeValue): Disposable {
  return markAsSingleton(resources.gauge(name, read))
}
