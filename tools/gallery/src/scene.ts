// What the gallery's sets share: a Kea window of the gallery's size, a demo project, fake-agent sessions put into a
// status through core's intake (tests/support/app-status.ts `ingest`), and the review sets' switch.

import fs from 'node:fs'
import path from 'node:path'
import type { AgentEvent } from '../../../packages/protocol/src/index.ts'
import { tinyRepo } from '../../repo-factory/src/index.ts'
import { until, type Kea, type KeaRun } from '../../../tests/support/app.ts'
import { AGENT_MARK, startFakeSession } from '../../../tests/support/app-fake-agent.ts'
import { recordClipboard } from '../../../tests/support/app-server.ts'
import { addProject, waitRow } from '../../../tests/support/app-sessions.ts'
import { ingest } from '../../../tests/support/app-status.ts'
import { pinSettings, SCALE_ARG, sizeWindow } from './shots.ts'

export type Launch = (o?: Parameters<KeaRun['launch']>[0]) => Promise<Kea>

/** The review sets (R-…) run only when asked for (`pnpm gallery --review`). */
export const REVIEW = process.env.KEA_GALLERY_REVIEW === '1'

/** Kea at the gallery's size and scale, the fake agent as Claude Code by default (`agent: false`: the shell pseudo-agent). */
export async function openKea(run: KeaRun, launch: Launch, o: { agent?: boolean; settings?: Record<string, Record<string, unknown>>; ready?: 'terminal' | 'window'; env?: Record<string, string> } = {}): Promise<Kea> {
  pinSettings(run, { general: { defaultAgent: o.agent === false ? 'shell' : 'claude' }, ...o.settings })
  const kea = await launch({ args: [SCALE_ARG], ...(o.ready ? { ready: o.ready } : {}), ...(o.env ? { env: o.env } : {}) })
  await sizeWindow(kea)
  // nothing a set does reaches the person's clipboard: the page's writes are recorded instead
  await recordClipboard(await kea.page())
  return kea
}

/** A repo-factory `tiny` repository named `name` inside the run's home, added as a project. */
export async function demoProject(kea: Kea, name: string): Promise<string> {
  const root = tinyRepo({ name, parent: kea.run.home }).root
  await addProject(kea, root, name)
  return root
}

/** A fake agent's screen: its mark, the prompt, then `lines`. */
export const frame = (...lines: string[]) => `frame: ${JSON.stringify([AGENT_MARK, '', '> {{prompt}}', '', ...lines])}`

/** An agent that draws its prompt and waits, firing no hook of its own after its start: its status is the set's to give. */
export const QUIET = `steps:
  - ${frame('')}
  - wait: { answer: "~" }
`

/** Start a fake-agent session in the background with `title` as its prompt; resolves with its id. */
export async function session(kea: Kea, name: string, title: string, scenario = QUIET, o: { open?: boolean } = {}): Promise<string> {
  return (await startFakeSession(kea, name, title, scenario, { background: true, ...o })).id
}

/** Put a session into a status, as its agent's hooks would, and wait for its row to say so. */
export async function status(kea: Kea, id: string, row: string, ...events: AgentEvent[]): Promise<void> {
  await ingest(kea, id, 'hook', ...events)
  await waitRow(kea, id, row, (r) => r.status === row)
}

export const working: AgentEvent[] = [{ t: 'turn.started' }]
export const permission = (summary: string, tool = 'Bash'): AgentEvent[] => [{ t: 'turn.started' }, { t: 'attention.permission', key: `${tool}: ${summary}`, tool, summary }]
export const question = (summary: string): AgentEvent[] => [{ t: 'turn.started' }, { t: 'attention.question', key: summary, summary }]
export const finished = (lastMessage: string): AgentEvent[] => [{ t: 'turn.started' }, { t: 'turn.finished', lastMessage, backgroundWork: false }]
export const failed = (error: string): AgentEvent[] => [{ t: 'turn.started' }, { t: 'turn.failed', error, kind: 'other' }]
export const limited = (resetsAt: number): AgentEvent[] => [{ t: 'turn.started' }, { t: 'turn.failed', error: 'usage limit reached', kind: 'rate_limit', resetsAt }]

/** Write files into a folder (parents made). */
export function write(dir: string, files: Record<string, string | Uint8Array>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), content)
  }
}

/** Wait for `ms` of the page's own clock where a state has no event to wait on (a tooltip's delay, a hover). */
export async function pageDelay(kea: Kea, ms: number): Promise<void> {
  const page = await kea.page()
  await page.evaluate((t) => new Promise<void>((r) => setTimeout(r, t)), ms)
}

export { until }

/** A session's folder (its worktree), from the window's copy of core's `sessions` store. */
export async function cwdOf(kea: Kea, id: string): Promise<string> {
  const page = await kea.page()
  return until(`the folder of ${id}`, () =>
    page.evaluate((sid) => {
      const rows = (window as unknown as { __keaProbe: { store(n: string): { rows: Record<string, { cwd?: string }> | null } } }).__keaProbe.store('sessions').rows
      return rows?.[sid]?.cwd
    }, id),
  )
}

/** Run a command as a menu row would (`__keaProbe.run`); throws when it is not available. */
export async function runCommand(kea: Kea, id: string, args?: unknown): Promise<void> {
  const page = await kea.page()
  const ok = await page.evaluate(([c, a]) => (window as unknown as { __keaProbe: { run(id: string, args?: unknown): boolean } }).__keaProbe.run(c as string, a), [id, args] as const)
  if (!ok) throw new Error(`the command ${id} is not available`)
}

/** The id of the project at `root`, from the window's copy of core's `projects` store. */
export async function projectId(kea: Kea, root: string): Promise<string> {
  const page = await kea.page()
  return until(`the project at ${root}`, () =>
    page.evaluate((r) => {
      const rows = (window as unknown as { __keaProbe: { store(n: string): { rows: Record<string, { rootPath?: string }> | null } } }).__keaProbe.store('projects').rows
      return Object.entries(rows ?? {}).find(([, p]) => p.rootPath === r)?.[0]
    }, root),
  )
}
