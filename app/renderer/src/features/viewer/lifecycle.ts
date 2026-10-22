// The highlight worker's lifecycle as a `kit/Fsm` table: it starts on first use, ends after
// L.highlightIdleMs with no file or diff tab visible (which releases the WASM heap and every grammar), and is recycled
// when it has loaded more than L.highlightGrammarsMax grammars. The table is data; `client.ts` does what a transition
// means (start or terminate the worker, arm or clear the idle timer).
//
//   off    no worker
//   on     a worker; a file or diff tab is visible
//   idle   a worker; no file or diff tab is visible, and the idle timer runs
//
//   request   a document is to be tokenised         shown / hidden   a file or diff tab is, or no longer is, visible
//   timeout   the idle timer fired                  over             the worker reported more grammars than the limit
//   crashed   the worker raised an error

import { createFsm, type Fsm, type FsmDef, type TransitionRecord } from '@kea/kit/fsm'

export const WORKER_STATES = ['off', 'on', 'idle'] as const
export type WorkerState = (typeof WORKER_STATES)[number]

export type WorkerEvent = { t: 'request' } | { t: 'shown' } | { t: 'hidden' } | { t: 'timeout' } | { t: 'over' } | { t: 'crashed' }
export const WORKER_EVENTS = ['request', 'shown', 'hidden', 'timeout', 'over', 'crashed'] as const satisfies readonly WorkerEvent['t'][]

export const workerLifecycle: Pick<FsmDef<WorkerState, WorkerEvent, undefined>, 'initial' | 'transitions'> = {
  initial: 'off',
  transitions: {
    off: {
      // first use, and the next request after an idle end, a recycle or a crash
      request: () => 'on',
    },
    on: {
      request: () => 'on',
      shown: () => 'on',
      hidden: () => 'idle',
      // recycled: the worker ends here and the next request starts a fresh one
      over: () => ({ to: 'off', note: 'recycled above the grammar limit' }),
      crashed: () => ({ to: 'off', note: 'worker error' }),
    },
    idle: {
      request: () => 'on',
      shown: () => 'on',
      hidden: () => 'idle',
      timeout: () => ({ to: 'off', note: 'idle' }),
      over: () => ({ to: 'off', note: 'recycled above the grammar limit' }),
      crashed: () => ({ to: 'off', note: 'worker error' }),
    },
  },
}

export function createWorkerLifecycle(onTransition: (rec: TransitionRecord<WorkerState, WorkerEvent>) => void): Fsm<WorkerState, WorkerEvent, undefined> {
  return createFsm({ ...workerLifecycle, onTransition })
}
