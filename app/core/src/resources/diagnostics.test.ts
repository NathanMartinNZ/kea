import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { noopLogger } from '@kea/kit'
import { KEA_HOME_MARK, L, outsidePaths, PATH_MARK, type HolderRow, type PlatformReport } from '@kea/protocol'
import { Diagnostics, diagnosticsText, duration, errorText, readTail, recentErrors, type DiagnosticsFacts, type ErrorLine } from './diagnostics.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-diag-')))
  dirs.push(d)
  return d
}

const AT = Date.parse('2026-10-13T10:00:00.000Z')
const HOME = '/Users/someone/.kea'
const line = (proc: string, level: string, t: string, msg: string, fields: Record<string, unknown> = {}): string => JSON.stringify({ t, level, proc, msg, ...fields })
const err = (more: Partial<ErrorLine>): ErrorLine => ({ t: '2026-10-13T09:59:00.000Z', at: AT - 60_000, proc: 'core', level: 'warn', msg: 'm', fields: {}, ...more })
/** macOS's report as main sends it: every line the full answer. */
const MAC_REPORT: PlatformReport = {
  system: 'darwin',
  version: 'macOS 26.0.0',
  arch: 'arm64',
  lines: [
    { id: 'holderDetach', label: 'Terminals', value: 'each in a process of its own that macOS keeps when Kea quits', fix: null },
    { id: 'terminalRenderer', label: 'Terminal drawing', value: 'WebGL, on the GPU', fix: null },
  ],
}
const holder = (more: Partial<HolderRow>): HolderRow => ({ ptyId: 'abcdefghij', sessionId: 'S1', kind: 'agent', pid: 100, childPid: 101, startedAt: AT - 3 * 3_600_000 - 5 * 60_000, alive: true, exited: false, orphan: false, ...more })

function facts(more: Partial<DiagnosticsFacts> = {}): DiagnosticsFacts {
  return {
    at: AT,
    home: HOME,
    version: '0.6.0',
    runtime: { electron: '39.0.0', chrome: '142.0.1', node: '22.20.0' },
    system: 'Darwin 25.0.0 arm64',
    upMs: 2 * 3_600_000 + 5 * 60_000,
    database: { fresh: false, setAside: true, fromVersion: 7 },
    git: true,
    agents: [
      { id: 'claude', displayName: 'Claude Code', state: 'ready', version: '2.1.0', path: '/opt/homebrew/bin/claude', loggedIn: true, notice: null },
      { id: 'commandcode', displayName: 'Command Code', state: 'missing', version: null, path: null, loggedIn: null, notice: 'cmd is not on the login shell PATH' },
    ],
    sessions: [{ lifecycle: 'live' }, { lifecycle: 'live' }, { lifecycle: 'archived' }],
    terminals: [{ state: 'running' }, { state: 'exited' }],
    holders: [holder({}), holder({ ptyId: 'klmnopqrst', sessionId: null, kind: null, pid: null, childPid: null, startedAt: null, alive: null, exited: true, orphan: true })],
    // os-ok: macOS test tool
    banners: [{ kind: 'gitMissing', source: 'git', severity: 'warning', message: 'Git is not available.', fix: 'Install it: run /usr/bin/xcode-select --install' }],
    conditions: [{ agent: 'claude', kind: 'rate_limit', state: 'active', sessionIds: ['S1', 'S2'] }],
    errors: [err({ msg: 'worktree not removed', fields: { path: '/Users/someone/dev/app/.wt/x', code: 'ENOTEMPTY', n: 2 } })],
    unread: [{ proc: 'ptyhost', why: 'the file could not be read' }],
    platform: MAC_REPORT,
    ...more,
  }
}

