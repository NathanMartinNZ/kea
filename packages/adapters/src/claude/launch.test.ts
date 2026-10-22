import { L } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import type { LaunchContext } from '../types.ts'
import { ENV_NO_FLICKER, ENV_REMOVED, HOOK_EVENTS } from './contract.ts'
import { buildLaunch, buildResume, hookArgs, injectedSettings, projection, promptArg } from './launch.ts'

const UUID = '6f1c2b8e-1d2a-4c55-9a7e-0b3c4d5e6f70'
const ctx = (o: Partial<LaunchContext> = {}): LaunchContext => ({
  keaSessionId: '01JXKEASESSION0000000000AA',
  agentSessionId: UUID,
  cwd: '/tmp/wt/fix-auth',
  helperPath: '/Applications/Kea.app/Contents/Resources/kea-helper', // os-ok: test data
  keaHome: '/tmp/kea-home',
  portBase: 41000,
  binary: '/opt/bin/claude',
  version: '2.1.296',
  env: { PATH: '/usr/bin:/bin', HOME: '/tmp/h', KEA_SESSION_ID: '01JXKEASESSION0000000000AA', LANG: 'en_US.UTF-8' },
  settings: { extraArgs: [], env: {}, allowDangerousModes: false, renderer: 'agent-default' },
  ownWorktree: true,
  ...o,
})

/** The argv with the inline settings JSON replaced by a marker (its own test is U-AGT-2). */
const shape = (args: string[]) => args.map((a, i) => (args[i - 1] === '--settings' ? '<settings>' : a))

