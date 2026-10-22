// What core asks ptyhost to run. Shell tabs run `$SHELL -l` (an interactive login shell: the PTY is its
// terminal). Agent and dev-server PTYs exec their program directly or, "through login shell" (per agent setting,
// `agents.<id>.throughLoginShell`), as `$SHELL -l -i -c 'exec "$@"' kea <argv…>`: the argv reaches the program as the
// shell's positional parameters, so no user text is ever quoted into a script — the script is the constant below.

import { need, type SpawnSpec } from '@kea/protocol'
import { coreOs } from '../os/index.ts'
import type { Env } from './shellEnv.ts'

/** The whole script the login-shell wrapper runs. Constant: never built from argv, prompts or settings. */
export const LOGIN_SHELL_SCRIPT = 'exec "$@"'
/** `$0` of the wrapper shell, as error messages and `ps` show it. */
export const LOGIN_SHELL_ARG0 = 'kea'

/** The user's shell from the resolved environment, then Kea's own, then the system's default (`shellDefaults`). */
export function userShell(env: Readonly<Env>): string {
  return env.SHELL || process.env.SHELL || need(coreOs.shellDefaults).shell
}

/** A shell tab: `$SHELL -l`. */
export function shellTabArgv(shell: string): string[] {
  return [shell, '-l']
}

/** `$SHELL -l -i -c 'exec "$@"' kea <argv…>`: every element of `argv` is passed through untouched. */
export function loginShellArgv(shell: string, argv: readonly string[]): string[] {
  if (argv.length === 0 || !argv[0]) throw new Error('login-shell wrapper: empty argv')
  return [shell, '-l', '-i', '-c', LOGIN_SHELL_SCRIPT, LOGIN_SHELL_ARG0, ...argv]
}

/** Shells whose `-c` gives the arguments after the script to it as `$@` (the wrapper needs that). */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'ksh93', 'mksh', 'dash', 'yash'])

export function isPosixShell(shell: string): boolean {
  return POSIX_SHELLS.has(shell.slice(shell.lastIndexOf('/') + 1))
}

export interface Command {
  /** The program and its arguments, as an argv array (never a shell string). */
  argv: readonly string[]
  /** Run it through the user's login shell; the shell is `$SHELL` of `env`. */
  throughLoginShell?: boolean
}

/**
 * The SpawnSpec for `cmd` with the PTY's complete environment and working directory. With a shell that has no `$@`
 * (fish, nu, …) the program runs directly: `env` already is the login shell's environment.
 */
export function spawnSpec(cmd: Command, env: Env, cwd: string): SpawnSpec {
  const shell = userShell(env)
  const argv = cmd.throughLoginShell && isPosixShell(shell) ? loginShellArgv(shell, cmd.argv) : [...cmd.argv]
  const [file, ...args] = argv
  if (!file) throw new Error('spawn: empty argv')
  return { file, args, env, cwd }
}
