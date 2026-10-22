// Shared by the zoo's own tests: run a program on pipes, wait on its output, and make sure nothing outlives the tests.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { type ZooProgram, zooCommand } from './index.ts'

export interface Proc {
  child: ChildProcessWithoutNullStreams
  out(): string
  err(): string
  /** Resolves once `pred(stdout)` holds; rejects if the process exits first. */
  until(pred: (out: string) => boolean, what: string): Promise<void>
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

const running = new Set<ChildProcessWithoutNullStreams>() // bounded: the processes one test file starts
const extraPids = new Set<number>() // bounded: descendants one test file learns about (forker's trees)

export function run(file: string, args: readonly string[], o: { env?: NodeJS.ProcessEnv; encoding?: BufferEncoding } = {}): Proc {
  const child = spawn(file, [...args], { stdio: 'pipe', env: o.env ?? process.env })
  running.add(child)
  let out = ''
  let err = ''
  const waiters: { pred: (s: string) => boolean; resolve: () => void }[] = []
  const check = () => {
    for (const w of [...waiters]) {
      if (w.pred(out)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve()
      }
    }
  }
  child.stdout.setEncoding(o.encoding ?? 'utf8').on('data', (d: string) => {
    out += d
    check()
  })
  child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('close', (code, signal) => {
      running.delete(child)
      resolve({ code, signal })
    }),
  )
  return {
    child,
    out: () => out,
    err: () => err,
    until: (pred, what) =>
      new Promise<void>((resolve, reject) => {
        if (pred(out)) return resolve()
        waiters.push({ pred, resolve })
        void exited.then(() => {
          if (!pred(out)) reject(new Error(`exited before ${what}; stdout: ${JSON.stringify(out.slice(-2000))}; stderr: ${err}`))
        })
      }),
    exited,
  }
}

/** Run a zoo program (zooCommand) on pipes. */
export function zoo(name: ZooProgram, args: readonly string[], o: { env?: NodeJS.ProcessEnv; encoding?: BufferEncoding } = {}): Proc {
  const c = zooCommand(name, args)
  return run(c.file, c.args, o)
}

/** Remember pids that are not direct children (forker's descendants), so `killAll` can reap them on failure too. */
export function track(pids: readonly number[]): void {
  for (const p of pids) extraPids.add(p)
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Wait until none of `pids` exists (an orphan killed with SIGKILL is a zombie until init reaps it, so this is a
 * condition wait with a deadline, not an event).
 */
export function waitGone(pids: readonly number[], timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      const left = pids.filter(alive)
      if (left.length === 0) return resolve()
      if (performance.now() > deadline) return reject(new Error(`still running after ${timeoutMs} ms: ${left.join(', ')}`))
      setTimeout(poll, 5)
    }
    poll()
  })
}

/** SIGKILL everything a test file started (afterAll), then wait for it to be gone. */
export async function killAll(): Promise<void> {
  const pids = [...extraPids]
  for (const p of pids) {
    try {
      process.kill(p, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  const closing = [...running].map((c) => new Promise<void>((resolve) => (c.exitCode !== null || c.signalCode !== null ? resolve() : c.once('close', () => resolve()))))
  for (const c of running) c.kill('SIGKILL')
  await Promise.all(closing)
  await waitGone(pids)
  extraPids.clear()
}

/** JSON lines of `text` (complete lines only) whose first key is `key`. */
export function jsonLines<T>(text: string, key: string): T[] {
  return text
    .split('\n')
    .slice(0, -1)
    .filter((l) => l.startsWith(`{"${key}":`))
    .map((l) => JSON.parse(l) as T)
}
