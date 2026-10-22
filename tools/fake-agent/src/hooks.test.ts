import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeHooks, type HookConfig, hooksDisabledBy, parseClaudeSettings, runCommand, selectHooks, SettingsError } from './hooks.ts'
import { ModHost } from './mods.ts'

const dir = mkdtempSync(join(tmpdir(), 'fake-agent-hooks-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// A stub hook: appends {argv, stdin, env} as one JSON line to the file named by its first argument.
const STUB = join(dir, 'stub-hook.mjs')
writeFileSync(
  STUB,
  `import { appendFileSync } from 'node:fs'
let input = ''
process.stdin.setEncoding('utf8').on('data', (d) => (input += d)).on('end', () => {
  appendFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), stdin: input, sid: process.env.CLAUDE_CODE_SESSION_ID }) + '\\n')
})
`,
)
// A hook that never exits (for the timeout).
const HANG = join(dir, 'hang.mjs')
writeFileSync(HANG, 'setInterval(() => {}, 1 << 30)\n')
// A module without a default export (a broken mod).
const NO_DEFAULT = join(dir, 'no-default.mjs')
writeFileSync(NO_DEFAULT, 'export const x = 1\n')

const records = (file: string) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { argv: string[]; stdin: string; sid?: string })

const INFO = { sessionId: '0b3c2f6e-2a8e-4f0e-9a51-1c2d3e4f5a6b', transcriptPath: '/fake/t.jsonl', cwd: dir, permissionMode: 'default', model: 'opus', source: 'startup' }

function settingsFor(out: string, events: string[], extra: Record<string, unknown> = {}): string {
  const hook = { type: 'command', command: process.execPath, args: [STUB, out, 'hook', 'claude', '--session', 'k1', 'a b;$(echo no)'], timeout: 5, ...extra }
  return JSON.stringify({ model: 'ignored', hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [hook] }]])) })
}

