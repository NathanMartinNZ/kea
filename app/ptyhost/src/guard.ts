// A stalled `@xterm/headless` throws from inside a timer. The mirrors that had unparsed writes are rebuilt from
// checkpoint + ring and ptyhost keeps serving; an exception no mirror can explain is a ptyhost bug, so ptyhost shuts
// down and exits, and the supervisor restarts it. An unhandled rejection is only logged. Installed by main.ts, and by
// the test host that runs ptyhost in a worker thread (I-PTY-16).

import type { Logger } from '@kea/kit'

export interface ExceptionRecovery {
  /** Rebuild the mirrors the exception can have come from; how many (0: not a mirror's). */
  recoverFromException(e: unknown): number
  shutdown(): void
}

type ProcessEvents = {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (e: unknown) => void): unknown
  off(event: 'uncaughtException' | 'unhandledRejection', listener: (e: unknown) => void): unknown
}

const describe = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e))

/** Install the handlers on `proc`; returns their remover. `exit` ends the process (or thread). */
export function installExceptionGuard(proc: ProcessEvents, manager: ExceptionRecovery, log: Logger, exit: (code: number) => void): () => void {
  const onException = (e: unknown) => {
    const rebuilt = manager.recoverFromException(e)
    log.error('uncaught exception', { error: describe(e), mirrorsRebuilt: rebuilt })
    if (rebuilt === 0) {
      manager.shutdown()
      exit(1)
    }
  }
  const onRejection = (e: unknown) => log.error('unhandled rejection', { error: describe(e) })
  proc.on('uncaughtException', onException)
  proc.on('unhandledRejection', onRejection)
  return () => {
    proc.off('uncaughtException', onException)
    proc.off('unhandledRejection', onRejection)
  }
}
