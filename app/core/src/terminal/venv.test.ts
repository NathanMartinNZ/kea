// The session's virtual env: which folder a new terminal activates, its prompt name, and the variables a program gets.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setGitBinary } from '@kea/kit'
import { L } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configPrompt, findVenv, gitTracked, isVenv, safePrompt, venvPrompt, venvVariables } from './venv.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** A session folder holding a virtual env's layout at `rel` (pyvenv.cfg with `cfg`, a dangling bin/python link). */
function sessionDir(rel = '.venv', cfg = 'home = /nowhere\n'): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-venv-')))
  made.push(d)
  const v = path.resolve(d, rel)
  fs.mkdirSync(path.join(v, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(v, 'pyvenv.cfg'), cfg)
  fs.symlinkSync('/nowhere/python3', path.join(v, 'bin', 'python'))
  return d
}

const untracked = async () => false

describe('the session virtual env', () => {
  it('U-PTY-77 · the default .venv is found when it has pyvenv.cfg and bin/python (a dangling link counts) and git tracks nothing in it', async () => {
    const d = sessionDir()
    const tracked = vi.fn(untracked)
    expect(await findVenv(d, {}, tracked)).toEqual({ dir: path.join(d, '.venv'), prompt: '.venv' })
    expect(tracked).toHaveBeenCalledWith(d, '.venv')
    expect(await findVenv(d, { activatePythonEnv: true }, untracked)).not.toBeNull()
    expect(await findVenv(d, { activatePythonEnv: false }, untracked), 'the setting turned off').toBeNull()
    expect(await findVenv(d, {}, async () => true), 'a .venv the repository tracks is never activated').toBeNull()
    expect(await findVenv(d, {}, async () => null), 'nor one git cannot answer for').toBeNull()
  })

  it('U-PTY-77 · a folder without pyvenv.cfg as a file, or without bin/python, is not a virtual env', async () => {
    const d = sessionDir()
    fs.rmSync(path.join(d, '.venv', 'bin', 'python'))
    expect(isVenv(path.join(d, '.venv'))).toBe(false)
    expect(await findVenv(d, {}, untracked)).toBeNull()
    const e = sessionDir()
    fs.rmSync(path.join(e, '.venv', 'pyvenv.cfg'))
    fs.mkdirSync(path.join(e, '.venv', 'pyvenv.cfg'))
    expect(await findVenv(e, {}, untracked)).toBeNull()
    expect(await findVenv(fs.realpathSync(os.tmpdir()), {}, untracked), 'no folder at all').toBeNull()
  })

  it('U-PTY-77 · a folder named in the settings is used as given, relative to the session folder or absolute, without asking git', async () => {
    const d = sessionDir('envs/py')
    const tracked = vi.fn(async () => true)
    expect(await findVenv(d, { pythonEnvFolder: ' envs/py ' }, tracked)).toEqual({ dir: path.join(d, 'envs', 'py'), prompt: 'py' })
    expect(await findVenv('/elsewhere', { pythonEnvFolder: path.join(d, 'envs', 'py') }, tracked)).toEqual({ dir: path.join(d, 'envs', 'py'), prompt: 'py' })
    expect(tracked).not.toHaveBeenCalled()
    expect(await findVenv(d, { pythonEnvFolder: 'envs/py', activatePythonEnv: false }, tracked)).toBeNull()
    expect(await findVenv(d, {}, untracked), 'the default .venv is not there').toBeNull()
  })

  it('U-PTY-77 · git is asked in the session folder: tracked files under .venv, none, or no repository', async () => {
    setGitBinary('git')
    const d = sessionDir()
    const run = (...args: string[]) => {
      const r = spawnGit(d, args)
      expect(r, args.join(' ')).toBe(0)
    }
    expect(await gitTracked(d, '.venv'), 'not a repository').toBeNull()
    run('init', '-q')
    expect(await gitTracked(d, '.venv')).toBe(false)
    run('add', '.venv/pyvenv.cfg')
    expect(await gitTracked(d, '.venv')).toBe(true)
    expect(await findVenv(d, {})).toBeNull()
    run('rm', '-q', '--cached', '.venv/pyvenv.cfg')
    expect(await findVenv(d, {})).toEqual({ dir: path.join(d, '.venv'), prompt: '.venv' })
  })

  it('U-PTY-78 · the prompt name is pyvenv.cfg\'s prompt (quoted or not), else the folder\'s name, in safe characters only', () => {
    expect(configPrompt("home = /x\nprompt = 'my-app'\n")).toBe('my-app')
    expect(configPrompt('prompt="two words"')).toBe('two words')
    expect(configPrompt('  prompt =  plain  \r\nversion = 3.12\r\n')).toBe('plain')
    expect(configPrompt('home = /x\n')).toBeNull()
    expect(safePrompt('$(id)%n`x`;ü')).toBe('__id__n_x__ü')
    expect(venvPrompt(path.join(sessionDir('.venv', "prompt = 'demo'\n"), '.venv'))).toBe('demo')
    expect(venvPrompt(path.join(sessionDir('.venv', "prompt = '%#'\n"), '.venv')), 'nothing but unsafe characters').toBe('__')
    expect(venvPrompt(path.join(sessionDir('.venv', "prompt = ''\n"), '.venv')), 'an empty prompt').toBe('.venv')
    const far = `${'#'.repeat(L.venvConfigMaxBytes)}\nprompt = late\n`
    expect(venvPrompt(path.join(sessionDir('.venv', far), '.venv')), 'a prompt past the read cap is not seen').toBe('.venv')
  })

  it('U-PTY-78 · a program gets VIRTUAL_ENV, VIRTUAL_ENV_PROMPT and the env\'s bin first on PATH, with no other copy of it', () => {
    const v = { dir: '/w/.venv', prompt: 'demo' }
    expect(venvVariables(v, '/usr/bin:/w/.venv/bin:/bin')).toEqual({ VIRTUAL_ENV: '/w/.venv', VIRTUAL_ENV_PROMPT: 'demo', PATH: '/w/.venv/bin:/usr/bin:/bin' })
    expect(venvVariables(v, undefined).PATH).toBe('/w/.venv/bin')
    expect(venvVariables(v, '').PATH).toBe('/w/.venv/bin')
    expect(venvVariables(v, '/a::/b').PATH, 'an empty entry (the current folder) is kept').toBe('/w/.venv/bin:/a::/b')
  })
})

function spawnGit(cwd: string, args: string[]): number | null {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  return spawnSync('git', args, { cwd, env, stdio: 'ignore' }).status
}
