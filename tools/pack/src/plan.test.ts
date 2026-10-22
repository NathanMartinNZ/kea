import { describe as suite, expect, it } from 'vitest'
import { parseSettings } from '../../../packages/protocol/src/settings.ts'
import { describe, firstPruneNotice, PRUNE_SETTING, relaunchPlan, type Findings, type KeaFound } from './plan.ts'

const kea = (o: Partial<KeaFound> = {}): KeaFound => ({ pid: 4321, home: null, window: true, front: true, held: 0, ...o })
const found = (o: Partial<Findings> = {}): Findings => ({
  target: '/Applications/Kea.app', // os-ok: test data
  test: false,
  installedVersion: '0.1.0',
  newVersion: '0.1.0',
  recovered: [],
  keas: [],
  holders: [],
  firstPrune: false,
  pruneDays: 7,
  noRelaunch: false,
  quitSeconds: 20,
  ...o,
})

suite('what the install says before it replaces anything (tools/pack/src/plan.ts)', () => {
  it('U-PACK-13 · Kea is opened again only if it ran from the target with its own home, had a window and was in front; every other case says why not', () => {
    expect(relaunchPlan(found({ keas: [kea()] }))).toEqual({ will: true, say: 'Kea is opened again and reattaches every session.' })
    const no = (f: Partial<Findings>) => {
      const r = relaunchPlan(found(f))
      expect(r.will, JSON.stringify(f)).toBe(false)
      return r.say
    }
    expect(no({ keas: [] })).toMatch(/was not running/)
    expect(no({ keas: [kea({ window: false, front: false })] })).toMatch(/no window .*menu bar/)
    expect(no({ keas: [kea({ front: false })] })).toMatch(/not the app in front/)
    expect(no({ keas: [kea()], test: true })).toMatch(/test target/)
    expect(no({ keas: [kea()], noRelaunch: true })).toMatch(/--no-relaunch/)
    expect(no({ keas: [kea()], firstPrune: true })).toMatch(/change that setting first/)
    expect(no({ keas: [kea({ home: '/tmp/other-home' })] })).toMatch(/a home of its own/)
    expect(no({ keas: [kea(), kea({ pid: 5, home: '/tmp/other-home' })] })).toMatch(/more than one Kea/)
  })

  it('U-PACK-14 · the plan names what is installed, whether Kea runs and how, the holders alive by build, and each step in order', () => {
    const quiet = describe(found({ installedVersion: null })).join('\n')
    expect(quiet).toMatch(/Nothing is installed at \/Applications\/Kea\.app yet/) // os-ok: test data
    expect(quiet).toMatch(/Kea is not running from it/)
    expect(quiet).not.toMatch(/asked to quit/)
    // os-ok: test data
    expect(quiet).toMatch(/1\. The new build is copied.*\n {2}2\. It is moved to \/Applications\/Kea\.app\.\n {2}3\. Kea was not running, so it is not opened\./)
    expect(describe(found()).join('\n')).toMatch(/2\. \/Applications\/Kea\.app is replaced: same path, same signature.*\n {2}3\. Kea was not running/) // os-ok: test data

    const busy = describe(
      found({
        recovered: ['Removed /Applications/Kea.app.installing, the copy an earlier install had not finished.'], // os-ok: test data
        keas: [kea()],
        holders: [{ home: '/tmp/kea-home', groups: [{ build: '0.1.0-aaaaaaaaaaaa', count: 2 }, { build: '0.1.0-bbbbbbbbbbbb', count: 1 }] }],
      }),
    ).join('\n')
    expect(busy).toMatch(/^Note: Removed \/Applications\/Kea\.app\.installing/) // os-ok: test data
    expect(busy).toMatch(/\/Applications\/Kea\.app is Kea 0\.1\.0\. This build is Kea 0\.1\.0\./) // os-ok: test data
    expect(busy).toMatch(/Kea is running from it \(pid 4321\): its window is open and in front\./)
    expect(busy).toMatch(/3 terminals are running in the background under \/tmp\/kea-home, started by 2 builds:\n {6}0\.1\.0-aaaaaaaaaaaa: 2\n {6}0\.1\.0-bbbbbbbbbbbb: 1/)
    expect(busy).toMatch(/Each runs from its own copy of kea-helper in \/tmp\/kea-home\/bin, not from the app\. None is touched\./)
    expect(busy).toMatch(/1\. The new build is copied.*\(Kea keeps running\)\.\n {2}2\. Kea is asked to quit completely, and given 20 s\. Your sessions keep running without it\. If it does not quit, nothing is replaced\.\n {2}3\. .*replaced.*\n {2}4\. Kea is opened again and reattaches every session\./)

    expect(describe(found({ keas: [kea({ window: false, front: false, home: '/tmp/kea-home' })], holders: [{ home: '/tmp/kea-home', groups: [] }] })).join('\n')).toMatch(/home \/tmp\/kea-home\): no window \(menu bar or Dock\)\.\n.*No session's terminal is running under \/tmp\/kea-home\./)
    expect(describe(found({ keas: [kea({ front: false })] })).join('\n')).toMatch(/its window is open, behind another app/)
  })

  it('U-PACK-15 · terminals that are not detached stop the install before anything is replaced; the first build with the prune says so and what to set', () => {
    const held = describe(found({ keas: [kea({ held: 2 })] })).join('\n')
    expect(held).toMatch(/Nothing: 2 terminals run as Kea's own processes \(not detached\), and would end when Kea quits\./)
    expect(held).not.toMatch(/is replaced/)
    const first = describe(found({ keas: [kea()], firstPrune: true, pruneDays: 9 })).join('\n')
    expect(first).toMatch(/Kea is not opened again this time/)
    expect(first).toMatch(/archived for more than 9 days loses its rebuildable folders/)
    // what the notice says to write must turn the prune off as Kea reads settings.json (nested by the key's dots): a
    // flat `"general.pruneArchivedBuildDirsDays": 0` is ignored and leaves the default in force
    const snippet = /set (\{.*\}) in ~\/\.kea\/settings\.json/s.exec(firstPruneNotice(7).join(' '))?.[1]
    expect(snippet, 'the notice names what to write').toBeDefined()
    expect(parseSettings(JSON.parse(snippet as string), []).values.get(PRUNE_SETTING), 'that text turns the prune off').toBe(0)
    expect(describe(found({ keas: [kea()] })).join('\n')).not.toContain(PRUNE_SETTING)
    expect(firstPruneNotice(7).join(' ')).toMatch(/for good/)
  })
})
