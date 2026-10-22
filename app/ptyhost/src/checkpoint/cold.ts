// The last screen of a PTY whose holder is gone (it exited, crashed or did not survive a reboot) or that is parked: its
// checkpoint plus whatever the ring holds after it, parsed into a temporary mirror that is freed as soon as the
// snapshot is taken. Without a checkpoint the ring alone is replayed from its first line boundary. Nothing is ever
// answered. A ring file whose header is corrupt (C-COR-3) says nothing trustworthy about what followed the checkpoint,
// so there is no cold screen at all: skipped, with a note in the log; the session stays resumable.

import fs from 'node:fs'
import type { Logger } from '@kea/kit'
import { DEFAULT_TERMINAL_SETTINGS, L } from '@kea/protocol'
import type { ColorTheme } from '@kea/terminal'
import { Mirror } from '../mirror/mirror.ts'
import { firstLineBoundary } from '../pty.ts'
import { RingFile } from '../stream/ring.ts'
import type { CheckpointStore } from './store.ts'

export interface ColdScreen {
  seq: number
  cols: number
  rows: number
  data: string
  /** The visible screen as text (a capture of an exited PTY). */
  text: string
}

export async function coldScreen(o: {
  stateDir: string
  ptyId: string
  store: CheckpointStore
  colors: ColorTheme
  /** The grid for a ring with no usable checkpoint. */
  cols: number
  rows: number
  scrollback?: number
  now(): number
  log?: Logger
}): Promise<ColdScreen | null> {
  const path = `${o.stateDir}/${o.ptyId}.ring`
  const ring = new RingFile(path)
  let m: Mirror | null = null
  try {
    const h = ring.header()
    if (!h && fs.existsSync(path)) {
      o.log?.warn('cold restore skipped: ring header corrupt', { ptyId: o.ptyId, ring: path })
      return null
    }
    const c = o.store.read(o.stateDir, o.ptyId)
    const latest = h ? h.latestSeq : (c?.seq ?? 0)
    if (!c && !h) return null
    const usable = c && (!h || c.seq >= h.earliestSeq) && c.seq <= latest ? c : null
    const start = usable ? usable.seq : firstLineBoundary(ring, h!.earliestSeq, latest)
    let lastParsed = start
    let target = start
    let done!: () => void
    const parsed = new Promise<void>((r) => (done = r))
    m = new Mirror({
      cols: usable?.cols ?? Math.max(L.ptyMinCols, o.cols),
      rows: usable?.rows ?? Math.max(L.ptyMinRows, o.rows),
      scrollback: o.scrollback ?? DEFAULT_TERMINAL_SETTINGS.scrollback,
      colors: o.colors,
      startSeq: start,
      ...(usable ? { restore: { cols: usable.cols, rows: usable.rows, data: usable.data } } : {}),
      reply: () => {},
      parsed: (seq) => {
        lastParsed = seq
        if (seq >= target) done()
      },
      now: o.now,
    })
    m.setReplying(false)
    for (let s = start; s < latest; ) {
      const d = ring.read(s, latest, L.coalesceMaxBytes)
      if (!d || d.byteLength === 0) break
      m.write(s, d)
      s += d.byteLength
      target = s
    }
    await m.whenRestored()
    if (lastParsed < target) await parsed
    const s = m.snapshot()
    return { seq: s.seq, cols: s.cols, rows: s.rows, data: s.data, text: m.screenText() }
  } finally {
    m?.dispose()
    ring.close()
  }
}
