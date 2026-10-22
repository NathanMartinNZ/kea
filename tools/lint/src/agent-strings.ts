// U-AGT-11 · agent specificity: agent-specific CLI flags, env vars, payload field names and paths appear only
// in packages/adapters (and in fixtures/, tools/fake-agent, tools/mock-model and tests), never in app/ or
// native/kea-helper/src (non-test code).
//
// The list is the seed below plus every agent-specific-looking string literal in packages/adapters/src/*/contract.ts,
// where each adapter declares every flag, env var and payload field it uses.
//
// Kea's own database has columns named like three payload fields (`session_id`, `transcript_path`,
// `permission_mode`): those are allowed in .sql files and in SQL text inside string literals.
// Anything else can be allowed, with a reason, by `kea-lint-allow U-AGT-11` on the same or the previous line.
// Comments are not scanned (like READMEs, they document; e.g. generated limits.rs repeats each limit's `why`); in a
// .svelte component that includes HTML comments, and its markup text and attributes are scanned like code.
import { type Lexed, lexCss, lexJs, lexRust, lexSvelte } from './lexer.ts'
import type { Violation } from './types.ts'

export type AgentString = { text: string; kind: 'flag' | 'env' | 'env-prefix' | 'field' | 'path'; source: string }

export const SEED: AgentString[] = [
  ...['--session-id', '--permission-mode', '--settings', '--resume', '--mod', '--trust', '--effort'].map((text) => ({ text, kind: 'flag' as const, source: 'seed' })),
  { text: 'CLAUDECODE', kind: 'env', source: 'seed' },
  { text: 'CLAUDE_CODE_', kind: 'env-prefix', source: 'seed' },
  { text: 'ANTHROPIC_', kind: 'env-prefix', source: 'seed' },
  ...['hook_event_name', 'transcript_path', 'tool_input', 'tool_name', 'session_id', 'permission_mode', 'notification_type', 'last_assistant_message', 'agent_id', 'agent_type', 'prompt_id', 'session_title'].map(
    (text) => ({ text, kind: 'field' as const, source: 'seed' }),
  ),
  ...['~/.claude', '.claude/', '.commandcode', 'commandcode', 'claude/projects'].map((text) => ({ text, kind: 'path' as const, source: 'seed' })),
]

/** Payload fields that are also Kea's own column names: allowed in SQL. */
const SQL_COLUMNS = new Set(['session_id', 'transcript_path', 'permission_mode'])

/** Flags and env vars Kea itself uses (kea-helper's own CLI, the environment Kea gives a session, POSIX). */
const GENERIC_FLAGS = new Set(['--help', '--version', '--json', '--verbose', '--debug', '--cwd', '--dir', '--id', '--session', '--kind', '--home', '--project', '--cols', '--rows', '--sock'])
const GENERIC_ENV = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'PWD', 'NODE_ENV', 'NODE_OPTIONS', 'EDITOR', 'VISUAL', 'PORT'])

/** String literals of a contract.ts that look agent-specific: flags, env vars, snake_case fields, dot-paths. */
export function contractStrings(src: string, source: string): AgentString[] {
  const out: AgentString[] = []
  for (const s of lexJs(src).strings) {
    const t = s.value.trim()
    if (t.length < 4 || /\$\{/.test(t)) continue
    if (/^--[a-z][a-z0-9-]+$/.test(t)) {
      if (!GENERIC_FLAGS.has(t)) out.push({ text: t, kind: 'flag', source })
    } else if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(t) && t.length >= 6) {
      if (!GENERIC_ENV.has(t) && !t.startsWith('KEA_')) out.push({ text: t, kind: 'env', source })
    } else if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(t)) {
      out.push({ text: t, kind: 'field', source })
    } else if (/^(?:~\/|\.)[\w.-]+(?:\/[\w.*-]*)*$/.test(t) && /[a-z]/.test(t) && !/^\.\.?\//.test(t)) {
      out.push({ text: t, kind: 'path', source })
    }
  }
  return out
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

function matcher(a: AgentString): RegExp {
  const e = escape(a.text)
  switch (a.kind) {
    case 'flag':
      return new RegExp(`(?<![\\w-])${e}(?![\\w-])`, 'g')
    case 'env':
      return new RegExp(`(?<![\\w])${e}(?![\\w])`, 'g')
    case 'env-prefix':
      return new RegExp(`(?<![\\w])${e}\\w*`, 'g')
    case 'field':
      return new RegExp(`(?<![\\w])${e}(?![\\w])`, 'g')
    case 'path':
      return new RegExp(`(?<![\\w])${e}${/[\w]$/.test(a.text) ? '(?![\\w-])' : ''}`, 'g')
  }
}

const SQL_RE = /\b(?:CREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX|VIEW|TRIGGER)|SELECT|INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REFERENCES|WHERE|ALTER\s+TABLE)\b/

/** Is this path scanned by the agent-strings rule? (app/ and native/kea-helper/src, non-test code, not docs) */
export function isAgentScanned(path: string): boolean {
  if (!(path.startsWith('app/') || path.startsWith('native/kea-helper/src/'))) return false
  if (/(?:^|\/)(?:node_modules|dist|out|tests|__tests__|test-results)\//.test(path)) return false
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return false
  if (/\.(?:md|png|jpg|jpeg|gif|icns|ico|svg|woff2?|ttf|lock)$/i.test(path)) return false
  return true
}

export function checkAgentStrings(path: string, src: string, list: AgentString[]): Violation[] {
  let text = src
  // Rust unit tests live in `#[cfg(test)]` modules at the end of a file: not scanned
  if (path.endsWith('.rs')) {
    const t = text.search(/^\s*#\[cfg\(test\)\]/m)
    if (t >= 0) text = text.slice(0, t)
  }
  const isJs = /\.[cm]?[jt]sx?$/.test(path)
  // a Svelte component: markup text and attributes too, with HTML, JS and CSS comments blanked
  const svelte = (t: string): Lexed => {
    const sv = lexSvelte(t)
    return { code: sv.code, strings: sv.js.strings }
  }
  const lexed = isJs ? lexJs(text) : path.endsWith('.svelte') ? svelte(text) : path.endsWith('.rs') ? lexRust(text) : path.endsWith('.css') ? lexCss(text) : null
  const strings = lexed?.strings ?? []
  const lines = src.split('\n')
  if (lexed) text = lexed.code
  const lineStarts: number[] = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1)
  const lineOf = (o: number) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= o) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const allowed = (line: number) => /kea-lint-allow\s+U-AGT-11/.test(lines[line - 1] ?? '') || /kea-lint-allow\s+U-AGT-11/.test(lines[line - 2] ?? '')
  const found = new Map<number, Set<string>>()
  for (const a of list) {
    for (const m of text.matchAll(matcher(a))) {
      const line = lineOf(m.index)
      if (allowed(line)) continue
      if (a.kind === 'field' && SQL_COLUMNS.has(a.text)) {
        if (path.endsWith('.sql')) continue
        const s = strings.find((x) => m.index >= x.start && m.index < x.end)
        if (s && SQL_RE.test(s.value)) continue
      }
      const set = found.get(line) ?? new Set<string>()
      set.add(m[0])
      found.set(line, set)
    }
  }
  return [...found.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, set]) => ({
      file: path,
      line,
      rule: 'agent-strings',
      message: `agent-specific ${[...set].map((s) => `"${s}"`).join(', ')} outside packages/adapters (move it there, or mark the line \`// kea-lint-allow U-AGT-11: <reason>\`)`,
    }))
}
