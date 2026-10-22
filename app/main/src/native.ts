// The native pieces the window's UI asks main for: the folder picker (`⌘O`, Locate…), Reveal (in Finder, or the file
// manager on Linux), opening settings.json, and the window's bounds (they persist per window). Pure helpers here, so
// the checks are unit-tested without Electron (U-LAYOUT-2); main.ts wires them.
//
// Under `--kea-perf` (the test and perf harnesses) no native dialog is ever shown, since it would take keyboard focus
// from the person at the machine: the harness queues the folder the next pick returns (`__keaTest.queueFolder`), and a
// pick with nothing queued is cancelled.

import fs from 'node:fs'
import path from 'node:path'

/** Why the renderer asks for a folder: Add Project, or Locate… for a missing project. */
export const PICK_PURPOSES = ['add', 'locate'] as const
export type PickPurpose = (typeof PICK_PURPOSES)[number]

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState extends Rect {
  maximized: boolean
}

export const WINDOW_STATE_FILE = 'window-state.json'

/**
 * The window's saved bounds, if they are usable: whole numbers, at least the minimum size, and with enough of the window
 * on a display that is connected now (else the window would open off screen). Null: open at the first-launch size.
 */
export function parseWindowState(raw: unknown, displays: readonly Rect[], min: { width: number; height: number }): WindowState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
  const x = n(o.x)
  const y = n(o.y)
  const width = n(o.width)
  const height = n(o.height)
  if (x === null || y === null || width === null || height === null) return null
  if (width < min.width || height < min.height) return null
  // at least the minimum size's worth of the window on one display
  const visible = displays.some((d) => {
    const w = Math.min(x + width, d.x + d.width) - Math.max(x, d.x)
    const h = Math.min(y + height, d.y + d.height) - Math.max(y, d.y)
    return w >= Math.min(min.width, width) && h >= Math.min(min.height, height)
  })
  if (!visible) return null
  return { x, y, width, height, maximized: o.maximized === true }
}

export function readWindowState(dir: string, displays: readonly Rect[], min: { width: number; height: number }): WindowState | null {
  try {
    return parseWindowState(JSON.parse(fs.readFileSync(path.join(dir, WINDOW_STATE_FILE), 'utf8')), displays, min)
  } catch {
    return null
  }
}

export function writeWindowState(dir: string, s: WindowState): void {
  try {
    const file = path.join(dir, WINDOW_STATE_FILE)
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(s))
    fs.renameSync(`${file}.tmp`, file)
  } catch {
    // the next launch opens at the default size
  }
}

/** A path the renderer may ask main to reveal in the file manager: absolute, normalised, existing. Null otherwise. */
export function revealablePath(p: unknown, exists: (p: string) => boolean = fs.existsSync): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0') || !path.isAbsolute(p)) return null
  const norm = path.resolve(p)
  return exists(norm) ? norm : null
}

/** Folders the test harness queued for the next picks (only under `--kea-perf`). */
export class FolderQueue {
  private readonly queue: string[] = [] // bounded: one folder per pick the harness is about to make
  push(p: string): void {
    this.queue.push(p)
  }
  /** The next queued folder, or null (the pick is cancelled). */
  take(): string | null {
    return this.queue.shift() ?? null
  }
}
