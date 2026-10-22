// Holder admission in a signed build, with the real local certificate. The requirement ptyhost derives from its
// own signature must admit what ptyhost runs as (the app's Electron helper) and refuse `kea-helper`, which carries the
// same certificate leaf and which any agent can run (`kea-helper hook`). It needs a Kea.app signed with "Kea Local Code
// Signing" (`pnpm kea:install --no-install --out <dir>`): set KEA_SIGNED_APP to it; without it the test is
// skipped. Nothing is signed here, so no keychain item is used. The holder runs the app's own signed `kea-helper` in a
// temp home of this run, and is SIGKILLed by identity at the end (this process is not a client it admits, so it cannot
// be TERMINATEd).
//
//   KEA_SIGNED_APP=dist/pack/Kea.app npx vitest run --project integration tests/integration/holder-signed.test.ts

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ptyId as newPtyId, runProcess } from '@kea/kit'
import { HOOK_ACK_BYTE, L } from '@kea/protocol'
import { clientRequirement, launchHolder } from '../../app/ptyhost/src/holder/launch.ts'
import { holderState, killHolder, shortKeaHome, testEnv } from '../support/holders.ts'

const APP = process.env.KEA_SIGNED_APP ? path.resolve(process.env.KEA_SIGNED_APP) : null
/** What ptyhost (an Electron utility process) runs as, and the helper binary the app ships. */
const PTYHOST_EXE = APP ? path.join(APP, 'Contents/Frameworks/Kea Helper.app/Contents/MacOS/Kea Helper') : ''
const KEA_HELPER = APP ? path.join(APP, 'Contents/Resources/kea-helper') : ''

/** `codesign -v` of `exe` against requirement text `req`: 0 when it satisfies it. */
async function satisfies(exe: string, req: string): Promise<boolean> {
  // os-ok: macOS test tool
  const r = await runProcess('/usr/bin/codesign', ['-v', `--test-requirement==${req}`, exe], { pool: 'other', timeoutMs: L.codesignTimeoutMs, maxBytes: L.codesignOutputMaxBytes })
  return r.code === 0
}

describe('signed-build holder admission', () => {
  it.runIf(APP !== null)("I-HLD-32 · a signed build's client requirement admits ptyhost's own executable, not the app's kea-helper, which shares its certificate leaf; a signed holder runs with it and the signed hook still delivers", async () => {
    const client = await clientRequirement(PTYHOST_EXE)
    expect(client.option).toBe('--client-req')
    const req = client.value
    expect(req, 'an identifier and the certificate leaf, never the leaf alone').toMatch(/^identifier "[^"]+" and certificate leaf = H"[0-9a-fA-F]+"$/)
    const leaf = /certificate leaf = H"[0-9a-fA-F]+"/.exec(req)![0]
    expect(await satisfies(PTYHOST_EXE, req), 'ptyhost satisfies it').toBe(true)
    expect(await satisfies(KEA_HELPER, leaf), 'kea-helper carries the same leaf: the leaf alone would admit it').toBe(true)
    expect(await satisfies(KEA_HELPER, req), 'kea-helper does not satisfy it').toBe(false)

    // At run time: the signed holder compiles that requirement (one that does not compile fails the launch). Next to
    // it, a `core.sock` that answers each line as core does, in the same private run directory — Kea's own layout: the
    // app's signed `kea-helper hook` passes its socket checks and delivers rather than spooling, so those
    // checks do not cut hooks off in a signed build. (A holder never answers a hook's line, so the hook is not pointed
    // at it.) The codesign checks above are what tell the two requirements apart; the signed pair in
    // `tools/perf/src/survival.ts` shows ptyhost admitted.
    const { home, dispose } = shortKeaHome()
    const ptyId = newPtyId()
    const lines: string[] = []
    const core = net.createServer((c) => c.on('data', (b) => (lines.push(b.toString('utf8')), c.write(Buffer.from([HOOK_ACK_BYTE])))))
    try {
      fs.mkdirSync(path.join(home, 'run'), { mode: 0o700 })
      await new Promise<void>((resolve) => core.listen(path.join(home, 'run', 'core.sock'), resolve))
      await launchHolder({
        helper: KEA_HELPER,
        ptyId,
        sessionId: 's1',
        kind: 'shell',
        stateDir: path.join(home, 'sessions', 's1'),
        sock: path.join(home, 'run', `${ptyId}.sock`),
        cols: 80,
        rows: 24,
        client,
        ringBytes: L.ringBytesDefault,
        keaVersion: 'test',
        spec: { file: '/bin/cat', args: [], env: testEnv(), cwd: home },
      })
      const hook = await runProcess(KEA_HELPER, ['hook', 'test', '--session', 's1', '--home', home, '--project', '{}'], { pool: 'other', stdin: '{}', timeoutMs: L.holderLaunchTimeoutMs, maxBytes: L.holderLaunchOutputMaxBytes })
      expect(hook.code).toBe(0)
      expect(fs.existsSync(path.join(home, 'sessions', 's1', 'spool.ndjson')), 'delivered, not spooled').toBe(false)
      expect(lines.join('')).toContain('"keaSessionId":"s1"')
      expect(holderState(home, ptyId)?.pid, 'the holder runs').toBeGreaterThan(0)
    } finally {
      core.close()
      killHolder(home, ptyId)
      dispose()
    }
  })
})
