// Gitignore pattern semantics (gitignore(5)), for `.worktreeinclude` and a project's "Files to copy": blank
// lines and `#` comments skipped; `!` negates; a trailing `/` matches directories only; a pattern with a slash at its
// start or in its middle is anchored at the root, any other matches at any depth; `*` and `?` never cross a `/`;
// `[…]` classes; a leading `**/`, a trailing `/**` and an inner `/**/` span any number of directories. The last
// matching pattern wins, and a path inside a matched directory matches (it cannot be re-included, as in git).

export interface IgnoreRule {
  re: RegExp
  negate: boolean
  dirOnly: boolean
  /** The pattern as written (minus negation), for "does a pattern name node_modules" checks. */
  source: string
}

function globToRegex(glob: string): string {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0
        const slashAfter = glob[i + 2] === '/'
        const atEnd = i + 2 === glob.length
        const slashBefore = i > 0 && glob[i - 1] === '/'
        if (atStart && slashAfter) {
          re += '(?:.*/)?'
          i += 2
          continue
        }
        if (slashBefore && atEnd) {
          re += '.*'
          i += 1
          continue
        }
        if (slashBefore && slashAfter) {
          re += '(?:.*/)?'
          i += 2
          continue
        }
        // any other `**` is two `*`s
        re += '[^/]*'
        i += 1
        continue
      }
      re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2)
      if (end < 0) {
        re += '\\['
        continue
      }
      let body = glob.slice(i + 1, end)
      if (body.startsWith('!')) body = `^${body.slice(1)}`
      re += `[${body.replace(/\\/g, '\\\\')}]`
      i = end
    } else if (c === '\\' && i + 1 < glob.length) {
      re += glob[i + 1]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      i++
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  return re
}

/** One line of a gitignore-style file → a rule, or null for blanks and comments. */
export function compileRule(line: string): IgnoreRule | null {
  let p = line.replace(/(?<!\\)\s+$/, '')
  if (!p || p.startsWith('#')) return null
  let negate = false
  if (p.startsWith('!')) {
    negate = true
    p = p.slice(1)
  } else if (p.startsWith('\\!') || p.startsWith('\\#')) p = p.slice(1)
  const dirOnly = p.endsWith('/')
  if (dirOnly) p = p.replace(/\/+$/, '')
  if (!p) return null
  const anchored = p.includes('/')
  if (p.startsWith('/')) p = p.slice(1)
  const body = globToRegex(p)
  return { re: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}$`), negate, dirOnly, source: p }
}

export function compileRules(lines: readonly string[]): IgnoreRule[] {
  return lines.map(compileRule).filter((r): r is IgnoreRule => r !== null)
}

function matchOne(rules: readonly IgnoreRule[], p: string, isDir: boolean): boolean {
  let hit = false
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue
    if (r.re.test(p)) hit = !r.negate
  }
  return hit
}

/** Whether `rel` (relative to the root, `/`-separated, no leading slash) matches `rules`. */
export function matches(rules: readonly IgnoreRule[], rel: string, isDir: boolean): boolean {
  const parts = rel.split('/').filter(Boolean)
  for (let i = 1; i < parts.length; i++) if (matchOne(rules, parts.slice(0, i).join('/'), true)) return true
  return matchOne(rules, parts.join('/'), isDir)
}
