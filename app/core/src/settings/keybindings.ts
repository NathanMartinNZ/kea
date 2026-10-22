// `<KEA_HOME>/keybindings.json`: read, validated and watched by core, and served to the window as the `keybindings`
// store. The rules an entry must keep, and what an entry does to the table's defaults, are the protocol's
// (`@kea/protocol` keybindings.ts); this file is the reading.
//
// · JSONC, as settings.json is: comments and trailing commas are allowed.
// · A file that is broken never stops anything: one that does not parse, is not an array, cannot be read or is larger
//   than `keybindingsMaxBytes` leaves the bindings as they were (the defaults when Kea starts with it) and the store
//   says where it broke. An entry that breaks a rule is left out with a notice and the others apply.
// · Edits apply live: the file is followed through core's watch service (an editor's atomic save, and a file made
//   later, are followed as for settings.json), changes collected for one window, then read again.
// · Kea never writes the file, except to make a starter one when the person asks to open it and none is there
//   (`keybindings.ensureFile`).

import fs from 'node:fs'
import path from 'node:path'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import { atomicWrite, type Disposable, type Logger } from '@kea/kit'
import {
  conflictText,
  effectiveBindings,
  KEYBINDINGS_FILE,
  KEYBINDINGS_KEY,
  KEYBINDINGS_STORE,
  KEYBINDINGS_TEMPLATE,
  KeyedStore,
  L,
  readKeybindings,
  type Handlers,
  type keybindingsApi,
  type KeybindingNotice,
  type KeybindingsError,
  type KeybindingsState,
  type KeyOverride,
} from '@kea/protocol'
import type { WatchService } from '../platform/watch/service.ts'
import { Watcher } from '../platform/watch/watcher.ts'
import { lineColumn } from './settings.ts'

/** `<KEA_HOME>/keybindings.json` */
export function keybindingsPath(home: string): string {
  return path.join(home, KEYBINDINGS_FILE)
}

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true }

/**
 * The parse result of a keybindings.json text: its entries (empty text is none), or the first error with its position.
 * A document that is not an array, or nests too deeply for the parser, is an error too.
 */
export function parseKeybindingsText(text: string): { raw: unknown[]; error: null } | { raw: null; error: KeybindingsError } {
  const at = (message: string, offset: number) => ({ raw: null, error: { message, ...lineColumn(text, offset) } })
  const errors: ParseError[] = []
  let raw: unknown
  try {
    raw = parse(text, errors, PARSE_OPTIONS) as unknown
  } catch (e) {
    if (!(e instanceof RangeError)) throw e
    return at('nested too deeply', 0)
  }
  const e = errors[0]
  if (e) return at(printParseErrorCode(e.error), e.offset)
  if (raw === undefined) return { raw: [], error: null }
  if (!Array.isArray(raw)) return at('The file must be a list: [ { "command": "…", "key": "…" } ]', Math.max(0, text.search(/\S/)))
  return { raw, error: null }
}

export interface KeybindingsFileOptions {
  home: string
  log: Logger
  /** Watch the file for edits (default true; unit tests call `reload()` instead). */
  watch?: boolean
  /** Core's watch service. Default: one of this object's own, closed with it. */
  watcher?: WatchService
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export class KeybindingsFile {
  /** `keybindings`: the file's state, one row. */
  readonly store = new KeyedStore<KeybindingsState>(KEYBINDINGS_STORE)
  readonly file: string
  private readonly opts: KeybindingsFileOptions
  /** The entries in use: the last good file's. */
  private overrides: KeyOverride[] = []
  private notices: KeybindingNotice[] = []
  private watcher: Disposable | null = null
  /** The watch service made here when none was given: closed with this object. */
  private ownWatcher: Watcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(opts: KeybindingsFileOptions) {
    this.opts = opts
    this.file = keybindingsPath(opts.home)
    // followed first, read after: the watch reports what changes after it began, and takes what the file held then
    // as read. Read first, a save landing between the two would be neither read nor reported
    if (opts.watch !== false) this.watch()
    this.reload()
  }

  get state(): KeybindingsState {
    return this.store.get(KEYBINDINGS_KEY) as KeybindingsState
  }

  /** Read the file again and apply what changed. */
  reload(): void {
    if (this.disposed) return
    let text: string | null = null
    let failed: string | null = null
    try {
      const size = fs.statSync(this.file).size
      if (size > L.keybindingsMaxBytes) failed = `The file is larger than ${L.keybindingsMaxBytes} bytes and is not read.`
      else text = fs.readFileSync(this.file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') failed = (e as Error).message
    }
    if (failed !== null) {
      this.set({ exists: true, error: { message: failed, line: 1, column: 1 } })
      this.opts.log.warn('keybindings.json not read; the bindings in use stay', { error: failed })
      return
    }
    const parsed = text === null ? { raw: [] as unknown[], error: null } : parseKeybindingsText(text)
    if (parsed.error) {
      this.set({ exists: true, error: parsed.error })
      this.opts.log.warn('keybindings.json does not parse; the bindings in use stay', { ...parsed.error })
      return
    }
    const { overrides, notices } = readKeybindings(parsed.raw)
    for (const n of notices) if (!this.notices.some((o) => equal(o, n))) this.opts.log.warn('key binding left out', { ...n })
    if (!equal(overrides, this.overrides)) {
      const { conflicts } = effectiveBindings(overrides)
      this.opts.log.info('key bindings applied', { entries: overrides.length, conflicts: conflicts.map(conflictText) })
    }
    this.overrides = overrides
    this.notices = notices
    this.set({ exists: text !== null, error: null })
  }

  /** "Open keybindings.json": the file is there afterwards (a starter file when it was not). */
  async ensureFile(): Promise<{ path: string; created: boolean }> {
    if (fs.existsSync(this.file)) return { path: this.file, created: false }
    await atomicWrite(this.file, KEYBINDINGS_TEMPLATE)
    this.reload()
    return { path: this.file, created: true }
  }

  handlers(): Handlers<typeof keybindingsApi> {
    return { 'keybindings.ensureFile': () => this.ensureFile() }
  }

  /** The `core.keybindings` gauge: entries in use, notices held, the file's watch. */
  get resourceCounts(): { entries: number; notices: number; watchers: number } {
    return { entries: this.overrides.length, notices: this.notices.length, watchers: this.watcher ? 1 : 0 }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.watcher?.dispose()
    this.watcher = null
    this.ownWatcher?.dispose()
    this.ownWatcher = null
    this.store.dispose()
  }

  private set(s: { exists: boolean; error: KeybindingsError | null }): void {
    const next: KeybindingsState = { path: this.file, exists: s.exists, error: s.error, overrides: this.overrides, notices: this.notices }
    const cur = this.store.get(KEYBINDINGS_KEY)
    if (!cur || !equal(cur, next)) this.store.set(KEYBINDINGS_KEY, next)
  }

  private watch(): void {
    const service = this.opts.watcher ?? (this.ownWatcher = new Watcher({ log: this.opts.log }))
    this.watcher = service.file(this.file, () => {
      if (this.timer || this.disposed) return
      // changes are collected for one window before the file is read again
      this.timer = setTimeout(() => {
        this.timer = null
        this.reload()
      }, L.watchBatchMs)
    })
  }
}
