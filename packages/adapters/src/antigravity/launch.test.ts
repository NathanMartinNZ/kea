import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { L } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { shellWords } from '../kit/shell.ts'
import type { LaunchContext } from '../types.ts'
import { ownStatusLine } from './config.ts'
import { FLAGS } from './contract.ts'
import { antigravityProjection, buildLaunch, buildResume, feedArgs, feedCommand, helperPaths, identify, stripEffortSuffix } from './launch.ts'
import { ANTIGRAVITY_SETTINGS } from './settings.ts'

const KEA_ID = '01JXKEASESSION0000000000AA'
const AGENT_ID = 'a40a7934-365e-4afd-a57a-506cb16fa4e9'
const HELPER = '/Applications/Kea.app/Contents/Resources/kea-helper' // os-ok: test data

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agt54-')))
  dirs.push(d)
  return d
}

function makeCtx(o: Partial<LaunchContext> = {}): LaunchContext {
  const home = o.env?.HOME ?? path.join(tmp(), 'home')
  fs.mkdirSync(home, { recursive: true })
  return {
    keaSessionId: KEA_ID,
    cwd: '/tmp/wt/fix-auth',
    helperPath: HELPER,
    keaHome: '/tmp/kea home',
    portBase: 41000,
    binary: '/opt/bin/agy',
    version: '1.5.13',
    env: { PATH: '/usr/bin:/bin', HOME: home, KEA_SESSION_ID: KEA_ID, LANG: 'en_US.UTF-8' },
    settings: { extraArgs: [], env: {}, allowDangerousModes: false },
    ownWorktree: true,
    ...o,
  }
}

interface ParsedSettings {
  statusLine?: { type: string; command: string; stack_with_default: boolean }
  clearScrollbackOnResize?: boolean
  trustedWorkspaces?: string[]
}

function settingsOf(args: readonly string[]): ParsedSettings {
  const tok = args.find((a) => a.startsWith('--settings='))
  expect(tok).toBeDefined()
  return JSON.parse(tok!.slice('--settings='.length)) as ParsedSettings
}

const shape = (args: readonly string[]) => args.map((a) => (a.startsWith('--settings=') ? '--settings=<json>' : a))

