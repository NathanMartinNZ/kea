// Why archiving a session asks first, as the archive sheet says it (`Sheets.svelte`). Pure, so the wording is
// unit-tested (U-SES-12).

import { terminalText } from '../terminal/text.ts'

const REASON: Record<string, string> = {
  midTurn: 'The agent is in the middle of a turn',
  server: 'A dev server is running',
  shellBusy: 'A shell tab is running a program',
  // core could not learn whether a program runs in it: the close-tab sheet's words (`shell/terminalPane.ts`
  // `closeQuestion`), never "is running"
  shellUnknown: 'A shell tab may be running a program: Kea could not tell whether one is still running in it',
}

/**
 * One line of the archive sheet's list: core's reason (`sessions.archive`) in words. A busy shell's `detail` is its
 * program's name, the program's own word: shown as data. A shell that is not known to be busy has none.
 */
export function archiveReason(r: { kind: string; detail: string }): string {
  const text = REASON[r.kind] ?? r.kind
  if (r.kind === 'shellUnknown') return text
  const detail = r.kind === 'shellBusy' ? terminalText(r.detail) : r.detail
  return detail ? `${text}: ${detail}` : text
}
