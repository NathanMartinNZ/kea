import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isAvailable } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { coreOs } from '../os/index.ts'
import { fallbackEnv, fileShellEnv, markerScript, parseMarkedEnv, resolveShellEnv, ShellEnvCache, terminalEnv, type Env, type ShellEnvResult, type StoredShellEnv } from './shellEnv.ts'

const S = '__KEA_ENV_START_ab__'
const E = '__KEA_ENV_END_ab__'

// Both systems have shell, PATH and locale defaults; a system without them would make these a named skip
const shellDefaults = isAvailable(coreOs.shellDefaults)
/** A login shell this machine has: zsh (macOS's), else bash (Linux's usual; Ubuntu has no zsh by default). */
const loginShell = fs.existsSync('/bin/zsh') ? { shell: '/bin/zsh', rc: '.zshrc' } : { shell: '/bin/bash', rc: '.bash_profile' }

describe('login-shell environment', () => {
  it('U-PTY-6 · marker parser: noise before and after the markers, multi-line values, `=` in values', () => {
    const out = `Last login: Mon\n\x1b]1337;SetMark\x07welcome!\n${S}A=1\0MULTI=line one\nline two\0EQ=a=b=c\0EMPTY=\0${E}\nbye from .zlogout\n`
    expect(parseMarkedEnv(out, S, E)).toEqual({ A: '1', MULTI: 'line one\nline two', EQ: 'a=b=c', EMPTY: '' })
  })

  it('U-PTY-6 · missing or empty markers → null (the caller falls back)', () => {
    expect(parseMarkedEnv('no markers here', S, E)).toBeNull()
    expect(parseMarkedEnv(`${S}A=1`, S, E)).toBeNull()
    expect(parseMarkedEnv(`${S}${E}`, S, E)).toBeNull()
  })

  it.runIf(shellDefaults)('U-PTY-6 · the marker script is constant text around the marker, and the fallback adds the tool directories once', () => {
    expect(markerScript(S, E)).toBe(`printf '%s' '${S}'; /usr/bin/env -0; printf '%s' '${E}'`)
    const env = fallbackEnv({ PATH: '/usr/bin:/opt/homebrew/bin', HOME: '/Users/x', SKIP: undefined }, '/Users/x')
    expect(env.PATH).toBe(
      coreOs.system === 'darwin'
        ? '/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/x/.local/bin'
        : '/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/x/.local/bin:/Users/x/.cargo/bin:/home/linuxbrew/.linuxbrew/bin:/snap/bin',
    )
    expect('SKIP' in env).toBe(false)
  })

  it.runIf(shellDefaults)('U-PTY-6 · terminal variables are set and LANG defaults only when unset', () => {
    expect(terminalEnv({ LANG: 'de_DE.UTF-8' }, '1.2.3')).toEqual({ LANG: 'de_DE.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Kea', TERM_PROGRAM_VERSION: '1.2.3' })
    // macOS: en_US.UTF-8; Linux: that when it is installed, else C.UTF-8
    if (coreOs.system === 'darwin') expect(terminalEnv({}, '1').LANG).toBe('en_US.UTF-8')
    else expect(['en_US.UTF-8', 'C.UTF-8']).toContain(terminalEnv({}, '1').LANG)
  })

  it.runIf(shellDefaults)('U-PTY-6 · a real login shell: its rc noise is ignored, multi-line values survive, session variables are removed', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-test-'))
    try {
      fs.writeFileSync(path.join(home, loginShell.rc), 'echo "hello from the rc file"\nexport KEA_TEST_MULTI="a\nb"\nexport KEA_SESSION_ID=leaked\n')
      const base = { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', SHELL: loginShell.shell }
      const r = await resolveShellEnv({ shell: loginShell.shell, base })
      expect(r.source).toBe('login-interactive')
      expect(r.env.KEA_TEST_MULTI).toBe('a\nb')
      expect(r.env.KEA_SESSION_ID).toBeUndefined()
      expect(r.env.HOME).toBe(home)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it.runIf(shellDefaults)('U-PTY-6 · a shell that hangs or fails falls back after the timeout', async () => {
    const r = await resolveShellEnv({ shell: '/usr/bin/false', base: { PATH: '/usr/bin' }, timeoutMs: 2000 }) // os-ok: in /usr/bin on both systems
    expect(r.source).toBe('fallback')
    expect(r.env.PATH).toContain(coreOs.system === 'darwin' ? '/opt/homebrew/bin' : '/snap/bin')
    expect(r.error).toMatch(/false/)
  })
})

describe('shell environment across launches', () => {
  type Deferred = { promise: Promise<ShellEnvResult>; resolve(r: ShellEnvResult): void }
  const deferred = (): Deferred => {
    let resolve!: (r: ShellEnvResult) => void
    return { promise: new Promise((r) => (resolve = r)), resolve }
  }
  const memoryStore = (initial: { shell: string; env: Env } | null = null) => {
    let saved = initial
    const writes: Env[] = []
    const store: StoredShellEnv = { read: () => saved, write: (shell, env) => ((saved = { shell, env }), writes.push(env)) }
    return { store, writes }
  }

  it('U-PTY-46 · until the launch resolves, PTYs get the last run’s environment; the fresh one replaces it and is stored', async () => {
    const d = deferred()
    const { store, writes } = memoryStore({ shell: '/bin/zsh', env: { PATH: '/old' } })
    const cache = new ShellEnvCache(() => d.promise, () => {}, { store, shell: '/bin/zsh' })
    expect(await cache.get()).toEqual({ PATH: '/old' }) // at once, while the resolution runs
    d.resolve({ env: { PATH: '/new' }, source: 'login-interactive' })
    await d.promise
    expect(await cache.get()).toEqual({ PATH: '/new' })
    expect(writes).toEqual([{ PATH: '/new' }])
  })

  it('U-PTY-46 · another shell’s stored environment, a fallback result and a reload never use or feed the store', async () => {
    const d1 = deferred()
    const other = memoryStore({ shell: '/bin/bash', env: { PATH: '/bash' } })
    const c1 = new ShellEnvCache(() => d1.promise, () => {}, { store: other.store, shell: '/bin/zsh' })
    const waiting = c1.get()
    d1.resolve({ env: { PATH: '/fallback' }, source: 'fallback', error: 'timed out' })
    expect(await waiting).toEqual({ PATH: '/fallback' }) // waited: the stored one is bash's
    expect(other.writes).toEqual([]) // a fallback is never stored

    const runs: Deferred[] = [deferred(), deferred()]
    let n = 0
    const { store } = memoryStore({ shell: '/bin/zsh', env: { PATH: '/old' } })
    const c2 = new ShellEnvCache(() => runs[n++]!.promise, () => {}, { store, shell: '/bin/zsh' })
    expect(await c2.get()).toEqual({ PATH: '/old' })
    runs[0]!.resolve({ env: { PATH: '/first' }, source: 'login' })
    await runs[0]!.promise
    expect(await c2.get()).toEqual({ PATH: '/first' })
    const reloading = c2.reload()
    const next = c2.get() // after a reload: waits for the new resolution, never the stored one
    runs[1]!.resolve({ env: { PATH: '/second' }, source: 'login-interactive' })
    expect(await reloading).toBe('login-interactive')
    expect(await next).toEqual({ PATH: '/second' })
  })

  it('U-PTY-46 · the stored file is private, versioned, and ignored when unreadable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-test-env-'))
    try {
      const file = path.join(dir, 'shell-env.json')
      const s = fileShellEnv(file)
      expect(s.read()).toBeNull()
      s.write('/bin/zsh', { PATH: '/x', MULTI: 'a\nb' })
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(s.read()).toEqual({ shell: '/bin/zsh', env: { PATH: '/x', MULTI: 'a\nb' } })
      fs.writeFileSync(file, '{"v":1,"shell":')
      expect(s.read()).toBeNull()
      fs.writeFileSync(file, JSON.stringify({ v: 2, shell: '/bin/zsh', env: { A: 'b' } }))
      expect(s.read()).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
