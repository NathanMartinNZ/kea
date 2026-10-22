// `<KEA_HOME>/settings.json`: read, validated, watched and edited in place by core, and served to the renderer as the
// `settings` and `settings.status` stores.
//
// · JSONC: comments and trailing commas are allowed (jsonc-parser).
// · A file that does not parse never stops anything: the last good values stay in use (the defaults
//   when Kea starts with a broken file) and `settings.status` carries the error with its line and column. "Does not
//   parse" includes a document that is not an object, one nested too deeply to parse, and a file that cannot be read.
// · A file that parses is validated key by key (`parseSettings`): an invalid value falls back to its default with a
//   notice; unknown keys are ignored here and kept in the file.
// · External edits apply live: `settings.json` is followed through core's watch service (an editor's atomic
//   save replaces the file, which the service follows onto its new inode, and a file made later is found through its
//   folder), changes collected for one window, then the file is read again. Nothing changes unless a value does.
// · A change from the UI edits exactly one key: read the file, `modify` + `applyEdits` that key, write it
//   atomically (kit's atomicWrite, to the real file when settings.json is a symlink), so comments, unknown keys, key
//   order and formatting survive. A file that does not parse is never edited (`file_invalid`); nor is a key whose
//   parent is written as something that is no object (`"terminal": 5`): the refusal names it and says what to do.
//   Of a key written twice the last is in effect, so that one is changed, and Reset takes every one of them out. Reset
//   of a key that is not there writes nothing.
// · A byte order mark at the start (an editor's "UTF-8 with BOM") is read past, and kept when the file is written.

import fs from 'node:fs'
import path from 'node:path'
import { applyEdits, createScanner, modify, parse, parseTree, printParseErrorCode, type Edit, type Node, type ParseError } from 'jsonc-parser'
import { atomicWrite, type Disposable, type Logger } from '@kea/kit'
import {
  allSettingDefs,
  isAvailable,
  KeyedStore,
  L,
  parseSettings,
  RpcError,
  SETTINGS_STATUS_KEY,
  SETTINGS_STATUS_STORE,
  SETTINGS_STORE,
  settingRows,
  settingsApi,
  type AgentSettingsExtension,
  type Handlers,
  type SettingsNotice,
  type SettingsParseError,
  type SettingsStatus,
  type SettingsValues,
  type SettingRow,
} from '@kea/protocol'
import { coreOs } from '../os/index.ts'
import type { WatchService } from '../platform/watch/service.ts'
import { Watcher } from '../platform/watch/watcher.ts'

export const SETTINGS_FILE = 'settings.json'

/** `<KEA_HOME>/settings.json` */
export function settingsPath(home: string): string {
  return path.join(home, SETTINGS_FILE)
}

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true }
/** A byte order mark, as some editors put at the start of a UTF-8 file. */
const BOM = '\uFEFF'
const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }

/** 1-based line and column of `offset` in `text`. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let start = 0
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      start = i + 1
    }
  }
  return { line, column: offset - start + 1 }
}

const errorAt = (text: string, message: string, offset: number): SettingsParseError => ({ message, offset, ...lineColumn(text, offset) })

/**
 * The parse result of a settings.json text: the document (an object; empty text is `{}`), or the first error with its
 * position. A document that is not an object, or nests too deeply for the parser, is an error too (C-COR-5).
 */
export function parseSettingsText(file: string): { raw: unknown; error: SettingsParseError | null } {
  // an error is placed as an editor shows it: the mark is no character of line 1
  const text = file.startsWith(BOM) ? file.slice(BOM.length) : file
  const errors: ParseError[] = []
  let raw: unknown
  try {
    raw = parse(text, errors, PARSE_OPTIONS) as unknown
  } catch (e) {
    if (!(e instanceof RangeError)) throw e
    return { raw: undefined, error: errorAt(text, 'nested too deeply', 0) }
  }
  const e = errors[0]
  if (e) return { raw: undefined, error: errorAt(text, printParseErrorCode(e.error), e.offset) }
  if (raw === undefined) return { raw: {}, error: null }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const scanner = createScanner(text, true)
    scanner.scan()
    return { raw: undefined, error: errorAt(text, 'ObjectExpected', scanner.getTokenOffset()) }
  }
  return { raw, error: null }
}

