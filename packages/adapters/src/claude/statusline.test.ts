import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { L, zAgentEvent, type AgentEvent } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { projectPayload } from '../kit/projection.ts'
import type { LaunchContext } from '../types.ts'
import { claude } from './adapter.ts'
import { STATUS_LINE_FIELDS } from './contract.ts'
import { buildLaunch, buildResume, helperPaths, injectedSettings, statusLineArgs, statusLineCommand } from './launch.ts'
import { usageEvents } from './mapping.ts'
import { CLAUDE_SETTINGS } from './settings.ts'
import { ownStatusLine, shellWord, shellWords, statusLineProjection } from './statusline.ts'

const FX = fileURLToPath(new URL('../../../../fixtures/statusline/claude/2.1.322/', import.meta.url))
/** A recorded status line payload as core receives it: projected by the helper's rules. */
const fx = (name: string): Record<string, unknown> => projectPayload(JSON.parse(fs.readFileSync(`${FX}${name}.json`, 'utf8')), statusLineProjection())

const UUID = '6f1c2b8e-1d2a-4c55-9a7e-0b3c4d5e6f70'
const HELPER = '/tmp/kea home/bin/1.3.0-aaaaaaaaaaaa/kea-helper'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-sl-')))
  dirs.push(d)
  return d
}
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** A launch context in a folder of its own: HOME, the working folder and nothing else on disk. */
function setup(o: { usageLimits?: unknown; env?: Record<string, string>; helperPath?: string; keaHome?: string } = {}) {
  const root = tmp()
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'repo')
  fs.mkdirSync(home)
  fs.mkdirSync(cwd)
  const ctx: LaunchContext = {
    keaSessionId: '01JXKEASESSION0000000000AA',
    agentSessionId: UUID,
    cwd,
    helperPath: o.helperPath ?? HELPER,
    keaHome: o.keaHome ?? '/tmp/kea home',
    portBase: 41000,
    binary: '/opt/bin/claude',
    version: '2.1.322',
    env: { PATH: '/usr/bin:/bin', HOME: home, ...o.env },
    settings: { extraArgs: [], env: {}, allowDangerousModes: false, ...('usageLimits' in o ? { usageLimits: o.usageLimits } : { usageLimits: true }) },
    ownWorktree: true,
  }
  return { root, home, cwd, ctx }
}

type Settings = { hooks: Record<string, unknown>; statusLine?: { type: string; command: string } }
const settingsOf = (args: readonly string[]): Settings => JSON.parse(args[args.indexOf('--settings') + 1]!) as Settings

