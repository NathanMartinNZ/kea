// Core's last line of defence. An exception nothing caught, or a rejection nothing handled, leaves core in a state no
// code planned for, so core logs it and exits 1; main's Supervisor then restarts it and the new core rebuilds from its
// records and ptyhost's PTY list. Terminals are unaffected: they never pass through core. Ptyhost's guard
// (app/ptyhost/src/guard.ts) differs: it first tries to rebuild the mirrors an exception can have come from, and it
// only logs an unhandled rejection.

import type { Logger } from '@kea/kit'

type ProcessEvents = {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (e: unknown) => void): unknown
  off(event: 'uncaughtException' | 'unhandledRejection', listener: (e: unknown) => void): unknown
}

const describe = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e))

/** Install the handlers on `proc`; returns their remover. `exit` ends the process. */
export function installCoreGuard(proc: ProcessEvents, log: Logger, exit: (code: number) => void): () => void {
  const fatal = (msg: string, e: unknown) => {
    try {
      log.error(msg, { error: describe(e) })
    } finally {
      exit(1)
    }
  }
  const onException = (e: unknown) => fatal('uncaught exception', e)
  const onRejection = (e: unknown) => fatal('unhandled rejection', e)
  proc.on('uncaughtException', onException)
  proc.on('unhandledRejection', onRejection)
  return () => {
    proc.off('uncaughtException', onException)
    proc.off('unhandledRejection', onRejection)
  }
}
