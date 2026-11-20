// kea-helper's projection rules (native/kea-helper/README.md, `hook`), in TypeScript, so adapter tests and the
// fixture contract (K-FX-1) can see a payload exactly as core receives it. The helper is the implementation; this
// mirrors it: `keep` copies strings (cut to L.hookSummaryMaxChars characters), numbers, booleans and null; `count`
// turns an array into its length (an object into its key count); `countWhere` counts array elements whose dotted
// subfield matches a scalar value; `keepMap` copies up to `maxKeys` entries (clamped to L.projectionMapKeysMax) of an
// object map in deterministic sorted key order, keeping only the listed scalar subfields of each entry; `summarise`
// cuts a string, and writes anything else as compact JSON, cut the same way. Paths are dotted and walk objects only.

import { L } from '@kea/protocol'

export type Scalar = string | number | boolean | null

export interface CountWhereRule {
  path: string
  field: string
  equals: Scalar
}

export interface KeepMapRule {
  path: string
  fields: readonly string[]
  maxKeys?: number
}

export interface CriticalRule {
  field: string
  values: readonly Scalar[]
}

export interface Projection {
  keep: readonly string[]
  count: readonly string[]
  countWhere?: readonly CountWhereRule[]
  keepMap?: readonly KeepMapRule[]
  summarise: readonly string[]
  critical?: CriticalRule | readonly CriticalRule[] | null
}

function isScalar(v: unknown): v is Scalar {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null
}

function get(v: unknown, path: string): unknown {
  for (const k of path.split('.')) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
    v = (v as Record<string, unknown>)[k]
  }
  return v
}

function put(out: Record<string, unknown>, path: string, val: unknown): void {
  const parts = path.split('.')
  let cur = out
  for (const k of parts.slice(0, -1)) {
    const next = cur[k]
    if (next === undefined) cur[k] = {}
    else if (next === null || typeof next !== 'object') return
    cur = cur[k] as Record<string, unknown>
  }
  const last = parts.at(-1)!
  if (!(last in cur)) cur[last] = val
}

/** At most `max` characters (code points), cut on a character boundary. */
export function cutChars(s: string, max: number = L.hookSummaryMaxChars): string {
  const cps = [...s]
  return cps.length <= max ? s : cps.slice(0, max).join('')
}

/** Whether `payload` matches any critical rule in `p` (spooled above the soft cap). */
export function isCritical(payload: unknown, p: Partial<Projection>): boolean {
  if (!p.critical) return false
  const rules: readonly CriticalRule[] = Array.isArray(p.critical) ? p.critical : [p.critical as CriticalRule]
  for (const rule of rules) {
    const v = get(payload, rule.field)
    if (v !== undefined && (rule.values as readonly unknown[]).includes(v)) return true
  }
  return false
}

/** The payload as kea-helper projects it (without the envelope's cap, which real projected payloads stay far below). */
export function projectPayload(payload: unknown, p: Projection): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const path of p.keep) {
    const v = get(payload, path)
    if (typeof v === 'string') put(out, path, cutChars(v))
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) put(out, path, v)
  }
  for (const path of p.count) {
    const v = get(payload, path)
    if (Array.isArray(v)) put(out, path, v.length)
    else if (v !== null && typeof v === 'object') put(out, path, Object.keys(v).length)
    else if (typeof v === 'number') put(out, path, v)
  }
  for (const rule of p.countWhere ?? []) {
    if (!isScalar(rule.equals)) continue
    const v = get(payload, rule.path)
    if (!Array.isArray(v)) continue
    let n = 0
    for (const elem of v) {
      if (get(elem, rule.field) === rule.equals) n++
    }
    put(out, rule.path, n)
  }
  for (const rule of p.keepMap ?? []) {
    const v = get(payload, rule.path)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) continue
    const maxKeys = Math.min(L.projectionMapKeysMax, Math.max(0, Math.trunc(rule.maxKeys ?? L.projectionMapKeysMax)))
    const keys = Object.keys(v as Record<string, unknown>).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const outer: Record<string, unknown> = {}
    let kept = 0
    for (const k of keys) {
      if (kept >= maxKeys) break
      const entry = (v as Record<string, unknown>)[k]
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const inner: Record<string, unknown> = {}
      let hasField = false
      for (const field of rule.fields) {
        const fv = get(entry, field)
        if (typeof fv === 'string') {
          put(inner, field, cutChars(fv))
          hasField = true
        } else if (typeof fv === 'number' || typeof fv === 'boolean' || fv === null) {
          put(inner, field, fv)
          hasField = true
        }
      }
      if (hasField) {
        const ck = cutChars(k)
        if (!(ck in outer)) kept++
        outer[ck] = inner
      }
    }
    if (kept > 0) put(out, rule.path, outer)
  }
  for (const path of p.summarise) {
    const v = get(payload, path)
    if (v === undefined || v === null) continue
    put(out, path, cutChars(typeof v === 'string' ? v : JSON.stringify(v)))
  }
  return out
}
