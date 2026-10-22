// What the detached overlay says: "Session ended", refined by why the agent PTY ended (`end_reason`): stopped, exited,
// crashed with its exit code or signal, or lost with its holder.

import type { EndReason } from '@kea/protocol'

export function endedText(reason: EndReason | null, exit: { code: number | null; signal: number | null } | null): string {
  switch (reason) {
    case 'stopped':
      return 'Session stopped'
    case 'crashed':
      if (exit?.code !== null && exit?.code !== undefined) return `Agent crashed (exit ${exit.code})`
      if (exit?.signal !== null && exit?.signal !== undefined) return `Agent crashed (signal ${exit.signal})`
      return 'Agent crashed'
    case 'lost':
      return 'Agent lost with its terminal'
    default:
      return 'Session ended'
  }
}