/** Every file under `dir` with its bytes: nothing Kea reads is ever written. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) {
      const f = path.join(e.parentPath, e.name)
      out[path.relative(dir, f)] = fs.readFileSync(f, 'utf8')
    }
  }
  return out
}

describe('claude usage status line', () => {
  it('U-AGT-53 · with the setting on (the default, or never set), the inline settings carry a status line running kea-helper statusline for this session; turned off, none; launch and resume alike', () => {
    const { ctx } = setup()
    for (const spec of [buildLaunch({ prompt: 'go on' }, ctx), buildResume({ keaSessionId: ctx.keaSessionId, agentSessionId: UUID, transcriptPath: null, cwd: ctx.cwd, launch: { prompt: '' } }, ctx)!]) {
      const s = settingsOf(spec.args)
      expect(Object.keys(s)).toEqual(['hooks', 'statusLine'])
      expect(s.statusLine).toEqual({ type: 'command', command: statusLineCommand(ctx) })
      expect(shellWords(s.statusLine!.command)).toEqual([HELPER, ...statusLineArgs(ctx)])
      expect(statusLineArgs(ctx)).toEqual(['statusline', 'claude', '--session', ctx.keaSessionId, '--home', ctx.keaHome, '--project', JSON.stringify(statusLineProjection())])
      expect(Buffer.byteLength(spec.args[spec.args.indexOf('--settings') + 1]!)).toBeLessThanOrEqual(L.settingsInlineMaxBytes)
    }
    // the hooks are the same with or without it
    expect(settingsOf(buildLaunch({ prompt: '' }, ctx).args).hooks).toEqual((JSON.parse(injectedSettings(ctx)) as Settings).hooks)
    // never set: on, its default
    expect(settingsOf(buildLaunch({ prompt: '' }, setup({ usageLimits: undefined }).ctx).args).statusLine).toEqual(settingsOf(buildLaunch({ prompt: '' }, ctx).args).statusLine)
    // turned off: no status line at all
    const off = setup({ usageLimits: false })
    expect(settingsOf(buildLaunch({ prompt: '' }, off.ctx).args).statusLine).toBeUndefined()
    const def = CLAUDE_SETTINGS.keys.find((k) => k.key === 'usageLimits')!
    expect(def).toMatchObject({ default: true, control: 'toggle', section: 'Agents', label: 'Show usage limits' })
    expect(def.schema.safeParse(true).success && !def.schema.safeParse('on').success).toBe(true)
    // the cost is stated where the switch is: Claude hides a hint while any status line is set; the user's own wins
    expect(def.help).toMatch(/esc to interrupt/)
    expect(def.help).toMatch(/status line/)
    expect(claude.usage?.enabled({ extraArgs: [], env: {}, allowDangerousModes: false, usageLimits: true })).toBe(true)
    expect(claude.usage?.enabled({ extraArgs: [], env: {}, allowDangerousModes: false })).toBe(true)
    expect(claude.usage?.enabled({ extraArgs: [], env: {}, allowDangerousModes: false, usageLimits: false })).toBe(false)
  })

  it('U-AGT-53 · never over the user’s own status line: one in their user settings (the config folder, CLAUDE_CONFIG_DIR or ~/.claude), the project’s or the local settings (the working folder’s, or the main checkout’s for a worktree) means none is injected; files are read, never written', () => {
    const own = JSON.stringify({ statusLine: { type: 'command', command: 'my-line' } })
    const cases: [string, (x: ReturnType<typeof setup>) => void][] = [
      ['user, ~/.claude', (x) => write(path.join(x.home, '.claude', 'settings.json'), own)],
      ['user, CLAUDE_CONFIG_DIR', (x) => write(path.join(x.root, 'cfg', 'settings.json'), own)],
      ['project', (x) => write(path.join(x.cwd, '.claude', 'settings.json'), own)],
      ['local', (x) => write(path.join(x.cwd, '.claude', 'settings.local.json'), own)],
    ]
    for (const [name, place] of cases) {
      const x = setup()
      if (name.includes('CLAUDE_CONFIG_DIR')) x.ctx.settings = { ...x.ctx.settings, env: { CLAUDE_CONFIG_DIR: path.join(x.root, 'cfg') } }
      place(x)
      const before = snapshot(x.root)
      expect(ownStatusLine({ ...x.ctx.env, ...x.ctx.settings.env }, x.cwd), name).toBe(true)
      expect(settingsOf(buildLaunch({ prompt: '' }, x.ctx).args).statusLine, name).toBeUndefined()
      expect(snapshot(x.root), `${name}: nothing written`).toEqual(before)
    }
    // a worktree reads the main checkout's local settings (Claude shares them from there)
    const w = setup()
    const main = path.join(w.root, 'main')
    write(path.join(main, '.git', 'worktrees', 'wt1', 'commondir'), '../..\n')
    write(path.join(w.cwd, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt1')}\n`)
    expect(ownStatusLine(w.ctx.env, w.cwd), 'no local settings anywhere yet').toBe(false)
    write(path.join(main, '.claude', 'settings.local.json'), own)
    expect(ownStatusLine(w.ctx.env, w.cwd), 'the main checkout’s local settings').toBe(true)
    expect(settingsOf(buildLaunch({ prompt: '' }, w.ctx).args).statusLine).toBeUndefined()
    // settings without a status line, a null one, unreadable JSON, a folder in a file's place: Kea's is injected
    const n = setup()
    write(path.join(n.home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, statusLine: null }))
    write(path.join(n.cwd, '.claude', 'settings.json'), '{ not json')
    fs.mkdirSync(path.join(n.cwd, '.claude', 'settings.local.json'))
    expect(ownStatusLine(n.ctx.env, n.cwd)).toBe(false)
    expect(settingsOf(buildLaunch({ prompt: '' }, n.ctx).args).statusLine).toBeDefined()
    // a settings file too large to read whole may hold one: Kea stays out of its way
    write(path.join(n.home, '.claude', 'settings.json'), `${' '.repeat(L.settingsInlineMaxBytes)}{}`)
    expect(ownStatusLine(n.ctx.env, n.cwd)).toBe(true)
  })

  it('U-AGT-53 · the command is the one shell string Kea builds: every word single-quoted, so a space, a quote, $, ;, a backtick and a newline in the helper’s path and the home reach the helper as they are', () => {
    expect(shellWord("it's")).toBe(`'it'\\''s'`)
    expect(shellWord('')).toBe(`''`)
    expect(shellWord('a b$c;`d`\ne')).toBe("'a b$c;`d`\ne'")
    expect(shellWords(`'a' 'b c' 'it'\\''s'`)).toEqual(['a', 'b c', "it's"])
    for (const notOurs of ['a b', `'a'b`, `'a`, `'a'  'b'`, ` 'a'`, `"a"`, '']) expect(shellWords(notOurs), notOurs).toBeNull()
    // a stand-in helper in a folder whose name holds every character a shell would act on, run as Claude runs it
    const odd = "odd dir 'q' $HOME ;x `id` \"dq\" \\b\nline"
    const root = path.join(tmp(), odd)
    fs.mkdirSync(root, { recursive: true })
    const helper = path.join(root, 'kea-helper')
    const out = path.join(path.dirname(root), 'argv.json')
    fs.writeFileSync(helper, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.KEA_SL_OUT, JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o755 })
    const { ctx } = setup({ helperPath: helper, keaHome: path.join(root, 'kea home') })
    const command = settingsOf(buildLaunch({ prompt: '' }, ctx).args).statusLine!.command
    execFileSync('/bin/sh', ['-c', command], { env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, KEA_SL_OUT: out }, input: '{}' })
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(statusLineArgs(ctx))
    expect(shellWords(command)).toEqual([helper, ...statusLineArgs(ctx)])
  })

  it('U-AGT-53 · the projection keeps the usage windows and the session id and nothing else; the recorded payloads map to account.usage: none before the first reply, each window on its own, seconds to ms', () => {
    const p = statusLineProjection()
    expect(p).toEqual({ keep: Object.values(STATUS_LINE_FIELDS), count: [], summarise: [] })
    for (const k of p.keep) expect(k === 'session_id' || k.startsWith('rate_limits.'), k).toBe(true)
    // the recorded payloads, as core receives them: paths, cost, model, transcript are gone
    const after = fx('after-reply')
    expect(Object.keys(after).sort()).toEqual(['rate_limits', 'session_id'])
    expect(JSON.stringify(after)).not.toMatch(/transcript|cost|cwd|model/)
    expect(fx('start')).toEqual({ session_id: 'c4e952d3-80fa-4f18-b6fe-4dce94766819' })
    expect(usageEvents(fx('start'))).toEqual([])
    const ev = usageEvents(after)
    expect(ev).toEqual([
      {
        t: 'account.usage',
        windows: [
          { id: 'session', usedPct: 25, resetsAt: 1_794_426_600_000 },
          { id: 'week', usedPct: 67, resetsAt: 1_794_618_000_000 },
        ],
      },
    ])
    for (const e of ev) expect(zAgentEvent.safeParse(e).success).toBe(true)
    // each window on its own; a fraction kept; a value out of range or of the wrong type drops only its window
    const rl = (o: Record<string, unknown>) => ({ rate_limits: o })
    const win = (used: unknown, resets: unknown) => ({ used_percentage: used, resets_at: resets })
    const cases: [Record<string, unknown>, AgentEvent[]][] = [
      [rl({ five_hour: win(42.5, 1_794_426_600) }), [{ t: 'account.usage', windows: [{ id: 'session', usedPct: 42.5, resetsAt: 1_794_426_600_000 }] }]],
      [rl({ seven_day: win(0, 1_794_618_000) }), [{ t: 'account.usage', windows: [{ id: 'week', usedPct: 0, resetsAt: 1_794_618_000_000 }] }]],
      [rl({ five_hour: win('25', 1_794_426_600), seven_day: win(67, 1_794_618_000) }), [{ t: 'account.usage', windows: [{ id: 'week', usedPct: 67, resetsAt: 1_794_618_000_000 }] }]],
      [rl({ five_hour: win(25, null), seven_day: win(67, -1) }), []],
      [rl({ five_hour: win(120, 1_794_426_600) }), [{ t: 'account.usage', windows: [{ id: 'session', usedPct: 100, resetsAt: 1_794_426_600_000 }] }]],
      [rl({ five_hour: win(-3, 1_794_426_600) }), [{ t: 'account.usage', windows: [{ id: 'session', usedPct: 0, resetsAt: 1_794_426_600_000 }] }]],
      [rl({ five_hour: win(25, 1e300) }), []],
      [{ rate_limits: 'x' }, []],
      [{}, []],
    ]
    for (const [payload, want] of cases) {
      const got = usageEvents(projectPayload(payload, p))
      expect(got, JSON.stringify(payload)).toEqual(want)
      for (const e of got) expect(zAgentEvent.safeParse(e).success).toBe(true)
    }
    // the account: the agent's config folder, so two logins are two readings
    expect(claude.usage?.account({ HOME: '/tmp/h' })).toBe('/tmp/h/.claude')
    expect(claude.usage?.account({ HOME: '/tmp/h', CLAUDE_CONFIG_DIR: '/tmp/other' })).toBe('/tmp/other')
    expect(claude.usage?.map(after)).toEqual(ev)
  })

  it('U-AGT-53 · helperPaths finds the helper a status line runs, alone or beside the hooks; a status line not of Kea’s making names none', () => {
    const { ctx } = setup()
    const spec = buildLaunch({ prompt: 'x' }, ctx)
    expect(helperPaths([spec.file, ...spec.args])).toEqual([HELPER])
    const other = '/tmp/a "quoted" \\ it\'s\nhome/kea-helper'
    const alone = JSON.stringify({ statusLine: { type: 'command', command: statusLineCommand({ ...ctx, helperPath: other }) } })
    expect(helperPaths(['claude', '--settings', alone])).toEqual([other])
    expect(helperPaths(['claude', '--settings', JSON.stringify({ hooks: JSON.parse(injectedSettings(ctx)).hooks, statusLine: { type: 'command', command: statusLineCommand({ ...ctx, helperPath: other }) } })]).sort()).toEqual([HELPER, other].sort())
    for (const command of ['my-line', `'/x/kea-helper' 'hook'`, `'/x/kea-helper'`, 7]) {
      expect(helperPaths(['claude', '--settings', JSON.stringify({ statusLine: { type: 'command', command } })]), String(command)).toEqual([])
    }
  })
})
