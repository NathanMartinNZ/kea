// Where a PTY's checkpoint lives: `<stateDir>/<ptyId>.ckpt`, written atomically (temp + rename) and private
// to the user (0600). With "Keep scrollback on disk" off (`terminal.diskBackedScrollback`), checkpoints stay in
// ptyhost's memory instead: one per PTY, dropped with the PTY, and cold restore after a reboot is lost.

import fs from 'node:fs'
import { atomicWriteSync } from '@kea/kit'

export interface Checkpoint {
  /** The seq the state describes: every byte below it is in `data`. Always a ground-state seq. */
  seq: number
  cols: number
  rows: number
  /** Serialized screen + mode trailer, written into a fresh terminal of `cols × rows`. */
  data: string
  title: string | null
}

const VERSION = 1

export function checkpointPath(stateDir: string, ptyId: string): string {
  return `${stateDir}/${ptyId}.ckpt`
}

/** Parse a checkpoint file; null for anything that is not a complete version-1 checkpoint (C-COR). */
export function parseCheckpoint(text: string): Checkpoint | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const nat = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
  if (o.v !== VERSION || !nat(o.seq) || !nat(o.cols) || !nat(o.rows) || typeof o.data !== 'string') return null
  if (o.title !== null && typeof o.title !== 'string') return null
  return { seq: o.seq as number, cols: o.cols as number, rows: o.rows as number, data: o.data, title: o.title }
}

export function serializeCheckpoint(c: Checkpoint): string {
  return JSON.stringify({ v: VERSION, seq: c.seq, cols: c.cols, rows: c.rows, title: c.title, data: c.data })
}

export interface CheckpointStore {
  read(stateDir: string, ptyId: string): Checkpoint | null
  write(stateDir: string, ptyId: string, c: Checkpoint): void
  remove(stateDir: string, ptyId: string): void
}

export const diskCheckpoints: CheckpointStore = {
  read(stateDir, ptyId) {
    try {
      return parseCheckpoint(fs.readFileSync(checkpointPath(stateDir, ptyId), 'utf8'))
    } catch {
      return null
    }
  },
  write(stateDir, ptyId, c) {
    atomicWriteSync(checkpointPath(stateDir, ptyId), serializeCheckpoint(c), { mode: 0o600 })
  },
  remove(stateDir, ptyId) {
    fs.rmSync(checkpointPath(stateDir, ptyId), { force: true })
  },
}

/**
 * Checkpoints in memory, for `terminal.diskBackedScrollback: false`: one serialised screen per live PTY, a parked one's
 * included. Counted in the resource report's `ptyhost.checkpoints` (`inMemory`, `inMemoryChars`).
 */
export class MemoryCheckpoints implements CheckpointStore {
  private readonly map = new Map<string, Checkpoint>() // bounded: one per live PTY; removed with it, or moved to disk when the setting is turned on

  read(stateDir: string, ptyId: string): Checkpoint | null {
    return this.map.get(checkpointPath(stateDir, ptyId)) ?? null
  }
  write(stateDir: string, ptyId: string, c: Checkpoint): void {
    this.map.set(checkpointPath(stateDir, ptyId), c)
  }
  remove(stateDir: string, ptyId: string): void {
    this.map.delete(checkpointPath(stateDir, ptyId))
  }
  get size(): number {
    return this.map.size
  }
  /** UTF-16 units of serialised state held (a one-byte string's bytes; two per unit once it has a non-Latin-1 char). */
  get chars(): number {
    let n = 0
    for (const c of this.map.values()) n += c.data.length
    return n
  }
}
