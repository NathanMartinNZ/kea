// kea-helper's projection rules (native/kea-helper/README.md, `hook`), in TypeScript, so adapter tests and the
// fixture contract (K-FX-1) can see a payload exactly as core receives it. The helper is the implementation; this
// mirrors it: `keep` copies strings (cut to L.hookSummaryMaxChars characters), numbers, booleans and null; `count`
// turns an array into its length (an object into its key count); `summarise` cuts a string, and writes anything else
// as compact JSON, cut the same way. Paths are dotted and walk objects only.

import { L } from '@kea/protocol'

export interface Projection {
  keep: readonly string[]
  count: readonly string[]
  summarise: readonly string[]
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
  for (const path of p.summarise) {
    const v = get(payload, path)
    if (v === undefined || v === null) continue
    put(out, path, cutChars(typeof v === 'string' ? v : JSON.stringify(v)))
  }
  return out
}
