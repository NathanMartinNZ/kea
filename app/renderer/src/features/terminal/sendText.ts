// Text at a terminal's prompt on the user's behalf: the one path for a path dragged from the file tree, the
// finder's `⌥↵` and a reference sent from the viewer. It goes through core (`terminal.sendText`), so it reaches the
// session's agent terminal whether or not the window holds a view of it, and it is never submitted. A caller that sends
// a path to a shell escapes it first (`shellEscape.ts`); a caller that then wants the Agent tab on screen asks
// for it (`wantAgentTab`, features/status/viewing.svelte.ts).
//
// The text holds no control character (`isTypedText`): a CR would be Enter, an ESC the start of a
// control sequence. A caller whose text comes from disk (a path) or from a file makes it clean first and tells the
// person when it cannot (`drop.ts`, the viewer's `reference.ts`); a text that still holds one is not sent, and the
// call's schema and core's own gate refuse it again.

import { isTypedText } from '@kea/protocol'
import { call } from '../../lib/rpc.ts'

export interface SendTextOptions {
  /** One of the session's terminals; default its agent terminal. */
  ptyId?: string
  /** As a paste, inside bracketed-paste markers (several lines that must arrive as one edit). */
  bracketed?: boolean
}

/** False, and nothing written, when the session has no such running terminal (or core is away), and for a text that may not be typed. */
export async function sendText(sessionId: string, text: string, o: SendTextOptions = {}): Promise<boolean> {
  if (!isTypedText(text)) return false
  try {
    return (await call('terminal.sendText', { sessionId, text, ...(o.ptyId ? { ptyId: o.ptyId } : {}), ...(o.bracketed ? { bracketed: true } : {}) })).ok
  } catch {
    return false
  }
}