/**
 * The edits that add a key as the last property of an object whose current last property has a comment after it on
 * its line (`"cursorBlink": false, // steady`), or null when that is not the case. `modify` puts a new property right
 * after the last value, which leaves such a comment (and a trailing comma) behind the key that was added, saying of it
 * what the person said of the other (U-SET-7). Here the new property goes on a line of its own after the comment; a
 * trailing comma is kept as the person's style, and one that is missing goes after the value, before the comment.
 */
function addAfterComment(text: string, keys: readonly string[], value: unknown): Edit[] | null {
  const root = parseTree(text, [], PARSE_OPTIONS)
  if (!root || root.type !== 'object') return null
  // the deepest object on the key's path that exists; the rest of the path is made under it
  let parent = root
  let depth = 0
  for (; depth < keys.length; depth++) {
    const held = parent.children?.find((c) => c.children?.[0]?.value === keys[depth])?.children?.[1]
    if (!held) break
    // the key is there (changed in place), or its path runs through something that is no object: `modify`'s
    if (depth === keys.length - 1 || held.type !== 'object') return null
    parent = held
  }
  const last = parent.children?.at(-1)
  if (depth >= keys.length || !last) return null
  // what follows the last property on its line: spaces, at most one comma, comments; then the line must end
  const end = last.offset + last.length
  let at = end
  let after = end
  let comma = false
  let comment = false
  for (;;) {
    const ch = text[at]
    if (ch === ' ' || ch === '\t') at++
    else if (ch === ',' && !comma) {
      comma = true
      after = ++at
    } else if (text.startsWith('//', at)) {
      while (at < text.length && text[at] !== '\n' && text[at] !== '\r') at++
      comment = true
      after = at
    } else if (text.startsWith('/*', at)) {
      const close = text.indexOf('*/', at + 2)
      if (close < 0) return null
      comment = true
      after = at = close + 2
    } else break
  }
  if (!comment || (text[at] !== '\n' && text[at] !== '\r')) return null
  const eol = text.includes('\r\n') ? '\r\n' : FORMAT.formattingOptions.eol
  const tab = ' '.repeat(FORMAT.formattingOptions.tabSize)
  const lineStart = Math.max(text.lastIndexOf('\n', last.offset - 1), text.lastIndexOf('\r', last.offset - 1)) + 1
  const lead = text.slice(lineStart, last.offset)
  // the last property's own indentation; one step in from its line's when the property does not start the line
  const indent = /^[ \t]*$/.test(lead) ? lead : `${/^[ \t]*/.exec(lead)![0]}${tab}`
  let made = value
  for (let i = keys.length - 1; i > depth; i--) made = { [keys[i]!]: made }
  const property = `${JSON.stringify(keys[depth])}: ${JSON.stringify(made, null, tab).split('\n').join(eol + indent)}`
  return [...(comma ? [] : [{ offset: end, length: 0, content: ',' }]), { offset: after, length: 0, content: `${eol}${indent}${property}${comma ? ',' : ''}` }]
}

const isBlank = (s: string) => /^[ \t]*$/.test(s)

/** The offset of the comma that follows `from`, with only spaces, line ends and comments before it; -1 when something else comes first. */
function commaAfter(text: string, from: number): number {
  let at = from
  for (;;) {
    const ch = text[at]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') at++
    else if (text.startsWith('//', at)) while (at < text.length && text[at] !== '\n' && text[at] !== '\r') at++
    else if (text.startsWith('/*', at)) {
      const close = text.indexOf('*/', at + 2)
      if (close < 0) return -1
      at = close + 2
    } else return ch === ',' ? at : -1
  }
}

