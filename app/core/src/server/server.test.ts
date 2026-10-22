import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { allPairs, createFsm, systemClock } from '@kea/kit'
import { L, SERVER_STATES } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectStartScript, parseShebang, resolveRun, runSource, START_SCRIPT } from './command.ts'
import { SERVER_EVENTS, SERVER_TABLE, serverAlive } from './fsm.ts'
import { lsofArgs, parseLsofHolder, parsePorts, ScanSchedule } from './scan.ts'
import { announcesListening, portInUse, primaryUrl, printedUrls, stripAnsi, urlPort } from './url.ts'

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function worktree(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-srv-')))
  dirs.push(d)
  return d
}

describe('what Run runs', () => {
  it('U-SRV-8 · looking at start.sh never holds core’s thread: a FIFO that took its place between the look and the open (the name still said "a file") is not waited on and is no script; a link to the real script is followed as running it would, and a link to a FIFO or a folder is no script', () => {
    const dir = worktree()
    const script = path.join(dir, START_SCRIPT)
    const plain = path.join(dir, 'plain.sh')
    fs.writeFileSync(plain, '#!/bin/bash\necho hi\n')
    execFileSync('/usr/bin/mkfifo', [script]) // os-ok: in /usr/bin on both systems
    // In a process of its own, with a time limit: opening a FIFO for reading waits for a writer, which never comes, and
    // a call that waits on core's thread cannot be timed out from inside it. `statSync` answers for the script's name as
    // it did a moment before the FIFO took its place.
    const code = [
      `import fs from 'node:fs'`,
      `const real = fs.statSync`,
      `const before = real(${JSON.stringify(plain)})`,
      `fs.statSync = (p, ...rest) => (String(p) === ${JSON.stringify(script)} ? before : real(p, ...rest))`,
      `const { inspectStartScript } = await import(${JSON.stringify(new URL('./command.ts', import.meta.url).href)})`,
      `process.stdout.write(JSON.stringify(inspectStartScript(${JSON.stringify(dir)})))`,
    ].join('\n')
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: path.dirname(fileURLToPath(import.meta.url)), timeout: 10_000, encoding: 'utf8' })
    expect(r.error, `it did not come back: ${r.stderr}`).toBeUndefined()
    expect({ status: r.status, out: r.stdout }, r.stderr).toEqual({ status: 0, out: 'null' })
    // seen as it is, a FIFO is no script either
    expect(inspectStartScript(dir)).toBeNull()

    // a link to the real script is the script (`./start.sh` runs what it leads to)
    fs.rmSync(script)
    fs.symlinkSync('plain.sh', script)
    expect(inspectStartScript(dir)).toEqual({ executable: false, shebang: ['/bin/bash'] })
    fs.chmodSync(plain, 0o755)
    expect(inspectStartScript(dir)).toEqual({ executable: true, shebang: ['/bin/bash'] })
    // a link to a FIFO, to a folder, to nothing: no script, and nothing waited for
    for (const target of ['pipe', 'folder', 'nothing']) {
      fs.rmSync(script)
      fs.symlinkSync(target, script)
      if (target === 'pipe') execFileSync('/usr/bin/mkfifo', [path.join(dir, 'pipe')]) // os-ok: in /usr/bin on both systems
      if (target === 'folder') fs.mkdirSync(path.join(dir, 'folder'))
      expect(inspectStartScript(dir), target).toBeNull()
    }
  })

  it('U-SRV-1 · run-command resolution: the project setting, else an executable start.sh run directly, else its shebang interpreter, else /bin/sh; nothing to run without either', () => {
    const dir = worktree()
    const script = path.join(dir, START_SCRIPT)
    // nothing at all
    expect(inspectStartScript(dir)).toBeNull()
    expect(resolveRun({}, null, '/bin/zsh')).toBeNull()
    expect(runSource({}, null)).toBe('none')

    // executable: exec ./start.sh directly
    fs.writeFileSync(script, '#!/bin/bash\necho hi\n', { mode: 0o755 })
    let s = inspectStartScript(dir)
    expect(s).toEqual({ executable: true, shebang: ['/bin/bash'] })
    expect(resolveRun({}, s, '/bin/zsh')).toEqual({ source: 'startScript', command: { argv: ['./start.sh'] }, label: 'start.sh' })
    expect(runSource({}, s)).toBe('startScript')

    // not executable, with a shebang: its interpreter and that line's arguments
    fs.chmodSync(script, 0o644)
    fs.writeFileSync(script, '#!/usr/bin/env  node --trace-warnings\nconsole.log(1)\n')
    s = inspectStartScript(dir)
    expect(s).toEqual({ executable: false, shebang: ['/usr/bin/env', 'node', '--trace-warnings'] })
    expect(resolveRun({}, s, '/bin/zsh')?.command.argv).toEqual(['/usr/bin/env', 'node', '--trace-warnings', 'start.sh'])

    // not executable, no shebang: /bin/sh start.sh
    fs.writeFileSync(script, 'echo hi\n')
    s = inspectStartScript(dir)
    expect(s).toEqual({ executable: false, shebang: null })
    expect(resolveRun({}, s, '/bin/zsh')?.command.argv).toEqual(['/bin/sh', 'start.sh'])

    // the setting wins over any start.sh: the user's text is one argv element of `$SHELL -l -c`, never spliced
    const cmd = `pnpm dev --port "$PORT"; echo 'done'`
    expect(resolveRun({ runCommand: `  ${cmd}  ` }, s, '/opt/homebrew/bin/fish')).toEqual({ source: 'runCommand', command: { argv: ['/opt/homebrew/bin/fish', '-l', '-c', cmd] }, label: cmd })
    expect(runSource({ runCommand: cmd }, null)).toBe('runCommand')
    // a blank setting is no setting
    expect(resolveRun({ runCommand: '   ' }, s, '/bin/zsh')?.source).toBe('startScript')
    expect(runSource({ runCommand: ' ' }, null)).toBe('none')

    // a directory named start.sh is not a script
    fs.rmSync(script)
    fs.mkdirSync(script)
    expect(inspectStartScript(dir)).toBeNull()

    expect(parseShebang('#!\n')).toBeNull()
    expect(parseShebang('#! /bin/sh -e\r\nrest')).toEqual(['/bin/sh', '-e'])
    expect(parseShebang('echo #!/bin/sh')).toBeNull()
  })
})

