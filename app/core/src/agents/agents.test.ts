import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdapterRegistry, ADAPTERS, type AgentAdapter, type Detection } from '@kea/adapters'
import { createMemoryLogger } from '@kea/kit'
import { allSettingDefs, KeyedStore, L, type AgentEvent, type PtyInfo, type SessionView } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeaDb } from '../platform/db/db.ts'
import type { StatusEngine, StatusInput } from '../status/engine.ts'
import { SettingsFile } from '../settings/settings.ts'
import { AgentService, identifyAgent } from './agents.ts'
import type { Envelope } from './intake.ts'
import { SPOOL_LOCK_FLAG } from './spool.ts'

const MS = 1_000_000n
/** How long the FIFO test's child may take: a blocked read never finishes (a normal run takes well under a second). */
const FIFO_BOUND_MS = 15_000
/** The machine slept this long since boot: the helper's clock, which stops in sleep, lags process.hrtime by it. */
const SLEPT = 18n * 3600n * 1000n * MS

const dirs: string[] = []
const services: AgentService[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const s of services.splice(0)) s.dispose()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function view(id: string, o: Partial<SessionView>): SessionView {
  return { id, projectId: 'p1', agent: 'claude', agentSessionId: '11111111-2222-4333-8444-555555555555', lifecycle: 'live', phase: 'idle', cwd: '/w', portBase: null, launch: {}, ...o } as SessionView
}

/** An adapter that lives only in this test (U-AGT-15): one folder's worth of code, registered and nothing else. */
const testAdapter: AgentAdapter = {
  id: 'testagent',
  displayName: 'Test Agent',
  commands: ['test-agent'],
  installCommand: 'install-test-agent',
  loginCommand: null,
  settings: { id: 'testagent', displayName: 'Test Agent', defaults: { model: 'tiny' }, keys: [] },
  trustGated: false,
  detect: async (): Promise<Detection> => ({ installed: true, path: '/opt/test-agent', version: '1.0.0', supported: true, loggedIn: true, notice: null }),
  options: () => ({ models: [{ id: 'tiny', label: 'Tiny', efforts: [], isDefault: true }], allowCustomModel: false, permissionModes: [{ id: 'ask', label: 'Ask', dangerous: false }, { id: 'yolo', label: 'YOLO', dangerous: true }] }),
  buildLaunch: (_cfg, ctx) => ({ file: '/opt/test-agent', args: ['--id', ctx.agentSessionId ?? ''], env: { ...ctx.env }, unset: [], cwd: ctx.cwd, agentSessionId: ctx.agentSessionId ?? null }),
  buildResume: () => null,
  identify: (argv) => argv[0] === '/opt/test-agent',
  signals: (id) => ({
    hook: (raw) => (raw.payload.kind === 'start' ? [{ t: 'turn.started' }] : raw.payload.kind === 'end' ? [{ t: 'turn.finished', backgroundWork: false }] : []),
    sessionIds: () => new Set(id ? [id] : []),
    agentSessionId: id,
    statusFile: () => ({ reading: null, events: [], interruptCandidate: null }),
    confirmInterrupt: () => [],
    turnEnded: () => undefined,
    ignored: { unknownStatus: 0, unknownWait: 0, foreignSession: 0, unparsable: 0, unknownEvent: 0 },
  }),
  reconcile: async () => ({ phase: null }),
}

function setup(
  o: { registry?: AdapterRegistry; hr?: () => bigint; now?: () => number; phase?: (id: string) => string | undefined; typed?: string[]; reconciled?: [string, unknown][]; settings?: Record<string, unknown>; files?: [string, unknown][]; intake?: boolean; argvs?: () => string[][]; spoolLockFlag?: number } = {},
) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agents-')))
  dirs.push(home)
  if (o.settings) fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(o.settings))
  const log = createMemoryLogger({ process: 'core' })
  const registry = o.registry ?? new AdapterRegistry(ADAPTERS)
  const settings = new SettingsFile({ home, log, watch: false, agents: registry.settingsExtensions() })
  // a stand-in for the kea-helper binary (the launch installs its per-build copy under KEA_HOME/bin)
  const helper = path.join(home, 'fake-helper')
  fs.writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const sessions = new KeyedStore<SessionView>('sessions')
  const terminals = new KeyedStore<PtyInfo>('terminals')
  const inputs: StatusInput[] = []
  const svc = new AgentService({
    home,
    version: 'test',
    log,
    db: { get: () => undefined } as unknown as KeaDb,
    registry,
    settings,
    env: async () => ({ PATH: '' }),
    helperSource: helper,
    sessions,
    terminals,
    status: {
      ingest: (i) => (inputs.push(i), true),
      statusFile: (id, r) => (o.files?.push([id, r]), true),
      reconcile: (id, r) => (o.reconciled?.push([id, r]), true),
      userTyped: (id) => (o.typed?.push(id), true),
      state: (id) => (o.phase?.(id) ? ({ phase: o.phase(id) } as ReturnType<StatusEngine['state']>) : undefined),
    },
    batch: { queue: () => undefined },
    intake: o.intake ?? false,
    ...(o.hr ? { mono: o.hr } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.argvs ? { runningArgvs: o.argvs } : {}),
    ...(o.spoolLockFlag !== undefined ? { spoolLockFlag: o.spoolLockFlag } : {}),
  })
  services.push(svc)
  return { svc, sessions, terminals, inputs, settings, registry, home, log }
}

/** An envelope the helper stamped `agoMs` before core's `hrNow`, on the helper's own clock. */
function stamped(sessionId: string, hrNow: bigint, agoMs: number, payload: Record<string, unknown>, adapter = 'claude'): Envelope {
  return { keaSessionId: sessionId, adapter, mono: Number(hrNow - BigInt(agoMs) * MS - SLEPT), receivedAt: Date.now() - agoMs, payload }
}

const near = (got: bigint | number | undefined, want: bigint, tolMs: number) => {
  expect(got, 'a mono was passed').toBeDefined()
  const d = BigInt(got!) - want
  expect(d < 0n ? -d : d).toBeLessThanOrEqual(BigInt(tolMs) * MS)
}

