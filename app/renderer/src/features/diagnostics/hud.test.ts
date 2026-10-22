import { describe, expect, it } from 'vitest'
import { reportLines, resourcesSection } from '@kea/protocol'
import { ByteRates, FrameMeter, framesText, rateText } from './hud.ts'

describe('the dev-only performance HUD’s numbers', () => {
  it('U-DIAG-7 · frame time is the mean and the longest gap between animation frames since the last reading; bytes per second per terminal come from counters read twice, busiest first', () => {
    const m = new FrameMeter()
    expect(m.take()).toEqual({ frames: 0, avgMs: 0, maxMs: 0 })
    expect(framesText(m.take())).toBe('no frames')
    // the first frame only starts the clock
    m.frame(1000)
    expect(m.take().frames).toBe(0)
    for (const t of [1016, 1032, 1082, 1100]) m.frame(t)
    const f = m.take()
    expect(f).toEqual({ frames: 4, avgMs: 25, maxMs: 50 })
    expect(framesText(f)).toBe('25.0 ms (40 fps), longest 50.0 ms')
    // a reading starts the count again, and the gap that spans it is counted in the next one
    m.frame(1116)
    expect(m.take()).toEqual({ frames: 1, avgMs: 16, maxMs: 16 })

    const r = new ByteRates()
    // the first reading has nothing to compare with
    expect(r.read(0, [['a', 500], ['b', 0]])).toEqual([{ id: 'a', bytesPerSec: 0 }, { id: 'b', bytesPerSec: 0 }])
    // 2 s later: a grew by 3 000, b by 40 000; c is new
    expect(r.read(2000, [['a', 3500], ['b', 40_000], ['c', 99]])).toEqual([{ id: 'b', bytesPerSec: 20_000 }, { id: 'a', bytesPerSec: 1500 }, { id: 'c', bytesPerSec: 0 }])
    // a view made again under the same id counts from 0; one that is gone is forgotten
    expect(r.read(3000, [['b', 100], ['c', 99]])).toEqual([{ id: 'b', bytesPerSec: 100 }, { id: 'c', bytesPerSec: 0 }])
    expect(r.read(4000, [['a', 9000]])).toEqual([{ id: 'a', bytesPerSec: 0 }])
    // two readings at the same time divide by nothing
    expect(r.read(4000, [['a', 9500]])).toEqual([{ id: 'a', bytesPerSec: 0 }])

    expect([0, 812, 1000, 12_345, 999_999, 3_400_000, 25_000_000].map(rateText)).toEqual(['0 B/s', '812 B/s', '1.0 kB/s', '12 kB/s', '1000 kB/s', '3.4 MB/s', '25 MB/s'])

    // the HUD shows the resource report with the text Copy diagnostics uses: names and numbers
    expect(resourcesSection({ reports: { renderer: { 'renderer.terminals': 2 } }, missing: {}, footprint: null })).toEqual(['## Resources', 'footprint: not sampled yet', 'renderer:', ...reportLines({ 'renderer.terminals': 2 })])
  })
})