describe('Copy diagnostics: core’s text', () => {
  it('U-DIAG-3 · the text, section by section: versions, the platform report, CLIs, sessions by state, holders by id and pid, banners, conditions, the newest errors; without paths every path outside the home is <path>, with them it is as written', () => {
    const scrub = { roots: ['/Users/someone'] }
    const text = diagnosticsText(facts(), scrub)
    expect(text.split('\n')).toEqual([
      '# Kea diagnostics',
      'copied 2026-10-13T10:00:00.000Z',
      `file paths: left out (${KEA_HOME_MARK} is Kea’s own folder, ${PATH_MARK} any other path)`,
      '',
      '## Kea',
      'version 0.6.0',
      'electron 39.0.0 · chrome 142.0.1 · node 22.20.0',
      'system Darwin 25.0.0 arm64',
      `home ${KEA_HOME_MARK}`,
      'core up 2 h 5 min',
      'database opened at schema 7, an unreadable one set aside as kea.db.corrupt',
      'git available',
      '',
      '## Platform',
      'macOS 26.0.0 · arm64',
      'Terminals: each in a process of its own that macOS keeps when Kea quits',
      'Terminal drawing: WebGL, on the GPU',
      '',
      '## Agent CLIs',
      'claude  Claude Code  ready  2.1.0  signed in',
      'commandcode  Command Code  missing  no version  (cmd is not on the login shell PATH)',
      '',
      '## Sessions',
      '3 sessions: 2 live, 1 archived',
      '2 terminals, 1 running',
      'claude: limited (active), holds 2 sessions',
      '',
      '## Holders',
      '2 holders, 1 orphaned',
      'abcdefghij  S1  agent  pid 100  child 101  up 3 h 5 min  alive',
      'klmnopqrst  (no state file)  ?  pid ?  child ?  up ?  unconfirmed, program exited, orphan',
      '',
      '## Banners',
      `gitMissing (warning, from git): Git is not available. Fix: Install it: run ${PATH_MARK} --install`,
      '',
      '## Recent errors',
      `the newest 1 warning or error of main, core, ptyhost, renderer (at most ${L.diagnosticsErrorsMax}; the logs are in ${KEA_HOME_MARK}/logs)`,
      'ptyhost: log not read (the file could not be read)',
      `2026-10-13T09:59:00.000Z core warn worktree not removed path=${PATH_MARK} code=ENOTEMPTY n=2`,
    ])
    expect(outsidePaths(text)).toEqual([])

    // "Include file paths": as written, the CLI's place included
    const withPaths = diagnosticsText(facts(), null)
    expect(withPaths).toContain('file paths: included')
    expect(withPaths).toContain(`home ${HOME}`)
    expect(withPaths).toContain('claude  Claude Code  ready  2.1.0  signed in  /opt/homebrew/bin/claude')
    expect(withPaths).toContain('path=/Users/someone/dev/app/.wt/x code=ENOTEMPTY')
    expect(withPaths).toContain(`the logs are in ${HOME}/logs`)
    expect(withPaths).not.toContain(PATH_MARK)

    // nothing to list
    const empty = diagnosticsText(facts({ runtime: { node: '22.20.0' }, database: { fresh: true, setAside: false, fromVersion: 0 }, git: null, agents: [], sessions: [], terminals: [], holders: [], banners: [], conditions: [], errors: [], unread: [] }), scrub)
    for (const l of ['node 22.20.0', 'database new', 'git being looked for', 'none detected yet', 'no sessions', '0 terminals, 0 running', 'none running', 'none', 'no warnings or errors in the logs']) expect(empty.split('\n'), l).toContain(l)
    expect(diagnosticsText(facts({ git: false }), scrub).split('\n')).toContain('git not available')

    // one entry as a line: a value with a space or a quote is quoted, an object is JSON, a long one is cut; a value that
    // is nothing but a relative path names a file of the person's
    const long = 'x'.repeat(L.diagnosticsFieldMaxChars + 50)
    const e = err({ msg: `two\nlines ${long}`, fields: { file: 'src/lib/app.ts', note: 'has space', q: 'a"b', err: { name: 'Error', code: 'EIO' }, ok: true, none: null, url: 'https://example.com/a/b', kind: 'text/plain', big: long } })
    const one = errorText(e, false)
    expect(one.startsWith(`2026-10-13T09:59:00.000Z core warn two lines ${'x'.repeat(L.diagnosticsFieldMaxChars - 'two lines '.length)}… `)).toBe(true)
    expect(one).toContain(` file=${PATH_MARK} note="has space" q="a\\"b" err={"name":"Error","code":"EIO"} ok=true none=null url=https://example.com/a/b kind=${PATH_MARK} big=${'x'.repeat(L.diagnosticsFieldMaxChars)}…`)
    expect(errorText(e, true)).toContain(' file=src/lib/app.ts ')

    // a path that is not quoted runs to the end of its text, since a name may hold spaces: the message and each field
    // are scrubbed by themselves, so one loses its own tail and the fields after it stay. A branch Kea made goes by its
    // name between quotes, and any word shaped like one (`kea/…`) wherever it stands
    const spaced = err({
      msg: 'not a git repository: /Users/someone/Documents/Client Acme/site',
      fields: {
        cwd: '/Users/someone/dev/app',
        path: '/Users/someone/Documents/Client Acme/q3 plan.md',
        error: `fatal: 'topic-acme-launch' is already checked out at '/Users/someone/dev/My App/.wt/x'; open /Volumes/Client Disk/Acme Corp/secret plan.txt failed`,
        branch: 'kea/acme-billing',
        stack: 'Error: no\n    at open (/Users/someone/dev/My App/a.ts:1:2)\n    at run (node:internal/x:3:4)',
        json: { cwd: '/Users/someone/dev/My App', ref: 'kea/acme-billing', n: 1 },
        n: 2,
      },
    })
    const lines = diagnosticsText(facts({ errors: [spaced] }), { ...scrub, names: ['topic-acme-launch'] }).split('\n')
    expect(lines.at(-1)).toBe(
      `2026-10-13T09:59:00.000Z core warn not a git repository: ${PATH_MARK} cwd=${PATH_MARK} path="${PATH_MARK}" error="fatal: '${PATH_MARK}' is already checked out at '${PATH_MARK}'; open ${PATH_MARK}" branch=${PATH_MARK} stack="Error: no\\n    at open (${PATH_MARK}\\n    at run (node:${PATH_MARK})" json={"cwd":"${PATH_MARK}","ref":"${PATH_MARK}","n":1} n=2`,
    )
    for (const word of ['Acme', 'Client', 'q3', 'plan', 'acme', 'someone', 'My App', 'secret']) expect(lines.join('\n'), word).not.toContain(word)
    expect(outsidePaths(lines.join('\n'))).toEqual([])

    for (const [ms, want] of [[0, '0 s'], [59_999, '59 s'], [60_000, '1 min'], [3_600_000, '1 h 0 min'], [90_000_000, '1 d 1 h'], [-5, '0 s']] as const) expect(duration(ms)).toBe(want)
  })

  it('U-DIAG-4 · recent errors are the newest warnings and errors across the processes’ logs, at most L.diagnosticsErrorsMax, read from the end of each file; a line that is no log entry is passed over', () => {
    const t = (s: number) => new Date(AT + s * 1000).toISOString()
    const logs = {
      core: [line('core', 'info', t(1), 'started'), line('core', 'warn', t(2), 'first', { a: 1 }), 'not json', '{"broken":', line('core', 'error', t(5), 'third')].join('\n'),
      main: [line('main', 'debug', t(3), 'noise'), line('main', 'error', t(4), 'second'), JSON.stringify({ level: 'error', msg: 'no time' }), JSON.stringify({ t: 'when', level: 'error', msg: 'bad time' }), line('main', 'error', t(5), 'fourth')].join('\n'),
      renderer: '',
    }
    expect(recentErrors(logs).map((e) => `${e.proc} ${e.level} ${e.msg}`)).toEqual(['main error fourth', 'core error third', 'main error second', 'core warn first'])
    expect(recentErrors(logs)[3]).toEqual({ t: t(2), at: AT + 2000, proc: 'core', level: 'warn', msg: 'first', fields: { a: 1 } })
    // the file's own `proc` is not believed: the log it was read from names the process
    expect(recentErrors({ ptyhost: line('core', 'warn', t(1), 'x') })[0]?.proc).toBe('ptyhost')
    expect(recentErrors(logs, 2).map((e) => e.msg)).toEqual(['fourth', 'third'])
    const many = Array.from({ length: L.diagnosticsErrorsMax + 20 }, (_, i) => line('core', 'warn', t(i), `w${i}`)).join('\n')
    const newest = recentErrors({ core: many })
    expect(newest).toHaveLength(L.diagnosticsErrorsMax)
    expect(newest[0]?.msg).toBe(`w${L.diagnosticsErrorsMax + 19}`)

    // the end of a file, from its first whole line
    const dir = tmp()
    const file = path.join(dir, 'core.log')
    fs.writeFileSync(file, 'first line\nsecond line\nthird line\n')
    expect(readTail(file)).toBe('first line\nsecond line\nthird line\n')
    expect(readTail(file, 15)).toBe('third line\n')
    expect(readTail(file, 11)).toBe('third line\n')
    expect(readTail(file, 3)).toBe('')
    fs.writeFileSync(path.join(dir, 'one.log'), 'a line with no end')
    expect(readTail(path.join(dir, 'one.log'), 4)).toBe('')
    expect(readTail(path.join(dir, 'one.log'))).toBe('a line with no end')
    expect(readTail(path.join(dir, 'none.log'))).toBeNull()
    fs.writeFileSync(file, '')
    expect(readTail(file)).toBe('')
  })

  it('U-DIAG-5 · collect reads each process’s log in <KEA_HOME>/logs, lists the holders once, and scrubs the home under both of its names; a holder list that fails leaves the section empty', async () => {
    const link = path.join(tmp(), 'home-link')
    const home = path.join(tmp(), 'home')
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true })
    fs.symlinkSync(home, link)
    const now = new Date(AT - 1000).toISOString()
    fs.writeFileSync(path.join(home, 'logs', 'core.log'), `${line('core', 'warn', now, `state file ${home}/run/x.json unreadable`, { other: `${link}/sessions/S1`, wt: '/srv/work trees/app/x' })}\n`)
    fs.writeFileSync(path.join(home, 'logs', 'renderer.log'), `${line('renderer', 'error', now, 'boom')}\n`)
    // a log that is a folder cannot be read
    fs.mkdirSync(path.join(home, 'logs', 'main.log'))
    let asked = 0
    let fail = false
    const d = new Diagnostics({
      home: link,
      version: '0.6.0',
      log: noopLogger,
      now: () => AT,
      database: { fresh: true, setAside: false, fromVersion: 0 },
      git: () => true,
      agents: () => [],
      sessions: () => [],
      terminals: () => [],
      holders: async () => {
        asked++
        if (fail) throw new Error('ptyhost is gone')
        return [holder({})]
      },
      banners: () => [],
      conditions: () => [],
      roots: () => ['/srv/work trees'],
    })
    const text = await d.collect(false)
    expect(asked).toBe(1)
    expect(text).toContain(`core warn state file ${KEA_HOME_MARK}/run/x.json unreadable other=${KEA_HOME_MARK}/sessions/S1 wt="${PATH_MARK}"`)
    expect(text).toContain('renderer error boom')
    expect(text).toContain('main: log not read (the file could not be read)')
    expect(text).toContain('abcdefghij  S1  agent')
    expect(text).not.toContain(home)
    expect(text).not.toContain(link)
    expect(outsidePaths(text)).toEqual([])
    expect(await d.collect(true)).toContain(`home ${link}`)

    fail = true
    expect(await d.collect(false)).toContain('## Holders\nnone running')
    expect(await d.handlers()['diagnostics.collect']!({}, {} as never)).toEqual({ text: await d.collect(false) })
  })

  it('U-DIAG-10 · the folder worktrees are made in by default stands in the home, and its folders carry a project’s and a session’s name: without paths nothing under it is named, whatever sessions are left, while Kea’s own files keep their place in the home', async () => {
    const home = path.join(tmp(), 'home')
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true })
    const now = new Date(AT - 1000).toISOString()
    const wt = `${home}/worktrees/acme-site/fix-acme-billing-bug`
    fs.writeFileSync(
      path.join(home, 'logs', 'core.log'),
      [
        line('core', 'warn', now, 'worktree not removed', { path: wt, error: `fatal: '${wt}' contains modified or untracked files, use --force to delete it` }),
        line('core', 'warn', now, `trash not emptied ${home}/worktrees/.kea-trash/fix-acme-billing-bug-1`, { url: `file://${wt}/index.html` }),
        line('core', 'warn', now, `state file ${home}/run/x.json unreadable`),
      ].join('\n') + '\n',
    )
    const d = new Diagnostics({
      home,
      version: '0.6.0',
      log: noopLogger,
      now: () => AT,
      database: { fresh: true, setAside: false, fromVersion: 0 },
      git: () => true,
      agents: () => [],
      sessions: () => [],
      terminals: () => [],
      holders: async () => [],
      banners: () => [],
      conditions: () => [],
      // every worktree session is deleted and the setting is unset: nothing names the folder
      roots: () => [],
    })
    const text = await d.collect(false)
    expect(text).toContain('worktree not removed')
    expect(text).toContain(`state file ${KEA_HOME_MARK}/run/x.json unreadable`)
    for (const word of ['acme', 'billing', 'worktrees/']) expect(text, word).not.toContain(word)
    expect(outsidePaths(text)).toEqual([])
    expect(await d.collect(true)).toContain(wt)
  })

  it('U-DIAG-12 · the platform report main sent is the text’s Platform section (each line with its fix where it is not the full answer), scrubbed without paths and as written with them; until main sends one the section says so; About is answered with it as sent, and a status report gets it scrubbed', async () => {
    const home = path.join(tmp(), 'home')
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true })
    const user = path.join(tmp(), 'user')
    const helper = path.join(user, 'kea-src', 'node_modules', 'electron', 'dist', 'chrome-sandbox')
    const report: PlatformReport = {
      system: 'linux',
      version: 'Linux 6.8.0-49-generic',
      arch: 'arm64',
      lines: [
        { id: 'holderDetach', label: 'Terminals', value: 'each in a systemd scope of its own, which outlives Kea', fix: null },
        { id: 'rendererSandbox', label: 'Window sandbox', value: 'off: the window runs without Chromium’s sandbox', fix: `Start Kea without --no-sandbox; if Chromium cannot start its sandbox, run sudo chown root:root ${helper} and sudo chmod 4755 ${helper}.` },
      ],
    }
    const d = new Diagnostics({
      home,
      version: '0.6.0',
      log: noopLogger,
      now: () => AT,
      database: { fresh: true, setAside: false, fromVersion: 0 },
      git: () => true,
      agents: () => [],
      sessions: () => [],
      terminals: () => [],
      holders: async () => [],
      banners: () => [],
      conditions: () => [],
      roots: () => [user],
    })
    const section = (text: string): string[] => {
      const lines = text.split('\n')
      const at = lines.indexOf('## Platform')
      return lines.slice(at, lines.indexOf('', at))
    }

    // nothing from main yet: the section says so, About gets null, a status report none
    expect(section(await d.collect(false))).toEqual(['## Platform', 'not known yet: main has not sent the platform report'])
    expect(await d.handlers()['diagnostics.platform']!({}, {} as never)).toEqual({ report: null })
    expect(d.scrubbedPlatform()).toBeNull()

    d.setPlatform(report)
    const plain = await d.collect(false)
    expect(section(plain)).toEqual([
      '## Platform',
      'Linux 6.8.0-49-generic · arm64',
      'Terminals: each in a systemd scope of its own, which outlives Kea',
      `Window sandbox: off: the window runs without Chromium’s sandbox. Fix: Start Kea without --no-sandbox; if Chromium cannot start its sandbox, run sudo chown root:root ${PATH_MARK}`,
    ])
    expect(plain).not.toContain(user)
    expect(outsidePaths(plain)).toEqual([])
    expect(section(await d.collect(true))).toContain(`Window sandbox: off: the window runs without Chromium’s sandbox. Fix: Start Kea without --no-sandbox; if Chromium cannot start its sandbox, run sudo chown root:root ${helper} and sudo chmod 4755 ${helper}.`)

    // About shows it as sent (it stays in the window); a status report's copy is scrubbed as the text is
    expect(await d.handlers()['diagnostics.platform']!({}, {} as never)).toEqual({ report })
    const copy = d.scrubbedPlatform()!
    expect(JSON.stringify(copy)).not.toContain(user)
    expect(copy.lines.map((l) => l.fix === null)).toEqual([true, false])
    expect(copy.lines[1]!.fix).toContain(PATH_MARK)

    // the next report replaces it
    d.setPlatform({ ...report, lines: [report.lines[0]!] })
    expect(section(await d.collect(false))).toHaveLength(3)
  })
})
