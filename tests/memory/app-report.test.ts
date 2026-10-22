// The resource report against the real app: a scripted scenario whose numbers are known from outside the process that
// reports them. The terminal rows only: tests/memory/app-resources-report.test.ts checks every other row of the
// reports, and main's hourly `resources.ndjson` line.

import { afterEach, describe, expect, it } from 'vitest'
import { ADAPTERS } from '../../packages/adapters/src/registry.ts'
import { descendants } from '../../tools/perf/src/launch.ts'
import { KeaRun, PROMPT, until, type Kea } from '../support/app.ts'
import { readAll, RendererProbe } from '../support/app-leak.ts'
import { sysKey } from '../support/keys.ts'

const runs: KeaRun[] = []
const probes: RendererProbe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

/** Ground truth from outside the reporting processes: state files, live processes, the DOM, V8's own object census. */
async function truth(run: KeaRun, kea: Kea, renderer: RendererProbe) {
  const page = await kea.page()
  const core = await kea.pid('core')
  return {
    liveHolders: run.holders().filter((h) => run.holderAlive(h) && !h.exited).length,
    tabs: await kea.tabCount(),
    views: await page.locator('.terminal-host').count(),
    webgl: await renderer.liveObjects('WebGL2RenderingContext'),
    coreChildren: descendants([core.pid]),
  }
}

type Child = { pid: number | null; argv: string[]; startedAt: number; exitedAt: number | null; closedAt: number | null }

/** Core's children alive at any point since `since` (Date.now()), as the child hook saw them start and close, by argv. */
async function childrenSince(kea: Kea, since: number): Promise<string[]> {
  const c = await kea.debug<{ live: Child[]; ended: Child[] }>('core', 'children')
  const at = (ms: number | null) => (ms === null ? 'not yet' : `${ms - since} ms`)
  return [...c.ended.filter((x) => (x.closedAt as number) >= since), ...c.live].map((x) => `${x.argv.join(' ')} (started ${at(x.startedAt)}, exited ${at(x.exitedAt)}, closed ${at(x.closedAt)})`)
}

describe('resource report (app)', () => {
  it('L-MEM-13 · a scripted scenario with known numbers: the terminal rows of the ptyhost, renderer and core reports match ground truth', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    // core at rest: its launch work ends with the first detection of every agent, after the login-shell probe and in
    // two rounds of children per adapter (its version, then its login check and lists, up to three at once). The first
    // prompt comes before that: a report read then counted those children, gone by the time the process table was read
    // (core counted 1 to 3)
    await until('core to detect every agent', () => ADAPTERS.every((a) => kea.logLines('core').some((l) => l.msg === 'agent detected' && l.agent === a.id)) || undefined)
    const renderer = await RendererProbe.open(kea)
    probes.push(renderer)

    const check = async (expected: { tabs: number; find: number }) => {
      const since = Date.now()
      const r = (await readAll(kea, renderer)).counts // collects garbage everywhere first
      const t = await truth(run, kea, renderer)
      expect(t.tabs, 'tabs').toBe(expected.tabs)
      expect(t.liveHolders, 'live holders').toBe(expected.tabs)
      // ptyhost: a socket per live holder; every mirror awake (all were active within L.mirrorParkIdleMs); a stream per
      // view the renderer keeps, and the renderer's own count of stream ports says the same
      expect(r['ptyhost.kit.ptyhost.holderSockets'], 'ptyhost holder sockets').toBe(t.liveHolders)
      expect(r['ptyhost.kit.ptyhost.mirrors'], 'ptyhost mirrors').toBe(t.liveHolders)
      expect(r['ptyhost.kit.ptyhost.streams'], 'ptyhost streams').toBe(t.views)
      expect(r['renderer.streamPorts'], 'renderer stream ports').toBe(t.views)
      expect(r['renderer.terminals'], 'renderer terminals').toBe(t.views)
      expect(r['renderer.webglContexts'], 'renderer WebGL contexts').toBe(t.webgl)
      expect(r['renderer.searchAddons'], 'renderer search addons').toBe(expected.find)
      // core at rest: no child process, and its report says so
      const coreChildren = Object.entries(r)
        .filter(([k]) => k.startsWith('core.kit.kit.children.') && k.endsWith('.active'))
        .reduce((n, [, v]) => n + v, 0)
      // a count that is not the truth names every child: those core started that were alive at any point since the
      // reading began (times from its start), and those the process table had
      const named = coreChildren === t.coreChildren.length ? '' : `; core's children since the reading began: ${(await childrenSince(kea, since)).join('; ') || 'none'}; in the process table: ${t.coreChildren.map((p) => p.args).join('; ') || 'none'}`
      expect(coreChildren, `core children${named}`).toBe(t.coreChildren.length)
    }

    await check({ tabs: 1, find: 0 })
    await kea.newTab()
    await kea.newTab()
    await check({ tabs: 3, find: 0 })
    const page = await kea.page()
    await page.keyboard.press(sysKey('Meta+f'))
    await page.waitForSelector('.find-bar')
    await check({ tabs: 3, find: 1 })
    await page.keyboard.press('Escape')
    await page.waitForSelector('.find-bar', { state: 'detached' })
    // a shell that exits takes its tab, holder, mirror and stream with it
    // its holder's state is read first: once the holder exits and is released, its state file may already be gone
    const gone = run.holder((await kea.shown()) as string)
    await kea.enter('exit')
    await until('the exited shell’s tab to close', async () => (await kea.tabCount()) === 2 || undefined)
    await until('its holder to exit', () => !run.holderAlive(gone) || undefined)
    await until('ptyhost to release it', async () => (await kea.debug<Record<string, number>>('ptyhost', 'kit'))['ptyhost.holderSockets'] === 2 || undefined)
    await check({ tabs: 2, find: 0 })
  })
})