describe('antigravity launch, statusLine guard and env hygiene', () => {
  it('U-AGT-54 · buildLaunch & buildResume: --flag=value form, model+effort pairing, yolo gated by allowDangerousModes, prompt edge cases, worktree-only trustedWorkspaces, usageLimits:false still injects statusLine, and helperPaths extraction', () => {
    // (1) Default launch argv and agentSessionId: null (even when ctx.agentSessionId is provided)
    const c = makeCtx({ agentSessionId: 'pre-assigned-ignored' })
    const def = buildLaunch({ prompt: '' }, c)
    expect(def.file).toBe('/opt/bin/agy')
    expect(def.cwd).toBe('/tmp/wt/fix-auth')
    expect(def.agentSessionId).toBeNull()
    expect(def.silent).toBeUndefined()
    expect(shape(def.args)).toEqual(['--settings=<json>'])
    const defSettings = settingsOf(def.args)
    expect(defSettings).toEqual({
      statusLine: { type: 'command', command: feedCommand(c), stack_with_default: true },
      clearScrollbackOnResize: false,
      trustedWorkspaces: ['/tmp/wt/fix-auth'],
    })

    // (2) Every knob in --flag=value form, model+effort suffix stripping, and yolo permissionMode gating
    expect(stripEffortSuffix('gemini-3.8-flash-low')).toBe('gemini-3.8-flash')
    expect(stripEffortSuffix('gemini-4-neon-xhigh')).toBe('gemini-4-neon')
    expect(stripEffortSuffix('gemini-pro-orchestrator-neon')).toBe('gemini-pro-orchestrator-neon')

    expect(shape(buildLaunch({ prompt: '', model: 'default' }, c).args)).toEqual(['--settings=<json>'])
    expect(shape(buildLaunch({ prompt: '', model: 'gemini-3.8-flash' }, c).args)).toEqual([
      '--model=gemini-3.8-flash',
      '--settings=<json>',
    ])
    expect(shape(buildLaunch({ prompt: '', effort: 'high' }, c).args)).toEqual(['--effort=high', '--settings=<json>'])
    expect(shape(buildLaunch({ prompt: '', model: 'gemini-3.8-flash', effort: 'high' }, c).args)).toEqual([
      '--model=gemini-3.8-flash',
      '--effort=high',
      '--settings=<json>',
    ])
    // Custom effort-suffixed slug paired with --effort strips the suffix before emitting --model and --effort
    expect(shape(buildLaunch({ prompt: '', model: 'gemini-3.8-flash-low', effort: 'high' }, c).args)).toEqual([
      '--model=gemini-3.8-flash',
      '--effort=high',
      '--settings=<json>',
    ])
    // Single-variant / exact slug without effort keeps the exact slug
    expect(shape(buildLaunch({ prompt: '', model: 'gpt-oss-120b-medium' }, c).args)).toEqual([
      '--model=gpt-oss-120b-medium',
      '--settings=<json>',
    ])

    // Permission modes
    for (const mode of ['accept-edits', 'plan', 'auto'] as const) {
      expect(shape(buildLaunch({ prompt: '', permissionMode: mode }, c).args)).toEqual([`--mode=${mode}`, '--settings=<json>'])
    }
    expect(shape(buildLaunch({ prompt: '', permissionMode: 'default' }, c).args)).toEqual(['--settings=<json>'])

    // yolo -> --dangerously-skip-permissions (no --mode) ONLY when allowDangerousModes is true
    expect(shape(buildLaunch({ prompt: '', permissionMode: 'yolo' }, c).args)).toEqual(['--settings=<json>'])
    const cAllowed = makeCtx({ settings: { extraArgs: [], env: {}, allowDangerousModes: true } })
    const yoloLaunch = buildLaunch({ prompt: '', permissionMode: 'yolo' }, cAllowed)
    expect(shape(yoloLaunch.args)).toEqual([FLAGS.dangerouslySkipPermissions, '--settings=<json>'])
    expect(yoloLaunch.args.some((a) => a.startsWith('--mode'))).toBe(false)

    // Turning usageLimits off MUST still inject statusLine (tier-1 session status)
    const cUsageOff = makeCtx({ settings: { extraArgs: [], env: {}, allowDangerousModes: false, usageLimits: false } })
    expect(settingsOf(buildLaunch({ prompt: '' }, cUsageOff).args).statusLine).toBeDefined()

    // extraArgs placed after --settings and before --prompt-interactive
    const cExtra = makeCtx({ settings: { extraArgs: ['--sandbox'], env: {}, allowDangerousModes: false } })
    expect(shape(buildLaunch({ prompt: 'hello', extraArgs: ['--add-dir=/tmp/x'] }, cExtra).args)).toEqual([
      '--settings=<json>',
      '--sandbox',
      '--add-dir=/tmp/x',
      '--prompt-interactive=hello',
    ])

    // (3) Prompt edge cases: leading '-', quotes, newlines, unicode, bare subcommand 'models', '/help'
    const prompts = ['-x "quoted"\nline2 café', '--help', 'models', 'update', '/help', '"; rm -rf ~ # `id` $(whoami)']
    for (const p of prompts) {
      const s = buildLaunch({ prompt: p }, c)
      expect(s.args.at(-1)).toBe(`--prompt-interactive=${p}`)
    }

    // (4) POSIX quoting of helperPath and keaHome with spaces, single quotes and shell metacharacters
    const oddDir = path.join(tmp(), "odd dir 'q' $HOME ;x `id` \"dq\"")
    fs.mkdirSync(oddDir, { recursive: true })
    const helper = path.join(oddDir, 'kea-helper')
    const outFile = path.join(tmp(), 'argv.json')
    fs.writeFileSync(
      helper,
      "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.KEA_FEED_OUT, JSON.stringify(process.argv.slice(2)))\n",
      { mode: 0o755 },
    )
    const oddCtx = makeCtx({ helperPath: helper, keaHome: path.join(oddDir, 'kea home') })
    const cmd = settingsOf(buildLaunch({ prompt: '' }, oddCtx).args).statusLine!.command
    execFileSync('/bin/sh', ['-c', cmd], {
      env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, KEA_FEED_OUT: outFile },
      input: '{}',
    })
    expect(JSON.parse(fs.readFileSync(outFile, 'utf8'))).toEqual(feedArgs(oddCtx))
    expect(shellWords(cmd)).toEqual([helper, ...feedArgs(oddCtx)])
    expect(feedArgs(oddCtx)).toEqual([
      'feed',
      'antigravity',
      '--session',
      KEA_ID,
      '--home',
      oddCtx.keaHome,
      '--project',
      JSON.stringify(antigravityProjection()),
    ])

    // (5) helperPaths extracts helperPath from --settings=<json>, ['--settings', '<json>'], and behind a login-shell wrapper
    expect(helperPaths([def.file, ...def.args])).toEqual([HELPER])
    expect(helperPaths(['/bin/zsh', '-l', '-c', 'exec "$0" "$@"', '/opt/bin/agy', ...buildLaunch({ prompt: '' }, oddCtx).args])).toEqual([
      helper,
    ])
    const settingsJson = def.args[0]!.slice('--settings='.length)
    expect(helperPaths(['agy', '--settings', settingsJson])).toEqual([HELPER])
    expect(helperPaths(['agy', '--settings=not-json'])).toEqual([])
    expect(helperPaths(['agy', `--settings=${JSON.stringify({ statusLine: { type: 'command', command: 'echo custom' } })}`])).toEqual([])
    expect(
      helperPaths([
        'agy',
        `--settings=${JSON.stringify({ statusLine: { type: 'command', command: "'/x/kea-helper' 'statusline' 'claude'" } })}`,
      ]),
    ).toEqual([])

    // (6) trustedWorkspaces included ONLY when ownWorktree === true && autoTrustWorktrees !== false, NEVER in-place
    const inPlace = makeCtx({
      cwd: '/Users/dev/code/acme',
      ownWorktree: false,
      settings: { extraArgs: [], env: {}, allowDangerousModes: false, autoTrustWorktrees: true },
    })
    expect(settingsOf(buildLaunch({ prompt: '' }, inPlace).args).trustedWorkspaces).toBeUndefined()
    const trustOff = makeCtx({
      ownWorktree: true,
      settings: { extraArgs: [], env: {}, allowDangerousModes: false, autoTrustWorktrees: false },
    })
    expect(settingsOf(buildLaunch({ prompt: '' }, trustOff).args).trustedWorkspaces).toBeUndefined()
    expect(settingsOf(buildLaunch({ prompt: '' }, c).args).trustedWorkspaces).toEqual(['/tmp/wt/fix-auth'])

    // (7) buildResume emits --conversation=<id>, re-passes --settings and knobs (including yolo when allowed), null without id
    const rec = {
      keaSessionId: KEA_ID,
      agentSessionId: AGENT_ID,
      transcriptPath: null,
      cwd: '/tmp/wt/fix-auth',
      launch: { prompt: 'initial prompt', model: 'gemini-3.8-flash-low', effort: 'high', permissionMode: 'plan' },
    }
    const res = buildResume(rec, c)!
    expect(res.agentSessionId).toBe(AGENT_ID)
    expect(shape(res.args)).toEqual([
      `--conversation=${AGENT_ID}`,
      '--model=gemini-3.8-flash',
      '--effort=high',
      '--mode=plan',
      '--settings=<json>',
    ])
    expect(res.args.some((a) => a.includes('initial prompt'))).toBe(false)
    const yoloRec = { ...rec, launch: { prompt: '', permissionMode: 'yolo' } }
    expect(shape(buildResume(yoloRec, cAllowed)!.args)).toEqual([
      `--conversation=${AGENT_ID}`,
      FLAGS.dangerouslySkipPermissions,
      '--settings=<json>',
    ])
    expect(shape(buildResume(yoloRec, c)!.args)).toEqual([`--conversation=${AGENT_ID}`, '--settings=<json>'])
    expect(buildResume({ ...rec, agentSessionId: null }, c)).toBeNull()

    // (8) identify & settings definitions
    expect(identify(['/usr/local/bin/agy', '--settings={}'])).toBe(true)
    expect(identify(['agy'])).toBe(true)
    expect(identify(['/opt/bin/claude'])).toBe(false)
    expect(identify(['/opt/bin/cmd'])).toBe(false)
    expect(identify([])).toBe(false)
    expect(ANTIGRAVITY_SETTINGS.keys.map((k) => k.key)).toEqual(['usageLimits', 'autoTrustWorktrees'])
  })

  it('U-AGT-56 · ownStatusLine: active object suppresses injection and sets SpawnSpec.silent; enabled:false, boolean, empty command, absent, invalid JSON do not; oversize fails safe to active', () => {
    const writeSettings = (home: string, content: string) => {
      const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
      return file
    }

    // (1) Absent file -> injects statusLine, not silent
    const c1 = makeCtx()
    expect(ownStatusLine(c1.env)).toBe(false)
    const s1 = buildLaunch({ prompt: '' }, c1)
    expect(settingsOf(s1.args).statusLine).toBeDefined()
    expect(s1.silent).toBeUndefined()

    // (2) Active object { type: 'command', command: 'echo hi' } -> suppresses injection, sets silent: true
    const c2 = makeCtx()
    writeSettings(c2.env.HOME!, JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } }))
    expect(ownStatusLine(c2.env)).toBe(true)
    const s2 = buildLaunch({ prompt: '' }, c2)
    expect(settingsOf(s2.args).statusLine).toBeUndefined()
    expect(settingsOf(s2.args).clearScrollbackOnResize).toBe(false)
    expect(s2.silent).toBe(true)
    const r2 = buildResume({ keaSessionId: KEA_ID, agentSessionId: AGENT_ID, transcriptPath: null, cwd: c2.cwd, launch: { prompt: '' } }, c2)!
    expect(settingsOf(r2.args).statusLine).toBeUndefined()
    expect(r2.silent).toBe(true)

    // (3) Disabled via /statusline off ({ command: 'echo hi', enabled: false }) -> NOT active, injects Kea's statusLine
    const c3 = makeCtx()
    writeSettings(c3.env.HOME!, JSON.stringify({ statusLine: { type: 'command', command: 'echo hi', enabled: false } }))
    expect(ownStatusLine(c3.env)).toBe(false)
    expect(settingsOf(buildLaunch({ prompt: '' }, c3).args).statusLine).toBeDefined()

    // (4) Boolean, null, array, or empty command -> NOT active
    for (const raw of [
      JSON.stringify({ statusLine: true }),
      JSON.stringify({ statusLine: false }),
      JSON.stringify({ statusLine: null }),
      JSON.stringify({ statusLine: [] }),
      JSON.stringify({ statusLine: { type: 'command', command: '   ' } }),
      '{ invalid json',
    ]) {
      const cx = makeCtx()
      writeSettings(cx.env.HOME!, raw)
      expect(ownStatusLine(cx.env), raw).toBe(false)
      expect(settingsOf(buildLaunch({ prompt: '' }, cx).args).statusLine, raw).toBeDefined()
    }

    // (5) File larger than L.settingsInlineMaxBytes -> fail-safe active, suppresses injection + silent: true
    const cBig = makeCtx()
    writeSettings(cBig.env.HOME!, `${' '.repeat(L.settingsInlineMaxBytes + 10)}{}`)
    expect(ownStatusLine(cBig.env)).toBe(true)
    const sBig = buildLaunch({ prompt: '' }, cBig)
    expect(settingsOf(sBig.args).statusLine).toBeUndefined()
    expect(sBig.silent).toBe(true)

    // (6) Directory in place of settings.json -> does not hang or throw, treated as absent
    const cDir = makeCtx()
    fs.mkdirSync(path.join(cDir.env.HOME!, '.gemini', 'antigravity-cli', 'settings.json'), { recursive: true })
    expect(ownStatusLine(cDir.env)).toBe(false)
  })

  it('U-AGT-57 · environment hygiene: strips all ANTIGRAVITY_* variables and Electron/Node internals, lists removed keys in SpawnSpec.unset, and preserves explicit ctx.settings.env overrides', () => {
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: path.join(tmp(), 'home'),
      KEA_SESSION_ID: KEA_ID,
      KEA_WORKTREE: '/tmp/wt/fix-auth',
      ANTIGRAVITY_CSRF_TOKEN: 'secret-token',
      ANTIGRAVITY_AGENT: '1',
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:42100',
      ANTIGRAVITY_CONVERSATION_ID: 'outer-conv',
      ANTIGRAVITY_CUSTOM_FUTURE: 'future-val',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_CHANNEL_FD: '3',
      USER_VAR: 'kept',
    }
    const c = makeCtx({ env })
    const s = buildLaunch({ prompt: '' }, c)
    expect(s.env.PATH).toBe('/usr/bin:/bin')
    expect(s.env.KEA_SESSION_ID).toBe(KEA_ID)
    expect(s.env.USER_VAR).toBe('kept')
    for (const k of [
      'ANTIGRAVITY_CSRF_TOKEN',
      'ANTIGRAVITY_AGENT',
      'ANTIGRAVITY_LS_ADDRESS',
      'ANTIGRAVITY_CONVERSATION_ID',
      'ANTIGRAVITY_CUSTOM_FUTURE',
      'ELECTRON_RUN_AS_NODE',
      'NODE_CHANNEL_FD',
    ]) {
      expect(s.env[k]).toBeUndefined()
    }
    expect(s.unset.sort()).toEqual([
      'ANTIGRAVITY_AGENT',
      'ANTIGRAVITY_CONVERSATION_ID',
      'ANTIGRAVITY_CSRF_TOKEN',
      'ANTIGRAVITY_CUSTOM_FUTURE',
      'ANTIGRAVITY_LS_ADDRESS',
      'ELECTRON_RUN_AS_NODE',
      'NODE_CHANNEL_FD',
    ])

    // Explicit ctx.settings.env override wins and is excluded from unset
    const cOver = makeCtx({
      env,
      settings: { extraArgs: [], env: { ANTIGRAVITY_AGENT: 'custom-override', EXTRA_VAR: 'yes' }, allowDangerousModes: false },
    })
    const sOver = buildLaunch({ prompt: '' }, cOver)
    expect(sOver.env.ANTIGRAVITY_AGENT).toBe('custom-override')
    expect(sOver.env.EXTRA_VAR).toBe('yes')
    expect(sOver.unset).not.toContain('ANTIGRAVITY_AGENT')
    expect(sOver.unset).toContain('ANTIGRAVITY_CSRF_TOKEN')

    // buildResume applies the same environment hygiene
    const r = buildResume({ keaSessionId: KEA_ID, agentSessionId: AGENT_ID, transcriptPath: null, cwd: c.cwd, launch: { prompt: '' } }, c)!
    expect(r.unset.sort()).toEqual(s.unset.sort())
  })
})
