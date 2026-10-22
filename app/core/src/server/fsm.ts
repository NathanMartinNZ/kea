// The dev server's lifecycle: the `kit/Fsm` table, row for row with the diagram below.
//
//             Run                 process alive             port listening
//  stopped ────────▶ starting ─────────────────▶ running ────────────────▶ running + URL chip
//     ▲  ▲              │ exit ≠ 0                │   │ Stop / ⌘R
//     │  │ Run          ▼            exit ≠ 0     │   ▼
//     │  └────────── crashed ◀────────────────────┘ stopping
//     │                                               │ its exit, whatever the code (stopped by Kea)
//     └───────────────────────────────────────────────┘
//     (exit 0 from `starting` or `running` also ends in `stopped`; Stop is taken in `starting` too)
//
// An exit is one of two events: `ended` (exit code 0, or stopped by Kea: Stop, archive, delete, Stop All and
// Quit, whatever the code or signal it then ends with) and `failed` (any other exit, a lost holder included). A
// listening port changes what the control shows, never the state. "Run" from `crashed` is the diagram's way back
// through `stopped`, taken in one step.

import { createFsm, type Fsm, type FsmDef } from '@kea/kit'
import { SERVER_STATES, type ServerState } from '@kea/protocol'

export type ServerEvent =
  /** Run; Restart's second half. */
  | { t: 'run' }
  /** The PTY's holder has started the server's process. */
  | { t: 'alive' }
  /** A scan's result. */
  | { t: 'ports' }
  /** Stop, `⌘R`. */
  | { t: 'stop' }
  /** Exit code 0, or stopped by Kea. */
  | { t: 'ended' }
  /** Any other exit. */
  | { t: 'failed' }

export const SERVER_EVENTS = ['run', 'alive', 'ports', 'stop', 'ended', 'failed'] as const satisfies readonly ServerEvent['t'][]

export const SERVER_TABLE: FsmDef<ServerState, ServerEvent, undefined> = {
  initial: 'stopped',
  transitions: {
    stopped: { run: () => 'starting' },
    // Stop while the holder is still starting the process ends it as any other Stop does
    starting: { alive: () => 'running', stop: () => 'stopping', ended: () => 'stopped', failed: () => 'crashed' },
    running: { ports: () => 'running', stop: () => 'stopping', ended: () => 'stopped', failed: () => 'crashed' },
    // every exit that follows Kea's Stop is `ended`, a holder lost meanwhile included (its child is gone)
    stopping: { ended: () => 'stopped' },
    // Run again (the control's Restart) starts from `crashed` as from `stopped`
    crashed: { run: () => 'starting' },
  },
}

export function serverFsm(state: ServerState = SERVER_TABLE.initial): Fsm<ServerState, ServerEvent, undefined> {
  return createFsm(SERVER_TABLE, { state })
}

/** A server whose process may be alive (it holds a PTY that has not been seen to end). */
export function serverAlive(state: ServerState): boolean {
  return state === 'starting' || state === 'running' || state === 'stopping'
}

export { SERVER_STATES }