describe('claude launch', () => {
  it('U-AGT-1 · buildLaunch: golden argv over prompt variants × model/effort/mode present or absent; the prompt is one argv element, last, after --', () => {
    const prompts: [string, string[]][] = [
      ['', []],
      ['fix the login redirect loop', ['--', 'fix the login redirect loop']],
      ['doctor', ['--', 'doctor ']],
      ['--help me', ['--', '--help me']],
      ['-p', ['--', '-p ']],
      ['line one\nline two', ['--', 'line one\nline two']],
      ['"; rm -rf ~ # `id` $(whoami)', ['--', '"; rm -rf ~ # `id` $(whoami)']],
      ['🦜 émoji ok', ['--', '🦜 émoji ok']],
      ['/compact', ['--', '/compact ']],
      ['x'.repeat(100 * 1024), ['--', `${'x'.repeat(100 * 1024)} `]],
    ]
    const knobs: [Record<string, string>, string[]][] = [
      [{}, []],
      [{ model: 'default' }, []],
      [{ model: 'opus' }, ['--model', 'opus']],
      [{ effort: 'high' }, ['--effort', 'high']],
      [{ permissionMode: 'manual' }, ['--permission-mode', 'manual']],
      [{ model: 'claude-fable-5-1', effort: 'max', permissionMode: 'plan' }, ['--model', 'claude-fable-5-1', '--effort', 'max', '--permission-mode', 'plan']],
    ]
    for (const [prompt, tail] of prompts) {
      for (const [k, kArgs] of knobs) {
        const s = buildLaunch({ prompt, ...k }, ctx())
        expect(s.file).toBe('/opt/bin/claude')
        expect(shape(s.args)).toEqual(['--session-id', UUID, ...kArgs, '--settings', '<settings>', ...tail])
        expect(s.cwd).toBe('/tmp/wt/fix-auth')
        expect(s.agentSessionId).toBe(UUID)
        if (prompt !== '') {
          // one element, the last, right after the end of the options
          expect(s.args.at(-1)).toBe(tail[1])
          expect(s.args.at(-2)).toBe('--')
          expect(s.args.filter((a) => a === tail[1])).toHaveLength(1)
        }
      }
    }
    // extra arguments (settings, then the composer's) come before the prompt; an unknown mode is not passed
    const s = buildLaunch({ prompt: 'go now', permissionMode: 'nonsense', extraArgs: ['--add-dir', '/x'] }, ctx({ settings: { extraArgs: ['--verbose'], env: {}, allowDangerousModes: false } }))
    expect(shape(s.args)).toEqual(['--session-id', UUID, '--settings', '<settings>', '--verbose', '--add-dir', '/x', '--', 'go now'])
    // below the alias gate the default mode is passed by its old name
    expect(buildLaunch({ prompt: '', permissionMode: 'manual' }, ctx({ version: '2.1.150' })).args).toContain('default')
    expect(() => buildLaunch({ prompt: '' }, ctx({ agentSessionId: undefined }))).toThrow(/session id/)
    expect(promptArg('a\tb')).toBe('a\tb')
  })

  it('U-AGT-2 · injected settings: valid JSON with every listed event, each hook synchronous, timeout L.hookTimeoutS, exec form, absolute helper, generated projection, no statusLine', () => {
    const json = injectedSettings(ctx())
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(L.settingsInlineMaxBytes)
    const o = JSON.parse(json) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> } & Record<string, unknown>
    expect(Object.keys(o)).toEqual(['hooks'])
    expect(o.statusLine).toBeUndefined()
    expect(o.disableAllHooks).toBeUndefined()
    expect(Object.keys(o.hooks).sort()).toEqual([...HOOK_EVENTS].sort())
    for (const e of HOOK_EVENTS) {
      expect(o.hooks[e]).toHaveLength(1)
      const [h] = o.hooks[e]![0]!.hooks
      // os-ok: test data
      expect(h).toEqual({ type: 'command', command: '/Applications/Kea.app/Contents/Resources/kea-helper', args: hookArgs(ctx()), timeout: L.hookTimeoutS })
      expect('async' in h!).toBe(false)
      expect(String(h!.command).startsWith('/')).toBe(true)
    }
    const args = hookArgs(ctx())
    expect(args.slice(0, 6)).toEqual(['hook', 'claude', '--session', '01JXKEASESSION0000000000AA', '--home', '/tmp/kea-home'])
    expect(args[6]).toBe('--project')
    expect(JSON.parse(args[7]!)).toEqual(projection())
    expect(projection().keep).toContain('hook_event_name')
    expect(projection().keep).toContain('effort.level')
    expect(projection().count).toEqual(['background_tasks', 'session_crons'])
    expect(projection().summarise).toContain('tool_input.command')
    expect(projection().critical.values).toContain('Stop')
    // the settings reach Claude whole: one argv element
    const s = buildLaunch({ prompt: 'hi there' }, ctx())
    expect(s.args[s.args.indexOf('--settings') + 1]).toBe(json)
  })

  it('U-AGT-4 · buildResume re-passes --settings, omits the prompt, and targets the conversation id the session holds now (after /clear)', () => {
    const rec = { keaSessionId: '01JXKEASESSION0000000000AA', agentSessionId: UUID, transcriptPath: null, cwd: '/tmp/wt/fix-auth', launch: { prompt: 'the original prompt', model: 'opus', effort: 'high', permissionMode: 'plan' } }
    const r = buildResume(rec, ctx())!
    expect(shape(r.args)).toEqual(['--resume', UUID, '--settings', '<settings>', '--model', 'opus', '--effort', 'high'])
    expect(r.args.join(' ')).not.toContain('the original prompt')
    expect(r.args).not.toContain('--session-id')
    expect(r.args[r.args.indexOf('--settings') + 1]).toBe(injectedSettings(ctx()))
    const cleared = '0a0b0c0d-1111-4222-8333-444455556666'
    expect(buildResume({ ...rec, agentSessionId: cleared }, ctx())!.args.slice(0, 2)).toEqual(['--resume', cleared])
    expect(buildResume({ ...rec, agentSessionId: cleared }, ctx())!.agentSessionId).toBe(cleared)
    // bypass is re-passed only when the session was created with it; other modes are Claude's to restore
    expect(buildResume({ ...rec, launch: { prompt: '', permissionMode: 'bypassPermissions' } }, ctx())!.args).toContain('bypassPermissions')
    expect(buildResume({ ...rec, agentSessionId: null }, ctx())).toBeNull()
  })

  it('U-AGT-9 · environment: KEA_* kept, CLAUDECODE, Claude session markers and Electron/Node internals removed, the user environment otherwise untouched', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/tmp/h',
      KEA_SESSION_ID: '01JXKEASESSION0000000000AA',
      KEA_WORKTREE: '/tmp/wt/fix-auth',
      KEA_PORT: '41000',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_CHANNEL_FD: '3',
      CLAUDE_CONFIG_DIR: '/tmp/h/.cfg',
      ANTHROPIC_MODEL: 'user-choice',
      NODE_OPTIONS: '--max-old-space-size=4096',
      MY_VAR: 'kept',
    }
    const s = buildLaunch({ prompt: '' }, ctx({ env }))
    for (const k of ['PATH', 'HOME', 'KEA_SESSION_ID', 'KEA_WORKTREE', 'KEA_PORT', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_MODEL', 'NODE_OPTIONS', 'MY_VAR']) expect(s.env[k]).toBe(env[k as keyof typeof env])
    for (const k of [...ENV_REMOVED, 'ELECTRON_RUN_AS_NODE', 'NODE_CHANNEL_FD']) expect(s.env[k]).toBeUndefined()
    expect(s.unset.sort()).toEqual(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'ELECTRON_RUN_AS_NODE', 'NODE_CHANNEL_FD'])
    expect(s.env[ENV_NO_FLICKER]).toBeUndefined()
    // the agent's extra environment and the renderer setting are laid over it
    const r = buildLaunch({ prompt: '' }, ctx({ env, settings: { extraArgs: [], env: { MY_VAR: 'over', EXTRA: 'x' }, allowDangerousModes: false, renderer: 'classic' } }))
    expect(r.env.MY_VAR).toBe('over')
    expect(r.env.EXTRA).toBe('x')
    expect(r.env[ENV_NO_FLICKER]).toBe('0')
    expect(buildLaunch({ prompt: '' }, ctx({ settings: { extraArgs: [], env: {}, allowDangerousModes: false, renderer: 'fullscreen' } })).env[ENV_NO_FLICKER]).toBe('1')
    // resume gets the same environment
    expect(buildResume({ keaSessionId: 'k', agentSessionId: UUID, transcriptPath: null, cwd: '/x', launch: { prompt: '' } }, ctx({ env }))!.unset.sort()).toEqual(s.unset)
  })
})
