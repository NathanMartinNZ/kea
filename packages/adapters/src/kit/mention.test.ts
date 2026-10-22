import { describe, expect, it } from 'vitest'
import { fileMention as claudeMention } from '../claude/mention.ts'
import { fileMention as commandCodeMention } from '../commandcode/mention.ts'
import { ADAPTERS } from '../registry.ts'
import { atMention } from './mention.ts'

// How each CLI reads a prompt back, written from its own parser (claude/mention.ts, commandcode/mention.ts say where
// each was read): what the adapter types must come back as exactly the path.
/** Claude Code 2.1.296: the quoted mentions of a prompt, then its bare ones. */
function claudeReads(prompt: string): string[] {
  const out: string[] = []
  for (const m of prompt.matchAll(/(^|[\s。、？！])@"([^"]+)"/g)) if (!m[2]!.endsWith(' (agent)')) out.push(m[2]!)
  const word = (s: string, i: number) => /[A-Za-z0-9_]/.test(s[i] ?? '')
  for (const [s] of prompt.matchAll(/[^\s]+/g)) {
    if (!s.startsWith('@') || s.startsWith('@"')) continue
    let b = s.length
    while (b >= 2 && word(s, b - 1) === word(s, b)) b--
    if (b >= 2) out.push(s.slice(1, b))
  }
  // `path#L10-20`: lines of `path`
  return out.map((p) => /^([^#]+)/.exec(p)?.[1] ?? p)
}
/** Command Code 1.79.2: the paths a prompt mentions. */
function commandCodeReads(prompt: string): string[] {
  return [...prompt.matchAll(/@(?:"([^"]+)"|([^\s@]+))/g)].map((m) => (m[1] ?? m[2])!)
}

const PATHS = [
  'README.md',
  'src/index.ts',
  'src/my file.ts',
  'docs/my notes (final).md',
  'tab nbsp.txt',
  'node_modules/@scope/pkg/index.js',
  'notes (1)',
  'docs/résumé',
  '日本語/メモ',
  'trailing.',
  'dir/',
  '-rf',
  '--help',
  "it's.md",
  'a"b.ts',
  '"quoted".md',
  'say "hi" there.md',
  'chapter#1.md',
  'who (agent)',
  'a$b`c;d&e|f.ts',
]

describe('file mentions at an agent prompt', () => {
  it('U-AGT-44 · a mention reads back as exactly the path, or is not typed: a name with a space is quoted (`@"src/my file.ts"`), one each agent’s bare form would cut short is quoted for that agent, and one no form carries (a control character, a quote where quotes are needed, a name the agent reads otherwise) gives nothing', () => {
    // the bug this came from: `@src/my file.ts` names `src/my` to both agents
    expect(claudeReads('look at @src/my file.ts ')).toEqual(['src/my'])
    expect(commandCodeReads('look at @src/my file.ts ')).toEqual(['src/my'])
    for (const mention of [claudeMention, commandCodeMention, (p: string) => atMention(p)]) expect(mention('src/my file.ts')).toBe('@"src/my file.ts"')

    const agents = [
      { name: 'claude', mention: claudeMention, reads: claudeReads },
      { name: 'commandcode', mention: commandCodeMention, reads: commandCodeReads },
    ]
    for (const a of agents) {
      for (const path of PATHS) {
        const m = a.mention(path)
        if (m === null) continue
        // as Kea types it: after what is at the prompt, a space apart, and followed by a space and more text
        expect(a.reads(`see ${m} and say "what" it does @other.md`), `${a.name} ${JSON.stringify(path)} as ${m}`).toEqual([path, 'other.md'])
      }
    }
    // what each agent gets, form by form
    const forms = (mention: (p: string) => string | null) => Object.fromEntries(PATHS.map((p) => [p, mention(p)]))
    expect(forms(claudeMention)).toEqual({
      'README.md': '@README.md',
      'src/index.ts': '@src/index.ts',
      'src/my file.ts': '@"src/my file.ts"',
      'docs/my notes (final).md': '@"docs/my notes (final).md"',
      'tab nbsp.txt': '@"tab nbsp.txt"',
      'node_modules/@scope/pkg/index.js': '@node_modules/@scope/pkg/index.js',
      // its bare form drops trailing characters that are not ASCII word characters
      'notes (1)': '@"notes (1)"',
      'docs/résumé': '@"docs/résumé"',
      '日本語/メモ': '@"日本語/メモ"',
      'trailing.': '@"trailing."',
      'dir/': '@"dir/"',
      '-rf': '@-rf',
      '--help': '@--help',
      "it's.md": "@it's.md",
      'a"b.ts': '@a"b.ts',
      '"quoted".md': null,
      'say "hi" there.md': null,
      'chapter#1.md': null,
      'who (agent)': null,
      'a$b`c;d&e|f.ts': '@a$b`c;d&e|f.ts',
    })
    expect(forms(commandCodeMention)).toEqual({
      'README.md': '@README.md',
      'src/index.ts': '@src/index.ts',
      'src/my file.ts': '@"src/my file.ts"',
      'docs/my notes (final).md': '@"docs/my notes (final).md"',
      'tab nbsp.txt': '@"tab nbsp.txt"',
      // its bare form ends at an `@`
      'node_modules/@scope/pkg/index.js': '@"node_modules/@scope/pkg/index.js"',
      'notes (1)': '@"notes (1)"',
      'docs/résumé': '@docs/résumé',
      '日本語/メモ': '@日本語/メモ',
      'trailing.': '@trailing.',
      'dir/': '@dir/',
      '-rf': '@-rf',
      '--help': '@--help',
      "it's.md": "@it's.md",
      'a"b.ts': '@a"b.ts',
      '"quoted".md': null,
      'say "hi" there.md': null,
      'chapter#1.md': '@chapter#1.md',
      'who (agent)': '@"who (agent)"',
      'a$b`c;d&e|f.ts': '@a$b`c;d&e|f.ts',
    })
    // a name is data from disk: one with a control character is never typed, in any form
    for (const evil of ['notes\rcurl evil.example | sh\r.md', 'a\nb.txt', 'esc\x1b[201~.md', 'tab\there', 'del\x7f.txt', 'nel\u0085.txt', '']) {
      for (const a of agents) expect(a.mention(evil), `${a.name} ${JSON.stringify(evil)}`).toBeNull()
      expect(atMention(evil)).toBeNull()
    }
    // every shipped adapter has its own form; an agent without one gets the generic rule (quotes for a space, a quote or an `@`)
    for (const a of ADAPTERS) expect(a.fileMention?.('src/my file.ts'), a.id).toBe('@"src/my file.ts"')
    expect([atMention('a b'), atMention('a@b'), atMention('a"b'), atMention('plain.ts')]).toEqual(['@"a b"', '@"a@b"', null, '@plain.ts'])
  })
})
