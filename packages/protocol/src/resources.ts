// The resource report as it crosses a process boundary. Core and ptyhost answer main's `report` request on
// `parentPort` (process.ts); the renderer answers `kea:resources` through the preload (`zResourcesReply`). The rows are
// those of kit's report registry: one per dotted name, each a count or a record of counts. A gauge that threw reports
// NaN, so NaN is a valid value; nothing else that is not a finite number is.
//
// Main checks every report it receives, so a confused or compromised sender cannot make it hold an unbounded object:
// at most L.resourceReportRowsMax rows (and values per row), names of at most L.resourceNameMaxChars characters.

import { z } from 'zod'
import { L } from './generated/limits.ts'

export type ResourceValue = number | Record<string, number>
/** Same shape as kit's `ResourceReport` (kit's registry produces it; this package cannot import kit). */
export type ResourceReport = Record<string, ResourceValue>

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}

function isName(k: string): boolean {
  return k.length > 0 && k.length <= L.resourceNameMaxChars && k !== '__proto__'
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && (Number.isFinite(v) || Number.isNaN(v))
}

/** A report within the caps above: names checked, every value a count or a record of counts. */
export function isResourceReport(v: unknown): v is ResourceReport {
  if (!isPlainRecord(v)) return false
  const rows = Object.keys(v)
  if (rows.length > L.resourceReportRowsMax) return false
  for (const row of rows) {
    if (!isName(row)) return false
    const x = v[row]
    if (isCount(x)) continue
    if (!isPlainRecord(x)) return false
    const names = Object.keys(x)
    if (names.length > L.resourceReportRowsMax) return false
    for (const n of names) if (!isName(n) || !isCount(x[n])) return false
  }
  return true
}

export const zResourceReport = z.custom<ResourceReport>(isResourceReport, 'not a resource report')

/** Renderer → main (`kea:resources`): the answer to main's request `reqId`. */
export const zResourcesReply = z.object({ reqId: z.number().int().positive(), report: zResourceReport })
export type ResourcesReply = z.infer<typeof zResourcesReply>
