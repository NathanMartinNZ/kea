// The save state of an editable file's document: what it was last read or saved as (`base`, with the facts a save
// needs), whether it differs, and the one save in flight. The phases are a `kit/Fsm` table; `DocSave` does what a
// transition means for the text. Answers come to the document itself, not to whatever the viewer shows by then: a
// save answered after the user moved to another tab still settles it.
//
//   clean    the document is `base`
//   dirty    it differs (the tab's dot)
//   saving   one `viewer.save` in flight; `sent` is the text sent
//   failed   not saved; the notice says why, with Try Again
//
//   edited   the user changed the document (`same`: it is `base` again, as after an undo)
//   save     Save: ⌘S, the warning's Save, Try Again
//   saved    core wrote the file (`same`: the document is still what was sent)
//   changed  the file changed under the save: the viewer merges it, then saves again
//   missing  the file is gone: the text stays as "Deleted on disk", and Save creates it again
//   failed   refused, an error, no answer in L.viewerSaveTimeoutMs, or core restarted
//   adopted  the file's text became `base` (a reload, a merge; `same`: the document equals it)

import type { Text } from '@codemirror/state'
import { createFsm, type Fsm, type FsmDef } from '@kea/kit/fsm'
import type { LineEnding, TextEncoding } from '@kea/protocol'
import { L } from '@kea/protocol/limits'
import { lineBreakOf } from './decode.ts'

export const SAVE_PHASES = ['clean', 'dirty', 'saving', 'failed'] as const
export type SavePhase = (typeof SAVE_PHASES)[number]

export type SaveEvent =
  | { t: 'edited'; same: boolean }
  | { t: 'save' }
  | { t: 'saved'; same: boolean }
  | { t: 'changed' }
  | { t: 'missing' }
  | { t: 'failed' }
  | { t: 'adopted'; same: boolean }
export const SAVE_EVENTS = ['edited', 'save', 'saved', 'changed', 'missing', 'failed', 'adopted'] as const satisfies readonly SaveEvent['t'][]

/** What the table's guards read. */
export interface SaveContext {
  /** The file is gone and the document keeps its text: Save creates it again. */
  deleted: boolean
  /** Why the last save did not happen; null when nothing failed. */
  failure: string | null
}

const sameOr = (other: SavePhase) => (_c: SaveContext, e: { same: boolean }) => (e.same ? 'clean' : other)

export const saveTable: Pick<FsmDef<SavePhase, SaveEvent, SaveContext>, 'initial' | 'transitions'> = {
  initial: 'clean',
  transitions: {
    clean: {
      edited: sameOr('dirty'),
      adopted: sameOr('dirty'),
      // a clean document saves only to create its file again
      save: (c) => (c.deleted ? 'saving' : null),
    },
    dirty: {
      edited: sameOr('dirty'),
      adopted: sameOr('dirty'),
      save: () => 'saving',
      // the file kept changing under L.viewerSaveAttempts saves in a row
      failed: () => 'failed',
    },
    saving: {
      // typing goes on while the save is out; the answer decides
      edited: () => 'saving',
      adopted: () => 'saving',
      saved: sameOr('dirty'),
      changed: () => 'dirty',
      missing: () => ({ to: 'dirty', note: 'deleted on disk' }),
      failed: () => 'failed',
    },
    failed: {
      edited: sameOr('failed'),
      // a read that settles a lost save clears the failure first: the document is then only unsaved
      adopted: (c, e) => (e.same ? 'clean' : c.failure === null ? 'dirty' : 'failed'),
      save: () => 'saving',
    },
  },
}

/** What a save needs besides the text: the file's facts as last read. */
export interface SaveFacts {
  /** SHA-256 of the bytes `base` was read or saved as; null for a file that is not there. */
  version: string | null
  eol: LineEnding
  encoding: TextEncoding
  bom: boolean
  mode: number | null
}

/** The arguments of one `viewer.save`, less the session and path. */
export interface SaveCall {
  id: number
  text: string
  base: string | null
  eol: LineEnding
  create?: { encoding: TextEncoding; bom: boolean; mode: number }
}

