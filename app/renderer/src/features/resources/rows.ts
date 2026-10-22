// The renderer's resource rows read from their gauges. The renderer has no kit registry, so its rows are read
// when the report is taken, and named like every other process's: dotted, under `renderer.`. A gauge that throws costs
// only its own rows, each reported as NaN; the rest of the report is unaffected.

import type { ResourceReport } from '@kea/protocol'

/** One source of rows: the names it reports (so a failure is reported row by row) and how to read them now. */
export interface Gauge {
  rows: readonly string[]
  /** Each row a count or a record of counts. */
  read(): ResourceReport
}

export const ROW_PREFIX = 'renderer.'

/** Every gauge's rows under `renderer.<row>`; a gauge that throws gives NaN for each of its rows and is passed to `onError`. */
export function readGauges(gauges: readonly Gauge[], onError?: (rows: readonly string[], error: unknown) => void): ResourceReport {
  const out: ResourceReport = {}
  for (const g of gauges) {
    let values: ResourceReport
    try {
      values = g.read()
    } catch (e) {
      for (const row of g.rows) out[ROW_PREFIX + row] = Number.NaN
      onError?.(g.rows, e)
      continue
    }
    for (const row of g.rows) out[ROW_PREFIX + row] = values[row] ?? Number.NaN
    for (const [row, v] of Object.entries(values)) if (!g.rows.includes(row)) out[ROW_PREFIX + row] = v
  }
  return out
}
