// "Open with default app" and what it may run. `runProcess` is replaced by a recorder for this whole file, so nothing
// is ever started here whatever the service does: the test reads which tool it would have run.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { noopLogger } from '@kea/kit'
import { isAvailable, type CallContext } from '@kea/protocol'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sandboxEditorHost, systemEditorHost } from '../editor/host.ts'
import { coreOs } from '../os/index.ts'
import { StubGitFacts } from '../files/facts.ts'
import { VisibleSet } from '../platform/visible.ts'
import { StubWatchService } from '../platform/watch/stub.ts'
import { FILE_MANAGER } from './openable.ts'
import { readFile } from './read.ts'
import { ViewerService } from './service.ts'

const ran = vi.hoisted(() => ({ calls: [] as { file: string; args: string[] }[], result: { code: 0 as number | null, stderr: '', timedOut: false } }))
vi.mock('@kea/kit', async (original) => ({
  ...(await original<typeof import('@kea/kit')>()),
  runProcess: (file: string, args: string[]) => {
    ran.calls.push({ file, args: [...args] })
    return Promise.resolve({ code: ran.result.code, signal: null, stderr: ran.result.stderr, stdoutBytes: 0, truncated: false, timedOut: ran.result.timedOut, aborted: false })
  },
}))

let tmp: string
let cwd: string
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-viewer-open-')))
  cwd = path.join(tmp, 'session')
  fs.mkdirSync(cwd)
  fs.writeFileSync(path.join(cwd, 'doc.pdf'), '%PDF-1.7\n')
  fs.writeFileSync(path.join(cwd, 'tool'), '#!/bin/sh\n', { mode: 0o755 })
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
beforeEach(() => {
  ran.calls.length = 0
  ran.result = { code: 0, stderr: '', timedOut: false }
})

/** The service as core builds it for a window that shows the session: `openTool` is the editor host's `open`, or null. */
function serviceWith(openTool: string | null) {
  const visible = new VisibleSet()
  const service = new ViewerService({
    log: noopLogger,
    cwd: () => cwd,
    visible,
    watch: new StubWatchService(),
    git: new StubGitFacts(),
    gitEnv: () => Promise.resolve({}),
    openTool,
  })
  const peer = {}
  visible.set(peer, 'S')
  const open = (rel: string) => Promise.resolve(service.handlers()['viewer.openDefault']!({ sessionId: 'S', path: rel }, { peer, signal: new AbortController().signal } as unknown as CallContext))
  return { service, open }
}

/** The system's tool that opens a file with its default app: `open` on macOS, `xdg-open` on Linux. */
const OPEN_TOOL = isAvailable(coreOs.editors) && coreOs.editors.kind === 'commands' ? 'xdg-open' : 'open'

