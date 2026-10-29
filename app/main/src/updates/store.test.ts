// The two files main keeps for updates: the marks, read back as written and as defaults when they do not parse; the
// drafts across a restart, private to the user, read once if young enough and deleted whatever they held.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { L, NO_UPDATE_MARKS, type WindowHandoff } from '@kea/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readMarks, takeHandoff, writeHandoff, writeMarks } from './store.ts'

let dir: string
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-updates-store-'))))
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const draft = { prompt: 'fix the login redirect loop', isolation: 'worktree', base: { kind: 'default' }, branch: null, agent: 'claude', config: {} }
const DRAFTS = { drafts: [['01ARZ3NDEKTSV4RRFFQ69G5FAV', draft]] } as unknown as WindowHandoff

describe('the update files', () => {
  it('U-DST-29 · the marks read back as written, mode 0600; a missing or broken file, or a broken field, reads as the defaults', () => {
    expect(readMarks(dir)).toEqual(NO_UPDATE_MARKS)
    const m = { noticeShown: true, expected: { version: '1.0.3', attempts: 1 }, skip: ['1.0.1'] }
    writeMarks(dir, m)
    expect(readMarks(dir)).toEqual(m)
    expect(fs.statSync(path.join(dir, 'updates.json')).mode & 0o777).toBe(0o600)
    fs.writeFileSync(path.join(dir, 'updates.json'), '{not json')
    expect(readMarks(dir)).toEqual(NO_UPDATE_MARKS)
    fs.writeFileSync(path.join(dir, 'updates.json'), JSON.stringify({ noticeShown: true, expected: { version: 'x' }, skip: 'no' }))
    expect(readMarks(dir)).toEqual({ noticeShown: true, expected: null, skip: [] })
  })

  it('U-DST-30 · the drafts are read once and deleted; one older than L.handoffFileMaxAgeMs, from the future, or broken is deleted unread', () => {
    const now = 5_000_000
    writeHandoff(dir, DRAFTS, now)
    const file = path.join(dir, 'handoff.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(takeHandoff(dir, now + 1000)).toEqual(DRAFTS)
    expect(fs.existsSync(file)).toBe(false)
    expect(takeHandoff(dir, now), 'once').toBeNull()

    for (const [why, t] of [['too old', now - L.handoffFileMaxAgeMs - 1], ['from the future', now + 1]] as const) {
      fs.writeFileSync(file, JSON.stringify({ t, state: { drafts: [] } }))
      expect(takeHandoff(dir, now), why).toBeNull()
      expect(fs.existsSync(file), why).toBe(false)
    }
    for (const broken of ['{broken', JSON.stringify({ t: now, state: { drafts: [['not an id', draft]] } })]) {
      fs.writeFileSync(file, broken)
      expect(takeHandoff(dir, now)).toBeNull()
      expect(fs.existsSync(file)).toBe(false)
    }
  })
})
