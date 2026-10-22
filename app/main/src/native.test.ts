import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SIZE_PX } from '@kea/ui/tokens'
import { FolderQueue, parseWindowState, readWindowState, revealablePath, writeWindowState } from './native.ts'

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
