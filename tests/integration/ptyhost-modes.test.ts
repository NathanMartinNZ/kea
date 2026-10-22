// Modes a program sets survive a snapshot into a fresh renderer: here the kitty keyboard flags, checked with the
// window's own xterm (`@xterm/xterm`, whose key encoder runs without a DOM) and the window's own key override.

import { afterEach, describe, expect, it } from 'vitest'
import type { StreamToRenderer } from '@kea/protocol'
import { createTerminalOptions } from '@kea/terminal'
import { terminalKeyOverride } from '../../app/renderer/src/features/commands/keys.ts'
import { internals } from '../../packages/terminal/src/test-support.ts'
import { ptyhostHarness, rawTty, until, type Harness } from '../support/holders.ts'
import { childArgv } from './ptyhost-child.ts'
import { browserXterm, parsedSeq, TestRenderer } from './ptyhost-support.ts'

let h: Harness | null = null
afterEach(async () => {
  await h?.dispose()
  h = null
})

const SHIFT_ENTER = { type: 'keydown', key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }

/** What the window sends for ⇧↵ on a fresh terminal that was given `snapshot`: its override, else xterm's encoder. */
async function shiftEnter(snapshot: Extract<StreamToRenderer, { k: 'snapshot' }> | null, flags: number): Promise<string> {
  const { Terminal } = await browserXterm()
  const t = new Terminal({ ...createTerminalOptions({ side: 'renderer', cols: snapshot?.cols ?? 80, rows: snapshot?.rows ?? 24, scrollback: 100 }), allowProposedApi: true })
  try {
    if (snapshot) await new Promise<void>((r) => t.write(snapshot.data, r))
    const override = terminalKeyOverride(SHIFT_ENTER, flags)
    if (override !== null) return override
    const ev = { ...SHIFT_ENTER, preventDefault() {}, stopPropagation() {}, getModifierState: () => false }
    return (t._core._keyboardService.evaluateKeyDown(ev) as { key: string }).key
  } finally {
    t.dispose()
  }
}

describe('modes through a snapshot', () => {
  it('I-PTY-7 · kitty keyboard flags pushed by the program reach a fresh renderer through the snapshot, so ⇧↵ is encoded per the kitty protocol', async () => {
    // without the protocol: the window's override sends \n
    expect(await shiftEnter(null, 0)).toBe('\n')
    h = await ptyhostHarness()
    const push = '\x1b[>1u' // push "disambiguate escape codes"
    const pty = await h.spawn({ argv: rawTty(childArgv('talk', ['--print', '\\e[>1uready\\r\\n'])) })
    await until('the push to be parsed', () => parsedSeq(pty) === push.length + 'ready\r\n'.length)
    const r = new TestRenderer(h.manager, pty.ptyId)
    await until('the snapshot', () => r.snapshots === 1 && r.writtenSeq >= 0)
    const snap = r.messages.find((m) => m.k === 'snapshot') as Extract<StreamToRenderer, { k: 'snapshot' }>
    // the fresh renderer knows the flags: in xterm itself and in the window's mode tracker
    expect(internals(r.term).kitty.flags).toBe(1)
    expect(r.modes.tracker.state().kitty.flags).toBe(1)
    expect(await shiftEnter(snap, r.modes.tracker.state().kitty.flags)).toBe('\x1b[13;2u')
    r.close()
  })
})
