import { describe, expect, it } from 'vitest'
import { summaryLine } from './verify.ts'
import { namePattern, TIER_A, tierAIds } from './verify-tier-a.ts'

describe('verify-tier-a and verify summary', () => {
  it('U-VER-1 · namePattern expands exact IDs, ranges, slash lists and wildcards without matching longer suffixes', () => {
    const re = new RegExp(namePattern(['I-HLD-*', 'I-PTY-1…3', 'C-KILL-1/2/11']))
    expect(re.test('I-HLD-25 · holder survives restart')).toBe(true)
    expect(re.test('describe I-PTY-2 · mirror snapshot')).toBe(true)
    expect(re.test('I-PTY-4 · outside range')).toBe(false)
    expect(re.test('C-KILL-11 · crash recovery')).toBe(true)
    expect(re.test('C-KILL-12 · not listed')).toBe(false)
    expect(re.test('C-KILL-10 · longer number')).toBe(false)
    expect(() => namePattern(['not a test id'])).toThrow(/cannot use/)
    expect(tierAIds('contract')).toContain('K-CL-6')
    expect(tierAIds('contract')).toContain('K-AG-5')
    expect(tierAIds('contract')).toContain('K-FX-10')
    expect(tierAIds('integration')).toContain('I-HLD-*')
    for (const entries of Object.values(TIER_A)) expect(() => new RegExp(namePattern(entries))).not.toThrow()
  })

  it('U-VER-2 · summaryLine reports pass, failures and skipped steps by name', () => {
    expect(summaryLine([{ name: 'unit', status: 'pass', ms: 1200, note: '' }], 1200)).toBe('verify: Tier A green in 1.2s')
    expect(
      summaryLine(
        [
          { name: 'unit', status: 'pass', ms: 1000, note: '' },
          { name: 'memory (Tier A)', status: 'skip', ms: 0, note: 'left out with --skip' },
        ],
        1000,
      ),
    ).toBe('verify: Tier A green in 1.0s; 1 step skipped: memory (Tier A)')
    expect(summaryLine([{ name: 'lint', status: 'FAIL', ms: 500, note: 'exit 1' }], 500)).toBe('verify: 1 step failed (lint) in 0.5s')
  })
})
