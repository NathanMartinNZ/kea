// A file mention at an agent's prompt: `@path`, which the agent reads as "this file". Each agent
// parses its prompt its own way, so each adapter says when the bare form reads back as exactly the path; where it does
// not (a space in the name is the common case: `@src/my file.ts` would name `src/my`), the quoted form `@"path"` is
// typed, which both shipped agents read. A path neither form carries is not mentioned at all: the caller types
// nothing and says why (a name is data from disk).

import { hasControlCharacter } from '@kea/protocol'

export interface MentionRules {
  /** Does `@path`, followed by a space, read back as exactly `path`? */
  bare(path: string): boolean
  /** A path this agent reads as something else even quoted (none by default). */
  never?(path: string): boolean
}

/** What ends or splits a bare mention for any agent: whitespace, a quote, or another `@`. */
const GENERIC: MentionRules = { bare: (p) => !/[\s"@]/u.test(p) }

/**
 * `@path` or `@"path"` for `path` (relative to the session's working directory), without a trailing space; null when
 * the agent has no form that reads back as that path: a control character (it would act at the prompt), a `"` in a
 * path that needs quotes, or a path the agent reads otherwise.
 */
export function atMention(path: string, rules: MentionRules = GENERIC): string | null {
  if (path === '' || hasControlCharacter(path) || rules.never?.(path)) return null
  if (rules.bare(path)) return `@${path}`
  return path.includes('"') ? null : `@"${path}"`
}
