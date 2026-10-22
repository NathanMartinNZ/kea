// The login shell hangs while Kea resolves its environment. A throwaway HOME whose `.zshenv` (read by every zsh) hangs
// when stdin is not a terminal — as during resolution, never in a PTY. The user's own shell configuration is never
// read.

import fs from 'node:fs'
import path from 'node:path'
import { L } from '@kea/protocol'
import { resolveShellEnv, ShellEnvCache, type ShellEnvResult } from '@kea/core/src/terminal/shellEnv.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { ptyhostHarness, shortKeaHome, testEnv, until } from '../support/holders.ts'
import { ownPtyIds, readStream, startCore } from '../integration/core-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

describe('C-RES-10 · login shell hangs during environment resolution', () => {
  it('C-RES-10 · the fallback environment is used after the timeouts, and a shell requested meanwhile starts with it', async () => {
    const z = shortKeaHome()
    cleanup.push(() => z.dispose())
    fs.writeFileSync(path.join(z.home, '.zshenv'), '[[ -t 0 ]] || exec /usr/bin/tail -f /dev/null\n') // os-ok: in /usr/bin on both systems
    fs.writeFileSync(path.join(z.home, '.zshrc'), '# empty: no newuser wizard\n')
    const base = testEnv({ SHELL: '/bin/zsh', HOME: z.home, ZDOTDIR: z.home, KEA_TEST_MARK: 'kea-own-env' })
    let result: ShellEnvResult | null = null
    const env = new ShellEnvCache(
      () => resolveShellEnv({ shell: '/bin/zsh', base }),
      (r) => (result = r),
    )

    const h = await ptyhostHarness()
    cleanup.push(async () => {
      for (const id of ownPtyIds(h.home)) h.spawned.add(id)
      await h.dispose()
    })
    const c = startCore(h, { opts: { env: () => env.get(), reloadEnv: () => env.reload() } })
    cleanup.push(() => c.dispose())
    await c.reconciled()

    const t0 = performance.now()
    const opening = c.call<{ ptyId: string }>('terminal.openShell', { cwd: h.home, cols: 100, rows: 30 }) // asked while resolution hangs
    const { ptyId } = await opening
    const waited = performance.now() - t0
    expect(result!.source).toBe('fallback')
    expect(result!.error).toMatch(/timed out.*timed out/)
    expect(waited, 'both login-shell attempts ran into the timeout').toBeGreaterThanOrEqual(2 * L.shellEnvTimeoutMs)
    expect(result!.env.PATH).toContain('/opt/homebrew/bin')
    expect(c.t.store.get(ptyId)).toMatchObject({ state: 'running', kind: 'shell' })

    const s = readStream(h, ptyId)
    cleanup.push(() => s.close())
    h.manager.get(ptyId)!.input('print -r -- "MARK=$KEA_TEST_MARK"\r')
    await until('the shell to start with the fallback environment', () => s.text().includes('MARK=kea-own-env'))
  })
})
