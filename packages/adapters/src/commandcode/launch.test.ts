import { L } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import type { LaunchContext } from '../types.ts'
import { CRITICAL_EVENTS, ENV_REMOVED, FIELDS, GATES, MOD_EVENTS, PROJECTION_KEEP, PROJECTION_SUMMARISE, SESSION_END, SESSION_START, TOOL_WAITING } from './contract.ts'
import { decodeOptions } from './kea-mod.ts'
import { buildLaunch, buildResume, hookArgs, isSessionName, modeArg, modeFromEvent, modOptionArg, projection, promptArg, sessionName } from './launch.ts'

const KEA_ID = '01JXKEASESSION0000000000AA'
const AGENT_ID = 'a40a7934-365e-4afd-a57a-506cb16fa4e9'
const ctx = (o: Partial<LaunchContext> = {}): LaunchContext => ({
  keaSessionId: KEA_ID,
  cwd: '/tmp/wt/fix-auth',
  helperPath: '/Applications/Kea.app/Contents/Resources/kea-helper', // os-ok: test data
  keaHome: '/tmp/kea home',
  portBase: 41000,
  binary: '/opt/bin/cmd',
  version: '1.79.2',
  env: { PATH: '/usr/bin:/bin', HOME: '/tmp/h', KEA_SESSION_ID: KEA_ID, LANG: 'en_US.UTF-8' },
  settings: { extraArgs: [], env: {}, allowDangerousModes: false },
  filesDir: '/tmp/kea home/bin/agents/commandcode-0123abcd',
  ownWorktree: true,
  ...o,
})
const MOD = '/tmp/kea home/bin/agents/commandcode-0123abcd/kea-mod.ts'

/** The argv with the mod's option replaced by a marker (its content has its own assertions below). */
const shape = (args: string[]) => args.map((a, i) => (args[i - 1] === '--mod-option' ? '<option>' : a))