describe('the dev server lifecycle table', () => {
  /** The lifecycle diagram in fsm.ts, edge for edge. */
  const EXPECTED: Record<string, string> = {
    'stopped run': 'starting',
    'starting alive': 'running',
    'starting stop': 'stopping',
    'starting ended': 'stopped',
    'starting failed': 'crashed',
    'running ports': 'running',
    'running stop': 'stopping',
    'running ended': 'stopped',
    'running failed': 'crashed',
    'stopping ended': 'stopped',
    'crashed run': 'starting',
  }

  it('U-SRV-7 · every state × event pair: the diagram’s edges move the state, every other pair changes nothing; a server is alive from Run until its exit', () => {
    const pairs = allPairs(SERVER_TABLE, SERVER_STATES, SERVER_EVENTS)
    expect(pairs).toHaveLength(SERVER_STATES.length * SERVER_EVENTS.length)
    for (const { state, event, handled } of pairs) {
      const want = EXPECTED[`${state} ${event}`]
      expect(handled, `${state} × ${event}`).toBe(want !== undefined)
      expect(createFsm(SERVER_TABLE, { state }).send({ t: event }).to, `${state} × ${event}`).toBe(want ?? state)
    }
    expect(SERVER_TABLE.initial).toBe('stopped')
    expect(SERVER_STATES.filter(serverAlive)).toEqual(['starting', 'running', 'stopping'])
  })
})