/**
 * The edits that take one key out (written twice: the last one, the one in effect), or none when it is not there.
 * `modify` removes a property together with
 * everything up to its neighbour: the comment at the end of the line above, the key's own comment, the comment above
 * the next key; and for the only key of an object written with a trailing comma it leaves `{ , }`, which does not
 * parse (U-SET-8). Here exactly the property goes, with one comma: the one after it, or, for the last property of an
 * object written without a trailing comma, the one before it. Every comment stays where it is; the property's line
 * goes with it when nothing else is on it.
 */
function removeKey(text: string, keys: readonly string[]): Edit[] {
  const root = parseTree(text, [], PARSE_OPTIONS)
  // only comments, or nothing: no key is there
  if (!root || root.type !== 'object') return []
  let parent = root
  let index = -1
  for (const [depth, key] of keys.entries()) {
    // of a key written twice the last is the one in effect
    index = parent.children?.findLastIndex((c) => c.children?.[0]?.value === key) ?? -1
    if (index < 0) return []
    if (depth === keys.length - 1) break
    const held = parent.children![index]!.children?.[1]
    if (held?.type !== 'object') return []
    parent = held
  }
  const prop = parent.children![index]!
  const start = prop.offset
  const end = start + prop.length
  const lineStart = Math.max(text.lastIndexOf('\n', start - 1), text.lastIndexOf('\r', start - 1)) + 1
  const ownLine = isBlank(text.slice(lineStart, start))
  const out: Edit[] = []
  const cut = (from: number, to: number) => out.push({ offset: from, length: to - from, content: '' })
  let from = start
  let to = end
  const comma = commaAfter(text, end)
  if (comma >= 0) {
    // its own comma: taken with the property when nothing but spaces lies between them, else by itself
    if (isBlank(text.slice(end, comma))) to = comma + 1
    else cut(comma, comma + 1)
  } else if (index > 0) {
    // the last property, written without a trailing comma: the comma before it goes, so none trails now
    const before = parent.children![index - 1]!
    const sep = commaAfter(text, before.offset + before.length)
    if (sep >= 0 && sep < start) {
      if (!ownLine && isBlank(text.slice(sep + 1, start))) from = sep
      else cut(sep, sep + 1)
    }
  }
  // what is left of its line: nothing (the line goes, with its line end), or something (a comment, a neighbour, the
  // closing brace), which moves up to the property's place
  let lineEnd = to
  while (lineEnd < text.length && text[lineEnd] !== '\n' && text[lineEnd] !== '\r') lineEnd++
  const rest = text.slice(to, lineEnd)
  if (ownLine && isBlank(rest)) cut(lineStart, lineEnd + (text.startsWith('\r\n', lineEnd) ? 2 : lineEnd < text.length ? 1 : 0))
  else cut(from, from === start ? to + (rest.length - rest.trimStart().length) : to)
  return out.sort((a, b) => a.offset - b.offset)
}

/** What a value that is no object is, in words for the person. */
function kindOf(node: Node): string {
  if (node.type === 'array') return 'a list'
  if (node.type === 'number') return 'a number'
  if (node.type === 'string') return 'a text'
  if (node.type === 'boolean') return 'true or false'
  return 'null'
}

/** Where a key is in a text: followed through the objects on its path, taking of a name written twice the last (the one in effect). */
interface Place {
  /** The deepest object on the path that is there; null: the text holds no object (only comments, or nothing). */
  parent: Node | null
  /** How many names of the path lead to `parent`. */
  depth: number
  /** The key's own property (`"name": value`), when all of its path is there. */
  prop: Node | null
  /** A name on the path was written more than once. */
  twice: boolean
  /** The path runs through a value that is no object: the names up to it, and the value. */
  blocked: { at: string; node: Node } | null
}

