// The session popover's state: which session it shows, whether the report picker is open in it, and the
// request counter that reopens it. A runes store: ids only.

class StatusUi {
  /** The popover: its session, and whether the report picker is open in it (⌥⌘J opens it so). */
  popover = $state.raw<{ sessionId: string; report: boolean; seq: number } | null>(null)
}

export const statusUi = new StatusUi()

/** Open the session popover (`report`: with the picker open), or move it to another session. */
export function openPopover(sessionId: string, o: { report?: boolean } = {}): void {
  statusUi.popover = { sessionId, report: o.report === true, seq: (statusUi.popover?.seq ?? 0) + 1 }
}

export function closePopover(): void {
  statusUi.popover = null
}