describe('the dev server’s output', () => {
  it('U-SRV-2 · URLs from ANSI-coloured output in the order printed; 0.0.0.0 reads localhost; IPv6; a URL cut off at the end waits; the primary URL is the first printed one whose port listens, else the lowest port', () => {
    // Vite prints the port in bold and the whole line coloured
    const vite = '\x1b[32m  ➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n  ➜  Network: use --host to expose\r\n'
    expect(stripAnsi(vite)).toBe('  ➜  Local:   http://localhost:5173/\r\n  ➜  Network: use --host to expose\r\n')
    expect(printedUrls(stripAnsi(vite))).toEqual([{ url: 'http://localhost:5173/', port: 5173 }])

    const many = stripAnsi(
      [
        'api on https://127.0.0.1:8443/v1 (ready).',
        'listening on http://0.0.0.0:3000',
        'also http://[::1]:3001/path?q=1#top, and again http://0.0.0.0:3000 ',
        'not ours: http://example.com:80/ http://192.168.1.4:3000/ http://localhost/ http://localhost:99999/ ',
        '\x1b]8;;http://localhost:4000/docs\x07docs\x1b]8;;\x07 \x1b]0;title http://localhost:1\x07',
        'tail http://localhost:51',
      ].join('\n'),
    )
    expect(printedUrls(many)).toEqual([
      { url: 'https://127.0.0.1:8443/v1', port: 8443 },
      { url: 'http://localhost:3000', port: 3000 },
      { url: 'http://[::1]:3001/path?q=1#top', port: 3001 },
    ])
    // the last one ran to the end of what was read: the rest of its port may not be there yet
    expect(printedUrls(`${many}73/ `).at(-1)).toEqual({ url: 'http://localhost:5173/', port: 5173 })

    const printed = printedUrls(many)
    expect(primaryUrl(printed, [])).toBeNull()
    expect(primaryUrl(printed, [3001, 3000, 9229])).toBe('http://localhost:3000')
    expect(primaryUrl(printed, [9229, 8443])).toBe('https://127.0.0.1:8443/v1')
    expect(primaryUrl(printed, [9229, 4321])).toBe('http://localhost:4321')
    expect(primaryUrl([], [20010])).toBe('http://localhost:20010')
    expect(urlPort('http://[::1]:3001/x')).toBe(3001)
    expect(urlPort('http://localhost')).toBeNull()

    // what asks for an extra scan
    expect(announcesListening('Server listening on port 3000')).toBe(true)
    expect(announcesListening('  ready in 312 ms')).toBe(true)
    expect(announcesListening('Started server process [1234]')).toBe(true)
    expect(announcesListening('see http://127.0.0.1:8000/')).toBe(true)
    expect(announcesListening('GET /index.html 200 3ms')).toBe(false)
    expect(announcesListening('already unready, restarted')).toBe(false)

    // the server's own error, and the port it names
    expect(portInUse('Error: listen EADDRINUSE: address already in use :::3000\n    at Server.setupListenHandle')).toEqual({ port: 3000 })
    expect(portInUse('12:01:07 Error: listen EADDRINUSE: address already in use 127.0.0.1:20015')).toEqual({ port: 20015 })
    expect(portInUse('listen tcp :8080: bind: address already in use')).toEqual({ port: 8080 })
    expect(portInUse('Error: Port 5173 is already in use')).toEqual({ port: 5173 })
    expect(portInUse('OSError: [Errno 48] Address already in use')).toEqual({ port: null })
    expect(portInUse('all good on :3000')).toBeNull()
  })

  it('U-SRV-3 · `kea-helper ports` output: each listening port once, lowest first, with its pids; error lines and noise skipped. `lsof -F pc` output names the first holder', () => {
    const out = ['812 tcp4 127.0.0.1 5173', '812 tcp6 ::1 5173', '900 tcp6 :: 24678', '901 tcp4 0.0.0.0 3000', '902 error no such process', 'x error invalid pid', '', '903 udp4 0.0.0.0 53', '904 tcp4 0.0.0.0 70000', '905 tcp4 127.0.0.1'].join('\n')
    const p = parsePorts(out)
    expect(p.ports).toEqual([3000, 5173, 24678])
    expect(p.holders.get(5173)).toEqual([812])
    expect(p.holders.get(3000)).toEqual([901])
    expect(p.errors).toBe(1)
    expect(parsePorts('')).toEqual({ ports: [], holders: new Map(), errors: 0 })

    expect(lsofArgs(3000)).toEqual(['-nP', '-iTCP:3000', '-sTCP:LISTEN', '+c', '0', '-F', 'pc'])
    expect(parseLsofHolder('p4242\ncnode\nf23\np4300\ncruby\n')).toEqual({ pid: 4242, name: 'node' })
    expect(parseLsofHolder('p77\ncGoogle Chrome Helper\n')).toEqual({ pid: 77, name: 'Google Chrome Helper' })
    expect(parseLsofHolder('p77\n')).toEqual({ pid: 77, name: '' })
    expect(parseLsofHolder('')).toBeNull()
    expect(parseLsofHolder('lsof: no process\n')).toBeNull()
  })

  it('U-SRV-5 · the scan schedule: the fast interval until a port is found, then the slow one counted from that scan; one extra scan after announcing output (one pending at a time); one on opening the Server tab; scans never overlap; none after stop', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const at: number[] = []
    let found = false
    let hold: (() => void) | null = null
    const s = new ScanSchedule({
      clock: systemClock,
      scan: async () => {
        at.push(Date.now() - t0)
        if (hold) await new Promise<void>((r) => (hold = r))
        return found
      },
    })
    const F = L.portScanFastMs
    const S = L.portScanSlowMs
    const X = L.portScanExtraMs
    expect(s.active).toBe(false)
    s.start()
    expect(s.timers).toBe(1)
    await vi.advanceTimersByTimeAsync(3 * F)
    expect(at).toEqual([F, 2 * F, 3 * F])

    // the port appears: the fourth scan finds it, and the next one is a slow interval after it
    found = true
    await vi.advanceTimersByTimeAsync(F)
    expect(at).toEqual([F, 2 * F, 3 * F, 4 * F])
    await vi.advanceTimersByTimeAsync(S - 1)
    expect(at).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(at.at(-1)).toBe(4 * F + S)

    // output that announces something: one extra scan X later, however often it is said meanwhile
    at.length = 0
    s.output()
    s.output()
    expect(s.timers).toBe(2)
    await vi.advanceTimersByTimeAsync(X - 1)
    expect(at).toEqual([])
    s.output()
    await vi.advanceTimersByTimeAsync(1)
    expect(at).toEqual([4 * F + S + X])
    expect(s.timers).toBe(1)
    // the periodic scans keep their own beat
    await vi.advanceTimersByTimeAsync(S - X)
    expect(at).toEqual([4 * F + S + X, 4 * F + 2 * S])

    // the Server tab or the port menu opened: one scan now
    at.length = 0
    s.opened()
    await vi.advanceTimersByTimeAsync(0)
    expect(at).toEqual([4 * F + 2 * S])

    // never two at once: scans asked for while one runs become one more after it
    at.length = 0
    hold = () => undefined
    s.opened()
    await vi.advanceTimersByTimeAsync(0)
    expect(at).toHaveLength(1)
    s.opened()
    s.opened()
    await vi.advanceTimersByTimeAsync(0)
    expect(at).toHaveLength(1)
    const release = hold as () => void
    hold = null
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(at).toHaveLength(2)

    // stopped: nothing is armed, nothing runs, whatever is asked
    at.length = 0
    s.output()
    s.stop()
    expect(s.timers).toBe(0)
    expect(s.active).toBe(false)
    s.output()
    s.opened()
    await vi.advanceTimersByTimeAsync(10 * S)
    expect(at).toEqual([])
    expect(vi.getTimerCount()).toBe(0)

    // a new run starts fast again, and `now` (a restarted core) scans at once
    s.start({ now: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(at).toHaveLength(1)
    s.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
