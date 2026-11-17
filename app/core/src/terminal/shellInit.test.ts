// How zsh, bash and fish start with a session's virtual env, and Kea's startup files on disk. The real shells running
// these files are tested in tests/integration/core-venv-shell.test.ts.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureShellInit, FISH_INIT_COMMAND, SHELL_INIT_FILES, venvShellStart, writeShellInit } from './shellInit.ts'
import { loginScriptCommand, shellTabCommand, spawnSpec } from './spawn.ts'

const venv = { dir: '/w/.venv', prompt: 'demo' }
const dir = '/k/shell'
const base = { PATH: '/usr/bin:/bin', HOME: '/h', PYTHONHOME: '/py' }

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-shinit-')))
  made.push(d)
  return d
}

describe('starting a shell with the session virtual env', () => {
  it('U-PTY-79 · zsh: the shell tab and a login script keep their argv and get Kea\'s ZDOTDIR, the user\'s in KEA_ZDOTDIR only when they had one', () => {
    const tab = venvShellStart({ kind: 'tab', shell: '/bin/zsh' }, venv, { ...base, ZDOTDIR: '/h/.config/zsh' }, dir)
    expect(tab).toEqual({ argv: ['/bin/zsh', '-l'], env: { ...base, ZDOTDIR: '/k/shell/zsh', KEA_ZDOTDIR: '/h/.config/zsh', KEA_VENV: '/w/.venv', KEA_VENV_PROMPT: 'demo' } })
    const script = venvShellStart({ kind: 'script', shell: '/opt/homebrew/bin/zsh', script: 'pnpm dev' }, venv, base, dir)
    expect(script).toEqual({ argv: ['/opt/homebrew/bin/zsh', '-l', '-c', 'pnpm dev'], env: { ...base, ZDOTDIR: '/k/shell/zsh', KEA_VENV: '/w/.venv', KEA_VENV_PROMPT: 'demo' } })
    expect(script.env.PYTHONHOME, 'the startup files save it for deactivate').toBe('/py')
  })

  it('U-PTY-79 · bash: a tab runs --init-file (a login shell ignores it); a login script gets BASH_ENV, the user\'s in KEA_BASH_ENV', () => {
    expect(venvShellStart({ kind: 'tab', shell: '/bin/bash' }, venv, base, dir)).toEqual({ argv: ['/bin/bash', '--init-file', '/k/shell/bash/kea.bash'], env: { ...base, KEA_VENV: '/w/.venv', KEA_VENV_PROMPT: 'demo' } })
    expect(venvShellStart({ kind: 'script', shell: '/bin/bash', script: 'x' }, venv, { ...base, BASH_ENV: '/h/.bashenv' }, dir)).toEqual({
      argv: ['/bin/bash', '-l', '-c', 'x'],
      env: { ...base, BASH_ENV: '/k/shell/bash/env.bash', KEA_BASH_ENV: '/h/.bashenv', KEA_VENV: '/w/.venv', KEA_VENV_PROMPT: 'demo' },
    })
    expect(venvShellStart({ kind: 'script', shell: '/bin/bash', script: 'x' }, venv, base, dir).env).not.toHaveProperty('KEA_BASH_ENV')
  })

  it('U-PTY-79 · fish: a constant --init-command, the file\'s path in KEA_SHELL_INIT, before any -c', () => {
    const env = { ...base, KEA_VENV: '/w/.venv', KEA_VENV_PROMPT: 'demo', KEA_SHELL_INIT: '/k/shell/fish/kea.fish' }
    expect(venvShellStart({ kind: 'tab', shell: '/opt/homebrew/bin/fish' }, venv, base, dir)).toEqual({ argv: ['/opt/homebrew/bin/fish', '-l', '--init-command', FISH_INIT_COMMAND], env })
    expect(venvShellStart({ kind: 'script', shell: '/some/bin/fish', script: 'x' }, venv, base, dir)).toEqual({ argv: ['/some/bin/fish', '-l', '--init-command', FISH_INIT_COMMAND, '-c', 'x'], env })
  })

  it('U-PTY-79 · any other shell, or no startup files, gets the env\'s variables in place of PYTHONHOME', () => {
    const vars = { PATH: '/w/.venv/bin:/usr/bin:/bin', HOME: '/h', VIRTUAL_ENV: '/w/.venv', VIRTUAL_ENV_PROMPT: 'demo' }
    for (const shell of ['/usr/local/bin/nu', '/bin/sh', '/bin/ksh', '/bin/tcsh']) {
      expect(venvShellStart({ kind: 'tab', shell }, venv, base, dir), shell).toEqual({ argv: [shell, '-l'], env: vars })
    }
    expect(venvShellStart({ kind: 'tab', shell: '/bin/zsh' }, venv, base, null)).toEqual({ argv: ['/bin/zsh', '-l'], env: vars })
    expect(venvShellStart({ kind: 'script', shell: '/bin/bash', script: 'x' }, venv, base, null)).toEqual({ argv: ['/bin/bash', '-l', '-c', 'x'], env: vars })
  })

  it('U-PTY-79 · spawnSpec: without a virtual env every command is as before; with one, a marked shell goes through the files and a program gets the variables', () => {
    const env = { ...base, SHELL: '/bin/zsh' }
    expect(spawnSpec(shellTabCommand('/bin/zsh'), env, '/w')).toEqual({ file: '/bin/zsh', args: ['-l'], env, cwd: '/w' })
    expect(spawnSpec(loginScriptCommand('/bin/bash', 'pnpm dev'), env, '/w')).toEqual({ file: '/bin/bash', args: ['-l', '-c', 'pnpm dev'], env, cwd: '/w' })
    expect(spawnSpec(shellTabCommand('/bin/bash'), env, '/w', { venv, initDir: dir })).toMatchObject({ file: '/bin/bash', args: ['--init-file', '/k/shell/bash/kea.bash'] })
    const program = spawnSpec({ argv: ['./start.sh'] }, env, '/w', { venv, initDir: dir })
    expect(program).toEqual({ file: './start.sh', args: [], env: { PATH: '/w/.venv/bin:/usr/bin:/bin', HOME: '/h', SHELL: '/bin/zsh', VIRTUAL_ENV: '/w/.venv', VIRTUAL_ENV_PROMPT: 'demo' }, cwd: '/w' })
    expect(env.PATH, 'the caller\'s environment is not changed').toBe('/usr/bin:/bin')
  })
})