function place(text: string, keys: readonly string[]): Place {
  const root = parseTree(text, [], PARSE_OPTIONS)
  const out: Place = { parent: root?.type === 'object' ? root : null, depth: 0, prop: null, twice: false, blocked: null }
  while (out.parent && out.depth < keys.length) {
    const same = out.parent.children?.filter((c) => c.children?.[0]?.value === keys[out.depth]) ?? []
    const last = same.at(-1)
    if (!last) break
    if (same.length > 1) out.twice = true
    if (out.depth === keys.length - 1) {
      out.prop = last
      break
    }
    const held = last.children?.[1]
    if (held?.type !== 'object') {
      if (held) out.blocked = { at: keys.slice(0, out.depth + 1).join('.'), node: held }
      break
    }
    out.parent = held
    out.depth++
  }
  return out
}

/** `value` as the text of a property's value that starts on the line `offset` is on: further lines indented as that line is. */
function valueText(text: string, offset: number, value: unknown): string {
  const eol = text.includes('\r\n') ? '\r\n' : FORMAT.formattingOptions.eol
  const lineStart = Math.max(text.lastIndexOf('\n', offset - 1), text.lastIndexOf('\r', offset - 1)) + 1
  const indent = /^[ \t]*/.exec(text.slice(lineStart, offset))![0]
  return JSON.stringify(value, null, ' '.repeat(FORMAT.formattingOptions.tabSize)).split('\n').join(eol + indent)
}

function setKey(text: string, keys: readonly string[], value: unknown): string {
  const at = place(text, keys)
  if (at.blocked) {
    throw new RpcError('file_invalid', `settings.json: "${at.blocked.at}" is ${kindOf(at.blocked.node)}, not a group of settings, so ${keys.join('.')} cannot be set; make it { } or take it out, then try again`)
  }
  // the usual file: every name on the path written once
  if (!at.twice || !at.parent) return applyEdits(text, addAfterComment(text, keys, value) ?? modify(text, [...keys], value, FORMAT))
  // a name written twice: `modify` would change the first, which is not the one in effect
  const held = at.prop?.children?.[1]
  if (held) return applyEdits(text, [{ offset: held.offset, length: held.length, content: valueText(text, at.prop!.offset, value) }])
  // the key is new under the object in effect: that object is edited as a text of its own
  const from = at.parent.offset
  const to = from + at.parent.length
  const inner = text.slice(from, to)
  const rest = keys.slice(at.depth)
  return text.slice(0, from) + applyEdits(inner, addAfterComment(inner, rest, value) ?? modify(inner, [...rest], value, FORMAT)) + text.slice(to)
}

/**
 * The text with one key set (`value`) or removed (`undefined`), everything else untouched. `key` is a full
 * dotted key; its parts are nested objects. A comment stays on the line it is on, and the result parses
 * (`addAfterComment`, `removeKey`).
 *
 *   - Of a key written twice, the last is the one in effect: that one is set, and a removal takes out every one of
 *     them (in the object in effect), so the default applies.
 *   - Removing a key that is not there gives the text back as it is: an empty file, one that is only a comment.
 *   - A key under something that is no object (`"terminal": 5`) cannot be set: `RpcError('file_invalid')`, naming what
 *     is in the way and what to do about it. Removing it finds no such key.
 *   - A byte order mark stays where it is.
 */
export function editSettingsText(file: string, key: string, value: unknown): string {
  const mark = file.startsWith(BOM) ? BOM : ''
  const text = file.slice(mark.length)
  const keys = key.split('.')
  if (value === undefined) {
    let out = text
    // one property at a time (written twice: twice), each on the text as it is by then; a text has only so many
    for (let edits = removeKey(out, keys); edits.length > 0; edits = removeKey(out, keys)) out = applyEdits(out, edits)
    return mark + out
  }
  return mark + setKey(text.trim() === '' ? '{}\n' : text, keys, value)
}

