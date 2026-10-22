// settings.json broken in each of the ways below, and fuzzed: reading it never throws, the values in use are always
// valid (the last good ones while the file is broken), and the error's position is inside the text. Then the whole of
// core started on a broken file: it launches, PTYs run with the defaults, the banner has the error.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { createMemoryLogger } from '@kea/kit'
import { allSettingDefs, SETTINGS_STATUS_KEY, type MirrorConfig, type SettingsStatus } from '@kea/protocol'
import { SettingsFile, settingsPath } from '@kea/core/src/settings/settings.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { holderAlive, ptyhostHarness, testEnv, until } from '../support/holders.ts'
import { ownPtyIds, startFullCore } from '../integration/core-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-settings-chaos-'))
  cleanup.push(() => {
    fs.chmodSync(dir, 0o700)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

const GOOD = '{ "terminal": { "fontSize": 15, "cursorStyle": "bar" }, "general": { "branchPrefix": "me/" } }\n'
const DEFS = allSettingDefs([])

/** Every key present and valid against its definition; `text`'s error (if any) inside the text. */
function expectSane(s: SettingsFile, text: string): void {
  for (const d of DEFS) expect(d.schema.safeParse(s.values.get(d.fullKey)).success, d.fullKey).toBe(true)
  const e = (s.statusStore.get(SETTINGS_STATUS_KEY) as SettingsStatus).error
  if (!e) return
  expect(e.offset).toBeGreaterThanOrEqual(0)
  expect(e.offset).toBeLessThanOrEqual(text.length)
  const lines = text.split('\n')
  expect(e.line).toBeGreaterThanOrEqual(1)
  expect(e.line).toBeLessThanOrEqual(Math.max(1, lines.length))
  expect(e.column).toBeGreaterThanOrEqual(1)
  expect(e.column).toBeLessThanOrEqual((lines[e.line - 1]?.length ?? 0) + 1)
}

const goodValues = { 'terminal.fontSize': 15, 'terminal.cursorStyle': 'bar', 'general.branchPrefix': 'me/' }

/** Each corruption leaves settings.json broken: the last good values stay, the banner has an error, edits are refused. */
const BROKEN: [string, (file: string) => void][] = [
  ['truncated mid-way', (f) => fs.writeFileSync(f, GOOD.slice(0, 30))],
  ['binary garbage', (f) => fs.writeFileSync(f, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)))],
  ['NUL bytes inside a string', (f) => fs.writeFileSync(f, '{ "terminal": { "fontFamily": "a\u0000b" } }')],
  ['a lone byte-order mark and a brace', (f) => fs.writeFileSync(f, '﻿{')],
  ['an unterminated comment', (f) => fs.writeFileSync(f, '{ "terminal": {} /* never closed')],
  ['nesting deeper than anyone writes', (f) => fs.writeFileSync(f, '['.repeat(100_000))],
  ['a top-level array', (f) => fs.writeFileSync(f, '[{ "terminal": { "fontSize": 20 } }]')],
  ['a top-level number', (f) => fs.writeFileSync(f, '  // just a number\n  42\n')],
  ['a top-level null', (f) => fs.writeFileSync(f, 'null')],
  ['a directory in its place', (f) => fs.mkdirSync(f)],
  ['unreadable (mode 000)', (f) => {
    fs.writeFileSync(f, GOOD)
    fs.chmodSync(f, 0o000)
  }],
  ['a symlink to itself', (f) => fs.symlinkSync(f, f)],
  ['invalid UTF-8', (f) => fs.writeFileSync(f, Buffer.concat([Buffer.from('{ "terminal": { "fontFamily": "'), Buffer.from([0xc3, 0x28, 0xff]), Buffer.from('" ,,, } }')]))],
]

