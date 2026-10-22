// Linux's side of the test harnesses' OS layer (index.ts). A run's Kea draws on an Xvfb of the harness's own; the macOS
// tools become /proc reads, systemd-inhibit and a tmpfs; Time Machine's attribute, `leaks`, the power log and
// `footprint -p` have no Linux counterpart and are "not available".
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { notAvailable } from '../../../../packages/protocol/src/platform.ts'
import { runProcess } from '../../../../packages/kit/src/runProcess.ts'
import type { HarnessOs } from './index.ts'

/** How long Xvfb may take to say which display it serves, and one tool to answer (tests/support/app.ts `STEP_MS`). */
const START_TIMEOUT_MS = 20_000
/** The run's screen: as large as the GNOME VM's, so a window's default size fits. */
const SCREEN = '1600x1000x24'
/** Where util-linux and Xvfb live on every supported distribution (merged /usr: /usr/bin, /bin a link to it). */
const XVFB = '/usr/bin/Xvfb'
const SETPRIV = '/usr/bin/setpriv'
const SYSTEMD_INHIBIT = '/usr/bin/systemd-inhibit'
const SUDO = '/usr/bin/sudo'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'

/**
 * A session bus no process answers on: a run's Kea must not reach the person's (their tray would show its icon, their
 * notification service its notifications), so it has none, as on a machine with no desktop (no tray host, no
 * notification service).
 */
export const NO_SESSION_BUS = 'unix:path=/dev/null/kea-test-no-session-bus'

let xvfb: { child: ChildProcess; display: string } | null = null

/**
 * This process's Xvfb, started at its first launch and kept for every later one: the display number it chose
 * (`-displayfd`), with no TCP listener. It dies with this process (setpriv's parent-death signal, and a kill at exit),
 * so a killed test worker leaves no X server behind.
 */
async function runDisplay(): Promise<string> {
  if (xvfb && xvfb.child.exitCode === null && xvfb.child.signalCode === null) return xvfb.display
  if (!fs.existsSync(XVFB)) throw new Error(`Kea's test runs on Linux draw on an X server of their own, and ${XVFB} is missing: install Xvfb (apt install xvfb, dnf install xorg-x11-server-Xvfb)`)
  const child = spawn(SETPRIV, ['--pdeathsig', 'KILL', '--', XVFB, '-displayfd', '3', '-screen', '0', SCREEN, '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } })
  let err = ''
  child.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)))
  const display = await new Promise<string>((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`Xvfb did not say its display within ${START_TIMEOUT_MS} ms: ${err}`)), START_TIMEOUT_MS)
    const fd3 = child.stdio[3] as NodeJS.ReadableStream
    fd3.on('data', (d: Buffer) => {
      out += d.toString()
      const m = /^(\d+)\n/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve(`:${m[1]}`)
      }
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`Xvfb exited (${code ?? signal}) before it served a display: ${err}`))
    })
  })
  child.stdio[3]?.destroy()
  // the server lives as long as this process: neither keeps the other's event loop alive
  child.unref()
  for (const s of child.stdio) (s as { unref?(): void } | null)?.unref?.()
  if (!xvfb) process.once('exit', () => xvfb?.child.kill('SIGKILL'))
  xvfb = { child, display }
  return display
}

/** `/proc/<pid>/stat`'s CPU time, user and system, in clock ticks; null for a line that is not one. */
export function statTicks(stat: string): number | null {
  // the command name is in parentheses and may hold anything: the fields count from the last `)`
  const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  // after the name: state (field 3) … utime (14), stime (15)
  const utime = Number(after[11])
  const stime = Number(after[12])
  return Number.isInteger(utime) && Number.isInteger(stime) ? utime + stime : null
}

/** `/proc/net/unix`'s rows bound to `path`: a listening socket and each connection it accepted that is still open. */
export function unixSocketsAt(table: string, path: string): number {
  let n = 0
  for (const line of table.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length >= 8 && f.slice(7).join(' ') === path) n++
  }
  return n
}

