import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SIZE_PX } from '@kea/ui/tokens'
import { firstLaunchSize, FolderQueue, parseWindowState, readWindowState, revealablePath, writeWindowState } from './native.ts'

const MIN = { width: SIZE_PX['window-min-width'], height: SIZE_PX['window-min-height'] }
const SCREEN = { x: 0, y: 0, width: 1728, height: 1117 }

describe('window bounds and native requests', () => {
  it('U-LAYOUT-2 · the window comes back at its saved bounds while they fit a connected display at the minimum size; otherwise at the first-launch size', () => {
    const saved = { x: 100, y: 80, width: 1400, height: 900, maximized: false }
    expect(parseWindowState(saved, [SCREEN], MIN)).toEqual(saved)
    expect(parseWindowState({ ...saved, maximized: true }, [SCREEN], MIN)?.maximized).toBe(true)
    // below the minimum, broken, or on a display that is gone
    expect(parseWindowState({ ...saved, width: MIN.width - 1 }, [SCREEN], MIN)).toBe(null)
    expect(parseWindowState({ ...saved, x: 'a' }, [SCREEN], MIN)).toBe(null)
    expect(parseWindowState(null, [SCREEN], MIN)).toBe(null)
    expect(parseWindowState({ ...saved, x: 3000 }, [SCREEN], MIN)).toBe(null)
    expect(parseWindowState({ ...saved, x: 3000 }, [SCREEN, { x: 1728, y: 0, width: 2560, height: 1440 }], MIN)).not.toBe(null)
    // partly off screen is fine as long as the minimum size's worth shows
    expect(parseWindowState({ ...saved, x: SCREEN.width - MIN.width }, [SCREEN], MIN)).not.toBe(null)
    expect(parseWindowState({ ...saved, x: SCREEN.width - MIN.width + 1 }, [SCREEN], MIN)).toBe(null)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-u-layout-2-'))
    try {
      expect(readWindowState(dir, [SCREEN], MIN)).toBe(null)
      writeWindowState(dir, saved)
      expect(readWindowState(dir, [SCREEN], MIN)).toEqual(saved)
      fs.writeFileSync(path.join(dir, 'window-state.json'), '{oops')
      expect(readWindowState(dir, [SCREEN], MIN)).toBe(null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('U-LAYOUT-4 · a first launch opens at the default size, clamped to the display’s work area and never below the minimum', () => {
    const def = { width: SIZE_PX['window-default-width'], height: SIZE_PX['window-default-height'] }
    expect(firstLaunchSize(def, SCREEN, MIN)).toEqual(def)
    // a 14-inch laptop's work area, narrower than the default
    const laptop = { x: 0, y: 25, width: 1512, height: 944 }
    expect(firstLaunchSize({ width: 1600, height: 1000 }, laptop, MIN)).toEqual({ width: 1512, height: 944 })
    expect(firstLaunchSize(def, { x: 0, y: 0, width: MIN.width - 100, height: MIN.height - 100 }, MIN), 'a tiny display: the minimum').toEqual(MIN)
  })

  it('U-PRJ-3 · Reveal in Finder takes only an existing absolute path; under --kea-perf a folder pick returns what the harness queued, else nothing', () => {
    const exists = (p: string) => p === '/srv/code/app'
    expect(revealablePath('/srv/code/app', exists)).toBe('/srv/code/app')
    expect(revealablePath('/srv/code/./app/', exists)).toBe('/srv/code/app')
    expect(revealablePath('/srv/code/x/../app', exists)).toBe('/srv/code/app')
    expect(revealablePath('relative/app', exists)).toBe(null)
    expect(revealablePath('/srv/code/app\0x', exists)).toBe(null)
    expect(revealablePath(42, exists)).toBe(null)
    expect(revealablePath('/nope', exists)).toBe(null)

    const q = new FolderQueue()
    expect(q.take()).toBe(null)
    q.push('/tmp/a')
    q.push('/tmp/b')
    expect(q.take()).toBe('/tmp/a')
    expect(q.take()).toBe('/tmp/b')
    expect(q.take()).toBe(null)
  })
})
