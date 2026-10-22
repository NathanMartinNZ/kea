import { describe, expect, it } from 'vitest'
import { L } from './generated/limits.ts'
import { isChildToMain, isMainToChild } from './process.ts'
import { isResourceReport, zResourcesReply } from './resources.ts'

describe('resource reports across a process boundary', () => {
  it('U-MEM-19 · a report is checked where it crosses: counts or records of counts (NaN from a failed gauge allowed), at most L.resourceReportRowsMax rows of names ≤ L.resourceNameMaxChars', () => {
    const ok = { 'core.connections': 1, 'kit.children': { 'git.active': 0, 'other.queued': 2 }, 'core.broken': Number.NaN }
    expect(isResourceReport(ok)).toBe(true)
    expect(isResourceReport({})).toBe(true)
    const rows = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${i}`, i]))
    expect(isResourceReport(rows(L.resourceReportRowsMax))).toBe(true)
    expect(isResourceReport(rows(L.resourceReportRowsMax + 1))).toBe(false)
    expect(isResourceReport({ row: rows(L.resourceReportRowsMax + 1) })).toBe(false)
    expect(isResourceReport({ ['x'.repeat(L.resourceNameMaxChars)]: 1 })).toBe(true)
    expect(isResourceReport({ ['x'.repeat(L.resourceNameMaxChars + 1)]: 1 })).toBe(false)
    expect(isResourceReport({ row: { ['x'.repeat(L.resourceNameMaxChars + 1)]: 1 } })).toBe(false)
    for (const bad of [null, 1, 'x', [], { a: '1' }, { a: Infinity }, { a: { b: { c: 1 } } }, { a: [1] }, { '': 1 }, JSON.parse('{"__proto__": 1}'), new Map()]) expect(isResourceReport(bad), JSON.stringify(bad)).toBe(false)

    expect(isMainToChild({ k: 'report', id: 3 })).toBe(true)
    expect(isMainToChild({ k: 'report', id: '3' })).toBe(false)
    expect(isChildToMain({ k: 'report', id: 3, report: ok })).toBe(true)
    expect(isChildToMain({ k: 'report', id: 3, report: { a: 'x' } })).toBe(false)
    expect(isChildToMain({ k: 'report', report: ok })).toBe(false)
    expect(zResourcesReply.safeParse({ reqId: 1, report: ok }).success).toBe(true)
    expect(zResourcesReply.safeParse({ reqId: 0, report: ok }).success).toBe(false)
    expect(zResourcesReply.safeParse({ reqId: 1, report: rows(L.resourceReportRowsMax + 1) }).success).toBe(false)
  })
})