/** How a save ended, as the viewer heard it. */
export type SaveAnswer =
  | { kind: 'saved'; version: string }
  | { kind: 'changed' }
  | { kind: 'missing' }
  | { kind: 'refused'; reason: string; detail?: string }
  /** An RPC error, no answer in time, or core restarting: whether the file was written is not known. */
  | { kind: 'lost'; why: string }

/** What the viewer does next after an answer. */
export type SaveNext = 'none' | 'merge' | 'again'

/** The user's words for a refusal. */
export function refusalText(reason: string, detail?: string): string {
  switch (reason) {
    case 'busy':
      return 'Another file operation is running in this session'
    case 'permission':
      return 'No permission to write it'
    case 'git':
      return 'It is inside .git'
    case 'hard-linked':
      return 'It is hard-linked, and writing it would change the other names too'
    case 'outside':
      return 'It is outside this folder'
    case 'not-text':
      return 'It is not text any more'
    case 'line-endings':
      return 'Its line endings changed on disk'
    case 'too-large':
      return 'It would be too large'
    case 'no-folder':
      return 'Its folder is gone'
    default:
      return detail ? `It could not be written: ${detail}` : 'It could not be written'
  }
}

/** The text a save writes: the document's lines joined with the file's own line ending. */
export function saveText(doc: Text, eol: LineEnding): string {
  return doc.sliceString(0, doc.length, lineBreakOf(eol))
}

export class DocSave {
  private readonly fsm: Fsm<SavePhase, SaveEvent, SaveContext>
  /** The text as last read or saved. */
  base: Text
  facts: SaveFacts
  /** The text of the save in flight, or of the last one whose answer was lost (until a read settles it). */
  sent: Text | null = null
  /** The save in flight (0: none). */
  private flying = 0
  private nextId = 1
  /** A save was asked for while one was in flight: it runs after the answer. */
  queued = false
  /** The save in flight and what follows it (the queued save, one made again after a merge): a save asked for meanwhile ends with it. */
  running: Promise<void> | null = null
  /** Saves in a row answered `changed`. */
  attempts = 0
  /** Why the last save failed: the notice's words. */
  failure: string | null = null
  deleted = false
  /** The last save's answer was lost: a read whose text is `sent` is taken as that save. */
  private unsettled = false
  /** Answers landed: a read asked for before the latest one is dropped. */
  private answers = 0

  constructor(base: Text, facts: SaveFacts) {
    this.base = base
    this.facts = facts
    this.fsm = createFsm(saveTable)
  }

  get phase(): SavePhase {
    return this.fsm.state
  }

  /** Text that is not on disk: the dot, the warnings, the unsaved registry. */
  get unsaved(): boolean {
    return this.fsm.state !== 'clean' || this.deleted
  }

  /** The user changed the document. */
  edited(doc: Text): void {
    this.fsm.send({ t: 'edited', same: doc.eq(this.base) }, this)
    if (this.fsm.state === 'clean') this.failure = null
  }

  /**
   * Save `doc`: the call to make, or null when there is nothing to save or a save is in flight (then one more runs after
   * its answer). `again`: the viewer saving once more after a merge, which counts towards L.viewerSaveAttempts.
   */
  begin(doc: Text, again = false): SaveCall | null {
    if (this.fsm.state === 'saving') {
      this.queued = true
      return null
    }
    if (again && this.attempts >= L.viewerSaveAttempts) {
      this.attempts = 0
      this.fail('The file keeps changing')
      return null
    }
    if (!again) this.attempts = 0
    if (!this.fsm.send({ t: 'save' }, this).changed) return null
    const id = this.nextId++
    this.flying = id
    this.queued = false
    this.sent = doc
    const text = saveText(doc, this.facts.eol)
    const create = this.deleted || this.facts.version === null
    return {
      id,
      text,
      base: this.facts.version,
      eol: this.facts.eol,
      ...(create ? { create: { encoding: this.facts.encoding, bom: this.facts.bom, mode: this.facts.mode ?? L.viewerCreateMode } } : {}),
    }
  }

