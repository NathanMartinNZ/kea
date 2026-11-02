import { closeBrackets, insertBracket } from '@codemirror/autocomplete'
import { insertNewlineAndIndent, toggleComment } from '@codemirror/commands'
import { indentOnInput, indentUnit } from '@codemirror/language'
import { EditorState, type StateCommand } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { AIDS, aidsOf, DEFAULT, defaultIndent, languageAids, patternsOf, PLAIN } from './languageAids.ts'
import { LANGUAGE_NAMES, languageIds } from './language.ts'

/** A document of `lang` with the cursor at `|`, as the editable document has it. */
function docOf(lang: string | null, text: string): EditorState {
  const at = text.indexOf('|')
  return EditorState.create({
    doc: text.slice(0, at) + text.slice(at + 1),
    selection: { anchor: at },
    extensions: [languageAids(lang), indentUnit.of(defaultIndent(lang)), closeBrackets(), indentOnInput()],
  })
}

/** The document after `cmd`, with `|` where the cursor is; the same text when the command does nothing. */
function after(state: EditorState, cmd: StateCommand): string {
  let out = state
  cmd({ state, dispatch: (tr) => (out = tr.state) })
  const head = out.selection.main.head
  const doc = out.doc.toString()
  return doc.slice(0, head) + '|' + doc.slice(head)
}

const typed = (state: EditorState, ch: string): string => {
  const tr = insertBracket(state, ch)
  return tr ? after(state, ({ dispatch }) => (dispatch(tr), true)) : 'not closed'
}

/** Typing `ch` at the cursor, as the keyboard does (so `indentOnInput` sees it). */
const typeChar = (state: EditorState, ch: string): string => {
  const head = state.selection.main.head
  return after(state, ({ dispatch }) => (dispatch(state.update({ changes: { from: head, insert: ch }, selection: { anchor: head + ch.length }, userEvent: 'input.type' })), true))
}

