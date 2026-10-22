import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryLogger } from '@kea/kit'
import { chordLabel, chordText, effectiveBindings, KEYBINDINGS_TEMPLATE, L, parseKeyText, readKeybindings } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WatchService } from '../platform/watch/service.ts'
import { KeybindingsFile, keybindingsPath, parseKeybindingsText } from './keybindings.ts'

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
  vi.useRealTimers()
})

function home(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-keybindings-test-'))
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function open(h: string, watcher?: WatchService): KeybindingsFile {
  const k = new KeybindingsFile({ home: h, log: createMemoryLogger({ process: 'core' }), ...(watcher ? { watcher } : { watch: false }) })
  cleanup.push(() => k.dispose())
  return k
}

const GOOD = `// mine
[
  { "command": "server.toggle", "key": "cmd+shift+y" }, // run it with ⇧⌘Y
  { "command": "session.archive", "key": null },
]
`

/** `cmd+shift+y` as this system reads it: `cmd+shift+y` on macOS, `ctrl+shift+y` on Linux. */
const Y = chordText(parseKeyText('cmd+shift+y')!)

describe('keybindings.json in core', () => {
  it('U-KB-10 · the text is JSONC and must be a list; an error carries its line and column', () => {
    expect(parseKeybindingsText(GOOD)).toEqual({ raw: [{ command: 'server.toggle', key: 'cmd+shift+y' }, { command: 'session.archive', key: null }], error: null })
    expect(parseKeybindingsText('')).toEqual({ raw: [], error: null })
    expect(parseKeybindingsText('// nothing yet\n')).toEqual({ raw: [], error: null })
    expect(parseKeybindingsText('[\n  { "command": "x", "key": }\n]').error).toMatchObject({ line: 2, column: 28 })
    expect(parseKeybindingsText('\n  { "server.toggle": "cmd+y" }').error).toMatchObject({ line: 2, column: 3, message: expect.stringContaining('must be a list') })
    expect(parseKeybindingsText('['.repeat(100_000)).error).not.toBeNull()
  })

  it('U-KB-10 · no file: the defaults; a file: its entries; a broken file or entry never stops anything, the last good entries stay in use and the store says where it broke; a file removed: the defaults again', () => {
    const h = home()
    const k = open(h)
    expect(k.state).toEqual({ path: keybindingsPath(h), exists: false, error: null, overrides: [], notices: [] })

    fs.writeFileSync(k.file, GOOD)
    k.reload()
    expect(k.state).toMatchObject({ exists: true, error: null, notices: [] })
    expect(k.state.overrides).toEqual([
      { command: 'server.toggle', chord: Y },
      { command: 'session.archive', chord: null },
    ])
    expect(k.resourceCounts).toEqual({ entries: 2, notices: 0, watchers: 0 })

    // one bad entry: left out with a notice, the rest applied
    fs.writeFileSync(k.file, '[{ "command": "server.toggle", "key": "cmd+shift+y" }, { "command": "nope", "key": "cmd+y" }]')
    k.reload()
    expect(k.state.overrides).toEqual([{ command: 'server.toggle', chord: Y }])
    expect(k.state.notices).toEqual([{ index: 1, command: 'nope', key: 'cmd+y', message: 'No command "nope".' }])

    // the file breaks: what was in use stays, and the error has its place
    fs.writeFileSync(k.file, '[\n  { "command": "server.toggle" "key": "cmd+shift+u" }\n]')
    k.reload()
    expect(k.state.error).toMatchObject({ line: 2 })
    expect(k.state.overrides).toEqual([{ command: 'server.toggle', chord: Y }])
    expect(effectiveBindings(k.state.overrides).labels.get('server.toggle')).toEqual([chordLabel(Y)]) // ⇧⌘Y on macOS, Ctrl+Shift+Y on Linux (U-KB-8 and U-PLT-40 check the labels themselves)
    // not a list, too large, unreadable (a folder under its name): the same
    for (const broken of ['{ "server.toggle": "cmd+y" }', `[${' '.repeat(L.keybindingsMaxBytes)}]`]) {
      fs.writeFileSync(k.file, broken)
      k.reload()
      expect(k.state.error, broken.slice(0, 20)).not.toBeNull()
      expect(k.state.overrides).toEqual([{ command: 'server.toggle', chord: Y }])
    }
    fs.rmSync(k.file)
    fs.mkdirSync(k.file)
    k.reload()
    expect(k.state.error).not.toBeNull()
    expect(k.state.overrides).toHaveLength(1)

    // repaired, then removed
    fs.rmdirSync(k.file)
    fs.writeFileSync(k.file, '[]')
    k.reload()
    expect(k.state).toMatchObject({ exists: true, error: null, overrides: [], notices: [] })
    fs.rmSync(k.file)
    k.reload()
    expect(k.state).toMatchObject({ exists: false, error: null, overrides: [] })

    // Kea starts with a broken file: the defaults, and the error
    fs.writeFileSync(k.file, '[{')
    const fresh = open(h)
    expect(fresh.state.overrides).toEqual([])
    expect(fresh.state.error).not.toBeNull()
  })

  it('U-KB-10 · edits apply live through the watch service: a burst of changes is collected for one batching window and read once; closed, nothing is read any more and the watch is given back', () => {
    vi.useFakeTimers()
    const h = home()
    let changed: (() => void) | null = null
    let disposed = 0
    const service: WatchService = {
      file: (file, onChange) => {
        expect(file).toBe(keybindingsPath(h))
        changed = onChange
        return { dispose: () => void disposed++ } as ReturnType<WatchService['file']>
      },
      dir: () => ({ dispose: () => undefined }),
    }
    const k = open(h, service)
    expect(k.resourceCounts.watchers).toBe(1)
    const reads = vi.spyOn(k, 'reload')
    fs.writeFileSync(k.file, GOOD)
    for (let i = 0; i < 5; i++) changed!()
    expect(reads).not.toHaveBeenCalled()
    vi.advanceTimersByTime(L.watchBatchMs)
    expect(reads).toHaveBeenCalledTimes(1)
    expect(k.state.overrides).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)

    // 200 saves, each read once and nothing left behind (the timer is the one resource that comes and goes)
    for (let i = 0; i < 200; i++) {
      fs.writeFileSync(k.file, i % 2 ? GOOD : '[]')
      changed!()
      changed!()
      vi.advanceTimersByTime(L.watchBatchMs)
      expect(vi.getTimerCount()).toBe(0)
    }
    expect(reads).toHaveBeenCalledTimes(201)
    expect(k.resourceCounts).toEqual({ entries: 2, notices: 0, watchers: 1 })

    changed!()
    k.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(disposed).toBe(1)
    changed!()
    vi.advanceTimersByTime(L.watchBatchMs)
    expect(reads).toHaveBeenCalledTimes(201)
    expect(k.resourceCounts.watchers).toBe(0)
  })

  it('U-KB-10 · a save that lands just as Kea begins to follow the file is not lost: the file is followed first and read after, so what it held when the watch began is what was read, and a later save is heard as ever', () => {
    vi.useFakeTimers()
    const h = home()
    fs.writeFileSync(keybindingsPath(h), '[]\n')
    let changed: (() => void) | null = null
    // the watch service as it is (platform/watch/single.ts): what the file holds when its watch begins is the
    // caller's to have read; only a change after that is reported. The save lands right before the watch begins.
    const service: WatchService = {
      file: (file, onChange) => {
        fs.writeFileSync(file, GOOD)
        changed = onChange
        return { dispose: () => undefined, look: () => undefined }
      },
      dir: () => ({ dispose: () => undefined }),
    }
    const k = open(h, service)
    expect(k.state.overrides.map((o) => o.command), 'the save made as the watch began').toEqual(['server.toggle', 'session.archive'])
    // nothing more is reported for that save, and nothing needs to be
    vi.advanceTimersByTime(L.watchBatchMs)
    expect(k.state.overrides).toHaveLength(2)
    // a later save is reported and read
    fs.writeFileSync(k.file, '[]\n')
    changed!()
    vi.advanceTimersByTime(L.watchBatchMs)
    expect(k.state.overrides).toEqual([])
  })

  it('U-KB-10 · “Open keybindings.json” makes a starter file only when there is none, and never touches one that is there; the example the starter shows is a valid entry that takes no other command’s key', async () => {
    const h = home()
    const k = open(h)
    expect(await k.ensureFile()).toEqual({ path: k.file, created: true })
    expect(fs.readFileSync(k.file, 'utf8')).toBe(KEYBINDINGS_TEMPLATE)
    expect(k.state).toMatchObject({ exists: true, error: null, overrides: [] })
    fs.writeFileSync(k.file, GOOD)
    expect(await k.ensureFile()).toEqual({ path: k.file, created: false })
    expect(fs.readFileSync(k.file, 'utf8')).toBe(GOOD)
    expect(parseKeybindingsText(KEYBINDINGS_TEMPLATE)).toEqual({ raw: [], error: null })
    // the example the starter file shows (in its comment) is one a person can copy: read as the file is read, it is
    // one valid entry that takes no other command's key (an example on ⇧⌘R would take Restart Dev Server's)
    const example = KEYBINDINGS_TEMPLATE.split('\n').filter((l) => /^\/\/\s+\{/.test(l)).map((l) => l.replace(/^\/\/\s+/, ''))
    expect(example).toHaveLength(1)
    const parsed = parseKeybindingsText(`[${example[0]}]`)
    expect(parsed.error).toBeNull()
    const read = readKeybindings(parsed.raw ?? [])
    expect(read.notices).toEqual([])
    expect(read.overrides).toHaveLength(1)
    expect(effectiveBindings(read.overrides).conflicts, 'the example takes a key another command has').toEqual([])
    // and it changes something: the command has that key afterwards, and did not before
    const chord = read.overrides[0]?.chord
    const keysOf = (b: ReturnType<typeof effectiveBindings>) => b.bindings.filter((x) => x.id === read.overrides[0]?.command).map((x) => x.chord)
    expect(keysOf(effectiveBindings(read.overrides))).toEqual([chord])
    expect(keysOf(effectiveBindings())).not.toContain(chord)
  })
})