  /** Whether `id` is the save in flight. */
  isFlying(id: number): boolean {
    return id !== 0 && id === this.flying
  }

  /** The answer to save `id`; `doc` is the document as it is now. An answer for any other save is dropped. */
  settle(id: number, answer: SaveAnswer, doc: Text): SaveNext {
    if (!this.isFlying(id)) return 'none'
    this.flying = 0
    this.answers++
    const sent = this.sent as Text
    switch (answer.kind) {
      case 'saved':
        this.base = sent
        this.facts = { ...this.facts, version: answer.version }
        this.deleted = false
        this.unsettled = false
        this.sent = null
        this.attempts = 0
        this.failure = null
        this.fsm.send({ t: 'saved', same: doc.eq(sent) }, this)
        return 'none'
      case 'changed':
        this.unsettled = false
        this.sent = null
        this.attempts++
        this.fsm.send({ t: 'changed' }, this)
        return 'merge'
      case 'missing':
        this.unsettled = false
        this.sent = null
        this.deleted = true
        this.facts = { ...this.facts, version: null }
        this.fsm.send({ t: 'missing' }, this)
        return 'none'
      case 'refused':
        this.unsettled = false
        this.sent = null
        this.fail(refusalText(answer.reason, answer.detail))
        return 'none'
      case 'lost':
        // the write may have landed: the next read says
        this.unsettled = true
        this.fail(answer.why)
        return 'none'
    }
  }

  /** A save was queued while one was in flight and the user still has changes: run it now. */
  takeQueued(): boolean {
    const q = this.queued && this.unsaved
    this.queued = false
    return q
  }

  /** The document left the screen: a save asked for while one was in flight is not made. */
  dropQueued(): void {
    this.queued = false
  }

  private fail(why: string): void {
    this.failure = why
    this.fsm.send({ t: 'failed' }, this)
  }

  /** Stamp a read as it is asked for (`landed` drops one asked for before the latest answer). */
  readStamp(): number {
    return this.answers
  }

  /**
   * A read of the file landed, asked for at `stamp`, with `text` and its facts: whether to use it. A read that lands
   * while a save is in flight, or was asked for before the latest answer, says nothing new. A read whose text is the
   * text of a save whose answer was lost settles that save.
   */
  landed(stamp: number, text: Text, facts: SaveFacts, doc: Text): 'drop' | 'take' {
    if (this.flying !== 0 || stamp < this.answers) return 'drop'
    if (this.unsettled && this.sent && text.eq(this.sent)) {
      this.base = this.sent
      this.facts = facts
      this.sent = null
      this.unsettled = false
      this.deleted = false
      this.failure = null
      this.fsm.send({ t: 'adopted', same: doc.eq(this.base) }, this)
    }
    return 'take'
  }

  /** The file's text became `base` (a reload or a merge), with its facts; `doc` is the document after it. */
  adopt(disk: Text, facts: SaveFacts, doc: Text): void {
    this.base = disk
    this.facts = facts
    this.deleted = false
    this.fsm.send({ t: 'adopted', same: doc.eq(disk) }, this)
    if (this.fsm.state === 'clean') this.failure = null
  }

  /**
   * A document another window handed over (no history crosses): dirty, or failed; its file deleted; `sent`, the text of
   * a save whose answer is not known, which a read whose text it is settles as saved.
   */
  handedOver(doc: Text, failed: boolean, deleted: boolean, sent: Text | null): void {
    this.deleted = deleted
    if (deleted) this.facts = { ...this.facts, version: null }
    if (sent) {
      this.sent = sent
      this.unsettled = true
    }
    this.fsm.send({ t: 'edited', same: doc.eq(this.base) }, this)
    if (failed) this.fail('Its last save did not finish')
  }

  /** The file is gone while the document has unsaved text. */
  goneOnDisk(): void {
    this.deleted = true
    this.facts = { ...this.facts, version: null }
  }
}
