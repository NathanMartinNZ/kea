import { Text } from '@codemirror/state'
import { allPairs } from '@kea/kit/fsm'
import { zSaveArgs } from '@kea/protocol'
import { L } from '@kea/protocol/limits'
import { describe, expect, it } from 'vitest'
import { DocSave, SAVE_EVENTS, SAVE_PHASES, saveTable, saveText, type SaveCall, type SaveFacts } from './saving.ts'

const doc = (s: string): Text => Text.of(s.split('\n'))
const FACTS: SaveFacts = { version: 'v1', eol: 'lf', encoding: 'utf8', bom: false, mode: 0o644 }

describe('the save state of a document', () => {
  it('U-FV-23 · the table: every phase answers every event or leaves it alone, and only a deleted file saves from clean', () => {
    const pairs = allPairs(saveTable, SAVE_PHASES, SAVE_EVENTS)
    const handled = pairs.filter((p) => p.handled).map((p) => `${p.state}.${p.event}`)
    expect(handled).toEqual([
      'clean.edited', 'clean.save', 'clean.adopted',
      'dirty.edited', 'dirty.save', 'dirty.failed', 'dirty.adopted',
      'saving.edited', 'saving.saved', 'saving.changed', 'saving.missing', 'saving.failed', 'saving.adopted',
      'failed.edited', 'failed.save', 'failed.adopted',
    ])
    const s = new DocSave(doc('a'), FACTS)
    expect(s.begin(doc('a'))).toBeNull()
    s.goneOnDisk()
    const call = s.begin(doc('a'))
    expect(call?.create).toEqual({ encoding: 'utf8', bom: false, mode: 0o644 })
  })

  it('U-FV-23 · typing makes a document dirty and undoing back to what was saved makes it clean; a save answered for a document no longer on screen still settles it', () => {
    const s = new DocSave(doc('a\nb'), FACTS)
    s.edited(doc('a\nbX'))
    expect(s.phase).toBe('dirty')
    expect(s.unsaved).toBe(true)
    s.edited(doc('a\nb'))
    expect(s.phase).toBe('clean')
    s.edited(doc('a\nbX'))
    const call = s.begin(doc('a\nbX'))
    expect(call).toMatchObject({ text: 'a\nbX', base: 'v1', eol: 'lf' })
    expect(s.phase).toBe('saving')
    // the user types on while the save is out, then the tab is hidden: the answer still lands on the document
    s.edited(doc('a\nbXY'))
    expect(s.settle(call!.id, { kind: 'saved', version: 'v2' }, doc('a\nbXY'))).toBe('none')
    expect(s.phase).toBe('dirty')
    expect(s.facts.version).toBe('v2')
    expect(s.base.toString()).toBe('a\nbX')
    // an answer for no save in flight changes nothing
    expect(s.settle(call!.id, { kind: 'saved', version: 'v9' }, doc('a\nbXY'))).toBe('none')
    expect(s.facts.version).toBe('v2')
  })

  it('U-FV-23 · a save that meets the file changed is merged and sent again, at most L.viewerSaveAttempts in a row; a changed answer whose lines equal base saves over the new version', () => {
    const s = new DocSave(doc('a'), FACTS)
    s.edited(doc('aX'))
    let call = s.begin(doc('aX'))
    for (let i = 1; i <= L.viewerSaveAttempts; i++) {
      expect(s.settle(call!.id, { kind: 'changed' }, doc('aX'))).toBe('merge')
      expect(s.phase).toBe('dirty')
      // the merge: the file's text is the new base (here only its version differs)
      s.adopt(doc('a'), { ...FACTS, version: `v1.${i}` }, doc('aX'))
      call = s.begin(doc('aX'), true)
      if (i < L.viewerSaveAttempts) expect(call?.base).toBe(`v1.${i}`)
    }
    expect(call).toBeNull()
    expect(s.phase).toBe('failed')
    expect(s.failure).toBe('The file keeps changing')
    // Try Again starts a fresh run
    expect(s.begin(doc('aX'))).not.toBeNull()
  })

  it('U-FV-23 · Save while a save is in flight queues one more, made after the answer and dropped when the document leaves the screen', () => {
    const s = new DocSave(doc('a'), FACTS)
    s.edited(doc('aX'))
    const call = s.begin(doc('aX'))
    s.edited(doc('aXY'))
    expect(s.begin(doc('aXY'))).toBeNull()
    expect(s.queued).toBe(true)
    s.settle(call!.id, { kind: 'saved', version: 'v2' }, doc('aXY'))
    expect(s.takeQueued()).toBe(true)
    expect(s.begin(doc('aXY'))).toMatchObject({ text: 'aXY', base: 'v2' })
    const t = new DocSave(doc('a'), FACTS)
    t.edited(doc('aX'))
    t.begin(doc('aX'))
    t.begin(doc('aX'))
    t.dropQueued()
    expect(t.takeQueued()).toBe(false)
  })

  it('U-FV-23 · reads around saves: one landing while a save is in flight, or asked for before the latest answer, is dropped; one asked for after it is used', () => {
    const s = new DocSave(doc('a'), FACTS)
    s.edited(doc('aX'))
    const before = s.readStamp()
    const call = s.begin(doc('aX'))
    expect(s.landed(before, doc('a'), FACTS, doc('aX'))).toBe('drop')
    s.settle(call!.id, { kind: 'saved', version: 'v2' }, doc('aX'))
    expect(s.landed(before, doc('a'), FACTS, doc('aX'))).toBe('drop')
    const after = s.readStamp()
    expect(s.landed(after, doc('aX'), { ...FACTS, version: 'v2' }, doc('aX'))).toBe('take')
  })

  it('U-FV-23 · a save whose answer was lost (no answer in time, core restarting) fails, and a read whose text is what was sent settles it as saved', () => {
    const s = new DocSave(doc('a'), FACTS)
    s.edited(doc('aX'))
    const call = s.begin(doc('aX'))
    s.settle(call!.id, { kind: 'lost', why: 'Kea’s core restarted' }, doc('aX'))
    expect(s.phase).toBe('failed')
    expect(s.failure).toBe('Kea’s core restarted')
    expect(s.landed(s.readStamp(), doc('aX'), { ...FACTS, version: 'v2' }, doc('aX'))).toBe('take')
    expect(s.phase).toBe('clean')
    expect(s.facts.version).toBe('v2')
    expect(s.failure).toBeNull()
    // the user typed on after the lost answer: the save did land, so the document is unsaved, not failed
    s.edited(doc('aXY'))
    const again = s.begin(doc('aXY'))
    s.settle(again!.id, { kind: 'lost', why: 'Kea’s core restarted' }, doc('aXY'))
    s.edited(doc('aXYZ'))
    expect(s.landed(s.readStamp(), doc('aXY'), { ...FACTS, version: 'v3' }, doc('aXYZ'))).toBe('take')
    expect(s.phase).toBe('dirty')
    expect(s.failure).toBeNull()
  })

  it('U-FV-23 · deleted on disk keeps the text, and Save creates the file again; a refusal fails with its words, and a change keeps it failed until it is the saved text again', () => {
    const s = new DocSave(doc('a'), FACTS)
    s.edited(doc('aX'))
    let call = s.begin(doc('aX'))
    s.settle(call!.id, { kind: 'missing' }, doc('aX'))
    expect(s.phase).toBe('dirty')
    expect(s.deleted).toBe(true)
    call = s.begin(doc('aX'))
    expect(call?.create).toEqual({ encoding: 'utf8', bom: false, mode: 0o644 })
    s.settle(call!.id, { kind: 'refused', reason: 'no-folder' }, doc('aX'))
    expect(s.phase).toBe('failed')
    expect(s.failure).toBe('Its folder is gone')
    s.edited(doc('aXY'))
    expect(s.phase).toBe('failed')
    s.edited(doc('a'))
    expect(s.phase).toBe('clean')
  })

  it('U-FV-23 · a save that makes a deleted file again sends arguments core accepts, from a version or from none', () => {
    const args = (c: SaveCall | null) => zSaveArgs.safeParse({ sessionId: 's1', path: 'src/a.ts', text: c?.text, base: c?.base, eol: c?.eol, ...(c?.create ? { create: c.create } : {}) }).success
    const s = new DocSave(doc('a'), { ...FACTS, version: 'a'.repeat(64) })
    s.edited(doc('aX'))
    expect(args(s.begin(doc('aX')))).toBe(true)
    s.settle(1, { kind: 'missing' }, doc('aX'))
    expect(args(s.begin(doc('aX')))).toBe(true)
    // a deleted document handed to a window built again knows no version
    const handed = new DocSave(doc('a'), { ...FACTS, version: null })
    handed.handedOver(doc('aX'), false, true, null)
    expect(args(handed.begin(doc('aX')))).toBe(true)
  })

  it('U-FV-23 · the text saved is the lines joined with the file’s own ending', () => {
    expect(saveText(doc('a\nb\n'), 'crlf')).toBe('a\r\nb\r\n')
    expect(saveText(doc('a\nb'), 'cr')).toBe('a\rb')
  })
})