describe('settings.json broken', () => {
  for (const [name, corrupt] of BROKEN) {
    it(`C-COR-5 · ${name} → never throws; the last good values stay; the banner has an error inside the text; edits are refused`, async () => {
      const dir = home()
      const file = settingsPath(dir)
      fs.writeFileSync(file, GOOD)
      const s = new SettingsFile({ home: dir, log: createMemoryLogger({ process: 'core' }), watch: false })
      cleanup.push(() => s.dispose())
      expect(s.values.flat).toMatchObject(goodValues)
      fs.rmSync(file)
      corrupt(file)
      expect(() => s.reload()).not.toThrow()
      const status = s.statusStore.get(SETTINGS_STATUS_KEY) as SettingsStatus
      expect(status.error, 'the banner').not.toBeNull()
      expect(s.values.flat, 'last known good').toMatchObject(goodValues)
      let text = ''
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        // unreadable: the error points at the start
      }
      expectSane(s, text)
      await expect(s.set('terminal.fontSize', 12)).rejects.toMatchObject({ code: 'file_invalid' })
      expect(s.values.flat).toMatchObject(goodValues)
    })
  }

  it('C-COR-5 · fuzzed settings.json texts (random, and the good file mutated) → reload never throws; values always valid; error positions inside the text', () => {
    const dir = home()
    const file = settingsPath(dir)
    const s = new SettingsFile({ home: dir, log: createMemoryLogger({ process: 'core' }), watch: false })
    cleanup.push(() => s.dispose())
    const mutated = fc
      .tuple(fc.nat(GOOD.length), fc.nat(GOOD.length), fc.string({ maxLength: 8, unit: 'binary' }))
      .map(([a, b, ins]) => GOOD.slice(0, Math.min(a, b)) + ins + GOOD.slice(Math.max(a, b)))
    const text = fc.oneof(fc.string({ maxLength: 200, unit: 'binary' }), fc.json({ maxDepth: 3 }), mutated, fc.constant(GOOD))
    fc.assert(
      fc.property(text, (t) => {
        fs.writeFileSync(file, t)
        const before = { ...s.values.flat }
        expect(() => s.reload()).not.toThrow()
        expectSane(s, t)
        if ((s.statusStore.get(SETTINGS_STATUS_KEY) as SettingsStatus).error) expect(s.values.flat, 'broken → last known good').toEqual(before)
      }),
      { numRuns: 2000 },
    )
  })

  it('C-COR-5 · core started on a broken settings.json launches; PTYs run with the default settings; the banner has the line and column; fixing the file clears it without a restart', async () => {
    const h = await ptyhostHarness()
    cleanup.push(async () => {
      for (const id of ownPtyIds(h.home)) h.spawned.add(id)
      await h.dispose()
    })
    const broken = '{\n  "terminal": { "scrollback": 99,, }\n'
    fs.writeFileSync(settingsPath(h.home), broken)
    const scrollback = DEFS.find((d) => d.fullKey === 'terminal.scrollback')!.default
    const c = startFullCore(h, { env: testEnv(), opts: { watchSettings: true } })
    cleanup.push(() => c.dispose())
    await c.reconciled()
    expect(c.core.settings.status).toMatchObject({ exists: true, error: { line: 2, column: broken.split('\n')[1]!.indexOf(',,') + 2 } })
    expect(c.core.settings.values.get('terminal.scrollback'), 'the defaults: there is no last good yet').toBe(scrollback)
    const configured = c.calls.filter((x) => x.m === 'pty.configure').map((x) => x.a as unknown as MirrorConfig)
    expect(configured.at(-1)?.scrollback).toBe(scrollback)
    const { ptyId } = await c.core.terminals.launch({ sessionId: 'shells', kind: 'shell', command: { argv: ['/bin/cat'] }, cwd: h.home, cols: 80, rows: 24 })
    expect(c.core.terminals.store.get(ptyId)).toMatchObject({ state: 'running' })
    expect(holderAlive(h.home, ptyId)).toBe(true)
    // fixed by hand: the watcher applies it and the error (the banner) goes, no restart
    fs.writeFileSync(settingsPath(h.home), '{\n  "terminal": { "fontSize": 15 }\n}\n')
    await until('the settings error clears', () => c.core.settings.status.error === null)
    expect(c.core.settings.values.get('terminal.fontSize')).toBe(15)
  })
})
