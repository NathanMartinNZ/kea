// Session slugs and branch names. A slug names the worktree directory and the branch, and never changes
// after creation: from the prompt, lowercase, stop-words dropped, the first L.slugMaxWords words in kebab-case, at most
// L.slugMaxChars characters of `[a-z0-9-]`; an empty prompt gets two random words (`amber-fjord`). A slug taken
// by a session of the project (deleted ones keep theirs until purged), an existing branch or an existing directory gets
// `-2`, `-3`, ….

import { L } from '@kea/protocol'

/** Words that carry no meaning in a slug. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'a an the and or but nor so yet of to in on at by for with from into onto upon about over under up down out off as ' +
    'is are was were be been being am do does did done have has had having can could should would will shall may might must ' +
    'i me my we us our you your he him his she her it its they them their this that these those there here ' +
    'please pls just also then than too very some any all each every no not only own same such what which who whom whose ' +
    'when where why how let lets let\'s make sure ok okay hey hi'
  ).split(/\s+/),
)

const ADJECTIVES = [
  'amber', 'azure', 'bold', 'brisk', 'calm', 'cedar', 'clear', 'coral', 'crisp', 'dawn', 'deft', 'dusky', 'eager', 'fern', 'fleet',
  'gentle', 'golden', 'hazel', 'ivory', 'jade', 'keen', 'lunar', 'maple', 'misty', 'noble', 'ochre', 'pale', 'quiet', 'rapid', 'rustic',
  'sable', 'silver', 'solar', 'swift', 'tawny', 'teal', 'umber', 'vivid', 'warm', 'young',
] as const
const NOUNS = [
  'alder', 'basin', 'brook', 'canyon', 'cliff', 'cove', 'delta', 'dune', 'falcon', 'fjord', 'forest', 'glade', 'grove', 'harbor', 'heron',
  'island', 'kestrel', 'lagoon', 'ledge', 'marsh', 'meadow', 'mesa', 'otter', 'peak', 'pine', 'prairie', 'quarry', 'reef', 'ridge', 'river',
  'shore', 'sparrow', 'spring', 'summit', 'tide', 'tundra', 'valley', 'willow', 'wren', 'zephyr',
] as const

/** A slug is only these characters. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Cut `s` (kebab-case) to at most `max` characters, at a word boundary when one exists. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const at = head.lastIndexOf('-')
  return (at > 0 ? head.slice(0, at) : head).replace(/-+$/, '')
}

/** The prompt's slug, or '' when nothing usable is left (then use `randomSlug`). */
export function slugFromPrompt(prompt: string): string {
  const words = prompt
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // diacritics: café → cafe
    .toLowerCase()
    .replace(/'/g, '') // don't → dont
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .slice(0, L.slugMaxWords)
  return cut(words.join('-'), L.slugMaxChars)
}

/** Two random words (`amber-fjord`) for an empty prompt; `rng` returns [0, 1) (seeded in tests). */
export function randomSlug(rng: () => number = Math.random): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))]!
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`
}

/**
 * The first of `base`, `base-2`, `base-3`, … that `taken` refuses, each within `max` characters (L.slugMaxChars, or
 * less when the worktree path has less room).
 */
export async function uniqueSlug(base: string, taken: (slug: string) => boolean | Promise<boolean>, max: number = L.slugMaxChars): Promise<string> {
  const limit = Math.min(max, L.slugMaxChars)
  const b = cut(base, limit) || cut('session', limit)
  if (!(await taken(b))) return b
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const s = `${cut(b, Math.max(1, limit - suffix.length))}${suffix}`
    if (!(await taken(s))) return s
  }
}

/** A project's directory name under the worktree root: its folder name as a slug. */
export function projectSlug(rootPath: string): string {
  const name = rootPath.split('/').filter(Boolean).pop() ?? ''
  const s = cut(
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, ''),
    L.slugMaxChars,
  )
  return s || 'project'
}

/** The branch of a new session: `<prefix><slug>`. */
export function branchFor(prefix: string, slug: string): string {
  return `${prefix}${slug}`
}
