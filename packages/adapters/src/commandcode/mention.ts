// Command Code's file mention, as 1.79.2 reads the paths a prompt mentions (its own pattern, read
// in the installed bundle: `@"…"` with anything but `"` inside, or `@` and a run of characters that are neither
// whitespace nor `@`). So the bare form is typed for a path with no whitespace and no `@` that does not begin with a
// quote, the quoted one for the rest, and nothing for a path that needs quotes and holds one.

import { atMention, type MentionRules } from '../kit/mention.ts'

export const MENTION_RULES: MentionRules = { bare: (p) => !/[\s@]/u.test(p) && !p.startsWith('"') }

export function fileMention(path: string): string | null {
  return atMention(path, MENTION_RULES)
}
