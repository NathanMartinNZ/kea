// Copy diagnostics with the real pieces: core assembled as main.ts assembles it, on a temp KEA_HOME, wired to a real
// ptyhost and real holders, a session in a worktree outside the home whose terminal printed a secret and took it as its
// title. The logs are written with kit's file logger, as each process writes its own. The text's sections one by one,
// and what the window adds (the resource report), have unit tests of their own.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger } from '@kea/kit'
import { KEA_HOME_MARK, outsidePaths, PATH_MARK, type SessionView } from '@kea/protocol'
import { until } from '../support/holders.ts'
import { readStream } from './core-support.ts'
import { createArgs, repo, startSessions, type SessionsUnderTest } from './core-sessions-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

function tmpDir(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

async function create(s: SessionsUnderTest, projectId: string, prompt: string): Promise<SessionView> {
  const r = await s.call<{ sessionId: string }>('sessions.create', createArgs(projectId, prompt))
  const v = await s.until(r.sessionId, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
  if (v.lifecycle !== 'live') throw new Error(`creation failed: ${v.creation?.error}`)
  return v
}

describe('Copy diagnostics', () => {
  it('I-DIAG-1 · the text holds no terminal content, and no path outside <KEA_HOME> unless paths were asked for (not a word of one with spaces in its names, nor a session’s branch): versions, CLIs, holders, banners and the logs’ newest warnings and errors', async () => {
    const SECRET = 'hunter2-plum-zebra'
    const PROMPT = 'quokka ledger'
    // the worktrees live outside the home, as with a "Worktree location" of the person's own
    const wtRoot = tmpDir('kea-diag-wt-')
    const s = await startSessions({ settings: { general: { worktreeRoot: wtRoot } } })
    cleanup.push(() => s.dispose())
    const home = s.h.home
    const r = repo()
    cleanup.push(() => r.dispose())
    const p = await s.project(r.root)
    const a = await create(s, p.id, PROMPT)
    expect(a.cwd.startsWith(`${wtRoot}/`), a.cwd).toBe(true)

    // the terminal prints the secret and takes it as its title
    const pty = s.c.core.terminals.sessionRecords(a.id).find((x) => x.kind === 'agent')!.ptyId
    const out = readStream(s.h, pty)
    cleanup.push(() => out.close())
    s.h.manager.get(pty)!.input(`printf '\\033]0;%s\\007%s\\n' ${SECRET} ${SECRET}\r`)
    await until('the terminal printed the secret', () => out.text().includes(`${SECRET}\r\n`) || out.text().split(SECRET).length > 3)

    // each process's log, written as that process writes it
    const dir = path.join(home, 'logs')
    let t = Date.now() - 60_000
    const log = (proc: string) => {
      const l = createLogger({ dir, process: proc, now: () => (t += 1000) })
      cleanup.push(() => l.dispose())
      return l
    }
    const core = log('core')
    core.info('an info line is no error', { path: a.cwd })
    core.warn('worktree not removed', { path: a.cwd, error: `ENOTEMPTY: directory not empty, rmdir '${a.cwd}/node_modules'` })
    core.error('database invariant violated', { table: 'sessions', n: 2 })
    // what git and Node say when something of the person's is in the way: the session's branch (its title's slug), and
    // paths with spaces in their names, quoted and not
    expect(a.branch).toBeTruthy()
    core.warn('branch not removed', { branch: a.branch, error: `error: cannot delete branch '${a.branch}' checked out at '${a.cwd}'` })
    // os-ok: test data
    core.warn('editor settings not read', { error: `ENOENT: no such file or directory, open '${os.homedir()}/Library/Application Support/Some Editor/settings.json'` })
    core.warn(`not a git repository: ${r.root}/sub folder/x`, { n: 1 })
    log('main').warn('window state not saved', { file: path.join(home, 'window.json') })
    log('ptyhost').error(`checkpoint not written for a session in ${r.root}`, { ptyId: pty })
    log('renderer').error('Uncaught TypeError: x is not a function', { source: `file://${r.root}/app.js`, line: 3 })

    const collect = async (args: object) => (await s.call<{ text: string }>('diagnostics.collect', args)).text
    const text = await collect({})

    // the rule: no terminal content, no prompt, and no path outside the home
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(PROMPT)
    expect(text).not.toContain('quokka')
    for (const outside of [wtRoot, r.root, home, os.homedir(), s.env.HOME as string, os.tmpdir()]) expect(text, outside).not.toContain(outside)
    // nor a word of one, nor the session's branch, slug or title, nor the project's name
    for (const word of ['Application Support', 'Some Editor', 'settings.json', 'sub folder', a.branch as string, a.slug, a.title, p.name]) expect(text, word).not.toContain(word)
    expect(outsidePaths(text)).toEqual([])

    // what it does hold
    for (const heading of ['# Kea diagnostics', '## Kea', '## Agent CLIs', '## Sessions', '## Holders', '## Banners', '## Recent errors']) expect(text).toContain(heading)
    expect(text).toMatch(/^version test$/m)
    expect(text).toContain(`home ${KEA_HOME_MARK}`)
    expect(text).toMatch(/^file paths: left out/m)
    expect(text).toMatch(/^shell {2}.* {2}pseudo/m)
    expect(text).toMatch(/^1 session: 1 live$/m)
    // the holder of its terminal, by ptyId and session id
    expect(text).toMatch(new RegExp(`^${pty} {2}${a.id} {2}agent {2}pid \\d+ {2}child \\d+ {2}up \\d+ (s|min) {2}alive$`, 'm'))
    // warnings and errors of every process, newest first; a path in the home stays, as <KEA_HOME>
    expect(text).toContain(`core warn worktree not removed path=${PATH_MARK} error="ENOTEMPTY: directory not empty, rmdir '${PATH_MARK}'"`)
    expect(text).toContain('core error database invariant violated table=sessions n=2')
    expect(text).toContain(`core warn branch not removed branch=${PATH_MARK} error="error: cannot delete branch '${PATH_MARK}' checked out at '${PATH_MARK}'"`)
    expect(text).toContain(`core warn editor settings not read error="ENOENT: no such file or directory, open '${PATH_MARK}'"`)
    expect(text).toContain(`core warn not a git repository: ${PATH_MARK} n=1`)
    expect(text).toContain(`main warn window state not saved file=${KEA_HOME_MARK}/window.json`)
    expect(text).toContain(`ptyhost error checkpoint not written for a session in ${PATH_MARK} ptyId=${pty}`)
    expect(text).toContain(`renderer error Uncaught TypeError: x is not a function source=${PATH_MARK} line=3`)
    expect(text).not.toContain('an info line is no error')

    // "Include file paths": the same text with its paths; still nothing a terminal showed
    const withPaths = await collect({ paths: true })
    expect(withPaths).not.toContain(SECRET)
    expect(withPaths).toMatch(/^file paths: included/m)
    expect(withPaths).toContain(`home ${home}`)
    expect(withPaths).toContain(`core warn worktree not removed path=${a.cwd} `)
    expect(withPaths).toContain(`source=file://${r.root}/app.js`)
    expect(withPaths).not.toContain(PATH_MARK)
  })
})
