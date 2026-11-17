// A session's virtual env in real shells started by core through ptyhost and the debug kea-helper: a throwaway HOME
// whose startup files put another python3 first, a fake virtual env in the worktree. The user's own shell
// configuration is never read.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { loginScriptCommand, shellTabCommand } from '@kea/core/src/terminal/spawn.ts'
import { ptyhostHarness, shortKeaHome, testEnv, until, type Harness } from '../support/holders.ts'
import { ownPtyIds, readStream, startCore } from './core-support.ts'

const ZSH = fs.existsSync('/bin/zsh') ? '/bin/zsh' : null
const BASH = '/bin/bash'
const FISH = ((): string | null => {
  const r = spawnSync('/bin/sh', ['-c', 'command -v fish'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() || null : null
})()

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function harness(): Promise<Harness> {
  const h = await ptyhostHarness()
  cleanup.push(async () => {
    for (const id of ownPtyIds(h.home)) h.spawned.add(id)
    await h.dispose()
  })
  return h
}

/** A HOME holding `files` and a `shims/python3` that is not the virtual env's; returns its path. */
function userHome(files: Record<string, string>): string {
  const d = shortKeaHome()
  cleanup.push(() => d.dispose())
  for (const [rel, text] of Object.entries({ ...files, 'shims/python3': '#!/bin/sh\necho shim\n' })) {
    fs.mkdirSync(path.dirname(path.join(d.home, rel)), { recursive: true })
    fs.writeFileSync(path.join(d.home, rel), text, { mode: 0o755 })
  }
  return d.home
}

/** A worktree in `h`'s home with a virtual env whose prompt is `demo`; returns the worktree and the env. */
function worktree(h: Harness): { cwd: string; venv: { dir: string; prompt: string } } {
  const cwd = path.join(h.home, 'worktree')
  const dir = path.join(cwd, '.venv')
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pyvenv.cfg'), "prompt = 'demo'\n")
  fs.writeFileSync(path.join(dir, 'bin', 'python3'), '#!/bin/sh\necho venv\n', { mode: 0o755 })
  fs.symlinkSync('python3', path.join(dir, 'bin', 'python'))
  return { cwd, venv: { dir, prompt: 'demo' } }
}

/** Opens `command` in a PTY of session S1 and returns a way to type into it and read what it printed. */
async function open(h: Harness, env: Record<string, string>, kind: 'shell' | 'server', command: ReturnType<typeof shellTabCommand>, w: ReturnType<typeof worktree>) {
  const c = startCore(h, { env: testEnv(env) })
  cleanup.push(() => c.dispose())
  await c.reconciled()
  const { ptyId } = await c.t.launch({ sessionId: 'S1', kind, command, cwd: w.cwd, cols: 200, rows: 40, venv: w.venv })
  const s = readStream(h, ptyId)
  cleanup.push(() => s.close())
  return { argv: c.records.get(ptyId)?.argv, text: () => s.text(), type: (line: string) => h.manager.get(ptyId)!.input(`${line}\r`) }
}

/** The text after the last `marker`, up to the end of its line. The commands typed split each marker in two (`"P""Y="`), so the shell's echo of them never matches. */
function after(text: string, marker: string): string | null {
  const i = text.lastIndexOf(marker)
  return i < 0 ? null : text.slice(i + marker.length).split(/\r?\n/)[0]!.trim()
}

describe('a session virtual env in real shells', () => {
  it.runIf(ZSH)('I-PTY-36 · zsh: the env is activated after the user\'s files (a ZDOTDIR their .zshenv moves, python3 put first), with its prompt and deactivate', async () => {
    const h = await harness()
    const w = worktree(h)
    const home = userHome({
      '.zshenv': 'ZDOTDIR=$HOME/xdg\n',
      'xdg/.zprofile': 'export PATH=$HOME/shims:/usr/bin:$PATH\n',
      'xdg/.zshrc': "PS1='USER> '\n",
    })
    const t = await open(h, { SHELL: ZSH!, HOME: home, ZDOTDIR: home }, 'shell', shellTabCommand(ZSH!), w)
    expect(t.argv).toEqual([ZSH, '-l'])
    await until('the prompt', () => t.text().includes('(demo) USER> '))
    t.type('print -r -- "P""Y=$(command -v python3) VE=$VIRTUAL_ENV ZD=$ZDOTDIR KEA=${KEA_VENV-u}${KEA_VENV_PROMPT-u}${KEA_ZDOTDIR-u} HF=$HISTFILE"')
    await until('the report', () => after(t.text(), 'PY=') !== null && after(t.text(), 'PY=')!.includes('HF='))
    const report = after(t.text(), 'PY=')!
    expect(report).toContain(`${w.venv.dir}/bin/python3 VE=${w.venv.dir} ZD=${home}/xdg KEA=uuu`)
    expect(report, 'the history file is not in Kea\'s folder').not.toContain(path.join(h.home, 'shell'))
    t.type('print -r -- "N""ESTED=$(zsh -c \'print -r -- $ZDOTDIR\')"')
    await until('the nested shell', () => after(t.text(), 'NESTED=') !== null)
    expect(after(t.text(), 'NESTED='), 'a zsh started from the tab reads the user\'s files').toBe(`${home}/xdg`)
    t.type('deactivate; print -r -- "A""FTER=$(command -v python3) VE=${VIRTUAL_ENV-unset}"')
    await until('deactivate', () => after(t.text(), 'AFTER=') !== null)
    expect(after(t.text(), 'AFTER=')).toBe(`${home}/shims/python3 VE=unset`)
  })

  it('I-PTY-37 · bash: the tab reads the login files from --init-file, then activates the env, with its prompt and deactivate', async () => {
    const h = await harness()
    const w = worktree(h)
    const home = userHome({ '.bash_profile': "export PATH=$HOME/shims:/usr/bin:$PATH\nPS1='USER> '\nexport KEA_TEST_PROFILE=read\n" })
    const t = await open(h, { SHELL: BASH, HOME: home, BASH_SILENCE_DEPRECATION_WARNING: '1' }, 'shell', shellTabCommand(BASH), w)
    expect(t.argv).toEqual([BASH, '--init-file', path.join(h.home, 'shell', 'bash', 'kea.bash')])
    await until('the prompt', () => t.text().includes('(demo) USER> '))
    t.type('echo "P""Y=$(command -v python3) VE=$VIRTUAL_ENV P=$KEA_TEST_PROFILE KEA=${KEA_VENV-u}${KEA_VENV_PROMPT-u}"')
    await until('the report', () => (after(t.text(), 'PY=') ?? '').includes('KEA='))
    expect(after(t.text(), 'PY=')).toBe(`${w.venv.dir}/bin/python3 VE=${w.venv.dir} P=read KEA=uu`)
    t.type('deactivate; echo "A""FTER=$(command -v python3) VE=${VIRTUAL_ENV-unset}"')
    await until('deactivate', () => after(t.text(), 'AFTER=') !== null)
    expect(after(t.text(), 'AFTER=')).toBe(`${home}/shims/python3 VE=unset`)
  })

  it.runIf(FISH)('I-PTY-38 · fish: the env is activated after config.fish, with deactivate', async () => {
    const h = await harness()
    const w = worktree(h)
    const home = userHome({ '.config/fish/config.fish': "set -gx PATH $HOME/shims $PATH\nfunction fish_prompt; echo -n 'USER> '; end\n" })
    const t = await open(h, { SHELL: FISH!, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') }, 'shell', shellTabCommand(FISH!), w)
    await until('the prompt', () => t.text().includes('USER> ') && t.text().includes('(demo) '))
    t.type('echo "P""Y="(command -v python3)" VE=$VIRTUAL_ENV KEA="(set -q KEA_VENV; and echo set; or echo u)')
    await until('the report', () => (after(t.text(), 'PY=') ?? '').includes('KEA='))
    expect(after(t.text(), 'PY=')).toBe(`${w.venv.dir}/bin/python3 VE=${w.venv.dir} KEA=u`)
    t.type('deactivate; echo "A""FTER="(command -v python3)')
    await until('deactivate', () => after(t.text(), 'AFTER=') !== null)
    expect(after(t.text(), 'AFTER=')).toBe(`${home}/shims/python3`)
  })

  it('I-PTY-39 · the dev server\'s configured command (a login shell running it) sees the env first, after the user\'s profile', async () => {
    const script = 'echo "S""RV=$(command -v python3) VE=$VIRTUAL_ENV KEA=${KEA_VENV-u}${KEA_BASH_ENV-u}${BASH_ENV-u}"'
    const shells: [string, Record<string, string>][] = [[BASH, { '.bash_profile': 'export PATH=$HOME/shims:/usr/bin:$PATH\n' }]]
    if (ZSH) shells.push([ZSH, { '.zprofile': 'export PATH=$HOME/shims:/usr/bin:$PATH\n' }])
    for (const [shell, files] of shells) {
      const h = await harness()
      const w = worktree(h)
      const home = userHome(files)
      const t = await open(h, { SHELL: shell, HOME: home, ZDOTDIR: home }, 'server', loginScriptCommand(shell, script), w)
      await until(`${shell} to run the command`, () => (after(t.text(), 'SRV=') ?? '').includes('KEA='))
      expect(after(t.text(), 'SRV='), shell).toBe(`${w.venv.dir}/bin/python3 VE=${w.venv.dir} KEA=uuu`)
    }
  })
})
