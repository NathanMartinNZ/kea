// POSIX single-word quoting for the one shell string an adapter builds when a CLI runs its status line through a shell
// (`sh -c`). Every word is single-quoted with each `'` written `'\''`, and `shellWords` parses back only a command built
// that way so a user's own command is never mistaken for Kea's.

/** One word for a POSIX shell: single-quoted, each `'` written `'\''`; nothing inside single quotes is interpreted. */
export function shellWord(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/**
 * The words of a command `shellWord` built and joined with single spaces, or null for any other text: a status line
 * Kea did not make is never read as one of its own.
 */
export function shellWords(command: string): string[] | null {
  const out: string[] = []
  let i = 0
  while (i < command.length) {
    if (out.length > 0) {
      if (command[i] !== ' ') return null
      i++
    }
    if (command[i] !== "'") return null
    let word = ''
    for (;;) {
      const end = command.indexOf("'", i + 1)
      if (end < 0) return null
      word += command.slice(i + 1, end)
      i = end + 1
      // `'\''`: a quote inside the word, then the quoting goes on
      if (!command.startsWith(`\\''`, i)) break
      word += "'"
      i += 2
    }
    out.push(word)
  }
  return out.length > 0 ? out : null
}