describe('language aids', () => {
  it('U-FV-28 · the table covers every language id or falls to the default, and its patterns compile', () => {
    const ids = new Set([...Object.keys(LANGUAGE_NAMES), ...languageIds()])
    // nothing in the table that the viewer does not name
    for (const id of Object.keys(AIDS)) expect(ids.has(id), id).toBe(true)
    // the ids left to the default, each on purpose
    expect([...ids].filter((id) => !Object.hasOwn(AIDS, id))).toEqual(['asm'])
    expect(aidsOf('asm')).toBe(DEFAULT)
    expect(aidsOf('no-such-language')).toBe(DEFAULT)
    expect(aidsOf(null)).toBe(PLAIN)
    for (const [id, a] of [...Object.entries(AIDS), ['default', DEFAULT], ['plain', PLAIN]] as const) {
      const p = patternsOf(a)
      expect(a.brackets.length % 2, id).toBe(0)
      expect(/^(?:\t|( )+)$/.test(a.unit), id).toBe(true)
      // what closes itself is an opening bracket of the language or a quote
      const openers = [...a.brackets].filter((_, i) => i % 2 === 0)
      for (const ch of a.close) expect(openers.includes(ch) || `"'\``.includes(ch), `${id} ${ch}`).toBe(true)
      for (const t of [a.comments?.line, a.comments?.block?.open, a.comments?.block?.close]) if (t !== undefined) expect(t.trim(), id).toBe(t)
      if (a.indent === 'follow') {
        expect([p.opens, p.closes, p.onInput], id).toEqual([null, null, null])
        continue
      }
      for (let i = 0; i < a.brackets.length; i += 2) {
        const [open, close] = [a.brackets[i] as string, a.brackets[i + 1] as string]
        expect(p.opens?.test(`  call${open}`), `${id} ${open}`).toBe(true)
        expect(p.closes?.test(`  ${close} more`), `${id} ${close}`).toBe(true)
        expect(p.onInput?.test(`    ${close}`), `${id} ${close}`).toBe(true)
      }
      expect(p.opens?.test('  plain words'), id).toBe(false)
      expect(p.onInput?.test('  x'), id).toBe(false)
      // a trailing line comment is not the line's ending
      if (p.trailing) expect(`  run(  ${a.comments?.line} why`.replace(p.trailing, '').trimEnd(), id).toBe('  run(')
    }
  })

  it('U-FV-25 · ⌘/ toggles the language’s line comment, a block comment where it has none, the inner language’s in markup and front matter, nothing in plain text', () => {
    expect(after(docOf('typescript', 'const |a = 1'), toggleComment)).toBe('// const |a = 1')
    expect(after(docOf('typescript', '// const |a = 1'), toggleComment)).toBe('const |a = 1')
    expect(after(docOf('python', '    x = |1'), toggleComment)).toBe('    # x = |1')
    expect(after(docOf('css', 'a { color: |red }'), toggleComment)).toBe('/* a { color: |red } */')
    expect(after(docOf('html', '<p>hi|</p>'), toggleComment)).toBe('<!-- <p>hi|</p> -->')
    expect(after(docOf('sql', 'select |1'), toggleComment)).toBe('-- select |1')
    expect(after(docOf('make', 'all: |build'), toggleComment)).toBe('# all: |build')
    // a Svelte file's script and style, and its markup
    const svelte = '<script lang="ts">\n  let a = 1\n</script>\n<style>\n  p { margin: 0 }\n</style>\n<p>hi</p>'
    const at = (word: string) => svelte.replace(word, `|${word}`)
    expect(after(docOf('svelte', at('a = 1')), toggleComment)).toContain('\n  // let |a = 1\n')
    expect(after(docOf('svelte', at('margin')), toggleComment)).toContain('\n  /* p { |margin: 0 } */\n')
    expect(after(docOf('svelte', at('hi</p>')), toggleComment)).toContain('\n<!-- <p>|hi</p> -->')
    // a front matter block, and what follows it
    expect(after(docOf('astro', '---\nconst |a = 1\n---\n<p>hi</p>'), toggleComment)).toBe('---\n// const |a = 1\n---\n<p>hi</p>')
    expect(after(docOf('astro', '---\nconst a = 1\n---\n<p>|hi</p>'), toggleComment)).toBe('---\nconst a = 1\n---\n<!-- <p>|hi</p> -->')
    expect(after(docOf('markdown', '---\ntitle: |x\n---\n# Hi'), toggleComment)).toBe('---\n# title: |x\n---\n# Hi')
    expect(after(docOf('markdown', '# |Hi'), toggleComment)).toBe('<!-- # |Hi -->')
    // no comment toggle where the language has no comments, or is not known
    expect(after(docOf(null, 'some |text'), toggleComment)).toBe('some |text')
    expect(after(docOf('json', '{ "a": |1 }'), toggleComment)).toBe('{ "a": |1 }')
    expect(after(docOf('asm', 'mov |a, b'), toggleComment)).toBe('mov |a, b')
  })

  it('U-FV-25 · brackets and quotes close themselves as the language has them: no quotes in Markdown and plain text, no apostrophe in Rust', () => {
    expect(typed(docOf('typescript', 'f|'), '(')).toBe('f(|)')
    expect(typed(docOf('typescript', 'x = |'), '{')).toBe('x = {|}')
    expect(typed(docOf('typescript', 'x = |'), '"')).toBe('x = "|"')
    expect(typed(docOf('typescript', 'x = |'), '`')).toBe('x = `|`')
    expect(typed(docOf('python', 'x = |'), "'")).toBe("x = '|'")
    // a string prefix still starts a string
    expect(typed(docOf('python', 'x = f|'), '"')).toBe('x = f"|"')
    expect(typed(docOf('markdown', 'see |'), '(')).toBe('see (|)')
    expect(typed(docOf('markdown', 'say |'), '"')).toBe('not closed')
    expect(typed(docOf('markdown', 'say |'), "'")).toBe('not closed')
    expect(typed(docOf(null, 'a |'), '[')).toBe('a [|]')
    expect(typed(docOf(null, 'a |'), '"')).toBe('not closed')
    expect(typed(docOf('rust', 'fn f<|'), "'")).toBe('not closed')
    expect(typed(docOf('json', '|'), '(')).toBe('not closed')
    // an unknown language: brackets and both quotes
    expect(typed(docOf('asm', 'a |'), "'")).toBe("a '|'")
    // typing the closer over the one put in steps over it
    const open = docOf('typescript', 'f|')
    const tr = insertBracket(open, '(')
    expect(tr && typed(tr.state, ')')).toBe('f()|')
  })

  it('U-FV-25 · ↵ after an opening bracket, or after `:` in Python and YAML, indents one unit more; elsewhere a new line keeps the line’s indentation', () => {
    expect(after(docOf('typescript', 'function f() {|}'), insertNewlineAndIndent)).toBe('function f() {\n  |\n}')
    expect(after(docOf('typescript', '  if (x) {|'), insertNewlineAndIndent)).toBe('  if (x) {\n    |')
    expect(after(docOf('typescript', '  call(a, [|'), insertNewlineAndIndent)).toBe('  call(a, [\n    |')
    expect(after(docOf('typescript', '  if (x) { // why|'), insertNewlineAndIndent)).toBe('  if (x) { // why\n    |')
    expect(after(docOf('typescript', '    a = 1|'), insertNewlineAndIndent)).toBe('    a = 1\n    |')
    // a blank line between: the line above it counts
    expect(after(docOf('typescript', 'if (x) {\n|'), insertNewlineAndIndent)).toBe('if (x) {\n\n  |')
    expect(after(docOf('python', 'def f():|'), insertNewlineAndIndent)).toBe('def f():\n    |')
    expect(after(docOf('python', '    if x:  # why|'), insertNewlineAndIndent)).toBe('    if x:  # why\n        |')
    expect(after(docOf('python', '    return x|'), insertNewlineAndIndent)).toBe('    return x\n    |')
    expect(after(docOf('yaml', 'jobs:\n  build:|'), insertNewlineAndIndent)).toBe('jobs:\n  build:\n    |')
    expect(after(docOf('yaml', '  run: >-|'), insertNewlineAndIndent)).toBe('  run: >-\n    |')
    expect(after(docOf('yaml', '  name: x|'), insertNewlineAndIndent)).toBe('  name: x\n  |')
    // Markdown follows the line
    expect(after(docOf('markdown', '- item\n  more (see|'), insertNewlineAndIndent)).toBe('- item\n  more (see\n  |')
    expect(after(docOf('markdown', 'text:|'), insertNewlineAndIndent)).toBe('text:\n|')
    // an opening tag in markup
    expect(after(docOf('html', '<ul>\n  <li>|'), insertNewlineAndIndent)).toBe('<ul>\n  <li>\n    |')
    expect(after(docOf('html', '  <br>|'), insertNewlineAndIndent)).toBe('  <br>\n  |')
    expect(after(docOf('html', '  <p>hi</p>|'), insertNewlineAndIndent)).toBe('  <p>hi</p>\n  |')
  })

  it('U-FV-25 · a line beginning with a closing bracket outdents to its opener’s line, as it is typed and on ↵', () => {
    expect(typeChar(docOf('typescript', 'if (x) {\n  foo()\n  |'), '}')).toBe('if (x) {\n  foo()\n}|')
    expect(typeChar(docOf('typescript', '  const a = [\n    1,\n    |'), ']')).toBe('  const a = [\n    1,\n  ]|')
    expect(typeChar(docOf('python', 'x = (\n    1,\n    |'), ')')).toBe('x = (\n    1,\n)|')
    // the opener's line, not the line above
    expect(typeChar(docOf('typescript', 'call(a, {\n    b: 1,\n        |'), '}')).toBe('call(a, {\n    b: 1,\n}|')
    expect(after(docOf('typescript', 'foo(a,\n    b|)'), insertNewlineAndIndent)).toBe('foo(a,\n    b\n|)')
    // a closing tag goes one unit less
    expect(typeChar(docOf('html', '<ul>\n  <li>a</li>\n  <|'), '/')).toBe('<ul>\n  <li>a</li>\n</|')
    // a closer not at the line's start changes nothing
    expect(typeChar(docOf('typescript', '  foo(|'), ')')).toBe('  foo()|')
  })

  it('U-FV-25 · a Makefile indents with a tab: after a rule line and on a recipe line, never after an assignment', () => {
    expect(defaultIndent('make')).toBe('\t')
    expect(defaultIndent('go')).toBe('\t')
    expect(defaultIndent('typescript')).toBe('  ')
    expect(defaultIndent('python')).toBe('    ')
    expect(after(docOf('make', 'all: build|'), insertNewlineAndIndent)).toBe('all: build\n\t|')
    expect(after(docOf('make', 'all: build\n\tcc -o a a.c|'), insertNewlineAndIndent)).toBe('all: build\n\tcc -o a a.c\n\t|')
    expect(after(docOf('make', 'CFLAGS = -O2|'), insertNewlineAndIndent)).toBe('CFLAGS = -O2\n|')
    expect(after(docOf('make', 'X := a|'), insertNewlineAndIndent)).toBe('X := a\n|')
    expect(after(docOf('go', 'func f() {|}'), insertNewlineAndIndent)).toBe('func f() {\n\t|\n}')
  })
})
