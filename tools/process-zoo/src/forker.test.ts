import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { forkerBinary, type ForkerOutput, parseForkerOutput } from './forker.ts'
import { alive, killAll, type Proc, track, waitGone, zoo } from './test-support.ts'

afterAll(killAll)

/** Start forker on a pipe and wait for its ready line; every pid it reports is tracked for the cleanup. */
async function forker(args: readonly string[]): Promise<{ p: Proc; tree: ForkerOutput; parsed(): ForkerOutput }> {
  const p = zoo('forker', [...args, '--sleep', '60'])
  await p.until((s) => parseForkerOutput(s).ready !== null, 'the ready line')
  const tree = parseForkerOutput(p.out())
  track(tree.procs.map((x) => x.pid))
  return { p, tree, parsed: () => parseForkerOutput(p.out()) }
}

const ppidOf = (pid: number) => Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim())

describe('process zoo: forker', () => {
  it('U-ZOO-7 · --fork --setpgid: children in their own groups in the same session; signals are reported, TERM ends a child and the parent reaps it', async () => {
    const { p, tree, parsed } = await forker(['--fork', '--children', '2', '--setpgid'])
    const [parent, c0, c1] = tree.procs
    if (!parent || !c0 || !c1) throw new Error(`expected three processes: ${p.out()}`)
    expect(tree.procs.map((x) => `${x.role}${x.index}`)).toEqual(['parent0', 'child0', 'child1'])
    expect(parent.pid).toBe(p.child.pid)
    for (const c of [c0, c1]) {
      expect(c.ppid).toBe(parent.pid)
      expect(c.pgid).toBe(c.pid) // its own process group…
      expect(c.sid).toBe(parent.sid) // …in the parent's session
    }
    expect(parent.pgid).not.toBe(c0.pgid)
    expect(tree.ready).toEqual([parent.pid, c0.pid, c1.pid])

    process.kill(c0.pid, 'SIGUSR1')
    await p.until((s) => parseForkerOutput(s).signals.length === 1, 'the USR1 report')
    expect(parsed().signals).toEqual([{ role: 'child', index: 0, pid: c0.pid, signal: 'USR1', action: 'report' }])
    process.kill(c0.pid, 'SIGTERM')
    await p.until((s) => parseForkerOutput(s).reaped.length === 1, 'the parent reaping child 0')
    expect(parsed().signals[1]).toEqual({ role: 'child', index: 0, pid: c0.pid, signal: 'TERM', action: 'exit' })
    expect(parsed().reaped).toEqual([{ pid: c0.pid, by: parent.pid, code: null, signal: 'TERM' }])
    process.kill(-c1.pgid, 'SIGKILL') // the whole group of child 1: only child 1
    await p.until((s) => parseForkerOutput(s).reaped.length === 2, 'the parent reaping child 1')
    expect(parsed().reaped[1]).toEqual({ pid: c1.pid, by: parent.pid, code: null, signal: 'KILL' })
    expect(alive(parent.pid)).toBe(true)
    p.child.kill('SIGHUP')
    expect(await p.exited).toEqual({ code: null, signal: 'SIGHUP' })
  })

  it('U-ZOO-8 · --double-fork --setsid --stubborn: an orphaned grandchild in a new session that ignores TERM and HUP until SIGKILL', async () => {
    const { p, tree, parsed } = await forker(['--double-fork', '--setsid', '--stubborn'])
    const [parent, middle, grandchild] = tree.procs
    if (!parent || !middle || !grandchild) throw new Error(`expected three processes: ${p.out()}`)
    expect(tree.procs.map((x) => x.role)).toEqual(['parent', 'middle', 'grandchild'])
    expect(middle).toMatchObject({ ppid: parent.pid, pgid: middle.pid, sid: middle.pid }) // setsid: leader of both
    expect(grandchild).toMatchObject({ pgid: middle.pid, sid: middle.pid }) // inherited, not a leader
    expect(grandchild.sid).not.toBe(parent.sid)
    expect(tree.ready).toEqual([parent.pid, grandchild.pid]) // the middle has left
    await p.until((s) => parseForkerOutput(s).reaped.length === 1, 'the middle reaped')
    expect(parsed().reaped).toEqual([{ pid: middle.pid, by: parent.pid, code: 0, signal: null }])
    expect(ppidOf(grandchild.pid)).toBe(1) // orphaned: reparented to init (pid 1)

    process.kill(grandchild.pid, 'SIGTERM')
    process.kill(parent.pid, 'SIGHUP')
    await p.until((s) => parseForkerOutput(s).signals.length === 2, 'both reports')
    expect(new Set(parsed().signals.map((s) => `${s.role}:${s.signal}:${s.action}`))).toEqual(new Set(['grandchild:TERM:ignore', 'parent:HUP:ignore']))
    expect(alive(grandchild.pid) && alive(parent.pid)).toBe(true)
    process.kill(grandchild.pid, 'SIGKILL')
    p.child.kill('SIGKILL')
    expect((await p.exited).signal).toBe('SIGKILL')
    await waitGone([grandchild.pid])
  })

  it('U-ZOO-9 · forker is compiled once and cached; usage errors exit 2', async () => {
    expect(forkerBinary()).toBe(forkerBinary())
    expect(forkerBinary()).toMatch(/\/tools\/process-zoo\/build\/forker-[0-9a-f]{12}$/)
    const bad = [['--setsid'], ['--fork', '--double-fork'], ['--fork', '--setsid', '--setpgid'], ['--children', '0', '--fork'], ['--bogus']].map((a) => zoo('forker', a))
    for (const b of bad) expect((await b.exited).code).toBe(2)
    expect(bad[0]?.err()).toMatch(/need --fork or --double-fork/)
    const help = zoo('forker', ['--help'])
    expect((await help.exited).code).toBe(0)
    expect(help.out()).toMatch(/^forker: builds a process tree/)
  })
})
