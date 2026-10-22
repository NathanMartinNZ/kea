// The login shell for real: environment resolution against a throwaway HOME whose rc files misbehave, and PTYs started
// by core through ptyhost and the debug kea-helper (tests/support/holders.ts). The user's own shell configuration is
// never read: HOME and ZDOTDIR point at a temp directory, SHELL is passed explicitly.

import fs from 'node:fs'
import path from 'node:path'
import { isAvailable, L } from '@kea/protocol'
import { resolveShellEnv } from '@kea/core/src/terminal/shellEnv.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { holderState, ptyhostHarness, shortKeaHome, testEnv, until, type Harness } from '../support/holders.ts'
import { ownPtyIds, readStream, startCore } from './core-support.ts'
import { coreOs } from '../../app/core/src/os/index.ts'

// The login shell and its fallback environment use the system’s shell defaults (both systems have them).
const shellDefaults = isAvailable(coreOs.shellDefaults)

/**
 * The login shell the tests run, as this machine has it: zsh (macOS's), else bash (Ubuntu has no zsh). Its profile
 * is read by every login shell and its rc file only by an interactive one: bash's profile reads its rc file then, as
 * distributions' default `~/.profile` does.
 */
const SH = fs.existsSync('/bin/zsh')
  ? { shell: '/bin/zsh', profile: '.zprofile', rc: '.zshrc', logout: '.zlogout', profileText: (body: string) => body, say: (s: string) => `print "${s}"`, warn: (s: string) => `print -u2 "${s}"`, options: 'print -r -- "L=$options[login] I=$options[interactive] P=$PWD T=$TERM_PROGRAM"' }
  : {
      shell: '/bin/bash',
      profile: '.bash_profile',
      rc: '.bashrc',
      logout: '.bash_logout',
      profileText: (body: string) => `${body}case $- in *i*) . ~/.bashrc ;; esac\n`,
      say: (s: string) => `printf '%b\\n' "${s}"`,
      warn: (s: string) => `echo "${s}" >&2`,
      options: 'L=; I=; shopt -q login_shell && L=on; case $- in *i*) I=on ;; esac; echo "L=$L I=$I P=$PWD T=$TERM_PROGRAM"',
    }

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

/** A throwaway HOME (= ZDOTDIR) holding the given rc files. */
function zdotdir(files: Record<string, string>): string {
  const d = shortKeaHome()
  cleanup.push(() => d.dispose())
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d.home, name), text)
  return d.home
}

/** The JSON in `file`, or null while it is missing or still being written (not yet whole). */
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

const shellBase = (home: string, extra: Record<string, string> = {}) => testEnv({ SHELL: SH.shell, HOME: home, ZDOTDIR: home, ...extra })

async function harness(): Promise<Harness> {
  const h = await ptyhostHarness()
  cleanup.push(async () => {
    for (const id of ownPtyIds(h.home)) h.spawned.add(id)
    await h.dispose()
  })
  return h
}

