import { L } from '@kea/protocol/limits'
import { describe, expect, it } from 'vitest'
import { textStats, viewPolicy } from './policy.ts'

describe('the large-file policy', () => {
  it('U-FV-2 · the feature set at each threshold: full to 1 MB, a highlighting budget to 20 MB, plain text above it or above 300 000 lines, no wrap with a line over 10 000 characters', () => {
    const small = { lines: 100, longestLine: 80 }
    const full = { highlight: 'full', budgetMs: null, folding: true, wrap: true, preview: true, plain: false }
    const budget = { highlight: 'budget', budgetMs: L.viewerHighlightBudgetMs, folding: true, wrap: true, preview: false, plain: false }
    const plain = { highlight: 'none', budgetMs: null, folding: false, wrap: false, preview: false, plain: true }

    expect(viewPolicy({ bytes: 0, lines: 1, longestLine: 0 })).toEqual(full)
    expect(viewPolicy({ bytes: L.viewerFullBytes, ...small })).toEqual(full)
    expect(viewPolicy({ bytes: L.viewerFullBytes + 1, ...small })).toEqual(budget)
    expect(viewPolicy({ bytes: L.viewerPlainBytes, ...small })).toEqual(budget)
    expect(viewPolicy({ bytes: L.viewerPlainBytes + 1, ...small })).toEqual(plain)
    // the line count alone makes it plain, however small the file
    expect(viewPolicy({ bytes: 10, lines: L.viewerPlainLines, longestLine: 1 })).toEqual(full)
    expect(viewPolicy({ bytes: 10, lines: L.viewerPlainLines + 1, longestLine: 1 })).toEqual(plain)
    // one long line takes wrap away and nothing else (a minified bundle still gets its budgeted colours)
    expect(viewPolicy({ bytes: 10, lines: 1, longestLine: L.viewerWrapLineMax })).toEqual(full)
    expect(viewPolicy({ bytes: 10, lines: 1, longestLine: L.viewerWrapLineMax + 1 })).toEqual({ ...full, wrap: false })
    expect(viewPolicy({ bytes: 15 * 1024 * 1024, lines: 3, longestLine: 5_000_000 })).toEqual({ ...budget, wrap: false })
    // the limits' values themselves
    expect([L.viewerFullBytes, L.viewerPlainBytes, L.viewerPlainLines, L.viewerMaxBytes, L.viewerHighlightBudgetMs, L.viewerWrapLineMax, L.viewerTokenLineMax]).toEqual([1 << 20, 20 << 20, 300_000, 50 << 20, 1500, 10_000, 20_000])

    expect(textStats(42, ['a', 'bcd', ''])).toEqual({ bytes: 42, lines: 3, longestLine: 3 })
    expect(textStats(0, [''])).toEqual({ bytes: 0, lines: 1, longestLine: 0 })
  })
})