export interface SettingsFileOptions {
  home: string
  log: Logger
  /** Registered adapters' settings extensions. */
  agents?: readonly AgentSettingsExtension[]
  /** Watch the file for external edits (default true; unit tests call `reload()` instead). */
  watch?: boolean
  /** Core's watch service. Default: one of this object's own, closed with it. */
  watcher?: WatchService
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The rows as this system offers them. `general.terminalApp` takes either system's apps, since one settings file serves
 * both, and Settings offers Automatic and this system's. `general.excludeBuildDirsFromBackup` is offered only where
 * backups can be told what to leave out: macOS's Time Machine, so it is hidden on Linux.
 */
export function thisSystemsRows(rows: SettingRow[], terminalApps: readonly string[] | null = isAvailable(coreOs.editors) ? coreOs.editors.terminalApps : null, backups: boolean = isAvailable(coreOs.backupExclude)): SettingRow[] {
  const shown = backups ? rows : rows.filter((r) => r.key !== 'general.excludeBuildDirsFromBackup')
  if (terminalApps === null) return shown
  return shown.map((r) => (r.key === 'general.terminalApp' && r.options ? { ...r, options: r.options.filter((o) => o.value === 'auto' || terminalApps.includes(o.value)) } : r))
}

export class SettingsFile {
  /** `settings`: every key's effective value. */
  readonly store = new KeyedStore<unknown>(SETTINGS_STORE)
  /** `settings.status`: the banner's state. */
  readonly statusStore = new KeyedStore<SettingsStatus>(SETTINGS_STATUS_STORE)
  readonly file: string
  private readonly opts: SettingsFileOptions
  private readonly agents: readonly AgentSettingsExtension[]
  private current: SettingsValues
  private notices: SettingsNotice[] = []
  private readonly listeners = new Set<() => void>() // bounded: one per consumer in core (terminals, sessions …)
  private watcher: Disposable | null = null
  /** The watch service made here when none was given: closed with this object. */
  private ownWatcher: Watcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private writes: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(opts: SettingsFileOptions) {
    this.opts = opts
    this.agents = opts.agents ?? []
    this.file = settingsPath(opts.home)
    this.current = parseSettings({}, this.agents).values
    this.store.replace({ ...this.current.flat }) // the defaults, until (and unless) the file parses
    // followed first, read after: the watch reports what changes after it began, and takes what the file held then
    // as read. Read first, a save landing between the two would be neither read nor reported
    if (opts.watch !== false) this.watch()
    this.reload()
  }

  /** The values in use (the last good ones while the file does not parse). */
  get values(): SettingsValues {
    return this.current
  }

  get status(): SettingsStatus {
    return this.statusStore.get(SETTINGS_STATUS_KEY) as SettingsStatus
  }

  /** Called after any change of a value. Returns the unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Read the file again and apply what changed. */
  reload(): void {
    if (this.disposed) return
    let text: string | null
    let readError: string | null = null
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (e) {
      text = null
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') readError = (e as Error).message
    }
    if (readError) {
      this.setStatus({ exists: true, error: { message: readError, line: 1, column: 1, offset: 0 } })
      this.opts.log.warn('settings.json unreadable; last good settings kept', { error: readError })
      return
    }
    const { raw, error } = text === null ? { raw: {}, error: null } : parseSettingsText(text)
    if (error) {
      // The last good values stay; the banner shows where the file broke
      this.setStatus({ exists: true, error })
      this.opts.log.warn('settings.json does not parse; last good settings kept', { ...error })
      return
    }
    const { values, notices } = parseSettings(raw, this.agents)
    for (const n of notices) if (!this.notices.some((o) => o.key === n.key && o.message === n.message)) this.opts.log.warn('setting invalid, default used', n)
    const changed = !equal(this.current.flat, values.flat)
    this.notices = notices
    this.current = values
    this.setStatus({ exists: text !== null, error: null })
    this.store.replace({ ...values.flat }, equal)
    if (changed) for (const l of [...this.listeners]) l()
  }

