// What core asks ptyhost to run. Shell tabs run `$SHELL -l` (an interactive login shell: the PTY is its
// terminal). Agent and dev-server PTYs exec their program directly or, "through login shell" (per agent setting,
// `agents.<id>.throughLoginShell`), as `$SHELL -l -i -c 'exec "$@"' kea <argv…>`: the argv reaches the program as the
// shell's positional parameters, so no user text is ever quoted into a script — the script is the constant below.
// A shell tab or a login shell running a script, in a session with a Python virtual env, starts through Kea's startup
// files (shellInit.ts); any other program of such a session gets the env's variables.

import { need, type SpawnSpec } from '@kea/protocol'
import { coreOs } from '../os/index.ts'
import type { Env } from './shellEnv.ts'
import { venvShellStart, type ShellRole } from './shellInit.ts'
import { venvVariables, type Venv } from './venv.ts'

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

/** A shell tab's command: `$SHELL -l`, marked so a virtual env can reach it through Kea's startup files. */
export function shellTabCommand(shell: string): Command {
  return { argv: shellTabArgv(shell), shell: { kind: 'tab', shell } }
}

/** `$SHELL -l -c <script>`: a command the user configured, marked like a shell tab's. */
export function loginScriptCommand(shell: string, script: string): Command {
  return { argv: [shell, '-l', '-c', script], shell: { kind: 'script', shell, script } }
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
  /** Set when `argv` is a shell tab or a login shell running a script (`shellTabCommand`, `loginScriptCommand`). */
  shell?: ShellRole
}

/** The virtual env a PTY starts with, and Kea's startup files (null when they could not be written). */
export interface VenvStart {
  venv: Venv
  initDir: string | null
}

/**
 * The SpawnSpec for `cmd` with the PTY's complete environment and working directory. With a shell that has no `$@`
 * (fish, nu, …) the program runs directly: `env` already is the login shell's environment.
 */
export function spawnSpec(cmd: Command, env: Env, cwd: string, venv: VenvStart | null = null): SpawnSpec {
  if (venv && cmd.shell) {
    const s = venvShellStart(cmd.shell, venv.venv, env, venv.initDir)
    const [file, ...args] = s.argv
    if (!file) throw new Error('spawn: empty argv')
    return { file, args, env: s.env, cwd }
  }
  if (venv) {
    env = { ...env, ...venvVariables(venv.venv, env.PATH) }
    delete env.PYTHONHOME
  }
  const shell = userShell(env)
  const argv = cmd.throughLoginShell && isPosixShell(shell) ? loginShellArgv(shell, cmd.argv) : [...cmd.argv]
  const [file, ...args] = argv
  if (!file) throw new Error('spawn: empty argv')
  return { file, args, env, cwd }
}
