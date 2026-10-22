// macOS's side of the test harnesses' OS layer (index.ts): the tools the harnesses have always run, by their paths.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { notAvailable } from '../../../../packages/protocol/src/platform.ts'
import { runProcess } from '../../../../packages/kit/src/runProcess.ts'
import type { HarnessOs } from './index.ts'

/** How long one of these tools may take (a launch's step, tests/support/app.ts `STEP_MS`). */
const TOOL_TIMEOUT_MS = 20_000

/** `[[dd-]hh:]mm:ss.cc` (ps `time`) in seconds. */
export function psTime(s: string): number {
  const [days, rest] = s.includes('-') ? (s.split('-') as [string, string]) : ['0', s]
  return Number(days) * 86_400 + rest.split(':').reduce((acc, part) => acc * 60 + Number(part), 0)
}

function quiet(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir() } }).trim()
  } catch {
    return null
  }
}

/** The display's lines in the power log: its last state and each "off" at or after `since` (ms since the epoch). */
function displayLines(since: number): { line(l: string): void; result(): { on: boolean | null; offs: string[] } } {
  let on: boolean | null = null
  const offs: string[] = []
  return {
    line(l: string) {
      const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})\s.*Display is turned (on|off)\b/.exec(l)
      if (!m) return
      on = m[5] === 'on'
      if (!on && Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) >= since) offs.push(`${m[1]} ${m[2]}`)
    },
    result: () => ({ on, offs }),
  }
}

export const darwin: HarnessOs = {
  system: 'darwin',
  // the person's own screen: the window is never key (`--kea-perf`), and the harness checks it is never in front
  display: { shared: true, trayProblem: null, launch: async () => ({ args: [], env: {} }) },
  front: {
    pid: () => {
      const asn = quiet('/usr/bin/lsappinfo', ['front'])
      if (!asn) return null
      const info = quiet('/usr/bin/lsappinfo', ['info', '-only', 'pid', asn]) ?? ''
      const m = /\bpid\s*=\s*(\d+)/.exec(info) ?? /"pid"\s*=\s*(\d+)/.exec(info)
      return m ? Number(m[1]) : null
    },
  },
  // the display kept on (an assertion held by a process, not a setting): with it off, Electron's main keeps memory for
  // each window made and closed
  keepAwake: { wrap: (argv) => ({ file: '/usr/bin/caffeinate', args: ['-di', ...argv], warning: null }) },
  cpu: {
    seconds: async (pids) => {
      const out = new Map<number, number>()
      if (!pids.length) return out
      const r = await runProcess('/bin/ps', ['-o', 'pid=,time=', '-p', pids.join(',')], { pool: 'other', timeoutMs: TOOL_TIMEOUT_MS, env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } })
      for (const line of (r.stdout?.toString('utf8') ?? '').split('\n')) {
        const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line)
        if (m) out.set(Number(m[1]), psTime(m[2] as string))
      }
      return out
    },
  },
  openFiles: {
    // one line per open file after the header (descriptors, and the cwd and mapped files lsof also lists)
    count: async (pid) => {
      const r = await runProcess('/usr/sbin/lsof', ['-n', '-P', '-p', String(pid)], { pool: 'other' })
      return Math.max(0, (r.stdout?.toString('utf8').trim() ?? '').split('\n').length - 1)
    },
  },
  // lsof reads a holder's descriptors, sockets included
  unixSockets: notAvailable('macOS counts a holder’s descriptors, its sockets among them, with lsof'),
  smallVolumes: {
    problem: async () => null,
    // an APFS disk image in a temporary folder of its own, attached without showing in Finder; detached (forced if a
    // first try fails) and removed after
    mount: async (at, mb, name) => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)))
      const image = path.join(dir, 'volume.dmg')
      const hdiutil = (args: string[]) => runProcess('/usr/bin/hdiutil', args, { pool: 'other', timeoutMs: TOOL_TIMEOUT_MS })
      const made = await hdiutil(['create', '-quiet', '-size', `${mb}m`, '-fs', 'APFS', '-volname', name, '-type', 'UDIF', image])
      const attached = made.code === 0 ? await hdiutil(['attach', '-quiet', '-nobrowse', '-noautoopen', '-mountpoint', at, image]) : made
      if (attached.code !== 0) {
        fs.rmSync(dir, { recursive: true, force: true })
        throw new Error(`hdiutil: ${attached.stderr}`)
      }
      return {
        async detach() {
          if ((await hdiutil(['detach', '-quiet', at])).code !== 0) {
            const forced = await hdiutil(['detach', '-quiet', '-force', at])
            if (forced.code !== 0) throw new Error(`hdiutil detach ${at}: ${forced.stderr}`)
          }
          fs.rmSync(dir, { recursive: true, force: true })
        },
      }
    },
  },
  backupAttribute: {
    hex: async (p, attr) => {
      const r = await runProcess('/usr/bin/xattr', ['-px', attr, p], { pool: 'other', timeoutMs: TOOL_TIMEOUT_MS })
      return r.code === 0 ? (r.stdout?.toString('utf8') ?? '') : null
    },
  },
  leaks: { file: '/usr/bin/leaks' },
  powerLog: {
    display: async (since) => {
      const lines = displayLines(since)
      let rest = ''
      const r = await runProcess('/usr/bin/pmset', ['-g', 'log'], {
        pool: 'other',
        timeoutMs: TOOL_TIMEOUT_MS,
        onStdout: (chunk) => {
          const ls = (rest + chunk.toString('utf8')).split('\n')
          rest = ls.pop() ?? ''
          for (const l of ls) lines.line(l)
        },
      })
      lines.line(rest)
      if (r.code !== 0) throw new Error(`pmset -g log failed (${r.code}): ${r.stderr}`)
      return lines.result()
    },
  },
  ownedUnmapped: {
    blocks: async (pid) => {
      const r = await runProcess('/usr/bin/footprint', ['-p', String(pid)], { pool: 'other', timeoutMs: TOOL_TIMEOUT_MS })
      if (r.code !== 0) throw new Error(`footprint -p ${pid} failed (${r.code}): ${r.stderr}`)
      const m = /(\d+)\s+Owned physical footprint \(unmapped\)\s*$/m.exec(r.stdout?.toString('utf8') ?? '')
      return m ? Number(m[1]) : 0
    },
  },
  machine: {
    model: () => quiet('/usr/sbin/sysctl', ['-n', 'hw.model']),
    system: (release) => `macOS ${quiet('/usr/bin/sw_vers', ['-productVersion']) ?? '?'} (Darwin ${release})`,
    power: () => {
      const batt = quiet('/usr/bin/pmset', ['-g', 'batt'])
      return batt === null ? null : batt.includes("'AC Power'") ? 'AC' : batt.includes("'Battery Power'") ? 'battery' : null
    },
  },
}
