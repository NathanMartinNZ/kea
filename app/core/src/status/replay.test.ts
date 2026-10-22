import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadFixtures, replay } from './replay.ts'

const FIXTURES = path.resolve(import.meta.dirname, '../../../../fixtures/status')

describe('status-report replays', () => {
  it('U-ST-7 · every fixtures/status/* report fixture, driven through the status machine, ends in its golden state', () => {
    const fixtures = loadFixtures(FIXTURES)
    expect(fixtures.length, 'at least one report fixture').toBeGreaterThan(0)
    for (const f of fixtures) {
      expect(f.signals.length, `${path.basename(f.dir)} has signals`).toBeGreaterThan(0)
      expect(replay(f).expected, `${path.basename(f.dir)}: ${f.fixture.note ?? ''}`).toBe(f.fixture.expected)
    }
  })
})
