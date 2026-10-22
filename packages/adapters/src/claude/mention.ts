// Claude Code's file mention, as 2.1.296 parses a prompt (read in the installed build's own text; the CLI was not run,
// and no contract test checks it):
//
//   @"path"   anything but `"` between the quotes; one that ends in ` (agent)` is an agent's name, not a file
//   @path     one whitespace-delimited word, from which trailing characters other than ASCII letters, digits and `_`
//             are dropped (the full stop after a mention in a sentence: so `notes (1)`, `résumé` or `a.` lose their end)
//   #         both forms take `path#L10-20` as lines of `path`, so a name with a `#` is cut at it
//
// So the bare form is typed only for a path without whitespace that ends in a word character, the quoted one for the
// rest, and nothing for a name holding `#`, ending in ` (agent)`, or needing quotes while holding one.

import { atMention, type MentionRules } from '../kit/mention.ts'

const AGENT_SUFFIX = ' (agent)'
const LINES_MARK = '#'

export const MENTION_RULES: MentionRules = {
  bare: (p) => !/\s/u.test(p) && /[A-Za-z0-9_]$/.test(p) && !p.startsWith('"'),
  never: (p) => p.includes(LINES_MARK) || p.endsWith(AGENT_SUFFIX),
}

export function fileMention(path: string): string | null {
  return atMention(path, MENTION_RULES)
}
