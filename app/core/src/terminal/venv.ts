// The session's Python virtual env: the folder new terminals of a session activate, and the variables a program gets
// when no startup file of Kea's runs before it (shellInit.ts activates it in zsh, bash and fish).

import fs from 'node:fs'
import path from 'node:path'
import { git } from '@kea/kit'
import { DEFAULT_PYTHON_ENV_FOLDER, L, type ProjectSettings } from '@kea/protocol'
import type { Env } from './shellEnv.ts'

export interface Venv {
  /** The virtual env's folder, absolute. */
  dir: string
  /** The name its prompt shows: `pyvenv.cfg`'s `prompt`, else the folder's name, in safe characters only. */
  prompt: string
}

/** Whether git tracks any file under `rel` in `cwd`; null when git cannot answer. */
export type TrackedCheck = (cwd: string, rel: string) => Promise<boolean | null>

/**
 * The virtual env a new terminal in `cwd` (a session's working directory) activates, or null. A folder named in the
 * project's settings is used as given. The default folder must also be untracked: a repository that ships one would
 * otherwise put its own `python` in front of every command typed in the session.
 */
export async function findVenv(cwd: string, settings: Pick<ProjectSettings, 'activatePythonEnv' | 'pythonEnvFolder'>, tracked: TrackedCheck = gitTracked): Promise<Venv | null> {
  if (settings.activatePythonEnv === false) return null
  const configured = settings.pythonEnvFolder?.trim()
  const dir = path.resolve(cwd, configured || DEFAULT_PYTHON_ENV_FOLDER)
  if (!isVenv(dir)) return null
  if (!configured && (await tracked(cwd, DEFAULT_PYTHON_ENV_FOLDER)) !== false) return null
  return { dir, prompt: venvPrompt(dir) }
}

/** A virtual env's layout: `pyvenv.cfg` is a file and `bin/python` exists (a link counts, wherever it points). */
export function isVenv(dir: string): boolean {
  try {
    if (!fs.statSync(path.join(dir, 'pyvenv.cfg')).isFile()) return false
    fs.lstatSync(path.join(dir, 'bin', 'python'))
    return true
  } catch {
    return false
  }
}

/** The name the prompt shows for the virtual env in `dir`, as its own `bin/activate` would choose it. */
export function venvPrompt(dir: string): string {
  return safePrompt(configPrompt(readHead(path.join(dir, 'pyvenv.cfg'), L.venvConfigMaxBytes)) ?? '') || safePrompt(path.basename(dir)) || 'venv'
}

/** The `prompt` value of a `pyvenv.cfg`'s text, without the quotes Python's `venv --prompt` writes; null when none. */
export function configPrompt(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*prompt\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const v = m[1] ?? ''
    return v.length >= 2 && (v[0] === "'" || v[0] === '"') && v.at(-1) === v[0] ? v.slice(1, -1) : v
  }
  return null
}

/**
 * Letters, digits, space and `._+@-`; anything else becomes `_`. The name goes into the shell's prompt, where zsh reads
 * `%` escapes and, with PROMPT_SUBST, `$(…)`.
 */
export function safePrompt(name: string): string {
  return name.replace(/[^\p{L}\p{N} ._+@-]/gu, '_').trim()
}

/**
 * What `bin/activate` exports, for a program no startup file of Kea's runs before: `VIRTUAL_ENV`,
 * `VIRTUAL_ENV_PROMPT`, and `PATH` with the env's `bin` first and no other copy of it. The caller removes `PYTHONHOME`.
 */
export function venvVariables(v: Venv, pathVar: string | undefined): Env {
  const bin = path.join(v.dir, 'bin')
  const rest = pathVar ? pathVar.split(':').filter((e) => e !== bin) : []
  return { VIRTUAL_ENV: v.dir, VIRTUAL_ENV_PROMPT: v.prompt, PATH: [bin, ...rest].join(':') }
}

/** `git ls-files -- <rel>` in `cwd` lists anything: its output is only looked at, never kept. */
export const gitTracked: TrackedCheck = async (cwd, rel) => {
  let any = false
  const r = await git(['ls-files', '-z', '--', rel], {
    cwd,
    readOnly: true,
    onStdout: (chunk) => {
      if (chunk.length > 0) any = true
    },
  }).catch(() => null)
  return r && r.code === 0 ? any : null
}

function readHead(file: string, max: number): string {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(max)
    const n = fs.readSync(fd, buf, 0, max, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}
