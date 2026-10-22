import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { check, readLast, recordResult, summaryTable, type PerfEnv } from './record.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const env: PerfEnv = { machine: { model: 'Mac', cpu: 'M', cores: 1, memGb: 1, arch: 'arm64' }, os: 'macOS', electron: '0', node: 'v0', commit: null, dirty: null, power: 'AC', load: [0, 0, 0], build: 'test' }

describe('perf results (tools/perf/last.json)', () => {
  it('U-PERF-3 · a result replaces its budget’s entry and keeps the one before as previous; other budgets stay; the summary flags a passing value > 15 % worse', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-perf-record-'))
    dirs.push(dir)
    const file = path.join(dir, 'last.json')
    // format 1: one run, its results become previous values
    fs.writeFileSync(file, JSON.stringify({ at: '2026-01-01T00:00:00.000Z', machine: {}, commit: null, results: [{ id: 'P-TERM-7', values: { p99: 10 }, pass: true }] }))
    expect(readLast(file).results['P-TERM-7']?.previous?.values).toEqual({ p99: 10 })

    expect(check('p99', 15, 20, 'max', 'ms')).toMatchObject({ pass: true, margin: 0.25 })
    expect(check('fps', 40, 50, 'min', 'fps')).toMatchObject({ pass: false, margin: -0.2 })
    expect(check('p99', Number.NaN, 20, 'max', 'ms').pass).toBe(false)

    const first = recordResult({ id: 'P-TERM-1', metric: 'm', method: 'x', values: { p99: 10 }, checks: [check('p99', 10, 20, 'max', 'ms')] }, { file, env })
    expect(first.previous).toBeNull()
    recordResult({ id: 'P-TERM-4', metric: 'm', method: 'x', values: { mbPerS: 60 }, checks: [check('mbPerS', 60, 10, 'min', 'MB/s')] }, { file, env })
    const second = recordResult({ id: 'P-TERM-1', metric: 'm', method: 'x', values: { p99: 12 }, checks: [check('p99', 12, 20, 'max', 'ms')] }, { file, env })
    expect(second.previous?.values).toEqual({ p99: 10 })
    expect(second.pass).toBe(true)
    const last = readLast(file)
    expect(Object.keys(last.results).sort()).toEqual(['P-TERM-1', 'P-TERM-4', 'P-TERM-7'])
    expect(fs.readdirSync(dir)).toEqual(['last.json']) // nothing left aside

    const table = summaryTable(last)
    expect(table).toMatch(/\| P-TERM-1 \| p99 \| ≤ 20 ms \| 12 \| 40 % \| 10 \(> 15 % worse\) \| yes \|/)
    expect(table).toMatch(/\| P-TERM-4 \| mbPerS \| ≥ 10 MB\/s \| 60 \| 500 % \| — \| yes \|/)
    expect(summaryTable(last, { ids: (id) => id === 'P-TERM-4' })).not.toContain('P-TERM-1')
  })
})
