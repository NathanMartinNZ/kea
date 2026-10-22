// The process zoo: small programs for PTY tests, and how a test finds and checks them.
//
//   import { zooCommand, verifyCounter } from '@kea-tools/process-zoo/src/index.ts'
//   const { file, args } = zooCommand('flood', ['--bytes', '100M'])   // spawn `file` with `args`, in a PTY or not

import { fileURLToPath } from 'node:url'
import { forkerBinary } from './forker.ts'

export { COUNTER_DEFAULTS, counterLine, counterText, verifyCounter, type CounterCheck, type CounterOptions } from './counter.ts'
export { floodExpected, floodPeriod, parseSize, type FloodOptions } from './flood.ts'
export { forkerBinary, forkerUnavailable, parseForkerOutput, type ForkerOutput, type ForkerProc, type ForkerReaped, type ForkerSignal } from './forker.ts'
export { intruderBytes, type IntruderReport } from './intruder.ts'
export { ProbeSession, selectQueries, SENTINEL, type DoneRecord, type ProbeItem, type ProbeRecord, type StrayRecord } from './prober.ts'

export { announceLine, parseServerArgs, SERVER_ANNOUNCE, type ServerAnnounce, type ServerOptions } from './server.ts'

export const ZOO_PROGRAMS = ['counter', 'flood', 'forker', 'stubborn', 'prober', 'intruder', 'server'] as const
export type ZooProgram = (typeof ZOO_PROGRAMS)[number]

/** Absolute path of a Node program's entry file (run with Node; types are stripped). forker is C: see `forkerBinary`. */
export function zooScript(name: Exclude<ZooProgram, 'forker'>): string {
  return fileURLToPath(new URL(`./${name}.ts`, import.meta.url))
}

export interface ZooLaunch {
  /** Node binary for the Node programs; default `process.execPath` (under Electron, pass a real node). */
  node?: string
}

/**
 * argv for a zoo program: `{file, args}` to spawn directly (argv array, no shell). forker is compiled on first use
 * (`$CC`, else /usr/bin/cc, cached in tools/process-zoo/build/); this throws if no compiler is available.
 */
export function zooCommand(name: ZooProgram, args: readonly string[] = [], o: ZooLaunch = {}): { file: string; args: string[] } {
  if (name === 'forker') return { file: forkerBinary(), args: [...args] }
  if (!(ZOO_PROGRAMS as readonly string[]).includes(name)) throw new Error(`unknown zoo program "${name}" (${ZOO_PROGRAMS.join(', ')})`)
  return { file: o.node ?? process.execPath, args: [zooScript(name), ...args] }
}
