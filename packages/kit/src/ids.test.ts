import { L } from '@kea/protocol/limits'
import { describe, expect, it } from 'vitest'
import { ptyId, ulid, ulidTime } from './ids.ts'

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

describe('ulid', () => {
  it('U-ID-1 · encodes the millisecond time in the first 10 Crockford chars (spec vector)', () => {
    // Must run first in this file: ulid() never goes back in time within a process.
    const id = ulid(1469918176385)
    expect(id.slice(0, 10)).toBe('01ARYZ6S41')
    expect(id).toMatch(ULID_RE)
    expect(ulidTime(id)).toBe(1469918176385)
  })

  it('U-ID-1 · is monotonic: same millisecond and a clock stepping back still sort after the previous id', () => {
    const now = Date.now()
    const a = ulid(now + 1000)
    const b = ulid(now + 1000)
    const c = ulid(now) // clock stepped back
    expect(a < b && b < c).toBe(true)
    expect(ulidTime(c)).toBe(now + 1000)
    const many = Array.from({ length: 10_000 }, () => ulid())
    expect(new Set(many).size).toBe(many.length)
    expect([...many].sort()).toEqual(many)
    for (const id of many.slice(0, 50)) expect(id).toMatch(ULID_RE)
  })
})

describe('ptyId', () => {
  it('U-HLD-5 · is L.ptyIdLength chars of [a-z0-9], random', () => {
    const ids = Array.from({ length: 2000 }, () => ptyId())
    for (const id of ids) expect(id).toMatch(new RegExp(`^[a-z0-9]{${L.ptyIdLength}}$`))
    expect(new Set(ids).size).toBe(ids.length)
    const chars = new Set(ids.join(''))
    expect(chars.size).toBe(36)
  })
})
