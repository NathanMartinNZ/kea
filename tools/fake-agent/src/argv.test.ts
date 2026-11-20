import { describe, expect, it } from 'vitest'
import { argvHash, argvHashLine, ArgvError, parseAgentArgv, parseArgv, reportedPermissionMode, splitFakeOptions } from './argv.ts'

const UUID = '0b3c2f6e-2a8e-4f0e-9a51-1c2d3e4f5a6b'
const SETTINGS = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/x/kea-helper', args: ['hook', 'claude'], timeout: 5 }] }] } })

describe('fake-agent argv', () => {
  it('U-FAKE-1 · --as claude reads the flags Kea passes, keeps the rest as extra args and takes the prompt after --', () => {
    const argv = ['--session-id', UUID, '--model', 'opus', '--effort', 'high', '--permission-mode', 'manual', '--settings', SETTINGS, '--add-dir', '/a', '/b', '--verbose', '--weird=1', '--', '-starts with a dash', 'doctor']
    const a = parseAgentArgv('claude', argv)
    if (a.flavour !== 'claude') throw new Error('flavour')
    expect(a.sessionId).toBe(UUID)
    expect(a.model).toBe('opus')
    expect(a.effort).toBe('high')
    expect(a.permissionMode).toBe('manual')
    expect(a.settings).toBe(SETTINGS)
    expect(a.extra).toEqual(['--add-dir', '/a', '/b', '--verbose', '--weird=1'])
    expect(a.prompt).toBe('-starts with a dash doctor')
    expect(reportedPermissionMode(a)).toBe('default') // `manual` is reported as "default" in payloads
    // no prompt at all; `--flag=value` form; a positional prompt without --
    expect(parseAgentArgv('claude', ['--model=sonnet']).prompt).toBe('')
    expect(parseAgentArgv('claude', ['--model=sonnet']).model).toBe('sonnet')
    expect(parseAgentArgv('claude', ['--resume', UUID, 'fix it']).prompt).toBe('fix it')
    // the real CLI's validation
    expect(() => parseAgentArgv('claude', ['--session-id', 'nope'])).toThrow(/valid UUID/)
    expect(() => parseAgentArgv('claude', ['--permission-mode', 'yolo'])).toThrow(/Allowed choices/)
    expect(() => parseAgentArgv('claude', ['--effort', 'extreme'])).toThrow(/Allowed choices/)
    expect(() => parseAgentArgv('claude', ['--model'])).toThrow(/argument missing/)
  })

  it('U-FAKE-2 · --as commandcode reads -m, --effort, --permission-mode, repeated --mod and --mod-option, -t, --name, --resume and a positional prompt', () => {
    const a = parseAgentArgv('commandcode', ['-m', 'gpt-x', '--effort', 'low', '--permission-mode', 'standard', '--mod', '/k/kea-mod.ts', '--mod-option', 'kea=a=b', '--mod', 'b.ts', '--mod-option', 'x=1', '--mod-option', 'x=2', '-t', 'do the thing'])
    if (a.flavour !== 'commandcode') throw new Error('flavour')
    expect(a.model).toBe('gpt-x')
    expect(a.mods).toEqual(['/k/kea-mod.ts', 'b.ts'])
    expect(a.modOptions).toEqual({ kea: 'a=b', x: '2' }) // split at the first `=`; the later one of a name wins
    expect(a.trust).toBe(true)
    expect(a.prompt).toBe('do the thing')
    expect(reportedPermissionMode(a)).toBe('default') // `standard` is what the help calls the default mode
    // each spelling 1.79.2 takes, and the name its events report for it
    const reported = (mode: string) => reportedPermissionMode(parseAgentArgv('commandcode', ['--permission-mode', mode]))
    expect(['default', 'plan', 'accept-edits', 'auto-accept', 'yolo', 'bypass', 'dont-ask'].map(reported)).toEqual(['default', 'plan', 'auto-accept', 'auto-accept', 'bypass', 'bypass', 'dont-ask'])
    expect(() => parseAgentArgv('commandcode', ['--permission-mode', 'acceptEdits'])).toThrow(/Allowed choices/)
    expect(() => parseAgentArgv('commandcode', ['--effort', 'extreme'])).toThrow(/Allowed choices/)
    expect(() => parseAgentArgv('commandcode', ['--mod-option', 'novalue'])).toThrow(/name=value/)
    // a named conversation, a resume by id or by name, the prompt after `--`, and the questions detection asks
    const b = parseAgentArgv('commandcode', ['--name', 'kea-1', '--resume', 'kea-0', '--', '-fix it '])
    if (b.flavour !== 'commandcode') throw new Error('flavour')
    expect([b.name, b.resume, b.prompt]).toEqual(['kea-1', 'kea-0', '-fix it '])
    const c = parseAgentArgv('commandcode', ['--list-models'])
    expect(c.flavour === 'commandcode' && c.listModels).toBe(true)
  })

  it('U-FAKE-3 · fake-agent options are split out anywhere before --, fall back to env, and are not part of the argv hash', () => {
    const { fake, rest } = splitFakeOptions(['--model', 'opus', '--as', 'claude', '--scenario=s.yaml', '--', '--as', 'x'], { FAKE_AGENT_LOG: '/tmp/l', FAKE_AGENT_SCENARIO: 'ignored.yaml' })
    expect(fake).toEqual({ as: 'claude', scenario: 's.yaml', fakeHome: null, log: '/tmp/l' })
    expect(rest).toEqual(['--model', 'opus', '--', '--as', 'x']) // after --, `--as` is prompt text
    expect(splitFakeOptions([], { FAKE_AGENT_AS: 'commandcode' }).fake.as).toBe('commandcode')
    const missing = (() => {
      try {
        splitFakeOptions([], {})
      } catch (e) {
        return e
      }
    })()
    expect(missing).toBeInstanceOf(ArgvError)
    expect((missing as ArgvError).exitCode).toBe(2)
    expect(() => splitFakeOptions(['--as', 'codex'], {})).toThrow(/claude, commandcode, antigravity/)

    // the hash is over what the adapter built, so a test can compute it from the SpawnSpec
    const adapterArgs = ['--session-id', UUID, '--settings', SETTINGS, '--', 'hello']
    const p = parseArgv(['--as', 'claude', '--log', 'x.jsonl', ...adapterArgs], {})
    expect(p.agentArgv).toEqual(adapterArgs)
    expect(argvHash(p.agentArgv)).toBe(argvHash(adapterArgs))
    expect(argvHash(['a'])).not.toBe(argvHash(['a', '']))
    expect(argvHash(adapterArgs)).toMatch(/^[0-9a-f]{64}$/)
    expect(argvHashLine('ab')).toBe('fake-agent argv sha256=ab')
  })

  it('U-FAKE-32 · --as antigravity reads Go-style single/double-dash and --flag=value flags (-i/--prompt-interactive, --conversation, --mode, --dangerously-skip-permissions, --settings, --model, --effort, models subcommand) and validates --mode and --effort', () => {
    const agSettings = JSON.stringify({ statusLine: { type: 'command', command: "'/x/kea-helper' 'feed' 'antigravity'", stack_with_default: true } })
    const a = parseAgentArgv('antigravity', [
      '--model=gemini-3.8-flash',
      '--effort=high',
      '--mode=accept-edits',
      `--settings=${agSettings}`,
      '--add-dir=/tmp/a',
      '--prompt-interactive=-starts with dash\nand newline',
    ])
    if (a.flavour !== 'antigravity') throw new Error('flavour')
    expect(a.model).toBe('gemini-3.8-flash')
    expect(a.effort).toBe('high')
    expect(a.permissionMode).toBe('accept-edits')
    expect(a.dangerouslySkipPermissions).toBe(false)
    expect(a.settings).toBe(agSettings)
    expect(a.prompt).toBe('-starts with dash\nand newline')
    expect(a.extra).toEqual(['--add-dir=/tmp/a'])
    expect(a.modelsCmd).toBe(false)
    expect(reportedPermissionMode(a)).toBe('accept-edits')

    // Go single-dash flags (-mode=plan, -i=..., -conversation=...) and two-token form (-i <prompt>)
    const b = parseAgentArgv('antigravity', ['-model=gemini-4-neon', '-effort', 'xhigh', '-mode=plan', `-conversation=${UUID}`, '-i=resume prompt'])
    if (b.flavour !== 'antigravity') throw new Error('flavour')
    expect([b.model, b.effort, b.permissionMode, b.resume, b.prompt]).toEqual(['gemini-4-neon', 'xhigh', 'plan', UUID, 'resume prompt'])
    expect(reportedPermissionMode(b)).toBe('plan')

    // --dangerously-skip-permissions maps to dangerouslySkipPermissions: true and reportedPermissionMode 'yolo'
    const yolo = parseAgentArgv('antigravity', ['--dangerously-skip-permissions', '-i', 'run all'])
    if (yolo.flavour !== 'antigravity') throw new Error('flavour')
    expect(yolo.dangerouslySkipPermissions).toBe(true)
    expect(yolo.prompt).toBe('run all')
    expect(reportedPermissionMode(yolo)).toBe('yolo')

    // Default mode (no --mode and no --dangerously-skip-permissions)
    const dflt = parseAgentArgv('antigravity', [])
    expect(reportedPermissionMode(dflt)).toBe('default')

    // `models` subcommand
    const models = parseAgentArgv('antigravity', ['models'])
    if (models.flavour !== 'antigravity') throw new Error('flavour')
    expect(models.modelsCmd).toBe(true)
    expect(models.prompt).toBe('')

    // Prompt named "models" via --prompt-interactive=models is a prompt, not the subcommand
    const promptModels = parseAgentArgv('antigravity', ['--prompt-interactive=models'])
    if (promptModels.flavour !== 'antigravity') throw new Error('flavour')
    expect(promptModels.modelsCmd).toBe(false)
    expect(promptModels.prompt).toBe('models')

    // Validation of --mode and --effort
    expect(() => parseAgentArgv('antigravity', ['--mode=yolo'])).toThrow(/Allowed choices/)
    expect(() => parseAgentArgv('antigravity', ['--mode', 'acceptEdits'])).toThrow(/Allowed choices/)
    expect(() => parseAgentArgv('antigravity', ['--effort=extreme'])).toThrow(/Allowed choices/)
    expect(() => parseAgentArgv('antigravity', ['--model'])).toThrow(/argument missing/)
  })
})