let clockTicks: number | null = null
/** `CLK_TCK`, the unit of `/proc`'s CPU times (`getconf`, once). */
function ticksPerSecond(): number {
  clockTicks ??= Number(execFileSync('/usr/bin/getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
  return clockTicks
}

let inhibit: string | null | undefined
/** Null when logind grants this session an idle-and-sleep inhibitor; otherwise why not (asked once, with `true`). */
function inhibitProblem(): string | null {
  if (inhibit !== undefined) return inhibit
  try {
    execFileSync(SYSTEMD_INHIBIT, ['--what=idle:sleep', '--who=Kea tests', '--why=a test run', '--mode=block', 'true'], { stdio: ['ignore', 'ignore', 'pipe'] })
    inhibit = null
  } catch (e) {
    const why = String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim()
    inhibit = `systemd-inhibit was refused (${why || 'no logind'}): the machine may sleep during the run (logind grants an inhibitor only to the session at the screen, not an SSH or CI one)`
  }
  return inhibit
}

export const linux: HarnessOs = {
  system: 'linux',
  display: {
    shared: false,
    trayProblem: 'a run has no session bus (NO_SESSION_BUS), so no tray host: with no window Kea quits instead of running from a tray icon',
    launch: async () => ({
      args: ['--ozone-platform=x11'],
      env: { DISPLAY: await runDisplay(), WAYLAND_DISPLAY: undefined, XAUTHORITY: undefined, DBUS_SESSION_BUS_ADDRESS: NO_SESSION_BUS },
    }),
  },
  front: notAvailable('Linux has no app in front: a run’s window draws on the harness’s own X server (Xvfb), which nobody types into'),
  keepAwake: {
    wrap: (argv) => {
      const problem = inhibitProblem()
      return problem ? { file: argv[0] as string, args: argv.slice(1), warning: problem } : { file: SYSTEMD_INHIBIT, args: ['--what=idle:sleep', '--who=Kea tests', '--why=a test run', '--mode=block', ...argv], warning: null }
    },
  },
  cpu: {
    seconds: async (pids) => {
      const out = new Map<number, number>()
      for (const pid of pids) {
        let stat: string
        try {
          stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        } catch {
          continue // gone
        }
        const ticks = statTicks(stat)
        if (ticks !== null) out.set(pid, ticks / ticksPerSecond())
      }
      return out
    },
  },
  openFiles: {
    // a process's descriptors; a non-dumpable one's (a holder) cannot be read, and this throws
    count: async (pid) => fs.readdirSync(`/proc/${pid}/fd`).length,
  },
  unixSockets: { at: async (path) => unixSocketsAt(fs.readFileSync('/proc/net/unix', 'utf8'), path) },
  smallVolumes: {
    problem: async () => {
      // `sudo -l <command>` asks whether the rules allow it without running it; `-n`: never a password prompt
      const allowed = async (file: string) => (await runProcess(SUDO, ['-n', '-l', file], { pool: 'other', timeoutMs: START_TIMEOUT_MS, collect: true }).catch(() => ({ code: 1 }))).code === 0
      return (await allowed(MOUNT)) && (await allowed(UMOUNT)) ? null : `a size-limited tmpfs is mounted as root, and this user may not run ${MOUNT} and ${UMOUNT} through sudo without a password`
    },
    // a tmpfs of `mb` MiB, this user's alone, mounted as root through `sudo -n` and unmounted after
    mount: async (at, mb, name) => {
      const opts = `size=${mb}m,uid=${process.getuid?.()},gid=${process.getgid?.()},mode=0700`
      const r = await runProcess(SUDO, ['-n', MOUNT, '-t', 'tmpfs', '-o', opts, name, at], { pool: 'other', timeoutMs: START_TIMEOUT_MS, collect: true })
      if (r.code !== 0) throw new Error(`mount -t tmpfs ${at}: ${r.stderr}`)
      return {
        async detach() {
          const u = await runProcess(SUDO, ['-n', UMOUNT, at], { pool: 'other', timeoutMs: START_TIMEOUT_MS, collect: true })
          if (u.code !== 0) {
            const lazy = await runProcess(SUDO, ['-n', UMOUNT, '--lazy', at], { pool: 'other', timeoutMs: START_TIMEOUT_MS, collect: true })
            if (lazy.code !== 0) throw new Error(`umount ${at}: ${u.stderr} ${lazy.stderr}`)
          }
        },
      }
    },
  },
  backupAttribute: notAvailable('no Linux backup tool honours one marker the way Time Machine honours its attribute, so Kea writes none there'),
  leaks: notAvailable('macOS’s leaks has no Linux counterpart Kea’s tests use; the object-count cycle tests still run'),
  powerLog: notAvailable('a run’s display is the harness’s own Xvfb, which never turns off, and Linux keeps no power log of the display (the display-off window leak this guards against is Electron’s on macOS)'),
  ownedUnmapped: notAvailable('owned unmapped blocks are macOS’s footprint tool’s; Linux reports none'),
  machine: {
    model: () => {
      for (const f of ['/sys/firmware/devicetree/base/model', '/sys/class/dmi/id/product_name']) {
        try {
          const m = fs.readFileSync(f, 'utf8').replace(/\0/g, '').trim()
          if (m) return m
        } catch {
          // not this machine's kind of firmware
        }
      }
      return null
    },
    system: (release) => {
      let name = 'Linux'
      try {
        name = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(fs.readFileSync('/etc/os-release', 'utf8'))?.[1] ?? name
      } catch {
        // no os-release
      }
      return `${name} (Linux ${release})`
    },
    power: () => {
      let supplies: string[]
      try {
        supplies = fs.readdirSync('/sys/class/power_supply')
      } catch {
        return null
      }
      for (const s of supplies) {
        try {
          const type = fs.readFileSync(`/sys/class/power_supply/${s}/type`, 'utf8').trim()
          if (type === 'Mains') return fs.readFileSync(`/sys/class/power_supply/${s}/online`, 'utf8').trim() === '1' ? 'AC' : 'battery'
        } catch {
          // a supply without these files
        }
      }
      return null
    },
  },
}
