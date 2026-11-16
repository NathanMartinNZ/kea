// The renderer's xterm.js parses a control byte straight after `ESC [` the same way however the output is split, in
// both of the package's builds: the app ships the module build, and tests resolve the CommonJS one.

import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface Parsed {
  modes: { applicationCursorKeysMode: boolean; synchronizedOutputMode: boolean }
  dispose(): void
}
type TerminalClass = new (options: { allowProposedApi: boolean }) => Parsed

const require = createRequire(import.meta.url)
const lib = path.dirname(require.resolve('@xterm/xterm'))

async function build(file: string): Promise<TerminalClass> {
  const mod = (file.endsWith('.mjs') ? await import(pathToFileURL(path.join(lib, file)).href) : require(path.join(lib, file))) as { Terminal: TerminalClass }
  return mod.Terminal
}

const live: Parsed[] = [] // bounded: the terminals of one test
afterEach(() => {
  for (const t of live.splice(0)) t.dispose()
})

/** Writes each piece as its own synchronous parse (test only: `write` queues). */
function parse(Terminal: TerminalClass, pieces: string[]): Parsed {
  const t = new Terminal({ allowProposedApi: true })
  live.push(t)
  const core = (t as unknown as { _core: { writeSync(d: Uint8Array): void } })._core
  for (const p of pieces) core.writeSync(new TextEncoder().encode(p))
  return t
}

describe('the renderer’s xterm.js parser', () => {
  it('U-TERM-66 · a control byte between ESC [ and a private prefix is read the same in one write as split after ESC [, in both builds', async () => {
    for (const file of ['xterm.mjs', 'xterm.js']) {
      const Terminal = await build(file)
      for (const pieces of [['\x1b[\x0f?1h'], ['\x1b[', '\x0f?1h']]) {
        expect(parse(Terminal, pieces).modes.applicationCursorKeysMode, `${file}: application cursor keys from ${JSON.stringify(pieces)}`).toBe(true)
      }
      for (const pieces of [['\x1b[\x7f?2026h'], ['\x1b[', '\x7f?2026h']]) {
        expect(parse(Terminal, pieces).modes.synchronizedOutputMode, `${file}: synchronized output from ${JSON.stringify(pieces)}`).toBe(true)
      }
    }
  })
})