describe('login shell', () => {
  it.runIf(shellDefaults)('I-PTY-19 · environment resolution with a .zshrc that prints banners, is slow (3 s), or hangs: correct env, correct env, the next fallback after the timeout', async () => {
    const banners = zdotdir({
      [SH.profile]: SH.profileText('export KEA_PROFILE=profile\n'),
      [SH.rc]: [
        SH.say('Welcome! \\e[1;32mbold\\e[0m'),
        "printf 'x\\0y\\0__KEA_ENV_START_fake__\\0z=1\\0'",
        SH.warn('warning on stderr'),
        'export KEA_RC="from zshrc"',
        'export KEA_MULTI="one',
        'two"',
      ].join('\n'),
      [SH.logout]: `${SH.say('bye')}\n`,
    })
    const slow = zdotdir({ [SH.profile]: SH.profileText(''), [SH.rc]: 'sleep 3\nexport KEA_RC=slow\n' })
    const hangs = zdotdir({ [SH.profile]: SH.profileText('export KEA_PROFILE=profile\n'), [SH.rc]: 'export KEA_RC=never\nexec /usr/bin/tail -f /dev/null\n' }) // os-ok: in /usr/bin on both systems

    const t0 = performance.now()
    const [a, b, c] = await Promise.all([banners, slow, hangs].map((home) => resolveShellEnv({ shell: SH.shell, base: shellBase(home) })))
    const elapsed = performance.now() - t0

    expect(a!.source).toBe('login-interactive')
    expect(a!.env).toMatchObject({ KEA_RC: 'from zshrc', KEA_MULTI: 'one\ntwo', KEA_PROFILE: 'profile', HOME: banners })
    expect(Object.keys(a!.env).some((k) => k.includes('fake') || k === 'z' || k === 'x')).toBe(false)

    expect(b!.source).toBe('login-interactive')
    expect(b!.env.KEA_RC).toBe('slow')

    expect(c!.source, '-l -i timed out; -l without -i does not read .zshrc').toBe('login')
    expect(c!.env.KEA_PROFILE).toBe('profile')
    expect(c!.env.KEA_RC).toBeUndefined()
    expect(elapsed).toBeGreaterThanOrEqual(L.shellEnvTimeoutMs)
  })

  it.runIf(shellDefaults)('I-PTY-14 · a shell tab is an interactive login shell in the worktree; an agent "through login shell" gets its argv byte-exact through `exec "$@"`', async () => {
    const h = await harness()
    const zhome = zdotdir({ [SH.rc]: '# empty: no newuser wizard\n', [SH.profile]: SH.profileText('export KEA_PROFILE=profile\n') })
    const worktree = path.join(h.home, 'worktree')
    fs.mkdirSync(worktree)
    const out = path.join(h.home, 'argv.json')
    const c = startCore(h, { env: shellBase(zhome, { KEA_TEST_OUT: out }) })
    cleanup.push(() => c.dispose())
    await c.reconciled()

    // the shell tab
    const { ptyId: shell } = await c.t.openShell({ cwd: worktree, cols: 120, rows: 30 })
    expect(c.t.store.get(shell)).toMatchObject({ kind: 'shell', argv: [SH.shell, '-l'], cwd: worktree, state: 'running' })
    const s = readStream(h, shell)
    cleanup.push(() => s.close())
    h.manager.get(shell)!.input(`${SH.options}\r`)
    await until('the shell to report its options', () => s.text().includes('L=on I=on'))
    expect(s.text()).toContain(`L=on I=on P=${worktree} T=Kea`)

    // the agent, through the login shell
    const script = path.join(h.home, 'argv.cjs')
    fs.writeFileSync(script, "require('fs').writeFileSync(process.env.KEA_TEST_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), ppid: process.ppid, profile: process.env.KEA_PROFILE }))\n")
    const hostile = ['a b', '"double"', "'single'", '$HOME', '${HOME}', '`id`', '$(id)', ';', '|', '&& echo pwned', '\\', 'line\nbreak', '', '-c', '--', '*', '~', 'ünïcödé 🎉', '"$@"', '%s', "'; rm -rf ~; '", '\t']
    const { ptyId: agent } = await c.t.launch({ sessionId: 'S1', kind: 'agent', command: { argv: [process.execPath, script, ...hostile], throughLoginShell: true }, cwd: worktree, cols: 120, rows: 30 })
    expect(c.records.get(agent)?.argv.slice(0, 6)).toEqual([SH.shell, '-l', '-i', '-c', 'exec "$@"', 'kea'])
    // the file exists before the agent has finished writing it: wait until it parses
    await until('the agent to write its argv', () => readJson(out) !== null)
    const got = readJson<{ argv: string[]; cwd: string; ppid: number; profile: string }>(out)!
    expect(got.argv).toEqual(hostile)
    expect(got.cwd).toBe(worktree)
    expect(got.profile, 'the login profile ran').toBe('profile')
    expect(got.ppid, 'exec replaced the shell: the program is the holder child itself').toBe(holderState(h.home, agent)?.pid)
  })
})
