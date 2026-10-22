import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { createMemoryLogger } from '@kea/kit'
import { DEFAULT_TERMINAL_SETTINGS as DEFAULTS, L, RpcError, SETTINGS_STATUS_KEY } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WatchService } from '../platform/watch/service.ts'
import { editSettingsText, lineColumn, parseSettingsText, SettingsFile, settingsPath } from './settings.ts'

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
})

function home(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-settings-test-'))
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function open(h: string): SettingsFile {
  const s = new SettingsFile({ home: h, log: createMemoryLogger({ process: 'core' }), watch: false })
  cleanup.push(() => s.dispose())
  return s
}

const COMMENTED = `// my Kea settings
{
  "general": { "branchPrefix": "dev/" },   // short branches
  /* the terminal */
  "terminal": {
    "fontFamily": "Berkeley Mono",
    "fontSize": 14,
  },
  "zzz.unknown": [1, 2, 3],
}
`

describe('settings.json editing', () => {
  it('U-SET-5 · a single-key patch keeps comments, unknown keys, key order and formatting', () => {
    const changed = editSettingsText(COMMENTED, 'terminal.fontSize', 16)
    expect(changed).toBe(COMMENTED.replace('"fontSize": 14', '"fontSize": 16'))

    const added = editSettingsText(COMMENTED, 'terminal.cursorStyle', 'bar')
    for (const kept of ['// my Kea settings', '// short branches', '/* the terminal */', '"zzz.unknown": [1, 2, 3]', '"fontFamily": "Berkeley Mono"']) expect(added).toContain(kept)
    expect(added.indexOf('"fontFamily"')).toBeLessThan(added.indexOf('"fontSize"'))
    expect(parseSettingsText(added).raw).toMatchObject({ terminal: { fontFamily: 'Berkeley Mono', fontSize: 14, cursorStyle: 'bar' } })

    const nested = editSettingsText(COMMENTED, 'agents.claude.defaults', { model: 'fable' })
    expect(parseSettingsText(nested).raw).toMatchObject({ agents: { claude: { defaults: { model: 'fable' } } }, general: { branchPrefix: 'dev/' } })
    expect(nested).toContain('// short branches')

    const removed = editSettingsText(COMMENTED, 'general.branchPrefix', undefined)
    expect(parseSettingsText(removed).raw).not.toHaveProperty('general.branchPrefix')
    expect(removed).toContain('/* the terminal */')

    expect(parseSettingsText(editSettingsText('', 'terminal.fontSize', 12)).raw).toEqual({ terminal: { fontSize: 12 } })
  })

  it('U-SET-7 · a key added after a property whose line ends with a comment leaves the comment on that property’s line: the new key goes on its own line after it, with or without a trailing comma, at any depth', () => {
    // the comment says something about cursorBlink: it must not end up behind the key that was added
    const trailingComma = '{\n  "terminal": {\n    "cursorBlink": false, // steady\n  },\n}\n'
    expect(editSettingsText(trailingComma, 'terminal.theme', 'kea-light')).toBe('{\n  "terminal": {\n    "cursorBlink": false, // steady\n    "theme": "kea-light",\n  },\n}\n')
    // no trailing comma: the comma goes after the value, before the comment
    const noComma = '{\n  "terminal": {\n    "cursorBlink": false // steady\n  }\n}\n'
    expect(editSettingsText(noComma, 'terminal.theme', 'kea-light')).toBe('{\n  "terminal": {\n    "cursorBlink": false, // steady\n    "theme": "kea-light"\n  }\n}\n')
    // a block comment, and a comment after the comma or before it
    const block = '{\n  "terminal": {\n    "fontSize": 14 /* big */,\n  }\n}\n'
    expect(editSettingsText(block, 'terminal.theme', 'kea-light')).toBe('{\n  "terminal": {\n    "fontSize": 14 /* big */,\n    "theme": "kea-light",\n  }\n}\n')
    // at the top level, with a section that does not exist yet (nested objects are made), and a value of several lines
    const top = '{\n  "general": { "branchPrefix": "dev/" }, // short branches\n}\n'
    const made = editSettingsText(top, 'agents.one.env', { A: '1', B: '2' })
    expect(made).toBe('{\n  "general": { "branchPrefix": "dev/" }, // short branches\n  "agents": {\n    "one": {\n      "env": {\n        "A": "1",\n        "B": "2"\n      }\n    }\n  },\n}\n')
    expect(parseSettingsText(made).raw).toEqual({ general: { branchPrefix: 'dev/' }, agents: { one: { env: { A: '1', B: '2' } } } })
    // CRLF files keep their line ends
    expect(editSettingsText(trailingComma.replaceAll('\n', '\r\n'), 'terminal.theme', 'kea-light')).toBe('{\r\n  "terminal": {\r\n    "cursorBlink": false, // steady\r\n    "theme": "kea-light",\r\n  },\r\n}\r\n')
    // a comment on a line of its own after the last property is not that property's: the key goes before it, as ever
    const ownLine = '{\n  "terminal": {\n    "fontSize": 14,\n    // more to come\n  }\n}\n'
    expect(editSettingsText(ownLine, 'terminal.theme', 'kea-light')).toBe('{\n  "terminal": {\n    "fontSize": 14,\n    "theme": "kea-light",\n    // more to come\n  }\n}\n')
    // every result still parses to the document plus the key, and a second edit of the new key touches nothing else
    for (const text of [trailingComma, noComma, block, ownLine]) {
      const once = editSettingsText(text, 'terminal.theme', 'kea-light')
      expect(parseSettingsText(once)).toMatchObject({ error: null, raw: { terminal: { theme: 'kea-light' } } })
      expect(editSettingsText(once, 'terminal.theme', 'kea-dark')).toBe(once.replace('"kea-light"', '"kea-dark"'))
      // and taking the key out again gives the person's text back
      expect(parseSettingsText(editSettingsText(once, 'terminal.theme', undefined)).raw).toEqual(parseSettingsText(text).raw)
    }
  })

  it('U-SET-8 · a key taken out (Reset) leaves a file that parses and every comment where it was: the only key of an object written with a trailing comma, a key after a commented line, a key with its own comment, the last key without a trailing comma, a key in a one-line object', () => {
    const take = (text: string, key: string) => {
      const out = editSettingsText(text, key, undefined)
      expect(parseSettingsText(out).error, `${JSON.stringify(text)} without ${key} parses`).toBeNull()
      return out
    }
    // the only key, with the trailing comma a person leaves: the file must not become `{ , }`, which does not parse and
    // would raise the broken-file banner
    expect(take('{\n  "terminal": {\n    "fontSize": 14,\n  },\n}\n', 'terminal.fontSize')).toBe('{\n  "terminal": {\n  },\n}\n')
    expect(take('{\n  "terminal": {\n    "fontSize": 14\n  }\n}\n', 'terminal.fontSize')).toBe('{\n  "terminal": {\n  }\n}\n')
    // the comment on the line above is about the key above: it stays there
    expect(take('{\n  "a": 1, // one\n  "b": 2,\n}\n', 'b')).toBe('{\n  "a": 1, // one\n}\n')
    // the last key, no trailing comma: the comma before it goes with it, the comment between stays
    expect(take('{\n  "a": 1, // one\n  "b": 2\n}\n', 'b')).toBe('{\n  "a": 1 // one\n}\n')
    // a key's own comment is the person's text: it stays, on its line, and does not move to another key's line
    expect(take('{\n  "a": 1,\n  "b": 2, // two\n  "c": 3\n}\n', 'b')).toBe('{\n  "a": 1,\n  // two\n  "c": 3\n}\n')
    // the first key: its comment and the comment above the next key both stay
    expect(take('{\n  "a": 1, // about a\n  // about b\n  "b": 2\n}\n', 'a')).toBe('{\n  // about a\n  // about b\n  "b": 2\n}\n')
    // a block comment between the value and its comma
    expect(take('{\n  "a": 1 /* one */,\n  "b": 2\n}\n', 'a')).toBe('{\n  /* one */\n  "b": 2\n}\n')
    // a one-line object keeps its line
    expect(take('{ "a": 1, "b": 2 }', 'b')).toBe('{ "a": 1 }')
    expect(take('{ "a": 1, "b": 2 }', 'a')).toBe('{ "b": 2 }')
    expect(take('{ "a": { "x": 1, "y": [1, 2] }, "b": "x, // y" }\n', 'a.y')).toBe('{ "a": { "x": 1 }, "b": "x, // y" }\n')
    // a value of several lines, CRLF line ends
    expect(take('{\r\n  "a": {\r\n    "x": 1\r\n  }, // gone\r\n  "b": 2\r\n}\r\n', 'a')).toBe('{\r\n  // gone\r\n  "b": 2\r\n}\r\n')
    // a key that is not there, at any depth: the text is the text
    for (const key of ['zzz', 'terminal.zzz', 'a.b.c']) expect(take(COMMENTED, key)).toBe(COMMENTED)
    // adding a key and taking it out again gives the person's text back, comments included (the same texts as U-SET-7)
    for (const text of ['{\n  "terminal": {\n    "cursorBlink": false, // steady\n  },\n}\n', '{\n  "terminal": {\n    "cursorBlink": false // steady\n  }\n}\n', '{\n  "terminal": {\n    "fontSize": 14 /* big */,\n  }\n}\n', COMMENTED]) {
      expect(take(editSettingsText(text, 'terminal.theme', 'kea-light'), 'terminal.theme')).toBe(text)
    }
  })

  it('U-SET-8 · any key added to or taken out of any commented object: the file parses to the document it should, every comment is still there, and each one is still on the line of the key it was written beside; so too in a file with a byte order mark, with a key written twice (the last is the one in effect) and with the object itself written twice', () => {
    type Prop = { name: string; value: unknown; above: boolean; beside: boolean }
    const BOM = '\uFEFF'
    const value = fc.oneof(fc.integer(), fc.boolean(), fc.constantFrom('x', 'a // b', 'c, d', '/* e */', 'https://kea.invalid/x'), fc.constant({ in: 1, 'more // in': [1, 2] }), fc.constant([]))
    const doc = fc.record({
      props: fc.uniqueArray(fc.record({ name: fc.constantFrom('a', 'b', 'c', 'd', 'e'), value, above: fc.boolean(), beside: fc.boolean() }), { selector: (p) => p.name, minLength: 1, maxLength: 5 }),
      trailingComma: fc.boolean(),
      crlf: fc.boolean(),
      nested: fc.boolean(),
      bom: fc.boolean(),
      // a key written once more, before the others: the later one is in effect, or this one when no other has its name
      twice: fc.option(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { nil: null, freq: 4 }),
      // the object itself written once more, before the one in effect (when it is nested)
      twiceOuter: fc.boolean(),
    })
    type Doc = { props: Prop[]; trailingComma: boolean; crlf: boolean; nested: boolean; bom: boolean; twice: string | null; twiceOuter: boolean }
    const EARLIER = 'written earlier'
    const write = (d: Doc): string => {
      const pad = d.nested ? '    ' : '  '
      const lines: string[] = []
      if (d.twice) lines.push(`${pad}${JSON.stringify(d.twice)}: ${JSON.stringify(EARLIER)},`)
      d.props.forEach((p, i) => {
        if (p.above) lines.push(`${pad}// above ${p.name}`)
        const comma = i < d.props.length - 1 || d.trailingComma ? ',' : ''
        lines.push(`${pad}${JSON.stringify(p.name)}: ${JSON.stringify(p.value)}${comma}${p.beside ? ` // beside ${p.name}` : ''}`)
      })
      const body = d.nested ? ['{', ...(d.twiceOuter ? [OUTER] : []), '  "sec": {', ...lines, '  }', '}'] : ['{', ...lines, '}']
      return `${d.bom ? BOM : ''}${body.join(d.crlf ? '\r\n' : '\n')}${d.crlf ? '\r\n' : '\n'}`
    }
    const OUTER = '  "sec": { "a": "in the object written earlier", "new": 0 },'
    /** Each comment of a text with the key on its line, if any (`// beside a` must stay on the line of "a"). */
    const comments = (text: string) =>
      text
        .split(/\r?\n/)
        .filter((l) => / \/\/ (above|beside) [a-e]$/.test(l) || /^\s*\/\/ (above|beside) [a-e]$/.test(l))
        .map((l) => ({ comment: /\/\/ (?:above|beside) [a-e]$/.exec(l)![0], key: /^\s*"([a-e])":/.exec(l)?.[1] ?? null }))
    fc.assert(
      fc.property(doc, fc.constantFrom('a', 'b', 'c', 'd', 'e', 'new'), fc.boolean(), (d, key, remove) => {
        const text = write(d)
        const before = parseSettingsText(text)
        expect(before.error).toBeNull()
        const path = d.nested ? `sec.${key}` : key
        // what the object in effect holds, a later key over an earlier one of its name
        const held = Object.fromEntries([...(d.twice ? [[d.twice, EARLIER] as [string, unknown]] : []), ...d.props.map((p) => [p.name, p.value] as [string, unknown])])
        expect(before.raw).toEqual(d.nested ? { sec: held } : held)
        const has = key in held
        const out = editSettingsText(text, path, remove ? undefined : 'set')
        const after = parseSettingsText(out)
        expect(after.error, out).toBeNull()
        // set: the one in effect has the value. Taken out: every one of that name is gone from the object in effect
        const want = { ...held }
        if (remove) delete want[key]
        else want[key] = 'set'
        expect(after.raw, out).toEqual(d.nested ? { sec: want } : want)
        // the mark stays, once; an earlier writing of another key, and of the object, is as it was
        expect(out.startsWith(BOM)).toBe(d.bom)
        expect(out.lastIndexOf(BOM)).toBe(d.bom ? 0 : -1)
        if (d.twice && !(remove && d.twice === key) && d.props.some((p) => p.name === d.twice)) expect(out, out).toContain(`${JSON.stringify(d.twice)}: ${JSON.stringify(EARLIER)},`)
        if (d.nested && d.twiceOuter) expect(out, out).toContain(OUTER)
        // every comment survives, in order; one beside a key that stays is still beside it, and none moved beside another key
        const was = comments(text)
        const now = comments(out)
        expect(now.map((c) => c.comment), out).toEqual(was.map((c) => c.comment))
        for (const [i, c] of was.entries()) {
          if (remove && has && c.key === key) expect(now[i]!.key, `${c.comment} stays behind on its own line\n${out}`).toBeNull()
          else expect(now[i]!.key, `${c.comment}\n${out}`).toBe(c.key)
        }
        // nothing else changed: every line of the result that holds a key that stays is a line of the original (but for a comma)
        if (remove && !has) expect(out).toBe(text)
        expect(out.includes('\r\n')).toBe(text.includes('\r\n'))
        if (!d.crlf) expect(out).not.toContain('\r')
      }),
      { numRuns: 800 },
    )
  })

  it('U-SET-8 · the shapes a hand-written file can have: a key whose parent is not an object is refused with the key and the fix named, never a raw error; Reset of a key that is not there changes nothing, in an empty or comment-only file too; of duplicate keys the last, the one in effect, is the one edited; a byte order mark is read past and kept', async () => {
    const BOM = '\uFEFF'
    const refused = (text: string, key: string, value: unknown): RpcError => {
      let thrown: unknown
      try {
        editSettingsText(text, key, value)
      } catch (e) {
        thrown = e
      }
      expect(thrown, text).toBeInstanceOf(RpcError)
      expect((thrown as RpcError).code).toBe('file_invalid')
      return thrown as RpcError
    }
    // a parent that is no object: a change under it is refused in words for the person; Reset finds no such key
    for (const [held, what] of [['5 // oops', 'a number'], ['null', 'null'], ['[1, 2]', 'a list'], ['"x"', 'a text'], ['true', 'true or false']] as const) {
      const text = `{\n  "terminal": ${held}\n}\n`
      const e = refused(text, 'terminal.fontSize', 14)
      expect(e.message).toBe(`settings.json: "terminal" is ${what}, not a group of settings, so terminal.fontSize cannot be set; make it { } or take it out, then try again`)
      expect(editSettingsText(text, 'terminal.fontSize', undefined)).toBe(text)
    }
    expect(refused('{ "agents": { "claude": 3 } }', 'agents.claude.command', '/x').message).toContain('"agents.claude" is a number')

    // Reset of a key that is not there: the text as it is, whatever it is
    for (const text of ['', '\n', '// only a comment\n', '// only a comment', '/* nothing yet */', '{}\n', '{\n  // nothing\n}\n', '{ "terminal": { "cursorBlink": true } }\n', BOM, `${BOM}// c\n`]) {
      expect(editSettingsText(text, 'terminal.fontSize', undefined), JSON.stringify(text)).toBe(text)
    }
    // and a key set in a file that is only a comment: the key, and the comment still there
    for (const text of ['// only a comment\n', '/* nothing yet */']) {
      const out = editSettingsText(text, 'terminal.fontSize', 14)
      expect(parseSettingsText(out)).toEqual({ raw: { terminal: { fontSize: 14 } }, error: null })
      expect(out).toContain(text.trim())
    }

    // duplicate keys: the last is the one in effect, so it is the one changed; the others stay as they are
    const twice = '{\n  "terminal": { "fontSize": 12 },\n  "terminal": { "fontSize": 13 } // mine\n}\n'
    expect(parseSettingsText(twice).raw).toEqual({ terminal: { fontSize: 13 } })
    expect(editSettingsText(twice, 'terminal.fontSize', 20)).toBe(twice.replace('13', '20'))
    const added = editSettingsText(twice, 'terminal.cursorBlink', false)
    expect(parseSettingsText(added)).toEqual({ raw: { terminal: { fontSize: 13, cursorBlink: false } }, error: null })
    expect(added).toContain('"terminal": { "fontSize": 12 },')
    expect(added).toContain('// mine')
    // Reset looks at the one in effect only
    expect(editSettingsText(twice, 'terminal.cursorBlink', undefined)).toBe(twice)
    const reset = editSettingsText(twice, 'terminal.fontSize', undefined)
    expect(parseSettingsText(reset)).toEqual({ raw: { terminal: {} }, error: null })
    expect(reset).toContain('"terminal": { "fontSize": 12 },')
    const inOne = '{\n  "terminal": {\n    "fontSize": 12, // old\n    "fontSize": 13,\n    "cursorBlink": true\n  }\n}\n'
    expect(editSettingsText(inOne, 'terminal.fontSize', 20)).toBe(inOne.replace('13', '20'))
    expect(editSettingsText(inOne, 'terminal.fontSize', { a: [1] })).toBe(inOne.replace('13', '{\n      "a": [\n        1\n      ]\n    }'))
    // Reset takes every one of them out: the default is in effect then, and the comment stays
    const none = editSettingsText(inOne, 'terminal.fontSize', undefined)
    expect(parseSettingsText(none)).toEqual({ raw: { terminal: { cursorBlink: true } }, error: null })
    expect(none).toContain('// old')

    // a byte order mark (an editor's "UTF-8 with BOM"): read past, kept in what is written
    const marked = `${BOM}{\n  "terminal": { "fontSize": 12 } // mine\n}\n`
    expect(parseSettingsText(marked)).toEqual({ raw: { terminal: { fontSize: 12 } }, error: null })
    expect(parseSettingsText(BOM)).toEqual({ raw: {}, error: null })
    expect(editSettingsText(marked, 'terminal.fontSize', 14)).toBe(marked.replace('12', '14'))
    expect(editSettingsText(marked, 'terminal.fontSize', undefined)).toBe(`${BOM}{\n  "terminal": { } // mine\n}\n`)
    expect(editSettingsText(BOM, 'terminal.fontSize', 14)).toBe(`${BOM}{\n  "terminal": {\n    "fontSize": 14\n  }\n}\n`)
    // an error is placed as an editor shows it: the mark is no column
    expect(parseSettingsText(`${BOM}{ "a": }`).error).toMatchObject({ line: 1, column: 8 })
    expect(parseSettingsText('{ "a": }').error).toMatchObject({ line: 1, column: 8 })

    // through the file: the refusal reaches the UI as `file_invalid`, nothing is written, the values stay; a marked file is read and stays marked
    const h = home()
    const broken = '{\n  "terminal": 5, // oops\n  "general": { "branchPrefix": "dev/" }\n}\n'
    fs.writeFileSync(settingsPath(h), broken)
    const s = open(h)
    expect(s.values.get('general.branchPrefix')).toBe('dev/')
    await expect(s.set('terminal.fontSize', 14)).rejects.toMatchObject({ code: 'file_invalid', message: expect.stringContaining('"terminal" is a number') })
    await s.reset('terminal.fontSize')
    expect(fs.readFileSync(settingsPath(h), 'utf8')).toBe(broken)
    expect(s.values.get('terminal.fontSize')).toBe(DEFAULTS.fontSize)
    await s.set('general.branchPrefix', 'x/')
    expect(fs.readFileSync(settingsPath(h), 'utf8')).toBe(broken.replace('dev/', 'x/'))

    const h2 = home()
    fs.writeFileSync(settingsPath(h2), marked)
    const s2 = open(h2)
    expect(s2.statusStore.get(SETTINGS_STATUS_KEY)?.error).toBeNull()
    expect(s2.values.get('terminal.fontSize')).toBe(12)
    await s2.set('terminal.fontSize', 16)
    expect(fs.readFileSync(settingsPath(h2), 'utf8')).toBe(marked.replace('12', '16'))
    // Reset in a file that is only a comment: nothing is written
    const h3 = home()
    fs.writeFileSync(settingsPath(h3), '// later\n')
    const s3 = open(h3)
    await s3.reset('terminal.fontSize')
    expect(fs.readFileSync(settingsPath(h3), 'utf8')).toBe('// later\n')
  })

  it('U-SET-5 · a UI change writes the one key to the file and applies at once, through a symlinked file; invalid values and unknown keys are refused', async () => {
    const h = home()
    fs.writeFileSync(settingsPath(h), COMMENTED)
    const s = open(h)
    let changes = 0
    s.onChange(() => changes++)
    expect(s.values.get('terminal.fontSize')).toBe(14)
    await s.set('terminal.fontSize', 18)
    expect(s.values.get('terminal.fontSize')).toBe(18)
    expect(s.store.get('terminal.fontSize')).toBe(18)
    expect(changes).toBe(1)
    expect(fs.readFileSync(settingsPath(h), 'utf8')).toBe(COMMENTED.replace('"fontSize": 14', '"fontSize": 18'))

    await s.reset('general.branchPrefix')
    expect(s.values.get('general.branchPrefix')).toBe('kea/')
    expect(fs.readFileSync(settingsPath(h), 'utf8')).toContain('// my Kea settings')

    await expect(s.set('terminal.fontSize', 'huge')).rejects.toMatchObject({ code: 'invalid_value' })
    await expect(s.set('terminal.nope', 1)).rejects.toBeInstanceOf(RpcError)
    await expect(s.reset('nope.nope')).rejects.toMatchObject({ code: 'unknown_key' })
    expect(s.values.get('terminal.fontSize')).toBe(18)

    // settings.json linked from someone's dotfiles: the file it points to is edited, the link stays a link
    const h2 = home()
    const dotfiles = home()
    const target = path.join(dotfiles, 'kea-settings.json')
    fs.writeFileSync(target, COMMENTED)
    fs.symlinkSync(target, settingsPath(h2))
    const linked = open(h2)
    await linked.set('terminal.fontSize', 17)
    expect(fs.lstatSync(settingsPath(h2)).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(settingsPath(h2))).toBe(target)
    expect(fs.readFileSync(target, 'utf8')).toBe(COMMENTED.replace('"fontSize": 14', '"fontSize": 17'))
    expect(linked.values.get('terminal.fontSize')).toBe(17)
  })

  it('U-SET-5 · a save that lands just as Kea begins to follow settings.json is not lost: the file is followed first and read after, so what it held when the watch began is what was read, and a later save is heard as ever', () => {
    vi.useFakeTimers()
    try {
      const h = home()
      fs.writeFileSync(settingsPath(h), COMMENTED)
      let changed: (() => void) | null = null
      // the watch service as it is (platform/watch/single.ts): what the file holds when its watch begins is the
      // caller's to have read; only a change after that is reported. The save lands right before the watch begins.
      const service: WatchService = {
        file: (file, onChange) => {
          fs.writeFileSync(file, COMMENTED.replace('"fontSize": 14', '"fontSize": 19'))
          changed = onChange
          return { dispose: () => undefined, look: () => undefined }
        },
        dir: () => ({ dispose: () => undefined }),
      }
      const s = new SettingsFile({ home: h, log: createMemoryLogger({ process: 'core' }), watcher: service })
      cleanup.push(() => s.dispose())
      expect(s.values.get('terminal.fontSize'), 'the save made as the watch began').toBe(19)
      expect(s.store.get('terminal.fontSize')).toBe(19)
      vi.advanceTimersByTime(L.watchBatchMs)
      expect(s.values.get('terminal.fontSize')).toBe(19)
      // a later save is reported and read
      fs.writeFileSync(settingsPath(h), COMMENTED.replace('"fontSize": 14', '"fontSize": 21'))
      changed!()
      vi.advanceTimersByTime(L.watchBatchMs)
      expect(s.values.get('terminal.fontSize')).toBe(21)
    } finally {
      vi.useRealTimers()
    }
  })

  it('U-SET-5 · a broken file keeps the last-known-good values and reports the parse error with line and column; it is never edited', async () => {
    const h = home()
    fs.writeFileSync(settingsPath(h), '{ "terminal": { "fontSize": 15 } }\n')
    const s = open(h)
    expect(s.values.get('terminal.fontSize')).toBe(15)
    expect(s.status.error).toBeNull()

    const broken = '{\n  "terminal": {\n    "fontSize": 20\n    "fontFamily": "Menlo"\n  }\n}\n'
    fs.writeFileSync(settingsPath(h), broken)
    s.reload()
    expect(s.values.get('terminal.fontSize'), 'last known good').toBe(15)
    expect(s.store.get('terminal.fontSize')).toBe(15)
    expect(s.statusStore.get(SETTINGS_STATUS_KEY)?.error).toEqual({ message: 'CommaExpected', line: 4, column: 5, offset: broken.indexOf('"fontFamily"') })
    await expect(s.set('terminal.fontSize', 12)).rejects.toMatchObject({ code: 'file_invalid' })
    expect(fs.readFileSync(settingsPath(h), 'utf8')).toBe(broken)

    // fixed by hand: applied, banner gone
    fs.writeFileSync(settingsPath(h), broken.replace('20\n', '20,\n'))
    s.reload()
    expect(s.values.get('terminal.fontSize')).toBe(20)
    expect(s.values.get('terminal.fontFamily')).toBe('Menlo')
    expect(s.status.error).toBeNull()

    // broken at launch: the defaults, and the error
    const h2 = home()
    const bad = '{ "terminal": { "fontSize": 30, } ]'
    fs.writeFileSync(settingsPath(h2), bad)
    const s2 = open(h2)
    expect(s2.values.get('terminal.fontSize')).toBe(DEFAULTS.fontSize)
    expect(s2.store.get('terminal.fontSize')).toBe(DEFAULTS.fontSize)
    expect(s2.status.error).toMatchObject({ line: 1, column: bad.indexOf(']') + 1 })
  })

  it('U-SET-5 · invalid values fall back per key with a notice in settings.status; a deleted file means the defaults', () => {
    const h = home()
    // one past the largest font size, and a valid cursor
    fs.writeFileSync(settingsPath(h), JSON.stringify({ terminal: { fontSize: L.settingsFontSizeMax + 1, cursorStyle: 'bar' } }))
    const s = open(h)
    expect(s.values.get('terminal.fontSize')).toBe(DEFAULTS.fontSize)
    expect(s.values.get('terminal.cursorStyle')).toBe('bar')
    expect(s.status.notices.map((n) => n.key)).toEqual(['terminal.fontSize'])
    fs.rmSync(settingsPath(h))
    s.reload()
    expect(s.values.get('terminal.cursorStyle')).toBe(DEFAULTS.cursorStyle)
    expect(s.status).toMatchObject({ exists: false, error: null, notices: [] })
  })

  it('U-SET-5 · line and column are 1-based', () => {
    expect(lineColumn('ab\ncd', 0)).toEqual({ line: 1, column: 1 })
    expect(lineColumn('ab\ncd', 4)).toEqual({ line: 2, column: 2 })
  })
})
