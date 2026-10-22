import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@kea/kit'
import { L } from '@kea/protocol'
import { RendererLog, sourceName } from './rendererLog.ts'

const line = (level: string, message: string, sourceId = 'kea://app/assets/index-1a2b.js', lineNumber = 7) => ({ level, message, sourceId, lineNumber })

describe('the window’s log, written by main', () => {
  it('U-DIAG-6 · a window’s console warnings and errors become lines of renderer.log: the message cut at its cap, the script named by its path in the bundle, repeats counted instead of written, nothing kept once the window is gone', () => {
    const mem = createMemoryLogger({ process: 'renderer', now: () => 0 })
    const log = new RendererLog(mem)
    const lines = () => mem.entries.map((e) => `${e.level} ${e.msg} | ${e['window']} ${e['source'] ?? '-'}:${e['line'] ?? '-'}`)

    // only warnings and errors: what the window logs for the person developing it stays in the console
    log.message(1, line('info', 'hello'))
    log.message(1, line('debug', 'tick'))
    expect(lines()).toEqual([])

    log.message(1, line('error', 'Uncaught TypeError: x is not a function'))
    log.message(1, line('warning', 'resource gauge failed'))
    expect(lines()).toEqual(['error Uncaught TypeError: x is not a function | 1 assets/index-1a2b.js:7', 'warn resource gauge failed | 1 assets/index-1a2b.js:7'])

    // the same line again and again is one line and a count, written when another line follows
    for (let i = 0; i < 500; i++) log.message(1, line('warning', 'resource gauge failed'))
    expect(mem.entries).toHaveLength(2)
    // the same message from another place, or from another window, is another line
    log.message(1, line('warning', 'resource gauge failed', 'kea://app/assets/index-1a2b.js', 8))
    log.message(2, line('warning', 'resource gauge failed', 'kea://app/assets/index-1a2b.js', 8))
    expect(lines().slice(2)).toEqual(['warn the line before repeated 500 more times | 1 assets/index-1a2b.js:7', 'warn resource gauge failed | 1 assets/index-1a2b.js:8', 'warn resource gauge failed | 2 assets/index-1a2b.js:8'])

    // a long message is cut; a script that is not the app's is not named, and neither is a query or a fragment
    log.message(2, line('error', 'x'.repeat(L.rendererLogMessageMaxChars + 50), 'file:///Users/someone/evil.js?token=1', 3))
    const long = mem.entries.at(-1)!
    expect(long.msg).toHaveLength(L.rendererLogMessageMaxChars + 1)
    expect(long.msg.endsWith('…')).toBe(true)
    expect(long['source']).toBe('other')
    expect(JSON.stringify(long)).not.toContain('someone')
    expect(sourceName('kea://app/assets/a.js?v=1#x')).toBe('assets/a.js')
    expect(sourceName('')).toBe('')
    log.message(2, line('error', 'no source', ''))
    expect(mem.entries.at(-1)).not.toHaveProperty('source')
    expect(mem.entries.at(-1)).not.toHaveProperty('line')

    // the window goes: its count is written (one repeat reads "1 more time"), and nothing of it is kept
    log.message(1, line('warning', 'resource gauge failed', 'kea://app/assets/index-1a2b.js', 8))
    log.message(1, line('warning', 'resource gauge failed', 'kea://app/assets/index-1a2b.js', 8))
    const before = mem.entries.length
    // another window's going changes nothing
    log.closed(2)
    expect(mem.entries).toHaveLength(before)
    log.closed(1)
    expect(lines().at(-1)).toBe('warn the line before repeated 1 more time | 1 assets/index-1a2b.js:8')
    expect(mem.entries).toHaveLength(before + 1)
    log.closed(1)
    expect(mem.entries).toHaveLength(before + 1)

    // a window that opens again starts afresh: its first line is written even if it is the one last seen
    log.message(1, line('warning', 'resource gauge failed', 'kea://app/assets/index-1a2b.js', 8))
    expect(mem.entries).toHaveLength(before + 2)
  })
})
