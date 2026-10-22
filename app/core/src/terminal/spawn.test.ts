import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isPosixShell, LOGIN_SHELL_ARG0, LOGIN_SHELL_SCRIPT, loginShellArgv, shellTabArgv, spawnSpec, userShell } from './spawn.ts'

describe('spawn specs', () => {
  it('U-PTY-40 · shell tabs run `$SHELL -l`; programs run directly unless asked to go through the login shell', () => {
    expect(shellTabArgv('/bin/zsh')).toEqual(['/bin/zsh', '-l'])
    const env = { SHELL: '/opt/homebrew/bin/zsh', PATH: '/usr/bin' }
    expect(spawnSpec({ argv: ['claude', '--resume', 'x'] }, env, '/w')).toEqual({ file: 'claude', args: ['--resume', 'x'], env, cwd: '/w' })
    expect(spawnSpec({ argv: ['claude', '--resume', 'x'], throughLoginShell: true }, env, '/w')).toEqual({
      file: '/opt/homebrew/bin/zsh',
      args: ['-l', '-i', '-c', 'exec "$@"', 'kea', 'claude', '--resume', 'x'],
      env,
      cwd: '/w',
    })
    expect(userShell({})).toBe(process.env.SHELL || '/bin/zsh')
    expect(() => spawnSpec({ argv: [] }, env, '/w')).toThrow(/empty argv/)
    expect(() => loginShellArgv('/bin/zsh', [''])).toThrow(/empty argv/)
  })

  it('U-PTY-40 · with a shell that has no `$@` (fish, nu) the program runs directly with the resolved login environment', () => {
    for (const shell of ['/opt/homebrew/bin/fish', '/usr/local/bin/nu']) {
      const env = { SHELL: shell, PATH: '/login/path' }
      expect(isPosixShell(shell)).toBe(false)
      expect(spawnSpec({ argv: ['claude', 'x'], throughLoginShell: true }, env, '/w')).toEqual({ file: 'claude', args: ['x'], env, cwd: '/w' })
    }
    for (const shell of ['/bin/zsh', '/bin/bash', '/bin/sh', '/opt/homebrew/bin/bash', '/bin/ksh', '/bin/dash']) expect(isPosixShell(shell), shell).toBe(true)
  })

  it('U-PTY-40 · the wrapper script is constant and every argv element passes through as a positional parameter, unquoted (property)', () => {
    const hostile = fc.oneof(fc.string({ unit: 'grapheme' }), fc.constantFrom('"; rm -rf ~ #', "' $(id) `id` ${HOME} \\", 'a\nb', '-c', '"$@"', '*', '~', ''))
    fc.assert(
      fc.property(fc.string({ minLength: 1, unit: 'grapheme' }), fc.array(hostile, { maxLength: 8 }), (prog, rest) => {
        const argv = [prog, ...rest]
        const out = loginShellArgv('/bin/zsh', argv)
        expect(out.slice(0, 6)).toEqual(['/bin/zsh', '-l', '-i', '-c', LOGIN_SHELL_SCRIPT, LOGIN_SHELL_ARG0])
        expect(out.slice(6)).toEqual(argv)
        expect(LOGIN_SHELL_SCRIPT).toBe('exec "$@"')
      }),
    )
  })
})
