import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { shellWord, shellWords } from './shell.ts'

describe('adapters/kit POSIX shell word quoting', () => {
  it('U-AGT-53 · shellWord and shellWords round-trip arbitrary words, paths with spaces, quotes and shell metacharacters without interpretation', () => {
    expect(shellWord('')).toBe("''")
    expect(shellWord('plain')).toBe("'plain'")
    expect(shellWord("it's")).toBe(`'it'\\''s'`)
    expect(shellWord("'leading")).toBe(`''\\''leading'`)
    expect(shellWord("trailing'")).toBe(`'trailing'\\'''`)
    expect(shellWord("''")).toBe(`''\\'''\\'''`)
    expect(shellWord('a b$c;`d`\ne')).toBe("'a b$c;`d`\ne'")

    const words = [
      '/tmp/kea home/bin/kea-helper',
      'feed',
      '--session',
      '01JXKEASESSION0000000000AA',
      '--home',
      "/tmp/odd dir 'q' $HOME $(id) `uname` ;x |y &z \"dq\" \\b\nline\tend",
      '',
      "'",
      "''",
      '{"keep":["a.b"],"critical":[{"field":"x","values":["y"]}]}',
    ]
    const command = words.map(shellWord).join(' ')
    expect(shellWords(command)).toEqual(words)

    // `/bin/sh -c` delivers the exact words to argv without variable, command, glob or newline expansion
    const script = `${shellWord(process.execPath)} ${shellWord('-e')} ${shellWord('process.stdout.write(JSON.stringify(process.argv.slice(1)))')} ${command}`
    const got = JSON.parse(execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' })) as string[]
    expect(got).toEqual(words)
  })

  it('U-AGT-53 · shellWords rejects any command not built by joining shellWord tokens with single spaces', () => {
    const rejected = [
      '',
      ' ',
      'plain',
      'a b',
      `'a'b`,
      `a'b'`,
      `'a`,
      `'a'  'b'`,
      ` 'a'`,
      `'a' `,
      `"a"`,
      `'a' "b"`,
      `'a'\\''`,
      `'a'\\'b'`,
      `'a'\n'b'`,
      `'a'\t'b'`,
    ]
    for (const input of rejected) {
      expect(shellWords(input), JSON.stringify(input)).toBeNull()
    }
  })
})