describe('fake-agent hooks', () => {
  it('U-FAKE-10 · --settings hooks parse (inline JSON or a file), non-command hooks are skipped, matchers select by the event field', () => {
    const file = join(dir, 'settings.json')
    writeFileSync(file, settingsFor('/x', ['Stop']))
    expect(parseClaudeSettings(file).Stop?.[0]?.hooks[0]?.args).toEqual([STUB, '/x', 'hook', 'claude', '--session', 'k1', 'a b;$(echo no)'])
    const cfg: HookConfig = parseClaudeSettings(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Edit|Write', hooks: [{ type: 'command', command: '/a' }] },
            { matcher: '*', hooks: [{ type: 'command', command: '/b', args: [] }, { type: 'prompt', prompt: 'x' }] },
            { hooks: [{ type: 'command', command: '/c', timeout: 2 }] },
          ],
          SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: '/d' }] }],
        },
      }),
    )
    const cmds = (event: string, p: Record<string, unknown>) => selectHooks(cfg, event, p).map((h) => h.command)
    expect(cmds('PreToolUse', { tool_name: 'Write' })).toEqual(['/a', '/b', '/c'])
    expect(cmds('PreToolUse', { tool_name: 'Bash' })).toEqual(['/b', '/c'])
    expect(cmds('PreToolUse', { tool_name: 'WriteFile' })).toEqual(['/b', '/c']) // matchers are anchored
    expect(cmds('SessionStart', { source: 'startup' })).toEqual([])
    expect(cmds('SessionStart', { source: 'resume' })).toEqual(['/d'])
    expect(selectHooks(cfg, 'PreToolUse', { tool_name: 'Edit' })[2]).toEqual({ command: '/c', args: null, timeoutSec: 2 })
    expect(selectHooks(cfg, 'PreToolUse', { tool_name: 'Edit' })[0]?.timeoutSec).toBe(60) // Claude's default
    expect(parseClaudeSettings('{}')).toEqual({})
    expect(() => parseClaudeSettings('{"hooks": {"Stop": {}}}')).toThrow(SettingsError)
    expect(() => parseClaudeSettings('{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "/x", "args": "no"}]}]}}')).toThrow(/args must be an array/)
    expect(() => parseClaudeSettings('{nope')).toThrow(/not JSON/)
  })

  it('U-FAKE-11 · hooks are exec\'d without a shell, get the payload on stdin and are waited for in emission order', async () => {
    const out = join(dir, 'u11.jsonl')
    const hooks = new ClaudeHooks(parseClaudeSettings(settingsFor(out, ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'])), INFO, process.env)
    const fired = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']
    for (const e of fired) {
      const { runs } = await hooks.fire(e, { tool: e.includes('Tool') ? 'Bash' : null, input: e.includes('Tool') ? { command: 'ls' } : null, fields: e === 'UserPromptSubmit' ? { prompt: 'hi' } : {} })
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({ exitCode: 0, timedOut: false, error: null })
      // synchronous: the record is on disk before fire() resolves
      expect(records(out).length).toBe(fired.indexOf(e) + 1)
    }
    const got = records(out)
    expect(got.map((r) => (JSON.parse(r.stdin) as { hook_event_name: string }).hook_event_name)).toEqual(fired)
    // argv arrived exactly: no shell expanded `$(…)` or split on the space or `;`
    expect(got[0]?.argv).toEqual(['hook', 'claude', '--session', 'k1', 'a b;$(echo no)'])
    expect(got[0]?.sid).toBe(INFO.sessionId)
    // events not configured run nothing
    expect((await hooks.fire('Notification', { tool: null, input: null, fields: {} })).runs).toEqual([])
    // a missing binary is reported, not thrown
    const r = await runCommand(join(dir, 'missing'), [], { cwd: dir, env: process.env, input: '', timeoutMs: 1000 })
    expect(r.error).toMatch(/ENOENT/)
  })

  it('U-FAKE-12 · a hook that outlives its timeout is killed and the agent moves on', async () => {
    const hooks = new ClaudeHooks(parseClaudeSettings(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: process.execPath, args: [HANG], timeout: 0.2 }] }] } })), INFO, process.env)
    const { runs } = await hooks.fire('Stop', { tool: null, input: null, fields: {} })
    expect(runs[0]).toMatchObject({ timedOut: true, signal: 'SIGKILL', exitCode: null })
  })

  it('U-FAKE-13 · payloads have Claude\'s shapes: common fields, tool_use_id pairing, no tool_use_id on PermissionRequest, fields override or (null) remove', () => {
    const h = new ClaudeHooks({}, INFO, {})
    const none = { tool: null, input: null, fields: {} }
    expect(h.payload('SessionStart', none)).toEqual({ session_id: INFO.sessionId, transcript_path: '/fake/t.jsonl', cwd: dir, hook_event_name: 'SessionStart', source: 'startup', model: 'opus' })
    const pre = h.payload('PreToolUse', { tool: 'Write', input: { file_path: 'a.txt' }, fields: {} })
    expect(pre).toMatchObject({ permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'a.txt' }, tool_use_id: 'toolu_fake_0001' })
    const perm = h.payload('PermissionRequest', none)
    expect(perm).toMatchObject({ tool_name: 'Write', tool_input: { file_path: 'a.txt' } })
    expect(perm).not.toHaveProperty('tool_use_id')
    expect(h.payload('PostToolUse', none)).toMatchObject({ tool_name: 'Write', tool_use_id: 'toolu_fake_0001', tool_response: {} })
    expect(h.payload('PreToolUse', { tool: 'Bash', input: null, fields: {} })).toMatchObject({ tool_use_id: 'toolu_fake_0002', tool_input: {} })
    expect(h.payload('Stop', none)).toMatchObject({ stop_hook_active: false, background_tasks: [], session_crons: [] })
    expect(h.payload('StopFailure', { tool: null, input: null, fields: { error: 'overloaded' } })).toMatchObject({ error: 'overloaded' })
    expect(h.payload('Notification', none)).toMatchObject({ notification_type: 'permission_prompt' })
    const end = h.payload('SessionEnd', { tool: null, input: null, fields: { reason: 'logout', cwd: null } })
    expect(end).toMatchObject({ hook_event_name: 'SessionEnd', reason: 'logout' })
    expect(end).not.toHaveProperty('cwd')
    expect(end).not.toHaveProperty('permission_mode')
  })

  it('U-FAKE-14 · --as commandcode hosts --mod modules as 1.79.2 does: cmd.on events in its shapes and order, the session id only in the session hooks, options bound with the session, cmd.exec without a shell', async () => {
    const out = join(dir, 'u14.jsonl')
    const execOut = join(dir, 'u14-exec.jsonl')
    const mod = join(dir, 'kea-mod-stub.ts')
    writeFileSync(
      mod,
      `import { appendFileSync } from 'node:fs'
type Cmd = { name: string; addFlag: (n: string, o: object) => void; getFlag: (n: string) => unknown; on: (e: string, h: (p: unknown) => unknown) => void; hooks: (h: object) => void; exec: (o: object) => Promise<unknown> }
export default function (cmd: Cmd) {
  const note = (p: unknown) => appendFileSync(${JSON.stringify(out)}, JSON.stringify(p) + '\\n')
  cmd.addFlag('opt', { type: 'string', default: 'unset' })
  note({ type: 'loaded', mod: cmd.name, opt: cmd.getFlag('opt'), undeclared: cmd.getFlag('other') ?? null })
  for (const e of ['session_start', 'tool_queued', 'tool_running', 'tool_errored', 'session_shutdown']) cmd.on(e, note)
  cmd.on('run_start', () => { throw new Error('a mod that throws') })
  cmd.on('tool_running', (p) => cmd.exec({ command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(STUB)}, ${JSON.stringify(execOut)}, 'hook', 'commandcode', 'a b;$(echo no)'], input: JSON.stringify(p) }))
  cmd.hooks({
    onSessionStart: (a: object) => note({ hook: 'onSessionStart', ...a, opt: cmd.getFlag('opt'), undeclared: cmd.getFlag('other') ?? null }),
    onSessionEnd: (a: object) => note({ hook: 'onSessionEnd', ...a }),
  })
}
`,
    )
    const info = { sessionId: 's1', cwd: dir, permissionMode: 'default', model: 'm', source: 'startup' as const, modOptions: { opt: 'given', other: 'x' } }
    const host = new ModHost(info, process.env)
    await host.load([mod], dir)
    const notes = () =>
      readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    const fire = (e: string, fields: Record<string, string> = {}) => host.fire(e, { tool: e.startsWith('tool') ? 'shell_command' : null, input: e === 'tool_queued' ? { command: 'ls' } : null, fields })
    await fire('session_start')
    await fire('run_start')
    expect(host.errors).toEqual([{ event: 'run_start', message: 'a mod that throws' }]) // recorded: the agent goes on
    expect((await fire('tool_queued')).runs).toHaveLength(0)
    // the program a handler ran is finished (and reported) before the next step
    const running = await fire('tool_running')
    expect(running.runs).toMatchObject([{ exitCode: 0, args: [STUB, execOut, 'hook', 'commandcode', 'a b;$(echo no)'] }])
    expect(records(execOut)).toMatchObject([{ argv: ['hook', 'commandcode', 'a b;$(echo no)'], stdin: JSON.stringify(running.payload) }])
    await fire('tool_errored')
    await fire('run_end') // nothing subscribed to it
    // an end by a signal or a closed terminal: Command Code 1.79.2 says nothing at all
    expect(await fire('session_shutdown', { reason: 'other' })).toEqual({ payload: { type: 'session_shutdown', silent: true }, runs: [] })
    expect((await fire('session_shutdown', { reason: 'prompt_input_exit' })).payload).toEqual({ type: 'session_shutdown', reason: 'shutdown' })
    expect(notes()).toEqual([
      // before the session is bound an option answers its default; an undeclared one never answers
      { type: 'loaded', mod: 'kea-mod-stub', opt: 'unset', undeclared: null },
      { type: 'session_start' },
      { hook: 'onSessionStart', source: 'startup', sessionId: 's1', opt: 'given', undeclared: null },
      { type: 'tool_queued', toolCallId: 'toolu_fake_0001', toolName: 'shell_command', input: { command: 'ls' } },
      { type: 'tool_running', toolCallId: 'toolu_fake_0001', toolName: 'shell_command', description: null },
      { type: 'tool_errored', toolCallId: 'toolu_fake_0001', toolName: 'shell_command', error: 'the tool failed', deferred: false },
      { hook: 'onSessionEnd', reason: 'shutdown' },
      { type: 'session_shutdown' },
    ])
    // what a mod must not forward whole, and the scenario's fields laid over an event one level deep
    expect(host.payload('run_end', { tool: null, input: null, fields: { result: { finalText: 'done', stopReason: 'interrupted' } } }).result).toMatchObject({ finalText: 'done', stopReason: 'interrupted', turnCount: 1, nextState: { sessionId: 's1' } })
    expect(host.payload('run_error', { tool: null, input: null, fields: { error: { status: 401 } } }).error).toEqual({ name: 'TransportError', message: 'the run failed', status: 401, retryable: false })
    expect(host.payload('permission_mode_changed', { tool: null, input: null, fields: { mode: 'plan' } })).toEqual({ type: 'permission_mode_changed', mode: 'plan' })
    // another conversation in the same process (`/clear`): the old one ends as replaced, the new one's id is announced
    const ids: string[] = []
    host.onSessionId = (id) => ids.push(id)
    await fire('session_shutdown', { reason: 'replaced' })
    await fire('session_start', { sessionId: 's2' })
    expect(ids).toEqual(['s2'])
    expect(host.sessionId).toBe('s2')
    expect(notes().slice(-4)).toMatchObject([{ hook: 'onSessionEnd', reason: 'replaced' }, { type: 'session_shutdown' }, { type: 'session_start' }, { hook: 'onSessionStart', sessionId: 's2' }])
    await expect(new ModHost({ ...info, sessionId: 's' }, {}).load([NO_DEFAULT], dir)).rejects.toThrow(/no default export/)
  })

  it('U-FAKE-29 · disableAllHooks: true in the user’s or the project’s settings turns every hook off, unless the inline settings say false; the account’s own config dir is never read', () => {
    const files: Record<string, string> = {}
    const read = (f: string) => {
      if (!(f in files)) throw new Error('ENOENT')
      return files[f]!
    }
    const o = { configDir: '/cfg', cwd: '/w', inline: '{"hooks":{}}' }
    expect(hooksDisabledBy(o, read)).toBeNull()
    files['/w/.claude/settings.local.json'] = '{"disableAllHooks": false}'
    expect(hooksDisabledBy(o, read)).toBeNull()
    files['/w/.claude/settings.json'] = '{"disableAllHooks": true}'
    expect(hooksDisabledBy(o, read)).toBe('/w/.claude/settings.json')
    files['/cfg/settings.json'] = '{"disableAllHooks": true}'
    expect(hooksDisabledBy(o, read)).toBe('/cfg/settings.json')
    expect(hooksDisabledBy({ ...o, inline: '{"disableAllHooks": false, "hooks": {}}' }, read), 'inline false wins').toBeNull()
    delete files['/w/.claude/settings.json']
    expect(hooksDisabledBy({ ...o, configDir: null }, read), 'a null config dir is not read').toBeNull()
    files['/w/.claude/settings.json'] = 'not json'
    expect(hooksDisabledBy({ ...o, configDir: null }, read)).toBeNull()
  })
})
