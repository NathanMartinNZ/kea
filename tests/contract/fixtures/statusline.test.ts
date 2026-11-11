// Claude's status line payloads (fixtures/statusline/claude/<version>/) against the adapter: each recorded payload
// parses; projected by the status line's projection (as kea-helper keeps it) only the usage windows and the session id
// are left; the one at start (before the first reply) maps to nothing and the one after a reply to the account's usage,
// both windows, seconds as ms; fields the contract does not name (new ones included) change nothing.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { zAgentEvent, zUsageWindow } from '@kea/protocol'
import { projectPayload } from '../../../packages/adapters/src/kit/projection.ts'
import { STATUS_LINE_FIELDS } from '../../../packages/adapters/src/claude/contract.ts'
import { field, usageEvents } from '../../../packages/adapters/src/claude/mapping.ts'
import { statusLineProjection } from '../../../packages/adapters/src/claude/statusline.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/statusline/claude')
const versions = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((v) => fs.existsSync(path.join(ROOT, v, 'after-reply.json'))) : []
const read = (v: string, f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, v, f), 'utf8')) as Record<string, unknown>

describe('Claude status line payloads', () => {
  it('K-FX-9 · every recorded payload parses and keeps only the usage and the session id once projected; before the first reply it maps to nothing, after it to account.usage with both windows (Unix seconds as ms); fields Kea does not name, new ones included, change nothing', () => {
    expect(versions.length, 'recorded versions').toBeGreaterThan(0)
    const p = statusLineProjection()
    for (const v of versions) {
      const start = read(v, 'start.json')
      const after = read(v, 'after-reply.json')
      // before the first reply: no windows, so nothing for the meter
      expect(field(start, 'rate_limits'), `${v}/start.json`).toBeUndefined()
      expect(usageEvents(projectPayload(start, p)), `${v}/start.json`).toEqual([])
      // after it: every field the contract names is there, and the projection keeps nothing else
      for (const f of Object.values(STATUS_LINE_FIELDS)) expect(field(after, f), `${v}/after-reply.json ${f}`).toBeDefined()
      const projected = projectPayload(after, p)
      expect(Object.keys(projected).sort(), v).toEqual(['rate_limits', 'session_id'])
      const events = usageEvents(projected)
      expect(events, v).toHaveLength(1)
      const e = events[0]!
      expect(zAgentEvent.safeParse(e).success, v).toBe(true)
      if (e.t !== 'account.usage') throw new Error(`${v}: not a usage event`)
      expect(e.windows.map((w) => w.id), v).toEqual(['session', 'week'])
      for (const w of e.windows) expect(zUsageWindow.safeParse(w).success, `${v} ${w.id}`).toBe(true)
      expect(e.windows.map((w) => [w.usedPct, w.resetsAt]), v).toEqual([
        [field(after, STATUS_LINE_FIELDS.sessionUsed), (field(after, STATUS_LINE_FIELDS.sessionResets) as number) * 1000],
        [field(after, STATUS_LINE_FIELDS.weekUsed), (field(after, STATUS_LINE_FIELDS.weekResets) as number) * 1000],
      ])
      // fields Kea does not name are ignored: a later version's additions inside and beside the windows change nothing
      const limits = after.rate_limits as Record<string, Record<string, unknown>>
      const later = {
        ...after,
        brand_new: { nested: [1, 2, 3] },
        rate_limits: {
          ...limits,
          five_hour: { ...limits.five_hour, label: 'Session', used_tokens: 12 },
          seven_day_opus: { used_percentage: 99, resets_at: 1 },
          spend_limit: { used_usd: 3 },
        },
      }
      expect(usageEvents(projectPayload(later, p)), `${v}: unknown fields`).toEqual(events)
    }
  })
})