describe('open with the default app', () => {
  it('U-FV-15 · the file goes to the editor host’s `open` (on Linux `xdg-open`) and to nothing else: the harness’s own under a test, where the system’s is never run; with no host, or for a file that must not be opened, nothing is run at all', async () => {
    // the harness's world (tests/support/app-child-hooks.cjs): `open` (`xdg-open`) only under the run's own HOME
    const sandbox = sandboxEditorHost(path.join(tmp, 'home'))
    const inHarness = serviceWith(sandbox.open)
    expect(await inHarness.open('doc.pdf')).toEqual({ ok: true, message: null })
    expect(ran.calls).toEqual([{ file: path.join(tmp, 'home', 'bin', OPEN_TOOL), args: [path.join(cwd, 'doc.pdf')] }])
    expect(ran.calls.some((c) => c.file === systemEditorHost()!.open), 'the system’s `open`').toBe(false)
    // an `open` that fails says why, or that it could not
    ran.result = { code: 1, stderr: 'warning\nNo application knows how to open it\n', timedOut: false }
    expect(await inHarness.open('doc.pdf')).toEqual({ ok: false, message: 'No application knows how to open it' })
    ran.result = { code: null, stderr: '', timedOut: true }
    expect(await inHarness.open('doc.pdf')).toEqual({ ok: false, message: 'The file could not be opened' })
    // what must not be opened never reaches it: an executable, a missing file, a path out of the folder
    ran.calls.length = 0
    for (const p of ['tool', 'none.txt', '../home']) expect(await inHarness.open(p)).toMatchObject({ ok: false })
    expect(ran.calls).toEqual([])
    inHarness.service.dispose()

    // the app's own core: the system's `open` (`xdg-open`), with the file's real path as its one argument
    ran.result = { code: 0, stderr: '', timedOut: false }
    const inApp = serviceWith(systemEditorHost()!.open)
    expect(await inApp.open('doc.pdf')).toEqual({ ok: true, message: null })
    expect(ran.calls).toEqual([{ file: `/usr/bin/${OPEN_TOOL}`, args: [path.join(cwd, 'doc.pdf')] }]) // os-ok: the system's own, in /usr/bin on both
    inApp.service.dispose()

    // a core built without a host (every test that passes none): unavailable, and nothing is run
    ran.calls.length = 0
    const none = serviceWith(null)
    expect(await none.open('doc.pdf')).toEqual({ ok: false, message: 'Opening files is not available' })
    expect(ran.calls).toEqual([])
    none.service.dispose()
  })
  it('U-FV-17 · a file of a type that runs code or changes the system when it is opened — a Terminal file, a script the system launches, a location file, an installer or disk image, a profile, an add-on, a page for the browser — never reaches `open`, whatever the case of its name, also when a link with a plain name leads to it; the viewer is told with the file (`openable` is false), so it offers Reveal in Finder alone; a document still opens', async () => {
    const service = serviceWith(sandboxEditorHost(path.join(tmp, 'home')).open)
    // types of each kind, and their neighbours: every one a plain, non-executable file with ordinary bytes
    const never = [
      'run.terminal', 'run.command', 'run.tool', 'Run.COMMAND', 'build.jar', 'app.jnlp', 'go.inetloc', 'go.fileloc', 'go.webloc', 'go.url', 'share.afploc',
      'setup.pkg', 'setup.mpkg', 'disk.dmg', 'disk.sparseimage', 'disk.iso', 'Fake.app', 'do.workflow', 'do.action', 'do.shortcut', 'do.scpt', 'do.applescript',
      'add.osax', 'Pane.prefPane', 'pane.prefpane', 'wifi.mobileconfig', 'dev.provisionprofile', 'saver.saver', 'look.qlgenerator', 'page.html', 'page.webarchive',
      'ext.safariextz', 'script.py', 'two.tar.command', '.command',
    ]
    for (const name of never) fs.writeFileSync(path.join(cwd, name), 'ordinary bytes\n\0')
    // a link with a harmless name to one of them: `open` would be given the real file
    fs.symlinkSync('run.command', path.join(cwd, 'notes.txt'))
    for (const name of [...never, 'notes.txt']) {
      const r = await service.open(name)
      expect(r.ok, name).toBe(false)
      expect(r.message, name).toContain(`Reveal in ${FILE_MANAGER}`)
      expect((await readFile(cwd, name)).openable, name).toBe(false)
    }
    expect(ran.calls, 'nothing reached `open`').toEqual([])
    // what is no such type still opens: a document, and a name that only holds one of those words
    const fine = ['doc.pdf', 'command.txt', 'setup.pkg.log', 'archive.bin', 'no-extension']
    for (const name of fine.slice(1)) fs.writeFileSync(path.join(cwd, name), 'ordinary bytes\n\0')
    for (const name of fine) {
      expect((await readFile(cwd, name)).openable, name).toBe(true)
      expect(await service.open(name), name).toEqual({ ok: true, message: null })
    }
    expect(ran.calls.map((c) => c.args)).toEqual(fine.map((name) => [path.join(cwd, name)]))
    service.service.dispose()
  })

})
