// Why a launch failed decides what ptyhost does next: fall back to a non-detached holder, say terminals are
// unavailable, or report the refusal. Stand-in "helpers" here are tiny scripts.

import fs from 'node:fs'
import path from 'node:path'
import { runDir } from '@kea/kit'
import { afterEach, describe, expect, it } from 'vitest'
import { tempHome } from '../test-support.ts'
import { launchArgs, launchHolder, type LaunchRequest } from './launch.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function setup() {
  const home = tempHome()
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }))
  const req = (helper: string): LaunchRequest => ({
    helper,
    ptyId: 'abcdefghij',
    sessionId: 's1',
    kind: 'shell',
    stateDir: path.join(home, 'sessions', 's1'),
    sock: path.join(runDir(home), 'abcdefghij.sock'),
    cols: 80,
    rows: 24,
    client: { option: '--client-req', value: 'test' },
    ringBytes: 1,
    keaVersion: 'test',
    spec: { file: '/bin/sh', args: ['-c', 'true'], env: { PATH: '/usr/bin:/bin' }, cwd: '/' },
  })
  /** A stand-in helper: a script that prints `stdout` and exits with `code`. */
  const script = (name: string, stdout: string, code: number, mode = 0o755) => {
    const f = path.join(home, name)
    fs.writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\nexit ${code}\n`, { mode })
    return f
  }
  return { home, req, script }
}

describe('holder launch failures', () => {
  it('U-PTY-25 · each failure is classified: helper unusable, could not detach, or refused', async () => {
    const { home, req, script } = setup()
    await expect(launchHolder(req(path.join(home, 'missing')))).rejects.toMatchObject({ kind: 'helper', message: expect.stringContaining('not found') })
    await expect(launchHolder(req(script('noexec', '', 0, 0o644)))).rejects.toMatchObject({ kind: 'helper', message: expect.stringContaining('not executable') })
    await expect(launchHolder(req(script('silent', '', 3)))).rejects.toMatchObject({ kind: 'helper', message: expect.stringContaining('exited with code 3 without a result') })
    await expect(launchHolder(req(script('spawnfail', '{"error":"posix_spawn /x/kea-helper: Operation not permitted"}', 1)))).rejects.toMatchObject({ kind: 'detach' })
    await expect(launchHolder(req(script('daemondied', '{"error":"the holder exited before it was ready"}', 1)))).rejects.toMatchObject({ kind: 'detach' })
    await expect(launchHolder(req(script('refused', '{"error":"--cols must be at least 1"}', 1)))).rejects.toMatchObject({ kind: 'refused', message: expect.stringContaining('--cols') })
    expect(await launchHolder(req(script('ok', '{"pid":12,"childPid":13}', 0)))).toEqual({ pid: 12, childPid: 13 })
  })

  it('U-PTY-25 · the non-detached argv is the detached one plus --no-detach, before the child\'s argv', () => {
    const { req } = setup()
    const r = req('/x/kea-helper')
    const a = launchArgs(r)
    const b = launchArgs({ ...r, noDetach: true })
    const sep = a.indexOf('--')
    expect(b).toEqual([...a.slice(0, sep), '--no-detach', ...a.slice(sep)])
    expect(b.slice(b.indexOf('--') + 1)).toEqual(['/bin/sh', '-c', 'true'])
  })
})
