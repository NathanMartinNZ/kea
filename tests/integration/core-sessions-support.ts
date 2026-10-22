// Sessions under test: the whole of core (core.ts) on a temp KEA_HOME, wired to a real ptyhost and real holders, with
// repositories from tools/repo-factory and a hermetic git (no user or system config, a fixed identity, a temp HOME).
// A session's agent is the `shell` pseudo-agent (`/bin/sh -l`): `createArgs` asks for it unless a test names another
// agent. Used by the core-level suites in tests/integration, tests/chaos and tests/memory.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CoreOptions } from '@kea/core/src/core.ts'
import type { Project, SessionView } from '@kea/protocol'
import { fixtureGitEnv, tinyRepo, type FixtureRepo } from '@kea-tools/repo-factory/src/index.ts'
import { ptyhostHarness, testEnv, until, type Harness } from '../support/holders.ts'
import { ownPtyIds, startFullCore, type ControlWrap, type FullCoreUnderTest } from './core-support.ts'

export interface SessionsUnderTest {
  h: Harness
  c: FullCoreUnderTest
  /** The environment core's git and PTYs run with. */
  env: Record<string, string>
  call<T = unknown>(method: string, args: object): Promise<T>
  /** Register `root` as a project. */
  project(root: string): Promise<Project>
  view(id: string): SessionView | undefined
  /** Wait until the session's view satisfies `pred`. */
  until(id: string, what: string, pred: (v: SessionView) => boolean, ms?: number): Promise<SessionView>
  /** Background work done (pipelines, trash). */
  idle(): Promise<void>
  /** Core goes (clean shutdown) and a new one starts on the same home and ptyhost (a relaunch). */
  relaunch(o?: Partial<CoreOptions>): Promise<void>
  /** Core is killed (no clean shutdown) and a new one starts. */
  crashAndRelaunch(o?: Partial<CoreOptions>): Promise<void>
  dispose(): Promise<void>
}

/** Hermetic git and shells: no user config, a fixed identity, a throwaway HOME. */
export function sessionEnv(home: string): Record<string, string> {
  const fx = fixtureGitEnv() as Record<string, string>
  return { ...testEnv(), ...fx, HOME: home, SHELL: '/bin/sh', PATH: `${path.dirname(process.execPath)}:${testEnv().PATH}` }
}

/** Write `<home>/settings.json` before core starts (core under test does not watch it). */
export function writeSettings(home: string, values: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(values, null, 2))
}

export async function startSessions(o: { settings?: Record<string, unknown>; opts?: Partial<CoreOptions>; env?: Record<string, string>; wrap?: ControlWrap } = {}): Promise<SessionsUnderTest> {
  const h = await ptyhostHarness()
  const userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-sess-home-')))
  const env = { ...sessionEnv(userHome), ...o.env }
  if (o.settings) writeSettings(h.home, o.settings)
  let c = startFullCore(h, { env, opts: { ...o.opts }, wrap: o.wrap })
  await c.core.started
  const s: SessionsUnderTest = {
    h,
    get c() {
      return c
    },
    env,
    call: (m, a) => c.call(m, a),
    async project(root) {
      const r = await c.call<{ project: Project }>('projects.add', { path: root })
      return r.project
    },
    view: (id) => c.core.sessions.store.get(id),
    async until(id, what, pred, ms) {
      let last: SessionView | undefined
      await until(`session ${id}: ${what} (last: ${JSON.stringify(last && { lifecycle: last.lifecycle, creation: last.creation, setup: last.setup })})`, () => {
        last = c.core.sessions.store.get(id)
        return last !== undefined && pred(last)
      }, ms)
      return last!
    },
    idle: () => c.core.sessions.idle(),
    async relaunch(more) {
      await c.core.sessions.idle()
      c.dispose()
      c = startFullCore(h, { env, opts: { ...o.opts, ...more }, wrap: o.wrap })
      await c.core.started
    },
    async crashAndRelaunch(more) {
      c.crash()
      c = startFullCore(h, { env, opts: { ...o.opts, ...more }, wrap: o.wrap })
      await c.core.started
    },
    async dispose() {
      try {
        await c.core.sessions.idle().catch(() => undefined)
        c.dispose()
        for (const id of ownPtyIds(h.home)) h.spawned.add(id)
        await h.dispose()
      } finally {
        // also when a failed test left something for h.dispose to complain about
        fs.rmSync(userHome, { recursive: true, force: true })
      }
    },
  }
  return s
}

/** git in a fixture repo or worktree, hermetic. */
export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()
}

/** The tiny repo, plus a cleanup. */
export function repo(name = 'demo'): FixtureRepo {
  return tinyRepo({ name })
}

/** `git worktree list --porcelain` paths. */
export function worktreePaths(root: string): string[] {
  return gitIn(root, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
}

export function branches(root: string): string[] {
  return gitIn(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter(Boolean)
}

/** A clean `create` call for a project. */
export function createArgs(projectId: string, prompt: string, more: Record<string, unknown> = {}): Record<string, unknown> {
  return { projectId, prompt, agent: 'shell', config: {}, isolation: 'worktree', base: { kind: 'head' }, ...more }
}