describe('Kea\'s shell startup files', () => {
  it('U-PTY-80 · written with private modes; an unchanged file is left alone, a changed or missing one written again', () => {
    const d = path.join(tmp(), 'shell')
    writeShellInit(d)
    for (const [rel, text] of Object.entries(SHELL_INIT_FILES)) {
      const f = path.join(d, rel)
      expect(fs.readFileSync(f, 'utf8'), rel).toBe(text)
      expect(fs.statSync(f).mode & 0o777, rel).toBe(0o600)
      expect(fs.statSync(path.dirname(f)).mode & 0o777, rel).toBe(0o700)
    }
    const kept = path.join(d, 'zsh', '.zshrc')
    const ino = fs.statSync(kept).ino
    fs.writeFileSync(path.join(d, 'activate.sh'), 'stale')
    writeShellInit(d)
    expect(fs.statSync(kept).ino, 'unchanged: not replaced').toBe(ino)
    expect(fs.readFileSync(path.join(d, 'activate.sh'), 'utf8')).toBe(SHELL_INIT_FILES['activate.sh'])
    fs.rmSync(path.join(d, 'fish'), { recursive: true })
    expect(ensureShellInit(d)).toBe(true)
    expect(fs.existsSync(path.join(d, 'fish', 'kea.fish'))).toBe(true)
  })

  it('U-PTY-80 · when they cannot be written, ensureShellInit says so', () => {
    const blocker = path.join(tmp(), 'shell')
    fs.writeFileSync(blocker, 'a file where the folder should be')
    expect(ensureShellInit(blocker)).toBe(false)
  })

  it('U-PTY-80 · each file parses in its own shell (fish where installed)', () => {
    const d = path.join(tmp(), 'shell')
    writeShellInit(d)
    const check = (shell: string, rel: string) => {
      const r = spawnSync(shell, ['-n', path.join(d, rel)], { encoding: 'utf8' })
      expect(r.status, `${shell} -n ${rel}: ${r.stderr}`).toBe(0)
    }
    check('/bin/sh', 'activate.sh')
    for (const rel of ['activate.sh', 'bash/kea.bash', 'bash/env.bash']) check('/bin/bash', rel)
    if (fs.existsSync('/bin/zsh')) for (const rel of ['activate.sh', 'zsh/.zshenv', 'zsh/.zprofile', 'zsh/.zshrc', 'zsh/.zlogin', 'zsh/finish.zsh']) check('/bin/zsh', rel)
    const fish = spawnSync('fish', ['--version'])
    if (fish.status === 0) check('fish', 'fish/kea.fish')
  })
})