describe('the agent service', () => {
  it('U-AGT-18 · an envelope’s mono (the helper’s CLOCK_UPTIME_RAW, which stops in sleep) reaches the engine on process.hrtime’s clock: hooks of a spawned session are placed by emission time, not dropped as older than the spawn', () => {
    let hr = 1_000_000n * 1000n * MS // ~11.5 days since boot on process.hrtime
    const { svc, sessions, inputs } = setup({ hr: () => hr })
    const id = '01SPAWNED0000000000000000A'
    sessions.set(id, view(id, { lifecycle: 'creating' }))
    sessions.set(id, view(id, { lifecycle: 'live' })) // spawned at `hr`
    hr += 10n * MS
    const prompt = { hook_event_name: 'UserPromptSubmit', session_id: '11111111-2222-4333-8444-555555555555', prompt: 'hi' }
    svc.envelope(stamped(id, hr, 3, prompt))
    const first = inputs.at(-1)!
    expect(first.events.map((e) => e.t)).toEqual(['turn.started'])
    // emitted 3 ms ago, 7 ms after the spawn: the engine gets that time on its own clock (± the wall clock's ms)
    near(first.mono, hr - 3n * MS, 2)
    // the offset is held: envelopes 1 ms apart stay exactly 1 ms apart whatever the wall clock's rounding
    const stop = { hook_event_name: 'Stop', session_id: '11111111-2222-4333-8444-555555555555' }
    const e2 = stamped(id, hr, 2, stop)
    svc.envelope({ ...e2, mono: Number(BigInt(Math.trunc(stamped(id, hr, 3, prompt).mono)) + 1n * MS), receivedAt: e2.receivedAt })
    expect(BigInt(inputs.at(-1)!.mono!) - BigInt(first.mono!)).toBe(1n * MS)
    // a restored session takes every envelope with its time on the engine's clock too
    const rid = '01RESTORED000000000000000B'
    sessions.set(rid, view(rid, { lifecycle: 'live' }))
    svc.envelope(stamped(rid, hr, 5, prompt))
    near(inputs.at(-1)!.mono, hr - 5n * MS, 2)
  })

  it('U-AGT-15 · a test adapter added as one folder appears in the composer options (the agents store), the Settings agent cards and the status pipeline with no change elsewhere', async () => {
    const registry = new AdapterRegistry([...ADAPTERS, testAdapter])
    const { svc, sessions, inputs, settings } = setup({ registry })
    // the composer's options: a row per adapter in registry order, the pseudo-agent last; dangerous modes hidden
    await svc.detect('testagent')
    const row = svc.store.get('testagent')!
    expect(row).toMatchObject({ id: 'testagent', displayName: 'Test Agent', state: 'ready', version: '1.0.0', order: ADAPTERS.length, installCommand: 'install-test-agent', defaults: { model: 'tiny' } })
    expect(row.options.permissionModes.map((m) => m.id)).toEqual(['ask'])
    expect(svc.store.get('shell')).toMatchObject({ state: 'pseudo', order: ADAPTERS.length + 1 })
    expect([...svc.store.keys()].sort()).toEqual([...ADAPTERS.map((a) => a.id), 'shell', 'testagent'].sort())
    // the Settings agent cards: its `agents.testagent.*` keys
    expect(allSettingDefs(registry.settingsExtensions()).filter((d) => d.agent === 'testagent').map((d) => d.key)).toContain('allowDangerousModes')
    expect(settings.values.agent('testagent').defaults).toEqual({ model: 'tiny' })
    // the status pipeline: its envelopes go through its own signals into the engine
    const id = '01TESTAGENT000000000000000'
    sessions.set(id, view(id, { agent: 'testagent', lifecycle: 'live' }))
    svc.envelope({ keaSessionId: id, adapter: 'testagent', mono: 1, receivedAt: Date.now(), payload: { kind: 'start' } })
    svc.envelope({ keaSessionId: id, adapter: 'claude', mono: 2, receivedAt: Date.now(), payload: { kind: 'end' } }) // another adapter's: refused
    svc.envelope({ keaSessionId: id, adapter: 'testagent', mono: 3, receivedAt: Date.now(), payload: { kind: 'end' } })
    expect(inputs.filter((i) => i.sessionId === id).map((i) => i.events.map((e: AgentEvent) => e.t))).toEqual([['turn.started'], ['turn.finished']])
    expect(svc.stats.wrongAdapter).toBe(1)
    // and its launch through the seam: argv from its buildLaunch, the row's agent recorded
    const cmd = await svc.command({ id, agent: 'shell', requestedAgent: 'testagent', cwd: '/w', isolation: 'worktree' as const, agentSessionId: null, launch: { prompt: 'x' } }, 'start')
    expect(cmd).toMatchObject({ agent: 'testagent', argv: ['/opt/test-agent', '--id', expect.stringMatching(/^[0-9a-f-]{36}$/)] })
    expect(identifyAgent(registry, ['/opt/test-agent', '--id', 'x'])).toBe('testagent')
  })

  it('U-AGT-51 · the agents row says whether a plain right-click opens Kea’s terminal menu in the agent’s tab: Claude Code’s, which has nothing on that button; Command Code’s, an adapter that does not say and the shell keep it for the program', async () => {
    const registry = new AdapterRegistry([...ADAPTERS, testAdapter])
    const { svc } = setup({ registry })
    await svc.detect('testagent')
    expect(['claude', 'commandcode', 'testagent', 'shell'].map((id) => svc.store.get(id)?.rightButtonMenu)).toEqual([true, false, false, false])
  })

  it('U-AGT-42 · an adapter’s launch files are written into a folder of Kea’s own under KEA_HOME (named by their content, private, rewritten when they are not as given, earlier ones that no running agent was started with removed) and the launch names it; when they cannot be written the agent still starts, without them', async () => {
    const withFiles = (files: { name: string; content: string }[]): AgentAdapter => ({
      ...testAdapter,
      launchFiles: () => files,
      buildLaunch: (_cfg, ctx) => ({ file: '/opt/test-agent', args: ctx.filesDir ? ['--mod', path.join(ctx.filesDir, files[0]!.name)] : ['--plain'], env: { ...ctx.env }, unset: [], cwd: ctx.cwd, agentSessionId: null }),
    })
    const session = { id: '01TESTAGENT000000000000000', agent: 'shell', requestedAgent: 'testagent', cwd: '/w', isolation: 'worktree' as const, agentSessionId: null, launch: { prompt: '' } }
    const first = [{ name: 'mod.ts', content: 'export default function () {}\n' }]
    const a = setup({ registry: new AdapterRegistry([withFiles(first)]) })
    const cmd = await a.svc.command(session, 'start')
    const file = cmd!.argv[2]!
    const root = path.join(a.home, 'bin', 'agents')
    // under KEA_HOME, never the agent's config or the repo; the folder is named by the adapter and the content
    expect(path.dirname(path.dirname(file))).toBe(root)
    expect(path.basename(path.dirname(file))).toMatch(/^testagent-[0-9a-f]{12}$/)
    expect(fs.readFileSync(file, 'utf8')).toBe(first[0]!.content)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    // the next launch names the same file; one that was changed since is written again, by rename (a new inode)
    expect((await a.svc.command(session, 'start'))!.argv[2]).toBe(file)
    const ino = fs.statSync(file).ino
    fs.writeFileSync(file, 'tampered')
    expect((await a.svc.command(session, 'start'))!.argv[2]).toBe(file)
    expect(fs.readFileSync(file, 'utf8')).toBe(first[0]!.content)
    expect(fs.statSync(file).ino).not.toBe(ino)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['mod.ts'])

    // another build's files (other content): a folder of their own, and the earlier one is removed; other entries stay
    fs.mkdirSync(path.join(root, 'otheragent-0123456789ab'))
    fs.mkdirSync(path.join(root, 'testagent-notes'))
    const b = setup({ registry: new AdapterRegistry([withFiles([{ name: 'mod.ts', content: 'export default function () { /* v2 */ }\n' }])]) })
    fs.cpSync(root, path.join(b.home, 'bin', 'agents'), { recursive: true })
    const next = (await b.svc.command(session, 'start'))!.argv[2]!
    expect(path.basename(path.dirname(next))).not.toBe(path.basename(path.dirname(file)))
    expect(fs.readdirSync(path.join(b.home, 'bin', 'agents')).sort()).toEqual(['otheragent-0123456789ab', path.basename(path.dirname(next)), 'testagent-notes'].sort())

    // a name that would leave the folder is never written; the agent starts without its files, and the log says why
    for (const name of ['../escape.ts', 'a/b.ts', '.hidden', '']) {
      const c = setup({ registry: new AdapterRegistry([withFiles([{ name, content: 'x' }])]) })
      expect((await c.svc.command(session, 'start'))!.argv).toEqual(['/opt/test-agent', '--plain'])
      expect(fs.existsSync(path.join(c.home, 'escape.ts'))).toBe(false)
      expect(c.log.entries.some((e) => e.level === 'warn' && e.msg.includes('launch files'))).toBe(true)
    }
    // KEA_HOME's bin cannot be written (a file in its place): the same
    const d = setup({ registry: new AdapterRegistry([withFiles(first)]) })
    fs.mkdirSync(path.join(d.home, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(d.home, 'bin', 'agents'), 'not a folder')
    expect((await d.svc.command(session, 'start'))!.argv).toEqual(['/opt/test-agent', '--plain'])
    // no launch files: no folder at all
    const e = setup({ registry: new AdapterRegistry([testAdapter]) })
    await e.svc.command(session, 'start')
    expect(fs.existsSync(path.join(e.home, 'bin', 'agents'))).toBe(false)
  })

  // In a dev run, a helper rebuilt before core's first prune makes that prune take the earlier copy for another build's
  // and remove it. A path kept from the first launch and never looked at again would then give the next agent hooks
  // that call a file that is not there (ptyhost looks before every holder, U-HLD-13).
  it('U-HLD-15 · the helper an agent’s hooks call is a file that is there at every launch: the same copy while it is, never written again; one that has gone since (pruned after the helper was rebuilt) is installed again from the helper as it is now', async () => {
    const naming: AgentAdapter = { ...testAdapter, buildLaunch: (_cfg, ctx) => ({ file: '/opt/test-agent', args: ['--helper', ctx.helperPath], env: { ...ctx.env }, unset: [], cwd: ctx.cwd, agentSessionId: null }) }
    const session = { id: '01TESTAGENT000000000000000', agent: 'shell', requestedAgent: 'testagent', cwd: '/w', isolation: 'worktree' as const, agentSessionId: null, launch: { prompt: '' } }
    const a = setup({ registry: new AdapterRegistry([naming]) })
    const helperOf = async (): Promise<string> => (await a.svc.command(session, 'start'))!.argv[2]!
    expect(a.svc.hookHelperPath(), 'nothing handed out before the first launch').toBeNull()
    const first = await helperOf()
    expect(a.svc.hookHelperPath(), 'what core’s prune keeps (U-HLD-16)').toBe(first)
    expect(path.dirname(path.dirname(first))).toBe(path.join(a.home, 'bin'))
    expect(fs.readFileSync(first, 'utf8')).toBe('#!/bin/sh\nexit 0\n')
    const ino = fs.statSync(first).ino
    expect(await helperOf()).toBe(first)
    expect(fs.statSync(first).ino, 'not written again').toBe(ino)
    // the helper is rebuilt, and the copy of the earlier one is pruned as another build's
    fs.writeFileSync(path.join(a.home, 'fake-helper'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    fs.rmSync(path.dirname(first), { recursive: true })
    const next = await helperOf()
    expect(fs.existsSync(next), 'the next agent’s hooks call a file that is there').toBe(true)
    expect(next).not.toBe(first)
    expect(fs.readFileSync(next, 'utf8')).toBe('#!/bin/sh\nexit 1\n')
    expect(a.svc.hookHelperPath()).toBe(next)
    // its own copy removed under it (by hand): installed again where it was
    fs.rmSync(path.dirname(next), { recursive: true })
    expect(await helperOf()).toBe(next)
    expect(fs.existsSync(next)).toBe(true)
  })

  it('U-AGT-47 · a launch keeps the launch-files folder a running agent was started with: after an update changed the files, an older agent that is still running finds its mod where its argv says (it loads it again on /reload); the folder goes with a later launch once no running PTY names it, and no other folder is ever kept', async () => {
    const withFiles = (content: string): AgentAdapter => ({
      ...testAdapter,
      launchFiles: () => [{ name: 'mod.ts', content }],
      buildLaunch: (_cfg, ctx) => ({ file: '/opt/test-agent', args: ctx.filesDir ? ['--mod', path.join(ctx.filesDir, 'mod.ts')] : ['--plain'], env: { ...ctx.env }, unset: [], cwd: ctx.cwd, agentSessionId: null }),
    })
    const session = (id: string) => ({ id, agent: 'shell', requestedAgent: 'testagent', cwd: '/w', isolation: 'worktree' as const, agentSessionId: null, launch: { prompt: '' } })
    const pty = (ptyId: string, sessionId: string, argv: string[], o: Partial<PtyInfo> = {}): PtyInfo =>
      ({ ptyId, sessionId, kind: 'agent', state: 'running', holderPid: 1, holderStartedAt: 1, childPid: 2, cwd: '/w', argv, cols: 80, rows: 24, exitCode: null, exitSignal: null, detached: false, title: null, ...o }) as PtyInfo
    const OLD = '01OLDAGENT0000000000000000'
    const NEW = '01NEWAGENT0000000000000000'

    // the build before the update: an agent is started with its mod, and is still running
    const before = setup({ registry: new AdapterRegistry([withFiles('export default function () { /* v1 */ }\n')]) })
    const oldArgv = (await before.svc.command(session(OLD), 'start'))!.argv
    const oldMod = oldArgv[2]!
    const root = path.join(before.home, 'bin', 'agents')

    // the update: other files. Core starts on the same KEA_HOME and knows the PTYs that run, each with the argv it was
    // started with
    const after = setup({ registry: new AdapterRegistry([withFiles('export default function () { /* v2 */ }\n')]) })
    fs.cpSync(root, path.join(after.home, 'bin', 'agents'), { recursive: true })
    const moved = (p: string) => p.replace(before.home, after.home)
    after.terminals.set('pty-old', pty('pty-old', OLD, oldArgv.map(moved)))
    // a folder of an even earlier build that nothing runs from, and one an agent that has exited was started from
    const stale = path.join(after.home, 'bin', 'agents', 'testagent-000000000000')
    const ended = path.join(after.home, 'bin', 'agents', 'testagent-111111111111')
    for (const d of [stale, ended]) fs.mkdirSync(d)
    after.terminals.set('pty-ended', pty('pty-ended', '01ENDEDAGENT00000000000000', ['/opt/test-agent', '--mod', path.join(ended, 'mod.ts')], { state: 'exited', exitCode: 0 }))
    const newMod = (await after.svc.command(session(NEW), 'start'))!.argv[2]!
    expect(path.dirname(newMod)).not.toBe(path.dirname(moved(oldMod)))
    // the running agent's file is where its argv says, as it was; the folders nothing runs from are gone
    expect(fs.readFileSync(moved(oldMod), 'utf8')).toContain('v1')
    expect(fs.readFileSync(newMod, 'utf8')).toContain('v2')
    expect(fs.readdirSync(path.join(after.home, 'bin', 'agents')).sort()).toEqual([path.basename(path.dirname(moved(oldMod))), path.basename(path.dirname(newMod))].sort())
    // launches while it runs keep it; kept folders are at most the folders running PTYs name, plus the current one
    after.terminals.set('pty-new', pty('pty-new', NEW, ['/opt/test-agent', '--mod', newMod]))
    await after.svc.command(session(NEW), 'restart')
    expect(fs.existsSync(moved(oldMod))).toBe(true)
    // the old agent ends: its folder goes with the next launch
    after.terminals.set('pty-old', pty('pty-old', OLD, oldArgv.map(moved), { state: 'exited', exitCode: 0 }))
    await after.svc.command(session(NEW), 'restart')
    expect(fs.readdirSync(path.join(after.home, 'bin', 'agents'))).toEqual([path.basename(path.dirname(newMod))])
    expect(fs.readFileSync(newMod, 'utf8')).toContain('v2')

    // core's own source is the terminal records (known from its start, before ptyhost has listed what runs): a launch
    // made while the `terminals` store is still empty keeps the folder a recorded running PTY names
    let recorded: string[][] = []
    const early = setup({ registry: new AdapterRegistry([withFiles('export default function () { /* v3 */ }\n')]), argvs: () => recorded })
    fs.cpSync(path.join(after.home, 'bin', 'agents'), path.join(early.home, 'bin', 'agents'), { recursive: true })
    const v2 = newMod.replace(after.home, early.home)
    recorded = [['/bin/zsh', '-l'], ['/opt/test-agent', '--mod', v2]]
    const v3 = (await early.svc.command(session(NEW), 'start'))!.argv[2]!
    expect(early.terminals.size).toBe(0)
    expect(fs.readFileSync(v2, 'utf8')).toContain('v2')
    recorded = [['/bin/zsh', '-l']]
    await early.svc.command(session(NEW), 'restart')
    expect(fs.readdirSync(path.join(early.home, 'bin', 'agents'))).toEqual([path.basename(path.dirname(v3))])
  })

  it('U-AGT-43 · a detection older than the adapter’s detectionTtlMs is still answered from the cache and renewed in the background, once; without a ttl it is kept until the binary or the override changes', async () => {
    let t = 1_000_000
    let runs = 0
    const listing: AgentAdapter = { ...testAdapter, detectionTtlMs: 1000, detect: async () => ({ installed: true, path: '/opt/test-agent', version: `1.0.${runs++}`, supported: true, loggedIn: true, notice: null }) }
    const { svc } = setup({ registry: new AdapterRegistry([listing]), now: () => t })
    expect((await svc.detection('testagent')).version).toBe('1.0.0')
    t += 999
    expect((await svc.detection('testagent')).version).toBe('1.0.0')
    expect(runs).toBe(1)
    // at the ttl: the cached answer at once, and one renewal however often it is asked for meanwhile
    t += 1
    const asked = [svc.detection('testagent'), svc.detection('testagent'), svc.detection('testagent')]
    expect((await Promise.all(asked)).map((d) => d.version)).toEqual(['1.0.0', '1.0.0', '1.0.0'])
    await svc.detect('testagent') // the renewal in flight
    expect(runs).toBe(2)
    expect((await svc.detection('testagent')).version).toBe('1.0.1')
    expect(svc.store.get('testagent')?.version).toBe('1.0.1')
    // no ttl: never renewed by age
    let plainRuns = 0
    const plain: AgentAdapter = { ...testAdapter, detect: async () => ({ installed: true, path: '/opt/test-agent', version: `2.0.${plainRuns++}`, supported: true, loggedIn: true, notice: null }) }
    const p = setup({ registry: new AdapterRegistry([plain]), now: () => t })
    await p.svc.detection('testagent')
    t += 10 * 24 * 3600 * 1000
    expect((await p.svc.detection('testagent')).version).toBe('2.0.0')
    expect(plainRuns).toBe(1)
  })

  it('U-SET-2 · dangerous permission modes are absent from the composer’s options unless enabled for that agent: every shipped agent has one and its row leaves it out; `agents.<id>.allowDangerousModes` brings back that agent’s only; a launch naming one that is not allowed starts without it', async () => {
    // every shipped adapter as installed (nothing is run: detection is stubbed), so its launch can be built
    const installed = ADAPTERS.map((a): AgentAdapter => ({ ...a, detect: async () => ({ installed: true, path: `/opt/${a.id}`, version: null, supported: true, loggedIn: true, notice: null }) }))
    const dangerous = new Map(installed.map((a) => [a.id, a.options({ installed: true, path: null, version: null, supported: true, loggedIn: null, notice: null }).permissionModes.filter((m) => m.dangerous).map((m) => m.id)]))
    for (const [id, modes] of dangerous) expect(modes.length, `${id} has a dangerous mode`).toBeGreaterThan(0)
    const rowModes = async (svc: AgentService, id: string) => {
      await svc.detect(id)
      return svc.store.get(id)!.options.permissionModes
    }
    const launchArgv = async (svc: AgentService, id: string, mode: string) => (await svc.command({ id: '01SET5AGENT000000000000000', agent: 'shell', requestedAgent: id, cwd: '/w', isolation: 'worktree' as const, agentSessionId: null, launch: { prompt: '', permissionMode: mode } }, 'start'))!.argv

    // by default: no agent's row lists one (the composer offers the rest), and a preset or an older draft naming one is not launched with it
    const off = setup({ registry: new AdapterRegistry(installed) })
    for (const a of installed) {
      const modes = await rowModes(off.svc, a.id)
      expect(modes.length, a.id).toBeGreaterThan(0)
      expect(modes.filter((m) => m.dangerous), a.id).toEqual([])
      for (const mode of dangerous.get(a.id)!) expect(await launchArgv(off.svc, a.id, mode), `${a.id} ${mode}`).not.toContain('--permission-mode')
      // a mode that is not dangerous is passed as chosen
      expect(await launchArgv(off.svc, a.id, 'plan'), a.id).toEqual(expect.arrayContaining(['--permission-mode', 'plan']))
    }

    // enabled for one agent: that agent's dangerous modes are back, marked dangerous; the other agents' are still absent
    for (const one of installed) {
      const on = setup({ registry: new AdapterRegistry(installed), settings: { agents: { [one.id]: { allowDangerousModes: true } } } })
      for (const a of installed) {
        const listed = (await rowModes(on.svc, a.id)).filter((m) => m.dangerous).map((m) => m.id)
        expect(listed, `${a.id} with ${one.id} enabled`).toEqual(a.id === one.id ? dangerous.get(a.id) : [])
      }
      const mode = dangerous.get(one.id)![0]!
      const argv = await launchArgv(on.svc, one.id, mode)
      expect(argv[argv.indexOf('--permission-mode') + 1], one.id).toBe(mode)
    }
  })

  it('U-AGT-45 · agents.mention answers with the form of the agent the session runs: each adapter’s own (Claude Code quotes a name its bare form would cut, Command Code one with an `@`), the generic form for the shell pseudo-agent, and nothing for an unknown session or a name no form carries', async () => {
    const { svc, sessions } = setup()
    expect(Object.keys(svc.handlers())).toContain('agents.mention')
    const mention = (sessionId: string, path: string) => svc.mention(sessionId, path)
    sessions.set('s-claude', view('s-claude', { agent: 'claude' }))
    sessions.set('s-cmd', view('s-cmd', { agent: 'commandcode' }))
    sessions.set('s-shell', view('s-shell', { agent: 'shell' }))
    for (const id of ['s-claude', 's-cmd', 's-shell']) {
      expect(mention(id, 'README.md'), id).toBe('@README.md')
      expect(mention(id, 'src/my file.ts'), id).toBe('@"src/my file.ts"')
      expect(mention(id, 'a\rb'), id).toBeNull()
      expect(mention(id, 'say "hi" there.md'), id).toBeNull()
    }
    expect([mention('s-claude', 'docs/résumé'), mention('s-cmd', 'docs/résumé'), mention('s-shell', 'docs/résumé')]).toEqual(['@"docs/résumé"', '@docs/résumé', '@docs/résumé'])
    expect([mention('s-claude', 'pkg/@scope/x.js'), mention('s-cmd', 'pkg/@scope/x.js'), mention('s-shell', 'pkg/@scope/x.js')]).toEqual(['@pkg/@scope/x.js', '@"pkg/@scope/x.js"', '@"pkg/@scope/x.js"'])
    expect(mention('nobody', 'README.md')).toBeNull()
  })

  it('U-AGT-21 · an envelope that comes twice, through core’s socket and through the spool (a busy or hung core read the line after the helper had spooled it), is applied once, whichever copy comes first; envelopes without an id still apply', () => {
    const registry = new AdapterRegistry([...ADAPTERS, testAdapter])
    // core's clock stands a minute after its start: an envelope is placed on it to within the wall clock's millisecond
    // (`toHrtime`), so one sent in a core's first millisecond could land before its start and be taken for a quiet one
    let clock = 0n
    const { svc, sessions, inputs, home } = setup({ registry, hr: () => clock })
    clock = 60_000n * MS
    const id = '01DEDUPE000000000000000000'
    sessions.set(id, view(id, { agent: 'testagent', lifecycle: 'live' }))
    const spool = path.join(home, 'sessions', id, 'spool.ndjson')
    fs.mkdirSync(path.dirname(spool), { recursive: true })
    let mono = 0
    const env = (kind: string, envId?: string): Envelope => ({ keaSessionId: id, adapter: 'testagent', ...(envId ? { id: envId } : {}), mono: ++mono, receivedAt: Date.now(), payload: { kind } })
    const applied = () => inputs.filter((i) => i.sessionId === id).map((i) => `${i.events.map((e: AgentEvent) => e.t).join('+') || '-'}${i.spooled ? ' (spool)' : ''}`)
    // the spool's copy first: drained after the next live envelope (each placed by its emission time), then the
    // late socket copy is a duplicate; emitted while this core ran, it is not quiet
    const a = env('start', '00000000000000a1')
    fs.writeFileSync(spool, `${JSON.stringify(a)}\n`)
    svc.envelope(env('end', '00000000000000b2'))
    svc.envelope(a)
    expect(applied()).toEqual(['turn.finished', 'turn.started'])
    // the socket's copy first: applied live, then its spooled copy is dropped by the next drain
    const c = env('start', '00000000000000c3')
    svc.envelope(c)
    fs.writeFileSync(spool, `${JSON.stringify(c)}\n`)
    svc.envelope(env('end', '00000000000000d4'))
    expect(applied()).toEqual(['turn.finished', 'turn.started', 'turn.started', 'turn.finished'])
    expect(fs.existsSync(spool)).toBe(false)
    expect(svc.stats.duplicates).toBe(2)
    // an older helper's envelopes have no id: nothing to compare, each applies
    svc.envelope(env('start'))
    svc.envelope(env('start'))
    expect(applied().slice(-2)).toEqual(['turn.started', 'turn.started'])
    // the ids go with the live session
    expect(svc.resourceCounts.envelopeIds).toBe(4)
    sessions.set(id, view(id, { agent: 'testagent', lifecycle: 'detached' }))
    expect(svc.resourceCounts.envelopeIds).toBe(0)
  })

  it('U-AGT-22 · tier 3 live: an agent with no hook and no status file is followed from its PTY’s activity notes (output for L.tier3WorkingAfterMs after a keystroke → working, quiet for L.tier3ReadyAfterMs → ready, a bell → a question), as heuristic inputs; once a hook has come, tier 3 adds nothing but the user-input rule for a blocked agent', () => {
    vi.useFakeTimers()
    let ms = 1_000_000
    const phases = new Map<string, string>()
    const typed: string[] = []
    const { svc, sessions, terminals, inputs } = setup({ hr: () => BigInt(ms) * MS, now: () => 1_790_000_000_000 + ms, phase: (id) => phases.get(id), typed })
    const wall = () => 1_790_000_000_000 + ms
    const advance = (n: number) => {
      for (let i = 0; i < n; i += 10) {
        ms += 10
        vi.advanceTimersByTime(10)
      }
    }
    const pty = (ptyId: string, sessionId: string) => terminals.set(ptyId, { ptyId, sessionId, kind: 'agent', state: 'running', childPid: null } as PtyInfo)
    const heuristic = (id: string) => inputs.filter((i) => i.sessionId === id && i.source === 'heuristic').map((i) => i.events.map((e: AgentEvent) => (e.t === 'attention.question' ? `${e.t}:${e.key}` : e.t)).join('+'))

    // hooks disabled, no status file: tier 3 is the only source
    const id = '01TIERTHREE00000000000000A'
    sessions.set(id, view(id, { lifecycle: 'live' }))
    pty('aaaaaaaaaa', id)
    svc.activity({ m: 'pty.keystroke', a: { ptyId: 'aaaaaaaaaa', at: wall() } })
    advance(100)
    svc.activity({ m: 'pty.activity', a: { ptyId: 'aaaaaaaaaa', active: true, at: wall() } })
    advance(L.tier3WorkingAfterMs - 50)
    expect(heuristic(id), 'not before tier 3’s delay').toEqual([])
    advance(100)
    expect(heuristic(id)).toEqual(['turn.started'])
    svc.activity({ m: 'pty.activity', a: { ptyId: 'aaaaaaaaaa', active: false, at: wall() } })
    advance(L.tier3ReadyAfterMs + 50)
    expect(heuristic(id)).toEqual(['turn.started', 'turn.finished'])
    expect(svc.resourceCounts.timers, 'no timer once nothing is due').toBe(0)
    svc.activity({ m: 'pty.bell', a: { ptyId: 'aaaaaaaaaa' } })
    expect(heuristic(id).at(-1)).toBe('attention.question:terminal:bell')
    // notes of a shell tab of the session, or of an unknown PTY, are not the agent's
    terminals.set('bbbbbbbbbb', { ptyId: 'bbbbbbbbbb', sessionId: id, kind: 'shell', state: 'running', childPid: null } as PtyInfo)
    svc.activity({ m: 'pty.bell', a: { ptyId: 'bbbbbbbbbb' } })
    svc.activity({ m: 'pty.bell', a: { ptyId: 'cccccccccc' } })
    expect(heuristic(id)).toHaveLength(3)

    // a hooked agent: tier 3 never overrides its hooks
    const hooked = '01TIERTHREE00000000000000B'
    sessions.set(hooked, view(hooked, { lifecycle: 'live' }))
    pty('dddddddddd', hooked)
    svc.envelope({ keaSessionId: hooked, adapter: 'claude', mono: 1, receivedAt: wall(), payload: { hook_event_name: 'SessionStart', session_id: '11111111-2222-4333-8444-555555555555', source: 'startup' } })
    svc.activity({ m: 'pty.keystroke', a: { ptyId: 'dddddddddd', at: wall() } })
    svc.activity({ m: 'pty.activity', a: { ptyId: 'dddddddddd', active: true, at: wall() } })
    advance(L.tier3WorkingAfterMs + 100)
    svc.activity({ m: 'pty.bell', a: { ptyId: 'dddddddddd' } })
    svc.activity({ m: 'pty.activity', a: { ptyId: 'dddddddddd', active: false, at: wall() } })
    advance(L.tier3ReadyAfterMs + 100)
    expect(heuristic(hooked), 'no tier-3 turn, finish or question beside the hooks').toEqual([])
    // … except the user-input rule: typing into the blocked agent, then output for tier 3's delay
    phases.set(hooked, 'blocked')
    svc.activity({ m: 'pty.keystroke', a: { ptyId: 'dddddddddd', at: wall() } })
    expect(typed, 'the keystroke reached the engine while blocked').toEqual([hooked])
    advance(50)
    svc.activity({ m: 'pty.activity', a: { ptyId: 'dddddddddd', active: true, at: wall() } })
    advance(L.tier3WorkingAfterMs + 100)
    expect(heuristic(hooked)).toEqual(['turn.started'])
    // the session ends: its tier-3 timer goes with it
    sessions.set(hooked, view(hooked, { lifecycle: 'detached' }))
    sessions.set(id, view(id, { lifecycle: 'detached' }))
    expect(svc.resourceCounts.timers).toBe(0)
  })

  it('U-AGT-23 · a restored live session is confirmed once its reconcile completes, whatever it found: the transcript’s phase is applied; nothing usable, or a reconcile that fails, leaves the restored status as it is, confirmed (no wait for L.unconfirmedStatusMs)', async () => {
    const throwing: AgentAdapter = {
      ...testAdapter,
      id: 'throwing',
      settings: { ...testAdapter.settings, id: 'throwing', displayName: 'Throwing' },
      identify: () => false,
      reconcile: async () => {
        throw new Error('transcript unreadable')
      },
    }
    const finished: AgentAdapter = { ...testAdapter, id: 'finishing', settings: { ...testAdapter.settings, id: 'finishing', displayName: 'Finishing' }, identify: () => false, reconcile: async () => ({ phase: 'finished' }) }
    const reconciled: [string, unknown][] = []
    const { sessions } = setup({ registry: new AdapterRegistry([...ADAPTERS, testAdapter, throwing, finished]), reconciled })
    // live when core starts (no lifecycle seen before): restored, so reconciled
    sessions.set('01NOTHING0000000000000000A', view('01NOTHING0000000000000000A', { agent: 'testagent', lifecycle: 'live' }))
    sessions.set('01THROWS00000000000000000B', view('01THROWS00000000000000000B', { agent: 'throwing', lifecycle: 'live' }))
    sessions.set('01FINISHED000000000000000C', view('01FINISHED000000000000000C', { agent: 'finishing', lifecycle: 'live' }))
    await vi.waitFor(() => expect(reconciled.map(([id]) => id).sort()).toEqual(['01FINISHED000000000000000C', '01NOTHING0000000000000000A', '01THROWS00000000000000000B']))
    expect(new Map(reconciled)).toEqual(
      new Map<string, unknown>([
        ['01NOTHING0000000000000000A', null],
        ['01THROWS00000000000000000B', null],
        ['01FINISHED000000000000000C', { phase: 'ready' }],
      ]),
    )
  })
  it('U-AGT-24 · the status file is an exact source from its first reading: a file just registered (no status yet) reaches the engine, which answers the trust question with it, and turns tier 3 off — the user-input rule too; a Stop while the file still says busy is read again after L.statusFileInterruptGraceMs (a Stop hook that kept the turn going); an unknown wait is a silent question, logged once', () => {
    vi.useFakeTimers()
    let ms = 1_000_000
    const phases = new Map<string, string>()
    const typed: string[] = []
    const files: [string, unknown][] = []
    const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agents-cfg-')))
    dirs.push(cfg)
    const { svc, sessions, terminals, inputs, log } = setup({ hr: () => BigInt(ms) * MS, now: () => 1_790_000_000_000 + ms, phase: (id) => phases.get(id), typed, files, settings: { agents: { claude: { env: { CLAUDE_CONFIG_DIR: cfg } } } } })
    const wall = () => 1_790_000_000_000 + ms
    const advance = (n: number) => {
      for (let i = 0; i < n; i += 10) {
        ms += 10
        vi.advanceTimersByTime(10)
      }
    }
    const sid = '11111111-2222-4333-8444-555555555555'
    const write = (pid: number, o: Record<string, unknown>) => {
      const f = path.join(cfg, 'sessions', `${pid}.json`)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, JSON.stringify({ pid, sessionId: sid, ...o }))
    }
    const live = (id: string, ptyId: string, pid: number) => {
      sessions.set(id, view(id, { lifecycle: 'live' }))
      terminals.set(ptyId, { ptyId, sessionId: id, kind: 'agent', state: 'running', childPid: pid } as PtyInfo)
    }
    const heuristic = (id: string) => inputs.filter((i) => i.sessionId === id && i.source === 'heuristic')

    // a file just registered: the agent is past its trust dialog, whatever the hooks do
    const a = '01STATUSFILE00000000000A01'
    write(4201, {})
    live(a, 'aaaaaaaaaa', 4201)
    expect(files).toEqual([[a, null]])
    // tier 3 adds nothing from now on, not even the user-input rule (the file says when a prompt is answered)
    svc.activity({ m: 'pty.keystroke', a: { ptyId: 'aaaaaaaaaa', at: wall() } })
    svc.activity({ m: 'pty.activity', a: { ptyId: 'aaaaaaaaaa', active: true, at: wall() } })
    advance(L.tier3WorkingAfterMs + 100)
    phases.set(a, 'blocked')
    svc.activity({ m: 'pty.keystroke', a: { ptyId: 'aaaaaaaaaa', at: wall() } })
    advance(50)
    svc.activity({ m: 'pty.activity', a: { ptyId: 'aaaaaaaaaa', active: true, at: wall() } })
    advance(L.tier3WorkingAfterMs + 100)
    svc.activity({ m: 'pty.bell', a: { ptyId: 'aaaaaaaaaa' } })
    expect(heuristic(a)).toEqual([])

    // a Stop while the file says busy: read again after the grace; still busy, the turn goes on (the engine moves ready → working)
    const b = '01STATUSFILE00000000000B01'
    write(4202, { status: 'busy' })
    live(b, 'bbbbbbbbbb', 4202)
    files.length = 0
    svc.envelope({ keaSessionId: b, adapter: 'claude', id: '00000000000000b1', mono: 1, receivedAt: wall(), payload: { hook_event_name: 'Stop', session_id: sid } })
    expect(inputs.filter((i) => i.sessionId === b).at(-1)!.events.map((e: AgentEvent) => e.t)).toEqual(['turn.finished'])
    advance(L.statusFileInterruptGraceMs - 20)
    expect(files).toEqual([])
    advance(30)
    expect(files).toEqual([[b, { status: 'busy' }]])
    expect(svc.resourceCounts.timers).toBe(0)
    // the usual case: the file went idle 10–18 ms after the Stop, so the second look sees idle and says nothing twice
    svc.envelope({ keaSessionId: b, adapter: 'claude', id: '00000000000000b2', mono: 2, receivedAt: wall(), payload: { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'go on' } })
    svc.envelope({ keaSessionId: b, adapter: 'claude', id: '00000000000000b3', mono: 3, receivedAt: wall(), payload: { hook_event_name: 'Stop', session_id: sid } })
    write(4202, { status: 'idle' })
    files.length = 0
    advance(L.statusFileInterruptGraceMs + 20)
    expect(files.map(([, r]) => r)).not.toContainEqual({ status: 'busy' })

    // an unknown wait: a question the file only estimates, logged once for the contract to learn
    const c = '01STATUSFILE00000000000C01'
    write(4203, { status: 'waiting', waitingFor: 'goal vote' })
    live(c, 'cccccccccc', 4203)
    expect(files.at(-1)).toEqual([c, { status: 'waiting', waitingFor: 'unknown', detail: 'goal vote' }])
    const logged = () => log.entries.filter((e) => /unknown waitingFor/.test(e.msg))
    expect(logged()).toHaveLength(1)
    expect(JSON.stringify(logged()[0])).toContain('goal vote')
  })
  it('U-AGT-25 · a busy core: a live envelope whose copy the helper spooled too is applied live (it may notify) and the spooled copy skipped; a drained envelope is quiet only if it was emitted before this core started — after that (a busy core, the intake down) it is applied as live; at a Resume, an earlier agent’s spooled envelopes are not applied at all', async () => {
    let hr = 1_000_000n * 1000n * MS
    const registry = new AdapterRegistry([...ADAPTERS, testAdapter])
    const { svc, sessions, inputs, home } = setup({ hr: () => hr, registry })
    const born = hr
    const sid = '11111111-2222-4333-8444-555555555555'
    const id = '01BUSYCORE0000000000000000'
    sessions.set(id, view(id, { lifecycle: 'live' }))
    hr += 1000n * MS
    const spool = path.join(home, 'sessions', id, 'spool.ndjson')
    fs.mkdirSync(path.dirname(spool), { recursive: true })
    const applied = (sessionId: string) => inputs.filter((i) => i.sessionId === sessionId).map((i) => `${i.events.map((e: AgentEvent) => e.t).join('+')}${i.spooled ? ' (quiet)' : ''}`)
    // the helper waited L.hookBoundMs for core's answer and spooled the line; core, busy, reads it from its backlog
    const perm = { ...stamped(id, hr, 80, { hook_event_name: 'PermissionRequest', session_id: sid, tool_name: 'Bash', tool_input: { command: 'npm test' } }), id: '00000000000000a1' }
    fs.writeFileSync(spool, `${JSON.stringify(perm)}\n`)
    svc.envelope(perm)
    expect(applied(id)).toEqual(['attention.permission'])
    expect(svc.stats.duplicates).toBe(1)
    expect(fs.existsSync(spool)).toBe(false)
    // a spool with one envelope from before this core started (Kea was not running) and one from after (the intake was down)
    const before = { ...stamped(id, hr, Number((hr - born) / MS) + 5000, { hook_event_name: 'Notification', session_id: sid, notification_type: 'elicitation_dialog', message: 'old' }), id: '00000000000000b1' }
    const after = { ...stamped(id, hr, 40, { hook_event_name: 'Stop', session_id: sid }), id: '00000000000000b2' }
    fs.writeFileSync(spool, `${JSON.stringify(before)}\n${JSON.stringify(after)}\n`)
    hr += 10n * MS
    svc.envelope({ ...stamped(id, hr, 1, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'next' }), id: '00000000000000b3' })
    expect(applied(id).slice(1)).toEqual(['turn.started', 'attention.question (quiet)', 'turn.finished'])

    // Resume: the spool still holds envelopes of the agent that ran before (stamped before this launch)
    const t = '01RESUMED00000000000000000'
    sessions.set(t, view(t, { agent: 'testagent', lifecycle: 'live' }))
    sessions.set(t, view(t, { agent: 'testagent', lifecycle: 'detached' }))
    const tspool = path.join(home, 'sessions', t, 'spool.ndjson')
    fs.mkdirSync(path.dirname(tspool), { recursive: true })
    fs.writeFileSync(tspool, `${JSON.stringify({ keaSessionId: t, adapter: 'testagent', id: '00000000000000c1', mono: Number(hr - 50n * MS - SLEPT), receivedAt: Date.now() - 50, payload: { kind: 'start' } })}\n`)
    hr += 100n * MS
    await svc.command({ id: t, agent: 'testagent', cwd: '/w', isolation: 'worktree' as const, agentSessionId: 'x', launch: { prompt: '' } }, 'resume')
    sessions.set(t, view(t, { agent: 'testagent', lifecycle: 'live' }))
    expect(applied(t), 'an earlier agent’s envelope reaches neither the signals nor the engine').toEqual([])
    expect(fs.existsSync(tspool)).toBe(false)
  })
  it('U-AGT-26 · connections over the intake’s cap are refused and counted, and once a held connection closes the live sessions’ spools are drained: a refused hook’s envelope is applied then, not at the session’s next envelope', async () => {
    const { svc, sessions, inputs, home } = setup({ intake: true })
    const intake = svc.intake!
    expect(await intake.start()).toBe(true)
    const id = '01REFUSED00000000000000000'
    sessions.set(id, view(id, { lifecycle: 'live' }))
    const socks: net.Socket[] = []
    let closedByCore = 0
    try {
      for (let i = 0; i < L.hookSocketConnectionsMax + 1; i++) socks.push(net.connect(intake.socketPath).on('error', () => undefined).on('close', () => closedByCore++))
      await vi.waitFor(() => expect(intake.connections === L.hookSocketConnectionsMax && closedByCore === 1).toBe(true), { timeout: 10_000 })
      expect(intake.stats.refused, 'the connection over the cap is counted').toBe(1)
      // the refused helper spooled its envelope
      const spool = path.join(home, 'sessions', id, 'spool.ndjson')
      fs.mkdirSync(path.dirname(spool), { recursive: true })
      const env: Envelope = { keaSessionId: id, adapter: 'claude', id: '00000000000000e1', mono: 1, receivedAt: Date.now(), payload: { hook_event_name: 'Stop', session_id: '11111111-2222-4333-8444-555555555555' } }
      fs.writeFileSync(spool, `${JSON.stringify(env)}\n`)
      // a held connection closes: the spools are swept
      socks.find((x) => !x.destroyed && x.readyState === 'open')!.destroy()
      await vi.waitFor(() => expect(inputs.filter((i) => i.sessionId === id).map((i) => i.events.map((e: AgentEvent) => e.t).join('+'))).toEqual(['turn.finished']), { timeout: 10_000 })
      expect(fs.existsSync(spool)).toBe(false)
    } finally {
      for (const x of socks) x.destroy()
    }
  })
  it('U-AGT-28 · a FIFO (or any special file) where core reads a spool, a status file or a transcript never blocks core: each read opens without waiting and refuses what is not a regular file', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-fifo-')))
    dirs.push(dir)
    const mod = (rel: string) => JSON.stringify(fileURLToPath(new URL(rel, import.meta.url)))
    const spoolDir = path.join(dir, 'home', 'sessions', '01FIFO0000000000000000000A')
    fs.mkdirSync(spoolDir, { recursive: true })
    execFileSync('mkfifo', [path.join(spoolDir, 'spool.ndjson')])
    const cfg = path.join(dir, 'cfg')
    fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true })
    execFileSync('mkfifo', [path.join(cfg, 'sessions', '4242.json')])
    execFileSync('mkfifo', [path.join(dir, 'transcript.jsonl')])
    // in a child: a blocked read would block its thread for good, so the child's time is bounded from outside
    const script = path.join(dir, 'reads.ts')
    fs.writeFileSync(
      script,
      `import { readTail, JsonlTailer } from ${mod('../../../../packages/adapters/src/kit/jsonl.ts')}
import { AdapterRegistry, ADAPTERS } from ${mod('../../../../packages/adapters/src/index.ts')}
import { createMemoryLogger } from ${mod('../../../../packages/kit/src/index.ts')}
import { KeyedStore } from ${mod('../../../../packages/protocol/src/index.ts')}
import { drainSpool, hasSpool } from ${mod('./spool.ts')}
import { SettingsFile } from ${mod('../settings/settings.ts')}
import { AgentService } from ${mod('./agents.ts')}
const dir = ${JSON.stringify(dir)}
const out = {}
out.readTail = readTail(dir + '/transcript.jsonl')
out.tailer = new JsonlTailer(dir + '/transcript.jsonl', { from: 0 }).read()
out.drain = drainSpool(dir + '/home', '01FIFO0000000000000000000A', () => undefined)
out.hasSpool = hasSpool(dir + '/home', '01FIFO0000000000000000000A')
const home = dir + '/home'
const log = createMemoryLogger({ process: 'core' })
const registry = new AdapterRegistry(ADAPTERS)
const settings = new SettingsFile({ home, log, watch: false, agents: registry.settingsExtensions() })
const sessions = new KeyedStore('sessions')
const terminals = new KeyedStore('terminals')
const files = []
const svc = new AgentService({ home, version: 't', log, db: { get: () => undefined }, registry, settings, env: async () => ({ PATH: '', CLAUDE_CONFIG_DIR: ${JSON.stringify(cfg)} }), helperSource: null, sessions, terminals,
  status: { ingest: () => true, statusFile: (_id, r) => (files.push(r), true), reconcile: () => true, userTyped: () => true, state: () => undefined }, batch: { queue: () => undefined }, intake: false })
await svc.start()
sessions.set('s1', { id: 's1', projectId: 'p', agent: 'claude', agentSessionId: '11111111-2222-4333-8444-555555555555', lifecycle: 'live', phase: 'working', cwd: '/w', portBase: null, launch: {} })
terminals.set('aaaaaaaaaa', { ptyId: 'aaaaaaaaaa', sessionId: 's1', kind: 'agent', state: 'running', childPid: 4242 })
out.statusFile = { watched: svc.statusFilePath('s1'), readings: files }
svc.dispose()
process.stdout.write('DONE ' + JSON.stringify(out) + '\\n')
process.exit(0)
`,
    )
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: FIFO_BOUND_MS, killSignal: 'SIGKILL' })
    expect(r.signal, `the child was ${r.signal ? 'killed: a read blocked' : 'done'}\n${r.stderr}`).toBeNull()
    expect(r.status, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('DONE ') + 5)) as Record<string, unknown>
    expect(out).toMatchObject({ readTail: null, tailer: [], hasSpool: false, statusFile: { watched: path.join(cfg, 'sessions', '4242.json'), readings: [] } })
  })
  it('U-AGT-31 · a transcript_path a payload names is taken only under the agent’s config folder (<config>/projects/): any other — a forged SessionStart’s — is ignored and counted, never stored, read or watched', () => {
    const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agents-cfg-')))
    dirs.push(cfg)
    const { svc, sessions, inputs } = setup({ settings: { agents: { claude: { env: { CLAUDE_CONFIG_DIR: cfg } } } } })
    const id = '01TRANSCRIPT00000000000000'
    sessions.set(id, view(id, { lifecycle: 'live' }))
    const start = (n: number, transcript_path: string) =>
      svc.envelope({ keaSessionId: id, adapter: 'claude', id: `00000000000000f${n}`, mono: n, receivedAt: Date.now(), payload: { hook_event_name: 'SessionStart', session_id: '11111111-2222-4333-8444-555555555555', source: 'startup', transcript_path } })
    const started = () => inputs.filter((i) => i.sessionId === id).flatMap((i) => i.events).filter((e) => e.t === 'session.started') as Extract<AgentEvent, { t: 'session.started' }>[]
    for (const [n, forged] of [
      [1, '/tmp/x.jsonl'],
      [2, path.join(cfg, 'elsewhere', 'x.jsonl')],
      [3, path.join(cfg, 'projects', '..', '..', 'x.jsonl')],
      [4, 'projects/relative.jsonl'],
    ] as const) {
      start(n, forged)
      expect(started().at(-1)!.transcriptPath, forged).toBeUndefined()
    }
    expect(svc.stats.foreignTranscript).toBe(4)
    const own = path.join(cfg, 'projects', '-w', '11111111-2222-4333-8444-555555555555.jsonl')
    start(5, own)
    expect(started().at(-1)!.transcriptPath).toBe(own)
    expect(svc.stats.foreignTranscript).toBe(4)
  })

  // where core can take the hook's lock (macOS's O_EXLOCK); Linux has none: a named skip there, the next test
  // covers what stands in for it
  it.runIf(SPOOL_LOCK_FLAG !== 0)('U-AGT-32 · a drain that finds a helper appending (the spool’s lock held) leaves the spool and drains it once more after L.spoolLockRetryMs: the helper’s envelope is applied then, with no further event to trigger it', () => {
    vi.useFakeTimers()
    let hr = 1_000_000n * 1000n * MS
    const { svc, sessions, inputs, home } = setup({ hr: () => hr })
    const sid = '11111111-2222-4333-8444-555555555555'
    const id = '01SPOOLRETRY00000000000000'
    sessions.set(id, view(id, { lifecycle: 'live' }))
    hr += 1000n * MS
    const spool = path.join(home, 'sessions', id, 'spool.ndjson')
    fs.mkdirSync(path.dirname(spool), { recursive: true })
    const applied = () => inputs.filter((i) => i.sessionId === id).map((i) => i.events.map((e: AgentEvent) => e.t).join('+'))
    // a helper has the spool open and locked (macOS O_EXLOCK = flock's LOCK_EX), about to append the Stop it could not deliver
    fs.writeFileSync(spool, '')
    const helper = fs.openSync(spool, fs.constants.O_WRONLY | fs.constants.O_APPEND | SPOOL_LOCK_FLAG)
    svc.envelope({ ...stamped(id, hr, 5, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'go' }), id: '00000000000000d1' })
    expect(applied()).toEqual(['turn.started'])
    expect(fs.existsSync(spool), 'left while the helper holds its lock').toBe(true)
    fs.writeSync(helper, `${JSON.stringify({ ...stamped(id, hr, 1, { hook_event_name: 'Stop', session_id: sid }), id: '00000000000000d2' })}\n`)
    fs.closeSync(helper)
    expect(svc.resourceCounts.timers).toBe(1)
    vi.advanceTimersByTime(L.spoolLockRetryMs)
    expect(applied()).toEqual(['turn.started', 'turn.finished'])
    expect(fs.existsSync(spool)).toBe(false)
    expect(svc.resourceCounts.timers).toBe(0)
  })

  it('U-AGT-32 · a line the helper wrote twice, into a spool core had already taken and again into the next one (core renames without the hook’s lock on Linux), is applied once', () => {
    let hr = 1_000_000n * 1000n * MS
    const { svc, sessions, inputs, home } = setup({ hr: () => hr })
    const sid = '11111111-2222-4333-8444-555555555555'
    const id = '01SPOOLTWICE00000000000000'
    sessions.set(id, view(id, { lifecycle: 'live' }))
    hr += 1000n * MS
    const spool = path.join(home, 'sessions', id, 'spool.ndjson')
    fs.mkdirSync(path.dirname(spool), { recursive: true })
    const applied = () => inputs.filter((i) => i.sessionId === id).map((i) => i.events.map((e: AgentEvent) => e.t).join('+'))
    const stop = `${JSON.stringify({ ...stamped(id, hr, 1, { hook_event_name: 'Stop', session_id: sid }), id: '00000000000000e2' })}\n`
    // the first copy is in the spool core takes at the next envelope
    fs.writeFileSync(spool, stop)
    svc.envelope({ ...stamped(id, hr, 5, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'go' }), id: '00000000000000e1' })
    expect(applied()).toEqual(['turn.started', 'turn.finished'])
    // the helper's second copy, in the fresh spool, is drained after the next one and dropped by its id
    fs.writeFileSync(spool, stop)
    const before = svc.stats.duplicates
    svc.envelope({ ...stamped(id, hr, 9, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'again' }), id: '00000000000000e3' })
    expect(applied()).toEqual(['turn.started', 'turn.finished', 'turn.started'])
    expect(svc.stats.duplicates - before).toBe(1)
    expect(fs.existsSync(spool)).toBe(false)
  })

  // Without the hook's lock (Linux) core may read a spool before a helper's line lands; the helper writes it
  // again into a fresh spool, and nothing would drain that one before the session's next event (Command Code has no
  // status file): every take without the lock is followed by one more drain.
  it('U-AGT-32 · a spool taken without the hook’s lock is drained once more after L.spoolLockRetryMs: the line the helper wrote again into the fresh spool is applied then, with no further event; that drain arms no other', () => {
    vi.useFakeTimers()
    let hr = 1_000_000n * 1000n * MS
    const { svc, sessions, inputs, home } = setup({ hr: () => hr, spoolLockFlag: 0 })
    const sid = '11111111-2222-4333-8444-555555555555'
    const id = '01SPOOLUNLOCKED00000000000'
    sessions.set(id, view(id, { lifecycle: 'live' }))
    hr += 1000n * MS
    const spool = path.join(home, 'sessions', id, 'spool.ndjson')
    fs.mkdirSync(path.dirname(spool), { recursive: true })
    const applied = () => inputs.filter((i) => i.sessionId === id).map((i) => i.events.map((e: AgentEvent) => e.t).join('+'))
    // a helper is about to append the Stop it could not deliver; core takes the (still empty) spool first
    fs.writeFileSync(spool, '')
    svc.envelope({ ...stamped(id, hr, 5, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'go' }), id: '00000000000000f1' })
    expect(applied()).toEqual(['turn.started'])
    expect(svc.resourceCounts.timers, 'one more drain armed').toBe(1)
    // the helper's look after its write finds its file gone: the line goes into a fresh spool
    fs.writeFileSync(spool, `${JSON.stringify({ ...stamped(id, hr, 1, { hook_event_name: 'Stop', session_id: sid }), id: '00000000000000f2' })}\n`)
    vi.advanceTimersByTime(L.spoolLockRetryMs)
    expect(applied()).toEqual(['turn.started', 'turn.finished'])
    expect(fs.existsSync(spool)).toBe(false)
    expect(svc.resourceCounts.timers, 'that drain arms no other').toBe(0)
  })

  it('U-AGT-35 · a status file whose config folder appears unheard while its nearest ancestor is outside that folder (watched without recursion, so no deeper write is heard either) is read at the agent’s next sign of life: its next hook, or its PTY’s next activity note', async () => {
    // every directory event lost, as when the process's directory stream restarts for another watch (U-AGT-20). The
    // watch service's own look once that stream has settled (U-FT-19) is not this test's: its timer never runs here
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const watched: { target: string; recursive: boolean }[] = []
    vi.spyOn(fs, 'watch').mockImplementation(((target: string, opts: fs.WatchOptions) => {
      watched.push({ target, recursive: opts?.recursive === true })
      return Object.assign(new EventEmitter(), { close: () => undefined }) as unknown as fs.FSWatcher
    }) as unknown as typeof fs.watch)
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agents-cfg-')))
    dirs.push(base)
    const cfg = path.join(base, 'cfg') // not there yet: the agent's first run
    const files: [string, unknown][] = []
    const { svc, sessions, terminals } = setup({ files, settings: { agents: { claude: { env: { CLAUDE_CONFIG_DIR: cfg } } } } })
    const sid = '11111111-2222-4333-8444-555555555555'
    const write = (pid: number, status: string) => {
      const f = path.join(cfg, 'sessions', `${pid}.json`)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, JSON.stringify({ pid, sessionId: sid, status }))
    }
    const live = (id: string, ptyId: string, pid: number) => {
      sessions.set(id, view(id, { lifecycle: 'live' }))
      terminals.set(ptyId, { ptyId, sessionId: id, kind: 'agent', state: 'running', childPid: pid } as PtyInfo)
    }
    // past the new watch's own second look, so only an event or a later look can find the file
    const turns = async () => {
      for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r))
    }
    const a = '01STATUSUNHEARD000000000A1'
    const b = '01STATUSUNHEARD000000000B1'
    live(a, 'aaaaaaaaaa', 4301)
    live(b, 'bbbbbbbbbb', 4302)
    expect(watched).toEqual([
      { target: base, recursive: false },
      { target: base, recursive: false },
    ])
    await turns()
    write(4301, 'busy')
    await turns()
    expect(files, 'nothing heard: the creation’s events were lost').toEqual([])
    // the agent speaks: its hook
    svc.envelope({ keaSessionId: a, adapter: 'claude', id: '00000000000000e1', mono: 1, receivedAt: Date.now(), payload: { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'go' } })
    await turns()
    expect(files).toEqual([[a, { status: 'busy' }]])
    // that watch moving onto its file restarted the directory stream, and every file still waited for was looked for
    // again (U-FT-19): the other agent's file appears after those looks, unheard too
    for (let i = 0; i < 3; i++) await turns()
    write(4302, 'busy')
    await turns()
    expect(files, 'nothing heard of the second file either').toHaveLength(1)
    // its PTY's output is its sign of life
    svc.activity({ m: 'pty.activity', a: { ptyId: 'bbbbbbbbbb', active: true, at: Date.now() } })
    await turns()
    expect(files).toEqual([
      [a, { status: 'busy' }],
      [b, { status: 'busy' }],
    ])
    // each watch is on its file now (watched through its descriptor), so later writes are heard there
    expect(watched.filter((w) => w.target.startsWith('/dev/fd/'))).toHaveLength(2)
  })
})
