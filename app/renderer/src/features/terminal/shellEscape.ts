// Paths as text at a shell prompt: what a path dropped on a terminal, or sent there by the finder's `⌥↵`, is
// typed as. The result is one shell word that `bash` and `zsh` read back as exactly the path, whatever it contains, and
// `sh` too unless the path holds a control character (dash, `/bin/sh` on Debian and Ubuntu, has no ANSI-C quotes).
// Pure.
//
//   plain characters      as they are (letters and digits of any script, `_ - . / : @ % + ,`)
//   anything else         a backslash before it, as Terminal.app types a dropped file: `my\ file\ \(1\).txt`
//   a control character   cannot be escaped with a backslash (a backslash and a newline is a line continuation), and
//                         must not reach the terminal raw at all (a CR would be Enter), so the whole path is
//                         written in ANSI-C quotes: `$'a\nb'`. C0 and DEL as `\xHH`; a C1 character (U+0080…U+009F)
//                         as the two bytes of its UTF-8 form, `\xc2\xHH`, which bash 3.2 reads too (it has no `\u`)
//   a leading `-`         `./` before it, so no program reads the path as an option

import { hasControlCharacter } from '@kea/protocol'

/** ASCII characters with no meaning to a shell anywhere in a word. */
const PLAIN = /[A-Za-z0-9_\-./:@%+,]/

const NAMED: Readonly<Record<string, string>> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\\': '\\\\', "'": "\\'" }

function ansiC(path: string): string {
  let out = "$'"
  for (const ch of path) {
    const code = ch.codePointAt(0) as number
    out += NAMED[ch] ?? (code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, '0')}` : code >= 0x80 && code <= 0x9f ? `\\xc2\\x${code.toString(16)}` : ch)
  }
  return `${out}'`
}

/** `path` as one shell word. An empty path is `''`. */
export function shellEscape(path: string): string {
  if (path === '') return "''"
  const p = path.startsWith('-') ? `./${path}` : path
  if (hasControlCharacter(p)) return ansiC(p)
  let out = ''
  for (const ch of p) out += ch.charCodeAt(0) > 0x7f || PLAIN.test(ch) ? ch : `\\${ch}`
  return out
}

/** Several paths as the text typed at the prompt: each one escaped and followed by a space, ready for the next word. */
export function pathsForShell(paths: readonly string[]): string {
  return paths.map((p) => `${shellEscape(p)} `).join('')
}