  /** Set one key from the UI, then apply it at once. */
  set(key: string, value: unknown): Promise<void> {
    const def = allSettingDefs(this.agents).find((d) => d.fullKey === key)
    if (!def) return Promise.reject(new RpcError('unknown_key', `no setting ${key}`))
    const r = def.schema.safeParse(value)
    if (!r.success) return Promise.reject(new RpcError('invalid_value', `${key}: ${r.error.issues[0]?.message ?? 'invalid value'}`))
    return this.edit(key, r.data)
  }

  /** Back to the default: the key leaves the file. */
  reset(key: string): Promise<void> {
    if (!allSettingDefs(this.agents).some((d) => d.fullKey === key)) return Promise.reject(new RpcError('unknown_key', `no setting ${key}`))
    return this.edit(key, undefined)
  }

  handlers(): Handlers<typeof settingsApi> {
    return {
      'settings.set': async ({ key, value }) => {
        await this.set(key, value)
        return { ok: true }
      },
      'settings.reset': async ({ key }) => {
        await this.reset(key)
        return { ok: true }
      },
      // Settings' generated sections are drawn from these rows; the schemas stay here, where values are checked
      'settings.describe': async () => ({ rows: thisSystemsRows(settingRows(this.agents)), agents: this.agents.map((a) => ({ id: a.id, displayName: a.displayName })) }),
    }
  }

  /** The `settings.*` gauges: values held, watcher, listeners. */
  get resourceCounts(): { values: number; watchers: number; listeners: number } {
    return { values: this.store.size, watchers: this.watcher ? 1 : 0, listeners: this.listeners.size }
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
    this.listeners.clear()
    this.store.dispose()
    this.statusStore.dispose()
  }

  private setStatus(s: { exists: boolean; error: SettingsParseError | null }): void {
    const next: SettingsStatus = { path: this.file, exists: s.exists, error: s.error, notices: this.notices }
    const cur = this.statusStore.get(SETTINGS_STATUS_KEY)
    if (!cur || !equal(cur, next)) this.statusStore.set(SETTINGS_STATUS_KEY, next)
  }

  /** One key changed in the file, one edit at a time. */
  private edit(key: string, value: unknown): Promise<void> {
    const run = this.writes.then(async () => {
      if (this.disposed) throw new RpcError('unavailable', 'settings are closed')
      let text = ''
      try {
        text = await fs.promises.readFile(this.file, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new RpcError('file_invalid', `settings.json cannot be read (${(e as Error).message}); fix it first`)
      }
      const { error } = parseSettingsText(text)
      if (error) throw new RpcError('file_invalid', `settings.json does not parse (${error.message} at line ${error.line}, column ${error.column}); fix it first`)
      let next: string
      try {
        next = editSettingsText(text, key, value)
      } catch (e) {
        // never a raw error for the person: the refusal as it is, anything else with the key named
        if (e instanceof RpcError) throw e
        throw new RpcError('file_invalid', `settings.json could not be changed for ${key} (${e instanceof Error ? e.message : String(e)}); change it in the file`)
      }
      if (next !== text) await atomicWrite(this.realFile(), next)
      this.reload()
    })
    this.writes = run.catch(() => undefined)
    return run
  }

  /** settings.json may be a symlink into someone's dotfiles: write the file it points to, never replace the link. */
  private realFile(): string {
    try {
      return fs.realpathSync(this.file)
    } catch {
      return this.file
    }
  }

  private watch(): void {
    const service = this.opts.watcher ?? (this.ownWatcher = new Watcher({ log: this.opts.log }))
    this.watcher = service.file(this.file, () => {
      if (this.timer || this.disposed) return
      // Changes are collected for one window before the file is read again
      this.timer = setTimeout(() => {
        this.timer = null
        this.reload()
      }, L.watchBatchMs)
    })
  }
}
