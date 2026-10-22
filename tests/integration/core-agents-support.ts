// Agent sessions under test: the whole of core on a temp KEA_HOME with a real ptyhost and real holders, as
// core-sessions-support.ts sets it up, plus a `claude` on PATH that is tools/fake-agent (writeAgentShim) and the debug
// kea-helper as the hook helper. The fake agent's HOME is the sandboxed user home of the session environment: its
// transcripts and its live status file go under `<that home>/.claude/`, never the real one.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CoreOptions } from '@kea/core/src/core.ts'
import type { Envelope } from '@kea/core/src/agents/intake.ts'
import type { Phase, SessionView } from '@kea/protocol'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { helperBinary } from '../support/holders.ts'
import { createArgs, startSessions, type SessionsUnderTest } from './core-sessions-support.ts'

export interface AgentSessionsUnderTest extends SessionsUnderTest {
  /** The sandboxed user home (the fake agent's HOME). */
  userHome: string
  /** Where the `claude` shim lives (first on PATH). */
  binDir: string
  /** Rewrite the shim (a scenario, a version, logged out). */
  shim(env?: Record<string, string>): void
  /** Write a scenario file; returns its path. */
  scenario(name: string, yaml: string): string
  /** Every envelope core's intake delivered, in arrival order (wrapping the agent service's entry point). */
  envelopes: Envelope[]
  /** Wall ms (sub-ms) at each envelope's arrival, parallel to `envelopes` (compare with its `receivedAt`). */
  arrivals: number[]
  /** Called with each envelope before core applies it (a test stalls core here). */
  onEnvelope: ((e: Envelope) => void) | null
  /** Distinct phases each session went through, in order (from the `sessions` store). */
  phases(id: string): Phase[]
  /** The session's agent PTY id. */
  agentPty(id: string): string
  /** Type into the session's agent PTY (straight to the holder, so it works while core is down). */
  type(id: string, data: string): void
  /** Create a session running `agent` and wait until it is live. */
  create(projectId: string, prompt: string, more?: Record<string, unknown>): Promise<SessionView>
}

export async function startAgentSessions(o: { scenario?: string; settings?: Record<string, unknown>; opts?: Partial<CoreOptions>; env?: Record<string, string> } = {}): Promise<AgentSessionsUnderTest> {
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agt-bin-')))
  const scenarios = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agt-scn-')))
  const shimEnv: Record<string, string> = o.scenario ? { FAKE_AGENT_SCENARIO: o.scenario } : {}
  writeAgentShim(binDir, 'claude', { env: shimEnv })
  const helper = await helperBinary()
  const base = await startSessions({
    ...(o.settings ? { settings: o.settings } : {}),
    opts: { helperPath: helper, ...o.opts },
    env: { PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, ...o.env },
  })
  const envelopes: Envelope[] = []
  const arrivals: number[] = []
  const phases = new Map<string, Phase[]>()
  const watch = () => {
    const svc = base.c.core.agents
    const orig = svc.envelope.bind(svc)
    svc.envelope = (e: Envelope) => {
      envelopes.push(e)
      arrivals.push(performance.timeOrigin + performance.now())
      s.onEnvelope?.(e)
      orig(e)
    }
    const note = (v: SessionView) => {
      const list = phases.get(v.id) ?? []
      if (v.lifecycle === 'live' && list.at(-1) !== v.phase) list.push(v.phase)
      phases.set(v.id, list)
    }
    for (const v of base.c.core.sessions.store.values()) note(v)
    base.c.core.sessions.store.onDelta((d) => {
      for (const v of Object.values(d.set ?? {})) note(v)
    })
  }
  watch()
  const relaunch = base.relaunch.bind(base)
  const crashAndRelaunch = base.crashAndRelaunch.bind(base)
  const dispose = base.dispose.bind(base)
  const s: AgentSessionsUnderTest = Object.assign(base, {
    userHome: base.env.HOME!,
    binDir,
    shim(env: Record<string, string> = {}) {
      writeAgentShim(binDir, 'claude', { env: { ...shimEnv, ...env } })
    },
    scenario(name: string, yaml: string) {
      const f = path.join(scenarios, name)
      fs.writeFileSync(f, yaml)
      return f
    },
    envelopes,
    arrivals,
    onEnvelope: null,
    phases: (id: string) => phases.get(id) ?? [],
    agentPty(id: string) {
      const r = base.c.core.terminals.sessionRecords(id).filter((x) => x.kind === 'agent' && x.state === 'running').at(-1)
      if (!r) throw new Error(`session ${id} has no running agent PTY`)
      return r.ptyId
    },
    type(id: string, data: string) {
      base.h.manager.get(s.agentPty(id))!.input(data)
    },
    async create(projectId: string, prompt: string, more: Record<string, unknown> = {}) {
      const r = await base.call<{ sessionId: string }>('sessions.create', createArgs(projectId, prompt, { agent: 'claude', ...more }))
      const v = await base.until(r.sessionId, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
      if (v.lifecycle !== 'live') throw new Error(`creation failed: ${v.creation?.error}`)
      return v
    },
    async relaunch(more?: Partial<CoreOptions>) {
      await relaunch(more)
      watch()
    },
    async crashAndRelaunch(more?: Partial<CoreOptions>) {
      await crashAndRelaunch(more)
      watch()
    },
    async dispose() {
      try {
        await dispose()
      } finally {
        fs.rmSync(binDir, { recursive: true, force: true })
        fs.rmSync(scenarios, { recursive: true, force: true })
      }
    },
  })
  return s
}