describe('commandcode launch', () => {
  it('U-AGT-5 · buildLaunch: golden argv over prompts × knobs; --trust follows its setting and is passed only in a worktree Kea made, never for a session used in place; --name kea-<id> only in the no-mods fallback', () => {
    const prompts: [string, string[]][] = [
      ['', []],
      ['fix the login redirect loop', ['--', 'fix the login redirect loop']],
      ['status', ['--', 'status ']],
      ['--help me', ['--', '--help me']],
      ['-p', ['--', '-p ']],
      ['line one\nline two', ['--', 'line one\nline two']],
      ['"; rm -rf ~ # `id` $(whoami)', ['--', '"; rm -rf ~ # `id` $(whoami)']],
      ['🦜 émoji ok', ['--', '🦜 émoji ok']],
      ['x'.repeat(100 * 1024), ['--', `${'x'.repeat(100 * 1024)} `]],
    ]
    const knobs: [Record<string, string>, string[]][] = [
      [{}, []],
      [{ model: 'default' }, []],
      [{ model: 'deepseek/deepseek-v4-flash' }, ['--model', 'deepseek/deepseek-v4-flash']],
      [{ effort: 'high' }, ['--effort', 'high']],
      [{ permissionMode: 'default' }, ['--permission-mode', 'standard']],
      [{ permissionMode: 'standard' }, ['--permission-mode', 'standard']],
      [{ model: 'inclusionai/ling-3.0-flash-sante:free', effort: 'low', permissionMode: 'plan' }, ['--model', 'inclusionai/ling-3.0-flash-sante:free', '--effort', 'low', '--permission-mode', 'plan']],
      [{ permissionMode: 'yolo' }, ['--permission-mode', 'yolo']],
    ]
    for (const [prompt, tail] of prompts) {
      for (const [k, kArgs] of knobs) {
        const s = buildLaunch({ prompt, ...k }, ctx())
        expect(s.file).toBe('/opt/bin/cmd')
        expect(shape(s.args)).toEqual([...kArgs, '--mod', MOD, '--mod-option', '<option>', '--trust', ...tail])
        expect(s.cwd).toBe('/tmp/wt/fix-auth')
        // the conversation's id is Command Code's to make: the mod's first event carries it
        expect(s.agentSessionId).toBeNull()
        if (prompt !== '') {
          expect(s.args.at(-1)).toBe(tail[1])
          expect(s.args.at(-2)).toBe('--')
        }
      }
    }
    expect(promptArg('status')).toBe('status ')
    expect(promptArg('two words')).toBe('two words')

    // --trust follows `agents.commandcode.autoTrustWorktrees` (default on)
    const trust = (v: unknown) => buildLaunch({ prompt: '' }, ctx({ settings: { extraArgs: [], env: {}, allowDangerousModes: false, autoTrustWorktrees: v } })).args.includes('--trust')
    expect(trust(true)).toBe(true)
    expect(trust(undefined)).toBe(true)
    expect(trust(false)).toBe(false)
    // and only in a worktree Kea made: a session used in place runs in the project's own folder, which Kea never
    // trusts on the person's behalf, whatever the setting (Command Code asks there as it would in their terminal)
    const inPlace = (settings: Record<string, unknown> = {}) => ctx({ cwd: '/Users/dev/code/acme', ownWorktree: false, settings: { extraArgs: [], env: {}, allowDangerousModes: false, ...settings } })
    expect(shape(buildLaunch({ prompt: 'fix it now', model: 'x/y' }, inPlace()).args)).toEqual(['--model', 'x/y', '--mod', MOD, '--mod-option', '<option>', '--', 'fix it now'])
    expect(buildLaunch({ prompt: '' }, inPlace({ autoTrustWorktrees: true })).args).not.toContain('--trust')
    expect(buildLaunch({ prompt: '' }, { ...inPlace(), filesDir: null, agentSessionId: '6f1c2b8e-1d2a-4c55-9a7e-0b3c4d5e6f70' }).args).toEqual(['--name', 'kea-6f1c2b8e-1d2a-4c55-9a7e-0b3c4d5e6f70'])
    // the person's own extra arguments are theirs: `--trust` written there is passed, in place too
    expect(buildLaunch({ prompt: '' }, inPlace({ extraArgs: ['--trust'] })).args.filter((a) => a === '--trust')).toEqual(['--trust'])

    // extra arguments: the agent's settings', then the launch's, after Kea's own and before the prompt
    const extra = buildLaunch({ prompt: 'go on', extraArgs: ['--add-dir', '/tmp/x y'] }, ctx({ settings: { extraArgs: ['--no-auto-update'], env: {}, allowDangerousModes: false } }))
    expect(shape(extra.args)).toEqual(['--mod', MOD, '--mod-option', '<option>', '--trust', '--no-auto-update', '--add-dir', '/tmp/x y', '--', 'go on'])

    // the no-mods fallback: no folder for the mod file, or a CLI below the version the mod was verified on.
    // The conversation is named after the launch's own id, and that name stands in for its id (--resume takes either)
    const LAUNCH = '6f1c2b8e-1d2a-4c55-9a7e-0b3c4d5e6f70'
    const named = ['--name', `kea-${LAUNCH}`, '--trust']
    for (const o of [{ filesDir: null }, { filesDir: undefined }, { version: '1.74.0' }]) {
      const s = buildLaunch({ prompt: '' }, ctx({ ...o, agentSessionId: LAUNCH }))
      expect(s.args).toEqual(named)
      expect(s.agentSessionId).toBe(`kea-${LAUNCH}`)
    }
    expect(buildLaunch({ prompt: 'hi there', model: 'x/y' }, ctx({ version: '1.79.1', agentSessionId: LAUNCH })).args).toEqual(['--model', 'x/y', ...named, '--', 'hi there'])
    // at the gate, above it, and a version that could not be read (assumed compatible): the mod, and no name
    for (const version of [GATES.mods, '1.80.0', '2.0.0', null]) {
      const s = buildLaunch({ prompt: '' }, ctx({ version, agentSessionId: LAUNCH }))
      expect(s.args).toContain('--mod')
      expect(s.args).not.toContain('--name')
      expect(s.agentSessionId).toBeNull()
    }
    expect(sessionName(LAUNCH)).toBe(`kea-${LAUNCH}`)
    expect(isSessionName(`kea-${LAUNCH}`)).toBe(true)
    expect(isSessionName(`kea-${KEA_ID}`)).toBe(true)
    for (const title of ['kea', 'kea-', 'kea-fix', 'Kea-6f1c2b8e-1d2a', 'kea-mod refactor', 'Explain the demo repository']) expect(isSessionName(title)).toBe(false)

    // a mode the contract does not know goes through under its own name; anything that is not a mode name is dropped
    expect(modeArg('accept-edits')).toBe('accept-edits')
    expect(modeArg('auto-accept')).toBe('accept-edits')
    expect(modeArg('bypass')).toBe('yolo')
    expect(modeArg('review-only')).toBe('review-only')
    expect(modeArg('--yolo')).toBeNull()
    expect(modeArg('a b')).toBeNull()
    expect(buildLaunch({ prompt: '', permissionMode: '--yolo' }, ctx()).args).not.toContain('--permission-mode')
    // what `permission_mode_changed` reports, as Kea's ids
    expect(['default', 'auto-accept', 'plan', 'bypass', 'dont-ask', 'future'].map(modeFromEvent)).toEqual(['default', 'accept-edits', 'plan', 'yolo', 'dont-ask', 'future'])

    // the environment: the context's, without what a Command Code process sets for its own children; settings' env on top
    const env = buildLaunch({ prompt: '' }, ctx({ env: { PATH: '/bin', HOME: '/tmp/h', COMMANDCODE_SESSION_ID: 'x', COMMANDCODE_CWD: '/y', ELECTRON_RUN_AS_NODE: '1' }, settings: { extraArgs: [], env: { FOO: 'bar' }, allowDangerousModes: false } }))
    expect(env.env).toEqual({ PATH: '/bin', HOME: '/tmp/h', FOO: 'bar' })
    expect(env.unset.sort()).toEqual(['COMMANDCODE_CWD', 'COMMANDCODE_SESSION_ID', 'ELECTRON_RUN_AS_NODE'])
    for (const k of env.unset) if (k.startsWith('COMMANDCODE_')) expect(ENV_REMOVED).toContain(k)
  })

  it('U-AGT-48 · a launch or a resume without the mod says so (`silent`): nothing it runs can reach Kea, so the trust window, which only an event of the agent’s ends, must not be started for it; with the mod it is not silent', () => {
    const rec = (agentSessionId: string) => ({ keaSessionId: KEA_ID, agentSessionId, transcriptPath: null, cwd: '/tmp/wt/fix-auth', launch: { prompt: '' } })
    for (const o of [{ filesDir: null }, { version: '1.74.0' }, { version: '1.79.1' }]) {
      expect(buildLaunch({ prompt: 'fix it now' }, ctx({ ...o, agentSessionId: KEA_ID })).silent, JSON.stringify(o)).toBe(true)
      expect(buildResume(rec(`kea-${KEA_ID}`), ctx(o))?.silent, JSON.stringify(o)).toBe(true)
    }
    for (const version of [GATES.mods, '1.80.0', null]) {
      expect(buildLaunch({ prompt: 'fix it now' }, ctx({ version })).silent ?? false, String(version)).toBe(false)
      expect(buildResume(rec(AGENT_ID), ctx({ version }))?.silent ?? false, String(version)).toBe(false)
    }
  })

  it('U-AGT-36 · the mod’s option: one argv element that decodes to the helper’s command line, the projection’s paths and the numbers from constants/', () => {
    const arg = modOptionArg(ctx())
    expect(arg).toMatch(/^kea=[A-Za-z0-9_-]+$/) // nothing a shell, an option parser or `name=value` splitting could trip on
    const o = decodeOptions(arg.slice('kea='.length))
    expect(o).toEqual({
      helper: '/Applications/Kea.app/Contents/Resources/kea-helper', // os-ok: test data
      args: ['hook', 'commandcode', '--session', KEA_ID, '--home', '/tmp/kea home', '--project', JSON.stringify(projection())],
      paths: [...projection().keep, ...projection().summarise],
      maxChars: L.hookSummaryMaxChars,
      waitMs: L.ccPermissionQueuedMs,
      timeoutMs: L.hookTimeoutS * 1000,
      maxTools: L.ccModToolsMax,
    })
    expect(hookArgs(ctx())).toEqual(o?.args)
    // the projection is the contract's lists, field for field, and names every field the contract declares
    const p = projection()
    expect(p.keep).toEqual(PROJECTION_KEEP.map((k) => FIELDS[k]))
    expect(p.summarise).toEqual(PROJECTION_SUMMARISE.map((k) => FIELDS[k]))
    expect(p.count).toEqual([])
    expect(p.critical).toEqual({ field: FIELDS.event, values: [...CRITICAL_EVENTS] })
    expect(new Set([...p.keep, ...p.summarise])).toEqual(new Set(Object.values(FIELDS)))
    for (const e of CRITICAL_EVENTS) expect([...MOD_EVENTS, SESSION_START, SESSION_END, TOOL_WAITING]).toContain(e)
    // an option that is not Kea's decodes to nothing (the mod then stays silent)
    for (const bad of ['', 'x', Buffer.from('{"helper":"relative","args":[],"paths":[]}').toString('base64url'), Buffer.from('[]').toString('base64url'), 42, undefined]) expect(decodeOptions(bad)).toBeNull()
  })

  it('U-AGT-37 · buildResume: --resume <id> with the model, the knobs and the mod again; by its name for a conversation launched without the mod; null with nothing to resume', () => {
    const rec = (agentSessionId: string | null, launch: Record<string, string> = {}) => ({ keaSessionId: KEA_ID, agentSessionId, transcriptPath: null, cwd: '/tmp/wt/fix-auth', launch: { prompt: 'the first prompt', ...launch } })
    const r = buildResume(rec(AGENT_ID, { model: 'x/y', effort: 'high', permissionMode: 'accept-edits' }), ctx())
    // a resumed session keeps neither its model nor the mod (1.79.2 resumes on its default model); the prompt is not
    // sent again
    expect(shape(r?.args ?? [])).toEqual(['--resume', AGENT_ID, '--model', 'x/y', '--effort', 'high', '--permission-mode', 'accept-edits', '--mod', MOD, '--mod-option', '<option>', '--trust'])
    expect(shape(buildResume(rec(AGENT_ID, { model: 'default' }), ctx())?.args ?? [])).toEqual(['--resume', AGENT_ID, '--mod', MOD, '--mod-option', '<option>', '--trust'])
    expect(r?.agentSessionId).toBe(AGENT_ID)
    expect(r?.file).toBe('/opt/bin/cmd')
    // no conversation id: nothing to resume, a fresh conversation
    expect(buildResume(rec(null), ctx())).toBeNull()
    expect(buildResume(rec(null), ctx({ filesDir: null }))).toBeNull()
    // the fallback: the name the conversation was given at launch is its id here, and it is resumed by it; no mod
    const name = 'kea-6f1c2b8e-1d2a-4c55-9a7e-0b3c4d5e6f70'
    expect(buildResume(rec(name, { model: 'x/y' }), ctx({ filesDir: null }))?.args).toEqual(['--resume', name, '--model', 'x/y', '--trust'])
    expect(buildResume(rec(AGENT_ID), ctx({ version: '1.74.0' }))?.args).toEqual(['--resume', AGENT_ID, '--trust'])
    // named once (an older CLI), resumed after an update: by that name, now with the mod, whose first event gives the real id
    expect(shape(buildResume(rec(name), ctx())?.args ?? [])).toEqual(['--resume', name, '--mod', MOD, '--mod-option', '<option>', '--trust'])
    // a session used in place is resumed as it was launched: without `--trust`
    expect(shape(buildResume(rec(AGENT_ID, { model: 'x/y' }), ctx({ ownWorktree: false }))?.args ?? [])).toEqual(['--resume', AGENT_ID, '--model', 'x/y', '--mod', MOD, '--mod-option', '<option>'])
  })
})
