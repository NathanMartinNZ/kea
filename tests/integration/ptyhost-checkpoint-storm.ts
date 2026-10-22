// Checkpoints on many PTYs while keys are typed, shared by ptyhost-checkpoints.test.ts and
// tests/chaos/ptyhost-checkpoint-race.test.ts: twenty real holders print frames (SGR text inside DEC 2026 blocks, so
// the only ground-state seqs are frame boundaries), their checkpoints fall due while keystrokes arrive, and every
// serialisation is recorded with the (manual) time it ran.

import os from 'node:os'
import headless from '@xterm/headless'
import { DEFAULT_TERMINAL_SETTINGS, L } from '@kea/protocol'
import { colorThemeOf, createTerminalOptions } from '@kea/terminal'
import type { Checkpoint } from '../../app/ptyhost/src/checkpoint/store.ts'
import { Mirror } from '../../app/ptyhost/src/mirror/mirror.ts'
import type { Pty } from '../../app/ptyhost/src/pty.ts'
import { ManualClock } from '../../app/ptyhost/src/test-support.ts'
import { ptyhostHarness, rawTty, until, type Harness } from '../support/holders.ts'
import { childArgv } from './ptyhost-child.ts'
import { terminalState, write } from './ptyhost-support.ts'

export interface StormPty {
  pty: Pty
  /** Everything this PTY printed so far, in order. */
  out: string
  /** Seqs a checkpoint may be cut at: 0 and every frame's end. */
  ground: Set<number>
}

export interface Storm {
  h: Harness
  clock: ManualClock
  ptys: StormPty[]
  /** Every checkpoint written: when (manual clock), which PTY, what, and the last keystroke typed before it. */
  writes: { at: number; ptyId: string; c: Checkpoint; lastKey: { at: number; ptyId: string } | null }[]
  /** Every keystroke, in order: when (manual clock) and to which PTY. */
  keys: { at: number; ptyId: string }[]
}

const enc = new TextEncoder()
const len = (s: string) => enc.encode(s).byteLength

/** One synchronized frame: coloured text inside a DEC 2026 block. */
function frame(pty: number, k: number): string {
  return `\x1b[?2026h\x1b[3${(pty + k) % 8}mpty ${pty} frame ${k} ${'='.repeat(10 + ((pty * 7 + k) % 40))}\x1b[0m\r\n\x1b[?2026l`
}

/** `n` frames from `from` on, and the ground-state seqs they end at (relative to `base`). */
function frames(pty: number, from: number, n: number, base: number, ground: Set<number>): string {
  let s = ''
  for (let k = from; k < from + n; k++) {
    s += frame(pty, k)
    ground.add(base + len(s))
  }
  return s
}

/**
 * Twenty PTYs, the first visible. Each prints `perRound` frames at once and again on every `round()`. Checkpoint
 * writes are recorded from the manager's store.
 */
export async function checkpointStorm(o: { ptys: number; rounds: number; perRound: number }): Promise<Storm & { round(r: number): Promise<void>; type(p: StormPty): void; step(ms: number): void; settled(): Promise<void> }> {
  const clock = new ManualClock()
  const h = await ptyhostHarness({ clock })
  const ptys: StormPty[] = []
  for (let i = 0; i < o.ptys; i++) {
    const ground = new Set<number>([0])
    const first = frames(i, 0, o.perRound, 0, ground)
    let base = len(first)
    const thens: string[] = []
    for (let r = 1; r <= o.rounds; r++) {
      const t = frames(i, r * o.perRound, o.perRound, base, ground)
      thens.push(t)
      base += len(t)
    }
    const pty = await h.spawn({ argv: rawTty(childArgv('talk', ['--print', first, ...thens.flatMap((t) => ['--then', t])])) })
    ptys.push({ pty, out: first, ground })
    ;(ptys.at(-1) as StormPty & { thens: string[] }).thens = thens
  }
  h.manager.setVisible([ptys[0]!.pty.ptyId])
  const writes: Storm['writes'] = []
  const keys: Storm['keys'] = []
  const store = (h.manager as unknown as { checkpoints: { write(d: string, id: string, c: Checkpoint): void } }).checkpoints
  const real = store.write.bind(store)
  store.write = (d, id, c) => {
    writes.push({ at: clock.now(), ptyId: id, c, lastKey: keys.at(-1) ?? null })
    real(d, id, c)
  }
  const settled = () =>
    until(
      'every PTY to have parsed all it printed',
      () => ptys.every((p) => p.pty.flushedSeq() === len(p.out) && (p.pty.isParked || (p.pty.currentMirror?.parsedSeq === len(p.out) && p.pty.pendingWrites === 0))),
      undefined,
      () => clock.advance(L.coalesceWindowMs),
    )
  await settled()
  return {
    h,
    clock,
    ptys,
    writes,
    keys,
    settled,
    async round(r: number) {
      for (const p of ptys) {
        p.out += (p as StormPty & { thens: string[] }).thens[r]!
        p.pty.signal(os.constants.signals.SIGUSR2, 'child')
      }
      await settled()
    },
    type(p: StormPty) {
      p.pty.input('k')
      keys.push({ at: clock.now(), ptyId: p.pty.ptyId })
    },
    step(ms: number) {
      clock.advance(ms)
    },
  }
}

/** The screen a mirror that never stopped would show at `seq`: `out`'s first `seq` bytes, fed to a fresh terminal. */
export async function referenceAt(out: string, seq: number, cols = 80, rows = 24): Promise<ReturnType<typeof terminalState>> {
  const t = new headless.Terminal(createTerminalOptions({ side: 'mirror', cols, rows, scrollback: DEFAULT_TERMINAL_SETTINGS.scrollback }))
  try {
    await write(t, enc.encode(out).subarray(0, seq))
    return terminalState(t)
  } finally {
    t.dispose()
  }
}

/** A checkpoint restored the way ptyhost restores one (a parked PTY waking). */
export async function restored(c: Checkpoint): Promise<ReturnType<typeof terminalState>> {
  const m = new Mirror({ cols: c.cols, rows: c.rows, scrollback: DEFAULT_TERMINAL_SETTINGS.scrollback, colors: colorThemeOf(DEFAULT_TERMINAL_SETTINGS.theme), startSeq: c.seq, restore: { cols: c.cols, rows: c.rows, data: c.data }, reply: () => {}, parsed: () => {}, now: () => 0 })
  try {
    await m.whenRestored()
    return terminalState(m.terminal as never)
  } finally {
    m.dispose()
  }
}
