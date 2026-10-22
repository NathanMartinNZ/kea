import { describe, expect, it } from 'vitest'
import { L } from './generated/limits.ts'
import { childArgv, childV8Flags, isChildToMain, isMainToChild, parseChildArgv, parsePerfBusy, ptyhostV8Flags } from './process.ts'

describe('process messages and child argv', () => {
  it('U-PROC-1 · child argv round-trips; the perf stall is parsed only in its strict form', () => {
    const a = { home: '/tmp/kea-x', version: '1.2.3', dev: true, helper: '/h/kea-helper', perfBusy: { ms: 30, everyMs: 1000 } }
    expect(parseChildArgv(['/electron', 'x.cjs', ...childArgv(a)])).toEqual(a)
    expect(parseChildArgv(childArgv({ home: '/h', version: '0.1.0', dev: false }))).toEqual({ home: '/h', version: '0.1.0', dev: false })
    expect(() => parseChildArgv(['--dev'])).toThrow(/kea-home/)
    for (const bad of [undefined, '', '30', '30:', 'x:1000', '0:1000', '30:30', '30:20', '99999:1000000000']) expect(parsePerfBusy(bad)).toBeUndefined()
    expect(parsePerfBusy('30:1000')).toEqual({ ms: 30, everyMs: 1000 })
    expect(isMainToChild({ k: 'ping', n: 1 })).toBe(true)
    expect(isMainToChild({ k: 'nope' })).toBe(false)
    expect(isChildToMain({ k: 'ready' })).toBe(true)
  })

  it('U-PROC-2 · ptyhost runs with its V8 semi-space capped at L.ptyhostSemiSpaceMb (whole MB, as V8 takes it)', () => {
    expect(ptyhostV8Flags()).toEqual([`--max-semi-space-size=${L.ptyhostSemiSpaceMb}`])
    expect(Number.isInteger(L.ptyhostSemiSpaceMb) && L.ptyhostSemiSpaceMb >= 1).toBe(true)
  })

  it('U-MEM-27 · core and ptyhost are started with V8’s old space capped at their watchdog hard limit, in whole MiB; ptyhost keeps its semi-space cap beside it', () => {
    const mib = (bytes: number): number => bytes / (1024 * 1024)
    expect(childV8Flags('core')).toEqual([`--max-old-space-size=${mib(L.watchdogHardCoreBytes)}`])
    expect(childV8Flags('ptyhost')).toEqual([...ptyhostV8Flags(), `--max-old-space-size=${mib(L.watchdogHardPtyhostBytes)}`])
    for (const bytes of [L.watchdogHardCoreBytes, L.watchdogHardPtyhostBytes]) expect(Number.isInteger(mib(bytes)) && mib(bytes) >= 1, 'a whole number of MiB: V8 takes no fraction').toBe(true)
    // one flag per word, none with a space: main joins them into one `--js-flags=` argument (U-PTY-55)
    for (const f of [...childV8Flags('core'), ...childV8Flags('ptyhost')]) expect(f).toMatch(/^--[a-z-]+=\d+$/)
  })
})

describe('main ⇄ core for the visible set', () => {
  it('U-PROC-3 · main accepts a window’s visible-set directories from core only as a window id with absolute paths (none: it shows no session)', () => {
    expect(isChildToMain({ k: 'visible', connId: 1, dirs: ['/repo/.worktrees/fix-auth'] })).toBe(true)
    expect(isChildToMain({ k: 'visible', connId: 1, dirs: [] })).toBe(true)
    for (const bad of [{ connId: '1' }, { connId: 1.5 }, { dirs: null }, { dirs: 'x' }, { dirs: ['relative/dir'] }, { dirs: ['/ok', 3] }, { dirs: [''] }]) expect(isChildToMain({ k: 'visible', connId: 1, dirs: ['/a'], ...bad }), JSON.stringify(bad)).toBe(false)
    expect(isChildToMain({ k: 'visible' })).toBe(false)
  })
})

describe('main ⇄ core for menu-bar mode', () => {
  it('U-SES-8 · main accepts core’s menu-bar state only when well formed (counts, an On quit choice, a list of sessions with their glyphs, the badge switch) and its stop-all answer by id', () => {
    const ok = { k: 'menuBar', live: 2, onQuit: 'menuBar', count: 1, sessions: [{ id: 's1', title: 'Fix', reason: 'crashed', glyph: 'failed' }], badge: true }
    expect(isChildToMain(ok)).toBe(true)
    for (const bad of [
      { live: -1 },
      { live: 1.5 },
      { onQuit: 'later' },
      { count: '1' },
      { sessions: null },
      { sessions: [{ id: 's1', title: 3, reason: 'x', glyph: 'failed' }] },
      { sessions: [{ id: 's1', title: 'Fix', reason: 'x', glyph: 'red' }] },
      { sessions: [null] },
      { badge: 'yes' },
    ])
      expect(isChildToMain({ ...ok, ...bad }), JSON.stringify(bad)).toBe(false)
    expect(isChildToMain({ k: 'stoppedAll', id: 3 })).toBe(true)
    expect(isChildToMain({ k: 'stoppedAll' })).toBe(false)
    expect(isMainToChild({ k: 'stopAll', id: 4 })).toBe(true)
    expect(isMainToChild({ k: 'stopAll', id: 'x' })).toBe(false)
  })
})

describe('main ⇄ core for notifications', () => {
  it('U-NT-5 · main accepts core’s notifications only when well formed (a tag; a post’s session or null, texts and sound) and core accepts main’s focus only as a boolean', () => {
    const post = { k: 'notify', op: 'post', tag: 's:01K', sessionId: '01K', title: 'Fix · needs permission', subtitle: 'kea', body: 'Bash: npm test', sound: true }
    expect(isChildToMain(post)).toBe(true)
    expect(isChildToMain({ ...post, sessionId: null })).toBe(true)
    expect(isChildToMain({ k: 'notify', op: 'withdraw', tag: 's:01K' })).toBe(true)
    for (const bad of [{ tag: '' }, { tag: 3 }, { op: 'show' }, { sessionId: 4 }, { title: null }, { subtitle: undefined }, { body: 1 }, { sound: 'yes' }]) expect(isChildToMain({ ...post, ...bad }), JSON.stringify(bad)).toBe(false)
    expect(isChildToMain({ k: 'notify', op: 'withdraw' })).toBe(false)
    expect(isMainToChild({ k: 'focus', focused: false })).toBe(true)
    expect(isMainToChild({ k: 'focus', focused: 1 })).toBe(false)
    expect(isMainToChild({ k: 'focus' })).toBe(false)
  })
})

